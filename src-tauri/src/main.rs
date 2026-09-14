#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod broker;
mod macos;
mod runtime;

use broker::BrokerContext;
use std::process::Child;
use std::sync::{Arc, Mutex};
use tauri::utils::config::Color;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const APP_NAME: &str = "Typeless 工具集";
const EDITION: &str = env!("TYPELESS_TOOLKIT_EDITION");

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_backend(backend: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut child) = backend.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn show_startup_error(message: &str) {
    let escaped = message.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display alert \"Typeless 工具集启动失败\" message \"{escaped}\" as critical buttons {{\"好\"}} default button \"好\""
    );
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status();
}

fn main() {
    let backend: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let backend_for_setup = Arc::clone(&backend);

    let app_result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let server_dir = runtime::server_dir(&handle)?;
            let data_dir = runtime::prepare_data_dir(&handle, &server_dir)?;
            if let Err(error) = macos::reconcile_toolkit_identity(&data_dir) {
                eprintln!("[macOS permissions] {}", error.message);
            }

            let preferred = runtime::preferred_manager_port(&data_dir.join("config.json"));
            let port = runtime::select_manager_port(preferred)?;
            let node = runtime::discover_node(&handle, &data_dir, EDITION)?;
            let mut started = runtime::start_backend(&server_dir, &data_dir, port, &node, EDITION)?;
            let stdout = started
                .child
                .stdout
                .take()
                .ok_or("无法读取 manager.js 宿主协议输出")?;
            let stdin = started
                .child
                .stdin
                .take()
                .ok_or("无法写入 manager.js 宿主协议输入")?;
            let context = BrokerContext {
                app: handle.clone(),
                data_dir: data_dir.clone(),
                edition: EDITION.to_string(),
                node: started.node,
            };
            std::thread::spawn(move || broker::run(stdout, stdin, context));
            *backend_for_setup.lock().map_err(|_| "后端进程状态不可用")? = Some(started.child);

            let url = format!("http://127.0.0.1:{port}/")
                .parse()
                .map_err(|error| format!("无效的本地管理器 URL: {error}"))?;
            let allowed_origin = format!("http://127.0.0.1:{port}/");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(APP_NAME)
                .inner_size(1280.0, 820.0)
                .min_inner_size(880.0, 620.0)
                .background_color(Color(245, 246, 249, 255))
                .center()
                .on_navigation(move |target| {
                    let value = target.as_str();
                    if value.starts_with(&allowed_origin) {
                        true
                    } else {
                        if value.starts_with("https://") || value.starts_with("http://") {
                            let _ = std::process::Command::new("/usr/bin/open")
                                .arg(value)
                                .spawn();
                        }
                        false
                    }
                })
                .on_new_window(|target, _| {
                    let value = target.as_str();
                    if value.starts_with("https://") || value.starts_with("http://") {
                        let _ = std::process::Command::new("/usr/bin/open")
                            .arg(value)
                            .spawn();
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app_result {
        Ok(app) => app,
        Err(error) => {
            stop_backend(&backend);
            show_startup_error(&error.to_string());
            return;
        }
    };

    app.run(move |app, event| match event {
        RunEvent::Reopen { .. } => show_main_window(app),
        RunEvent::Exit => {
            stop_backend(&backend);
        }
        _ => {}
    });
}
