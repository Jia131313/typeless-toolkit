use serde::Serialize;
use serde_json::{Map, Value};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MINIMUM_NODE: (u64, u64, u64) = (22, 12, 0);
const DEFAULT_MANAGER_PORT: u16 = 7788;

#[derive(Clone, Debug, Serialize)]
pub struct NodeRuntime {
    pub path: PathBuf,
    pub source: String,
    pub version: String,
}

#[derive(Debug)]
pub struct StartedBackend {
    pub child: Child,
    pub node: NodeRuntime,
}

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(home
        .join("Library")
        .join("Application Support")
        .join("Typeless 工具集")
        .join("data"))
}

pub fn prepare_data_dir(app: &AppHandle, server_dir: &Path) -> Result<PathBuf, String> {
    let data_dir = data_dir(app)?;
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;

    let config_path = data_dir.join("config.json");
    if !config_path.exists() {
        fs::copy(server_dir.join("config.json"), &config_path)
            .map_err(|error| format!("无法初始化配置文件 {}: {error}", config_path.display()))?;
    }
    fs::set_permissions(&config_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    Ok(data_dir)
}

pub fn server_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("server");
    if packaged.join("manager.js").is_file() {
        return Ok(packaged);
    }

    let current = std::env::current_dir().map_err(|error| error.to_string())?;
    if current.join("manager.js").is_file() {
        return Ok(current);
    }
    Err("未找到随应用打包的 server/manager.js".to_string())
}

pub fn preferred_manager_port(config_path: &Path) -> u16 {
    let Ok(contents) = fs::read_to_string(config_path) else {
        return DEFAULT_MANAGER_PORT;
    };
    let Ok(value) = serde_json::from_str::<Value>(&contents) else {
        return DEFAULT_MANAGER_PORT;
    };
    value
        .get("manager_port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port > 0)
        .unwrap_or(DEFAULT_MANAGER_PORT)
}

pub fn select_manager_port(preferred: u16) -> Result<u16, String> {
    if can_listen(preferred) {
        return Ok(preferred);
    }

    for offset in 1..=100u16 {
        let Some(candidate) = preferred.checked_add(offset) else {
            break;
        };
        if can_listen(candidate) {
            return Ok(candidate);
        }
    }
    for candidate in 17888..=17988 {
        if can_listen(candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "端口 {preferred} 已被其他程序占用，且找不到可用的回退端口"
    ))
}

fn can_listen(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn probe_toolkit(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback address"),
        Duration::from_millis(700),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let request =
        format!("GET /api/env HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !headers
        .lines()
        .next()
        .is_some_and(|line| line.contains(" 200 "))
    {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/data/service")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|service| service == "typeless-toolkit")
}

pub fn discover_node(
    app: &AppHandle,
    data_dir: &Path,
    edition: &str,
) -> Result<NodeRuntime, String> {
    if edition == "portable" {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let bundled = executable
            .parent()
            .ok_or_else(|| "无法确定应用可执行文件目录".to_string())?
            .join("node");
        return validate_node(&bundled, "bundled");
    }

    let config_path = data_dir.join("config.json");
    if let Some(saved) = read_saved_node_path(&config_path) {
        if let Ok(runtime) = validate_node(&saved, "configured") {
            return Ok(runtime);
        }
    }

    for candidate in node_candidates(app)? {
        if let Ok(runtime) = validate_node(&candidate, "discovered") {
            save_node_path(&config_path, &runtime.path)?;
            return Ok(runtime);
        }
    }

    let selected = select_node_file()?;
    let runtime = validate_node(&selected, "selected")?;
    save_node_path(&config_path, &runtime.path)?;
    Ok(runtime)
}

fn read_saved_node_path(config_path: &Path) -> Option<PathBuf> {
    let value = serde_json::from_str::<Value>(&fs::read_to_string(config_path).ok()?).ok()?;
    value.get("node_path")?.as_str().map(PathBuf::from)
}

fn node_candidates(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        home.join(".volta/bin/node"),
        home.join(".local/share/mise/shims/node"),
        home.join(".asdf/shims/node"),
    ];

    let nvm_versions = home.join(".nvm/versions/node");
    if let Ok(entries) = fs::read_dir(nvm_versions) {
        let mut versioned: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path().join("bin/node"))
            .collect();
        versioned.sort_by(|left, right| right.cmp(left));
        candidates.extend(versioned);
    }
    Ok(candidates)
}

fn select_node_file() -> Result<PathBuf, String> {
    let script = r#"POSIX path of (choose file with prompt "请选择 Node.js 22.12 或更高版本的 node 可执行文件")"#;
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .map_err(|error| format!("无法打开 Node 选择窗口: {error}"))?;
    if !output.status.success() {
        return Err("未找到 Node.js 22.12+；Lite 版需要选择本机的 node 可执行文件".to_string());
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn save_node_path(config_path: &Path, node_path: &Path) -> Result<(), String> {
    let contents = fs::read_to_string(config_path).map_err(|error| error.to_string())?;
    let mut value = serde_json::from_str::<Value>(&contents).map_err(|error| error.to_string())?;
    let object: &mut Map<String, Value> = value
        .as_object_mut()
        .ok_or_else(|| "config.json 根节点必须是对象".to_string())?;
    object.insert(
        "node_path".to_string(),
        Value::String(node_path.to_string_lossy().into_owned()),
    );
    fs::write(
        config_path,
        format!("{}\n", serde_json::to_string_pretty(&value).unwrap()),
    )
    .map_err(|error| error.to_string())?;
    fs::set_permissions(config_path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())
}

fn validate_node(path: &Path, source: &str) -> Result<NodeRuntime, String> {
    if !path.is_file() {
        return Err(format!("Node 不存在: {}", path.display()));
    }
    let version_output = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|error| format!("无法运行 Node {}: {error}", path.display()))?;
    if !version_output.status.success() {
        return Err(format!("Node 版本检查失败: {}", path.display()));
    }
    let version = String::from_utf8_lossy(&version_output.stdout)
        .trim()
        .trim_start_matches('v')
        .to_string();
    if parse_version(&version).is_none_or(|candidate| candidate < MINIMUM_NODE) {
        return Err(format!("Node {version} 低于所需的 22.12.0"));
    }

    let arch_output = Command::new(path)
        .args(["-p", "process.arch"])
        .output()
        .map_err(|error| format!("无法检查 Node 架构: {error}"))?;
    if !arch_output.status.success() {
        return Err("Node 架构检查失败".to_string());
    }
    let actual = String::from_utf8_lossy(&arch_output.stdout)
        .trim()
        .to_string();
    let expected = toolkit_arch();
    if actual != expected {
        return Err(format!("Node 架构为 {actual}，当前工具集需要 {expected}"));
    }

    Ok(NodeRuntime {
        path: fs::canonicalize(path).map_err(|error| error.to_string())?,
        source: source.to_string(),
        version: format!("v{version}"),
    })
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.split('-').next()?.parse().ok()?,
    ))
}

pub fn toolkit_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

pub fn start_backend(
    server_dir: &Path,
    data_dir: &Path,
    port: u16,
    node: &NodeRuntime,
    edition: &str,
) -> Result<StartedBackend, String> {
    let host_pid = std::process::id().to_string();
    let install_dir = server_dir
        .parent()
        .ok_or_else(|| "无法确定工具集资源目录".to_string())?;
    let mut child = Command::new(&node.path)
        .arg(server_dir.join("manager.js"))
        .args(["--desktop-host", "tauri"])
        .arg("--data-dir")
        .arg(data_dir)
        .args(["--manager-port", &port.to_string()])
        .args(["--toolkit-edition", edition])
        .args(["--toolkit-arch", toolkit_arch()])
        .args(["--host-pid", &host_pid])
        .arg("--node-path")
        .arg(&node.path)
        .args(["--node-source", &node.source])
        .args(["--node-version", &node.version])
        .current_dir(server_dir)
        .env("TYPELESS_DATA_DIR", data_dir)
        .env("TYPELESS_MANAGER_PORT", port.to_string())
        .env("TYPELESS_TOOLKIT_BACKEND_OWNER", "desktop-host")
        .env("TYPELESS_TOOLKIT_HOST_PID", &host_pid)
        .env("TYPELESS_TOOLKIT_INSTALL_DIR", install_dir)
        .env("TYPELESS_TOOLKIT_DESKTOP_HOST", "tauri")
        .env("TYPELESS_TOOLKIT_EDITION", edition)
        .env("TYPELESS_TOOLKIT_ARCH", toolkit_arch())
        .env("TYPELESS_TOOLKIT_HOST_PROTOCOL", "stdio-jsonl")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("无法启动 manager.js: {error}"))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if probe_toolkit(port) {
            return Ok(StartedBackend {
                child,
                node: node.clone(),
            });
        }
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("manager.js 在服务就绪前退出".to_string());
        }
        thread::sleep(Duration::from_millis(150));
    }
    let _ = child.kill();
    Err("等待本地管理服务启动超时".to_string())
}
