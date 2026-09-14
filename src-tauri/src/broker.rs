use crate::macos::{self, HostError};
use crate::runtime::{toolkit_arch, NodeRuntime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

const PROTOCOL: &str = "typeless-toolkit-host/v1";

#[derive(Clone)]
pub struct BrokerContext {
    pub app: AppHandle,
    pub data_dir: PathBuf,
    pub edition: String,
    pub node: NodeRuntime,
}

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    protocol: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response<'a> {
    protocol: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    id: &'a Value,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostError>,
}

pub fn run(stdout: ChildStdout, stdin: ChildStdin, context: BrokerContext) {
    let writer = Arc::new(Mutex::new(stdin));
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(_) => {
                eprintln!("[manager stdout] {line}");
                continue;
            }
        };
        if request
            .protocol
            .as_deref()
            .is_some_and(|value| value != PROTOCOL)
            || request
                .kind
                .as_deref()
                .is_some_and(|value| value != "request")
        {
            continue;
        }
        let response = match dispatch(&context, &request.method, &request.params) {
            Ok(result) => Response {
                protocol: PROTOCOL,
                kind: "response",
                id: &request.id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Response {
                protocol: PROTOCOL,
                kind: "response",
                id: &request.id,
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        let Ok(serialized) = serde_json::to_string(&response) else {
            continue;
        };
        let Ok(mut input) = writer.lock() else { break };
        if writeln!(input, "{serialized}").is_err() || input.flush().is_err() {
            break;
        }
    }
}

fn dispatch(context: &BrokerContext, method: &str, params: &Value) -> Result<Value, HostError> {
    match method {
        "get_runtime_info" => Ok(json!({
            "desktop_host": "tauri",
            "edition": context.edition,
            "arch": toolkit_arch(),
            "node_path": context.node.path,
            "node_source": context.node.source,
            "node_version": context.node.version,
            "capabilities": { "mac_app_swap": true }
        })),
        "set_theme" => macos::set_theme(&context.app, params),
        "open_privacy_settings" => macos::open_privacy_settings(params),
        "reset_privacy_permissions" => macos::reset_privacy_permissions(params),
        "reconcile_toolkit_identity" => macos::reconcile_toolkit_identity(&context.data_dir),
        "swap_typeless_app" => macos::swap_typeless_app(params, &context.data_dir),
        "restore_typeless_backup" => macos::restore_typeless_backup(params, &context.data_dir),
        "open_toolkit_update_file" => {
            macos::open_toolkit_update_file(params, &context.edition, toolkit_arch())
        }
        _ => Err(HostError {
            code: "UNKNOWN_METHOD".to_string(),
            message: format!("未知的宿主方法: {method}"),
            phase: None,
        }),
    }
}
