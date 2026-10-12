use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use tauri::Manager;

use crate::attach::{apply_cursor_settings, real_cursor_settings_path};
use crate::hub::{find_bun, resolve_hub_root};

struct Hold {
    child: Child,
}

static LOOP: Mutex<Option<Hold>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopJoinView {
    pub webview_origin: String,
    pub token: String,
}

fn armada_home() -> PathBuf {
    if let Ok(h) = std::env::var("ARMADA_HUB_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".armada")
}

fn join_path() -> PathBuf {
    armada_home().join("desktop-join.json")
}

fn loopback_script(resource_dir: Option<&std::path::Path>) -> Result<PathBuf, String> {
    let hub = resolve_hub_root(resource_dir)?;
    let script = hub.join("../desktop-core/src/desktopLoopback.ts");
    if script.is_file() {
        return Ok(script);
    }
    Err("loopback-missing".into())
}

fn read_join() -> Option<Value> {
    let raw = fs::read_to_string(join_path()).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_join(value: &Value) -> Result<(), String> {
    let path = join_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true).mode(0o600);
        let mut file = opts.open(&path).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(unix))]
    fs::write(path, body).map_err(|e| e.to_string())
}

fn clear_matching_settings(host_port: &str) -> Result<(), String> {
    let path = real_cursor_settings_path();
    let raw = fs::read_to_string(&path).unwrap_or_default();
    let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(());
    };
    let Some(obj) = value.as_object_mut() else {
        return Ok(());
    };
    if obj.get("armada.hubUrl").and_then(|v| v.as_str()) != Some(host_port) {
        return Ok(());
    }
    obj.remove("armada.hubUrl");
    obj.remove("armada.token");
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(path, format!("{pretty}\n")).map_err(|e| e.to_string())
}

fn stop_child() {
    let Ok(mut slot) = LOOP.lock() else {
        return;
    };
    if let Some(mut hold) = slot.take() {
        let _ = hold.child.kill();
        let _ = hold.child.wait();
    }
}

pub fn stop_loopback_process() {
    stop_child();
}

fn spawn_loop(
    resource_dir: Option<&std::path::Path>,
    relay: &str,
    fleet: &str,
    desktop_token: &str,
    placeholder: &str,
    port: u16,
) -> Result<u16, String> {
    let bun = find_bun(resource_dir)?;
    let script = loopback_script(resource_dir)?;
    let mut cmd = Command::new(bun);
    cmd.arg(&script)
        .env("ARMADA_DESKTOP_RELAY", relay)
        .env("ARMADA_DESKTOP_FLEET", fleet)
        .env("ARMADA_DESKTOP_TOKEN", desktop_token)
        .env("ARMADA_DESKTOP_PLACEHOLDER", placeholder)
        .env("ARMADA_DESKTOP_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("spawn-failed:{e}"))?;
    let stdout = child.stdout.take().ok_or("spawn-failed:stdout")?;
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let parsed: Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if port != 0 { "port-busy".into() } else { "unauthorized".into() });
        }
    };
    if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error.to_string());
    }
    let bound = parsed.get("port").and_then(|v| v.as_u64()).ok_or("unauthorized")? as u16;
    let mut slot = LOOP.lock().map_err(|_| "spawn-failed:lock")?;
    *slot = Some(Hold { child });
    Ok(bound)
}

#[tauri::command]
pub fn start_desktop_join(
    app: tauri::AppHandle,
    relay: String,
    fleet: String,
    desktop_token: String,
    placeholder: String,
    port: u16,
) -> Result<DesktopJoinView, String> {
    stop_child();
    let resource = app.path().resource_dir().ok();
    let bound = spawn_loop(resource.as_deref(), &relay, &fleet, &desktop_token, &placeholder, port)?;
    let host_port = format!("127.0.0.1:{bound}");
    write_join(&serde_json::json!({
        "relay": relay,
        "fleet": fleet,
        "desktopToken": desktop_token,
        "placeholder": placeholder,
        "port": bound,
    }))?;
    apply_cursor_settings(&real_cursor_settings_path(), &host_port, &placeholder, true)?;
    Ok(DesktopJoinView { webview_origin: host_port, token: placeholder })
}

#[tauri::command]
pub fn restore_desktop_join(app: tauri::AppHandle) -> Result<Option<DesktopJoinView>, String> {
    let Some(saved) = read_join() else {
        return Ok(None);
    };
    let relay = saved.get("relay").and_then(|v| v.as_str()).unwrap_or("");
    let fleet = saved.get("fleet").and_then(|v| v.as_str()).unwrap_or("");
    let desktop_token = saved.get("desktopToken").and_then(|v| v.as_str()).unwrap_or("");
    let placeholder = saved.get("placeholder").and_then(|v| v.as_str()).unwrap_or("");
    let port = saved.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
    if relay.is_empty() || fleet.is_empty() || desktop_token.is_empty() || placeholder.is_empty() || port == 0 {
        return Ok(None);
    }
    stop_child();
    let resource = app.path().resource_dir().ok();
    let bound = spawn_loop(resource.as_deref(), relay, fleet, desktop_token, placeholder, port)?;
    if bound != port {
        stop_child();
        return Err("port-busy".into());
    }
    Ok(Some(DesktopJoinView {
        webview_origin: format!("127.0.0.1:{bound}"),
        token: placeholder.to_string(),
    }))
}

#[tauri::command]
pub fn stop_desktop_join() -> Result<(), String> {
    let saved = read_join();
    stop_child();
    if let Some(saved) = saved {
        if let Some(port) = saved.get("port").and_then(|v| v.as_u64()) {
            clear_matching_settings(&format!("127.0.0.1:{port}"))?;
        }
    }
    let _ = fs::remove_file(join_path());
    Ok(())
}
