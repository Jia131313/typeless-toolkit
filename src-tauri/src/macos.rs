use plist::Value as PlistValue;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::utils::config::Color;
use tauri::{AppHandle, Manager, Theme};

const TOOLKIT_BUNDLE_ID: &str = "com.typeless-toolkit.manager";
const TYPELESS_BUNDLE_ID: &str = "now.typeless.desktop";

#[derive(Debug, Serialize)]
pub struct HostError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

impl HostError {
    fn new(code: &str, message: impl Into<String>, phase: Option<&str>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            phase: phase.map(str::to_string),
        }
    }
}

pub fn set_theme(app: &AppHandle, params: &Value) -> Result<Value, HostError> {
    let theme = match params.get("theme").and_then(Value::as_str) {
        Some("light") => Theme::Light,
        Some("dark") => Theme::Dark,
        _ => {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "theme 必须是 light 或 dark",
                None,
            ))
        }
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| HostError::new("WINDOW_UNAVAILABLE", "主窗口尚未创建", None))?;
    window
        .set_theme(Some(theme))
        .map_err(|error| HostError::new("WINDOW_ERROR", error.to_string(), None))?;
    let color = if params["theme"] == "dark" {
        Color(15, 20, 32, 255)
    } else {
        Color(245, 246, 249, 255)
    };
    window
        .set_background_color(Some(color))
        .map_err(|error| HostError::new("WINDOW_ERROR", error.to_string(), None))?;
    Ok(json!({ "theme": params["theme"] }))
}

pub fn open_privacy_settings(params: &Value) -> Result<Value, HostError> {
    let pane = match params.get("section").and_then(Value::as_str) {
        Some("app-management") => "Privacy_AppBundles",
        Some("accessibility") => "Privacy_Accessibility",
        Some("microphone") => "Privacy_Microphone",
        _ => {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "未知的 macOS 隐私设置区域",
                None,
            ))
        }
    };
    open_url(&format!(
        "x-apple.systempreferences:com.apple.preference.security?{pane}"
    ))?;
    Ok(json!({ "opened": true }))
}

pub fn reset_privacy_permissions(params: &Value) -> Result<Value, HostError> {
    let target = params.get("target").and_then(Value::as_str);
    let (bundle_id, services, app_name): (&str, &[&str], &str) = match target {
        Some("toolkit") => (
            TOOLKIT_BUNDLE_ID,
            &["SystemPolicyAppBundles", "Accessibility"],
            "Typeless 工具集",
        ),
        Some("typeless") => (
            TYPELESS_BUNDLE_ID,
            &["Accessibility", "Microphone"],
            "Typeless",
        ),
        _ => {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "target 必须是 toolkit 或 typeless",
                None,
            ))
        }
    };
    reset_tcc(bundle_id, services).map_err(|message| {
        HostError::new("TCC_RESET_FAILED", message, Some("reset-permissions"))
    })?;
    Ok(json!({
        "ok": true,
        "message": format!("已清除 {app_name} 的旧权限记录，请重新启动并按系统提示授权")
    }))
}

pub fn reconcile_toolkit_identity(data_dir: &Path) -> Result<Value, HostError> {
    let Some(bundle) = current_app_bundle() else {
        return Ok(json!({ "changed": false, "skipped": true, "reason": "development" }));
    };
    let requirement = code_requirement(&bundle).map_err(|message| {
        HostError::new("IDENTITY_READ_FAILED", message, Some("read-identity"))
    })?;
    let state_path = data_dir.join("mac-permission-identity.json");
    let previous = fs::read_to_string(&state_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|state| {
            state
                .get("requirement")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if previous.as_deref() == Some(&requirement) {
        return Ok(json!({ "changed": false, "requirement": requirement }));
    }

    reset_tcc(
        TOOLKIT_BUNDLE_ID,
        &["SystemPolicyAppBundles", "Accessibility"],
    )
    .map_err(|message| HostError::new("TCC_RESET_FAILED", message, Some("reconcile-identity")))?;
    write_identity_state(&state_path, &requirement, previous.as_deref(), true)?;
    Ok(json!({
        "changed": true,
        "requirement": requirement,
        "previous_requirement": previous,
        "app_management_regrant_required": true
    }))
}

pub fn mark_app_management_authorized(data_dir: &Path) -> Result<(), HostError> {
    let state_path = data_dir.join("mac-permission-identity.json");
    let mut state = fs::read_to_string(&state_path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .unwrap_or_else(|| json!({}));
    state["app_management_regrant_required"] = Value::Bool(false);
    state["app_management_authorized_at"] = Value::String(timestamp_iso8601());
    write_private_json(&state_path, &state)
}

pub fn open_toolkit_update_file(
    params: &Value,
    edition: &str,
    arch: &str,
) -> Result<Value, HostError> {
    let file = params
        .get("file_path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "缺少 file_path", None))?;
    let info = fs::symlink_metadata(&file)
        .map_err(|_| HostError::new("INVALID_UPDATE_FILE", "已下载的 DMG 不存在", None))?;
    if !info.file_type().is_file() || info.file_type().is_symlink() {
        return Err(HostError::new(
            "INVALID_UPDATE_FILE",
            "更新包必须是普通 DMG 文件",
            None,
        ));
    }
    let expected_suffix = format!("-mac-{arch}-{edition}.dmg");
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if !name.starts_with("Typeless-Toolkit-")
        || !name.ends_with(&expected_suffix)
        || !valid_release_version(&name[17..name.len() - expected_suffix.len()])
    {
        return Err(HostError::new(
            "INVALID_UPDATE_FILE",
            "更新包与当前 Mac 架构或版本类型不匹配",
            None,
        ));
    }
    open_url(
        fs::canonicalize(&file)
            .map_err(|error| HostError::new("INVALID_UPDATE_FILE", error.to_string(), None))?
            .to_string_lossy()
            .as_ref(),
    )?;
    Ok(json!({ "ok": true, "opened": true }))
}

pub fn swap_typeless_app(params: &Value, data_dir: &Path) -> Result<Value, HostError> {
    let operation = params
        .get("operation")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "paywall-patch" | "official-update"))
        .ok_or_else(|| {
            HostError::new(
                "INVALID_ARGUMENT",
                "operation 必须是 paywall-patch 或 official-update",
                None,
            )
        })?;
    let requested_stage = params
        .get("staging_app")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "缺少 staging_app", None))?;
    let staging_root = data_dir.join("staging");
    let staging_root = fs::canonicalize(&staging_root).map_err(|error| {
        HostError::new(
            "INVALID_STAGING",
            format!("staging 目录不可用: {error}"),
            Some("validate-staging"),
        )
    })?;
    let staged_app = fs::canonicalize(&requested_stage).map_err(|error| {
        HostError::new(
            "INVALID_STAGING",
            format!("候选 App 不存在: {error}"),
            Some("validate-staging"),
        )
    })?;
    if staged_app.parent().is_none()
        || !staged_app.starts_with(&staging_root)
        || !staged_app.is_dir()
    {
        return Err(HostError::new(
            "INVALID_STAGING",
            "候选 App 必须位于工具集 data/staging 目录内",
            Some("validate-staging"),
        ));
    }
    verify_app(&staged_app)
        .map_err(|message| HostError::new("INVALID_STAGING", message, Some("verify-staging")))?;
    let target = target_app(params)?;

    if typeless_running() {
        return Err(HostError::new(
            "TARGET_RUNNING",
            "Typeless 仍在运行，请退出后重试",
            Some("preflight"),
        ));
    }

    let previous_requirement = code_requirement(&target).ok();
    let backup_dir = data_dir
        .join("backups/typeless-app")
        .join(format!("{operation}-{}.noindex", timestamp_for_path()));
    fs::create_dir_all(&backup_dir).map_err(|error| {
        HostError::new("SWAP_FAILED", error.to_string(), Some("create-backup-dir"))
    })?;
    let backup_app = backup_dir.join("Typeless.app.backup");
    copy_app(&target, &backup_app)
        .map_err(|message| HostError::new("SWAP_FAILED", message, Some("backup-current")))?;

    let install_result = (|| -> Result<(), HostError> {
        fs::remove_dir_all(&target).map_err(|error| {
            HostError::new(
                permission_code(&error.to_string()),
                format!("无法移除现有 Typeless.app: {error}"),
                Some("remove-current"),
            )
        })?;
        copy_app(&staged_app, &target).map_err(|message| {
            HostError::new(permission_code(&message), message, Some("install-staging"))
        })?;
        verify_app(&target)
            .map_err(|message| HostError::new("SWAP_FAILED", message, Some("verify-installed")))
    })();

    if let Err(error) = install_result {
        let restoration = restore_backup(&backup_app, &target);
        let message = match restoration {
            Ok(()) => format!("{}；已恢复原 Typeless.app", error.message),
            Err(restore_error) => format!("{}；恢复原 App 失败: {restore_error}", error.message),
        };
        return Err(HostError::new(&error.code, message, error.phase.as_deref()));
    }

    let current_requirement = code_requirement(&target).ok();
    let identity_changed = previous_requirement != current_requirement;
    let privacy_reset = if identity_changed {
        match reset_tcc(TYPELESS_BUNDLE_ID, &["Accessibility", "Microphone"]) {
            Ok(()) => Some(json!({
                "ok": true,
                "reset": ["Accessibility", "Microphone"],
                "failures": []
            })),
            Err(error) => Some(json!({
                "ok": false,
                "reset": [],
                "failures": ["Accessibility", "Microphone"],
                "error": error
            })),
        }
    } else {
        None
    };
    mark_app_management_authorized(data_dir)?;

    Ok(json!({
        "installed_app": target,
        "target_app": target,
        "backup": backup_app,
        "previous_requirement": previous_requirement,
        "current_requirement": current_requirement,
        "identity_changed": identity_changed,
        "privacy_reset": privacy_reset
    }))
}

pub fn restore_typeless_backup(params: &Value, data_dir: &Path) -> Result<Value, HostError> {
    let requested_backup = params
        .get("backup")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "缺少 backup", None))?;
    let backup_root = fs::canonicalize(data_dir.join("backups/typeless-app")).map_err(|error| {
        HostError::new(
            "INVALID_BACKUP",
            format!("备份目录不可用: {error}"),
            Some("validate-backup"),
        )
    })?;
    let backup = fs::canonicalize(requested_backup).map_err(|error| {
        HostError::new(
            "INVALID_BACKUP",
            format!("备份不存在: {error}"),
            Some("validate-backup"),
        )
    })?;
    if !backup.starts_with(&backup_root)
        || backup.file_name().and_then(|value| value.to_str()) != Some("Typeless.app.backup")
        || !backup.is_dir()
    {
        return Err(HostError::new(
            "INVALID_BACKUP",
            "只能恢复工具集 data/backups/typeless-app 下的 Typeless.app.backup",
            Some("validate-backup"),
        ));
    }
    verify_app(&backup)
        .map_err(|message| HostError::new("INVALID_BACKUP", message, Some("verify-backup")))?;
    let target = target_app(params)?;
    if typeless_running() {
        return Err(HostError::new(
            "TARGET_RUNNING",
            "Typeless 仍在运行，请退出后重试",
            Some("preflight"),
        ));
    }

    let previous_requirement = code_requirement(&target).ok();
    restore_backup(&backup, &target).map_err(|message| {
        HostError::new(
            permission_code(&message),
            format!("无法恢复 Typeless.app: {message}"),
            Some("restore-backup"),
        )
    })?;
    let current_requirement = code_requirement(&target).ok();
    let identity_changed = previous_requirement != current_requirement;
    let privacy_reset = if identity_changed {
        match reset_tcc(TYPELESS_BUNDLE_ID, &["Accessibility", "Microphone"]) {
            Ok(()) => Some(json!({
                "ok": true,
                "reset": ["Accessibility", "Microphone"],
                "failures": []
            })),
            Err(error) => Some(json!({
                "ok": false,
                "reset": [],
                "failures": ["Accessibility", "Microphone"],
                "error": error
            })),
        }
    } else {
        None
    };
    mark_app_management_authorized(data_dir)?;
    Ok(json!({
        "installed_app": target,
        "target_app": target,
        "backup": backup,
        "previous_requirement": previous_requirement,
        "current_requirement": current_requirement,
        "identity_changed": identity_changed,
        "privacy_reset": privacy_reset
    }))
}

fn target_app(params: &Value) -> Result<PathBuf, HostError> {
    let requested = params
        .get("target_app")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "缺少 target_app", None))?;
    if !requested.is_absolute()
        || requested.extension().and_then(|value| value.to_str()) != Some("app")
        || !requested.is_dir()
    {
        return Err(HostError::new(
            "INVALID_TARGET",
            "target_app 必须是现存的绝对 .app Bundle 路径",
            Some("validate-target"),
        ));
    }
    let target = fs::canonicalize(requested).map_err(|error| {
        HostError::new(
            "INVALID_TARGET",
            format!("无法读取 target_app: {error}"),
            Some("validate-target"),
        )
    })?;
    let bundle_id = bundle_identifier(&target)
        .map_err(|message| HostError::new("INVALID_TARGET", message, Some("validate-target")))?;
    if bundle_id != TYPELESS_BUNDLE_ID {
        return Err(HostError::new(
            "INVALID_TARGET",
            format!("target_app Bundle ID 必须是 {TYPELESS_BUNDLE_ID}，实际为 {bundle_id}"),
            Some("validate-target"),
        ));
    }
    Ok(target)
}

fn restore_backup(backup: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    copy_app(backup, target)?;
    verify_app(target)
}

fn copy_app(source: &Path, target: &Path) -> Result<(), String> {
    let output = Command::new("/usr/bin/ditto")
        .args(["--rsrc", "--extattr", "--acl"])
        .arg(source)
        .arg(target)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn verify_app(app: &Path) -> Result<(), String> {
    let bundle_id = bundle_identifier(app)?;
    if bundle_id != TYPELESS_BUNDLE_ID {
        return Err(format!(
            "Bundle ID 不匹配：期望 {TYPELESS_BUNDLE_ID}，实际 {bundle_id}"
        ));
    }
    let output = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict", "--verbose=2"])
        .arg(app)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "代码签名严格校验失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn bundle_identifier(app: &Path) -> Result<String, String> {
    let plist = PlistValue::from_file(app.join("Contents/Info.plist"))
        .map_err(|error| error.to_string())?;
    plist
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleIdentifier"))
        .and_then(PlistValue::as_string)
        .map(str::to_string)
        .ok_or_else(|| "Info.plist 缺少 CFBundleIdentifier".to_string())
}

fn code_requirement(app: &Path) -> Result<String, String> {
    let output = Command::new("/usr/bin/codesign")
        .args(["-d", "-r-"])
        .arg(app)
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let details = format!("{stdout}\n{stderr}");
    details
        .lines()
        .find_map(|line| line.find("designated => ").map(|start| &line[start..]))
        .map(str::to_string)
        .ok_or_else(|| format!("无法读取代码指定要求: {}", details.trim()))
}

fn current_app_bundle() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable.ancestors().find_map(|path| {
        (path.extension().and_then(|value| value.to_str()) == Some("app"))
            .then(|| path.to_path_buf())
    })
}

fn reset_tcc(bundle_id: &str, services: &[&str]) -> Result<(), String> {
    let mut failed = Vec::new();
    for service in services {
        let status = Command::new("/usr/bin/tccutil")
            .args(["reset", service, bundle_id])
            .status()
            .map_err(|error| error.to_string())?;
        if !status.success() {
            failed.push(*service);
        }
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("无法清除 {} 权限记录", failed.join("、")))
    }
}

fn write_identity_state(
    path: &Path,
    requirement: &str,
    previous: Option<&str>,
    regrant_required: bool,
) -> Result<(), HostError> {
    write_private_json(
        path,
        &json!({
            "requirement": requirement,
            "previous_requirement": previous,
            "updated_at": timestamp_iso8601(),
            "app_management_regrant_required": regrant_required,
            "app_management_authorized_at": Value::Null
        }),
    )
}

fn write_private_json(path: &Path, value: &Value) -> Result<(), HostError> {
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(value).unwrap()),
    )
    .map_err(|error| HostError::new("STATE_WRITE_FAILED", error.to_string(), None))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| HostError::new("STATE_WRITE_FAILED", error.to_string(), None))
}

fn open_url(target: &str) -> Result<(), HostError> {
    let status = Command::new("/usr/bin/open")
        .arg(target)
        .status()
        .map_err(|error| HostError::new("OPEN_FAILED", error.to_string(), None))?;
    if status.success() {
        Ok(())
    } else {
        Err(HostError::new("OPEN_FAILED", "macOS 无法打开目标", None))
    }
}

fn valid_release_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn typeless_running() -> bool {
    Command::new("/usr/bin/pgrep")
        .args(["-x", "Typeless"])
        .status()
        .is_ok_and(|status| status.success())
}

fn permission_code(message: &str) -> &'static str {
    if message.contains("Operation not permitted") || message.contains("Permission denied") {
        "APP_MANAGEMENT_REQUIRED"
    } else {
        "SWAP_FAILED"
    }
}

fn timestamp_for_path() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn timestamp_iso8601() -> String {
    let output = Command::new("/bin/date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output();
    output
        .ok()
        .filter(|result| result.status.success())
        .map(|result| String::from_utf8_lossy(&result.stdout).trim().to_string())
        .unwrap_or_else(timestamp_for_path)
}
