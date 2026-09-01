use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::{env, thread};

const HUB_PORT: u16 = 7380;
const JOIN_MUST_NOT_SPAWN: &str = "join-must-not-spawn";
const DENY_IFACE: &[&str] = &[
    "utun", "tun", "ppp", "docker", "veth", "br", "bridge", "vmnet", "vnic", "tailscale", "wg",
];

#[derive(Default)]
pub struct HubState {
    owned: Mutex<Option<Child>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OccupancyAction {
    ReuseOwned,
    Spawn,
    Attach,
    BlockForeign,
    BlockBusy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyKind {
    ReuseOwned,
    Spawn,
    Attach,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Auth {
    Ok,
    Unauthorized,
    Skipped,
}

pub(crate) struct Probe {
    pub health_name: Option<String>,
    pub auth: Auth,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareCandidate {
    pub ipv4: String,
    pub name: String,
    pub maybe_unreachable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFleetResult {
    pub decision: &'static str,
    pub token: String,
    pub share_candidates: Vec<ShareCandidate>,
    pub owned_hub_pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinFleetResult {
    pub webview_origin: String,
    pub token: String,
    pub cursor_hub_url: String,
    pub join_self: bool,
}

pub fn decide_occupancy(
    owned_pid_alive: bool,
    port_open: bool,
    health_name: Option<&str>,
    machines_status: Auth,
) -> OccupancyAction {
    if owned_pid_alive {
        return OccupancyAction::ReuseOwned;
    }
    if !port_open {
        return OccupancyAction::Spawn;
    }
    if health_name == Some("armada-hub") && machines_status == Auth::Ok {
        return OccupancyAction::Attach;
    }
    if health_name == Some("armada-hub") && machines_status == Auth::Unauthorized {
        return OccupancyAction::BlockForeign;
    }
    OccupancyAction::BlockBusy
}

pub fn apply_decision(allow_spawn: bool, action: OccupancyAction) -> Result<ApplyKind, &'static str> {
    match action {
        OccupancyAction::Spawn if !allow_spawn => Err(JOIN_MUST_NOT_SPAWN),
        OccupancyAction::Spawn => Ok(ApplyKind::Spawn),
        OccupancyAction::Attach => Ok(ApplyKind::Attach),
        OccupancyAction::ReuseOwned => Ok(ApplyKind::ReuseOwned),
        OccupancyAction::BlockForeign => Err("foreign-armada"),
        OccupancyAction::BlockBusy => Err("port-busy"),
    }
}

pub fn parse_join_uri(raw: &str) -> Result<(String, u16, String), &'static str> {
    let trimmed = raw.trim();
    let after = trimmed.strip_prefix("armada:").ok_or("invalid")?;
    let after = after.trim_start_matches('/');
    let (path, query) = after.split_once('?').ok_or("incomplete")?;
    let path = path.trim_end_matches('/');
    if path != "join" {
        return Err("invalid");
    }
    let mut hub_raw: Option<&str> = None;
    let mut token: Option<&str> = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "hub" => hub_raw = Some(v),
            "token" => token = Some(v),
            _ => {}
        }
    }
    let hub_raw = hub_raw.filter(|s| !s.is_empty()).ok_or("incomplete")?;
    let token = token.map(str::trim).filter(|s| !s.is_empty()).ok_or("incomplete")?;
    let (host, port) = strip_hub(hub_raw);
    if host.is_empty() {
        return Err("incomplete");
    }
    Ok((host, port, token.to_string()))
}

fn strip_scheme(raw: &str) -> &str {
    let lower = raw.as_bytes();
    for prefix in ["http://", "https://", "HTTP://", "HTTPS://"] {
        if raw.len() >= prefix.len() && lower[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes()) {
            return &raw[prefix.len()..];
        }
    }
    raw
}

fn strip_hub(raw: &str) -> (String, u16) {
    let s = strip_scheme(raw.trim()).trim_end_matches('/');
    if let Some((h, p)) = s.rsplit_once(':') {
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            return (h.to_string(), p.parse().unwrap_or(HUB_PORT));
        }
    }
    (s.to_string(), HUB_PORT)
}

pub fn resolve_hub_targets(
    role_join: bool,
    parsed_host: &str,
    parsed_port: u16,
    local_share_ips: &[String],
) -> (String, String, bool) {
    let join_self = role_join && parsed_port == HUB_PORT && local_share_ips.iter().any(|ip| ip == parsed_host);
    if !role_join || join_self {
        return (
            "127.0.0.1:7380".into(),
            "127.0.0.1:7380".into(),
            join_self,
        );
    }
    let hub = format!("{parsed_host}:{parsed_port}");
    (hub.clone(), hub, false)
}

pub fn is_rfc1918(ip: &str) -> bool {
    let mut parts = ip.split('.');
    let a: u8 = match parts.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    let b: u8 = match parts.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    let c: u8 = match parts.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    let d: u8 = match parts.next().and_then(|s| s.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    if parts.next().is_some() {
        return false;
    }
    let _ = (c, d);
    a == 10 || (a == 192 && b == 168) || (a == 172 && (16..=31).contains(&b))
}

pub fn is_denied_iface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    DENY_IFACE.iter().any(|p| n == *p || n.starts_with(p))
}

pub fn pick_share_candidates(ifaces: &[(String, String)]) -> Vec<ShareCandidate> {
    let mut out: Vec<ShareCandidate> = Vec::new();
    for (name, ipv4) in ifaces {
        if is_denied_iface(name) {
            continue;
        }
        if ipv4.starts_with("127.") || ipv4.starts_with("169.254.") {
            continue;
        }
        if !is_rfc1918(ipv4) {
            continue;
        }
        let low = name.to_ascii_lowercase();
        let maybe_unreachable = !(low.starts_with("en") || low.starts_with("eth"));
        out.push(ShareCandidate {
            ipv4: ipv4.clone(),
            name: name.clone(),
            maybe_unreachable,
        });
    }
    out.sort_by(|a, b| {
        a.maybe_unreachable
            .cmp(&b.maybe_unreachable)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

pub fn parse_ifconfig(text: &str) -> Vec<(String, String)> {
    let mut cur = String::new();
    let mut out = Vec::new();
    for line in text.lines() {
        if !(line.starts_with('\t') || line.starts_with(' ')) {
            if let Some(name) = line.split(':').next() {
                cur = name.to_string();
            }
            continue;
        }
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("inet ") {
            if let Some(ip) = rest.split_whitespace().next() {
                if !cur.is_empty() {
                    out.push((cur.clone(), ip.to_string()));
                }
            }
        }
    }
    out
}

fn list_ifaces() -> Vec<(String, String)> {
    let out = Command::new("ifconfig").output().ok();
    match out {
        Some(o) if o.status.success() => parse_ifconfig(&String::from_utf8_lossy(&o.stdout)),
        _ => Vec::new(),
    }
}

pub fn tcp_open(host: &str, port: u16, timeout: Duration) -> bool {
    let addr = format!("{host}:{port}");
    let Ok(mut addrs) = addr.to_socket_addrs() else {
        return false;
    };
    let Some(sa) = addrs.next() else {
        return false;
    };
    TcpStream::connect_timeout(&sa, timeout).is_ok()
}

fn http_get(host: &str, port: u16, path: &str, bearer: Option<&str>, timeout: Duration) -> Result<(u16, String), String> {
    let addr = format!("{host}:{port}");
    let sa: SocketAddr = addr
        .to_socket_addrs()
        .map_err(|e| e.to_string())?
        .next()
        .ok_or_else(|| "unreachable".to_string())?;
    let mut stream = TcpStream::connect_timeout(&sa, timeout).map_err(|_| "unreachable".to_string())?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n");
    if let Some(_token) = bearer {
        req.push_str("Authorization: Bearer ");
        req.push_str(_token);
        req.push_str("\r\n");
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).map_err(|_| "unreachable".to_string())?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).map_err(|_| "unreachable".to_string())?;
    let text = String::from_utf8_lossy(&buf);
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_ref(), ""));
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    Ok((status, body.to_string()))
}

pub(crate) fn may_write_cursor_settings(p: &Probe) -> bool {
    p.health_name.as_deref() == Some("armada-hub") && p.auth == Auth::Ok
}

pub(crate) fn probe_hub(host: &str, port: u16, token: &str) -> Probe {
    let timeout = Duration::from_secs(1);
    let Ok((status, body)) = http_get(host, port, "/api/health", None, timeout) else {
        return Probe {
            health_name: None,
            auth: Auth::Skipped,
        };
    };
    if status != 200 {
        return Probe {
            health_name: None,
            auth: Auth::Skipped,
        };
    }
    let name = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("name")?.as_str().map(|s| s.to_string()));
    if name.as_deref() != Some("armada-hub") {
        return Probe {
            health_name: name,
            auth: Auth::Skipped,
        };
    }
    match http_get(host, port, "/api/machines", Some(token), timeout) {
        Ok((401, _)) => Probe {
            health_name: name,
            auth: Auth::Unauthorized,
        },
        Ok((s, _)) if (200..300).contains(&s) => Probe {
            health_name: name,
            auth: Auth::Ok,
        },
        _ => Probe {
            health_name: name,
            auth: Auth::Skipped,
        },
    }
}

fn armada_home() -> PathBuf {
    if let Ok(h) = env::var("ARMADA_HUB_HOME") {
        return PathBuf::from(h);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".armada")
}

fn load_token_from_home() -> Option<String> {
    let p = armada_home().join("token");
    fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn resolve_hub_root(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = env::var("ARMADA_DESKTOP_HUB_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("src/index.ts").is_file() {
            return Ok(pb);
        }
        return Err("hub-root-missing".into());
    }
    if let Some(dir) = resource_dir {
        let p = dir.join("hub");
        if p.join("src/index.ts").is_file() {
            return Ok(p);
        }
    }
    #[cfg(debug_assertions)]
    {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hub");
        if p.join("src/index.ts").is_file() {
            return Ok(p);
        }
    }
    Err("hub-root-missing".into())
}

fn find_bun(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = env::var("ARMADA_DESKTOP_BUN") {
        return Ok(PathBuf::from(p));
    }
    if let Some(dir) = resource_dir {
        let recorded = dir.join("bun.path");
        if let Ok(s) = fs::read_to_string(&recorded) {
            let p = PathBuf::from(s.trim());
            if p.is_file() {
                return Ok(p);
            }
        }
        let sibling = dir.join("bun");
        if sibling.is_file() {
            return Ok(sibling);
        }
    }
    let out = Command::new("which")
        .arg("bun")
        .output()
        .map_err(|_| "bun-missing".to_string())?;
    if !out.status.success() {
        return Err("bun-missing".into());
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        return Err("bun-missing".into());
    }
    Ok(PathBuf::from(p))
}

fn spawn_hub(resource_dir: Option<&Path>) -> Result<Child, String> {
    let hub_root = resolve_hub_root(resource_dir)?;
    let bun = find_bun(resource_dir)?;
    let entry = hub_root.join("src/index.ts");
    let mut cmd = Command::new(bun);
    cmd.arg(entry)
        .arg("--lan")
        .current_dir(&hub_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map_err(|e| format!("spawn-failed:{e}"))
}

#[allow(dead_code)]
pub fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn signal(pid: u32, sig: &str) {
    let pid_s = pid.to_string();
    let _ = Command::new("kill").args([sig, &pid_s]).status();
    let _ = Command::new("kill").args([sig, &format!("-{pid}")]).status();
}

#[allow(dead_code)]
pub fn quit_pid(pid: Option<u32>) -> Result<(), String> {
    let Some(pid) = pid else {
        return Ok(());
    };
    signal(pid, "-TERM");
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    signal(pid, "-KILL");
    Ok(())
}

fn quit_child(child: &mut Option<Child>) {
    let Some(ch) = child.as_mut() else {
        return;
    };
    let pid = ch.id();
    signal(pid, "-TERM");
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        match ch.try_wait() {
            Ok(Some(_)) => {
                *child = None;
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    signal(pid, "-KILL");
    let _ = ch.wait();
    *child = None;
}

fn owned_alive(owned: &mut Option<Child>) -> bool {
    match owned {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => {
                *owned = None;
                false
            }
            Err(_) => false,
        },
        None => false,
    }
}

fn wait_probe_auth_ok(timeout: Duration) -> Option<String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(token) = load_token_from_home() {
            let p = probe_hub("127.0.0.1", HUB_PORT, &token);
            if p.auth == Auth::Ok {
                return Some(token);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

fn decision_label(kind: ApplyKind) -> &'static str {
    match kind {
        ApplyKind::ReuseOwned => "reuse-owned",
        ApplyKind::Spawn => "spawn",
        ApplyKind::Attach => "attach",
    }
}

fn resource_dir_from(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().resource_dir().ok()
}

fn finish_create(
    resource: Option<&std::path::Path>,
    token: String,
    kind: ApplyKind,
    pid: Option<u32>,
) -> CreateFleetResult {
    let existing = crate::attach::read_existing_hub_url();
    let overwrite = existing.as_deref() != Some("127.0.0.1:7380");
    let _ = crate::attach::run_local_attach(resource, "127.0.0.1:7380", &token, overwrite, None);
    CreateFleetResult {
        decision: decision_label(kind),
        token,
        share_candidates: pick_share_candidates(&list_ifaces()),
        owned_hub_pid: pid,
    }
}

#[tauri::command]
pub fn create_fleet(app: tauri::AppHandle, state: tauri::State<'_, HubState>) -> Result<CreateFleetResult, String> {
    let resource = resource_dir_from(&app);
    let mut owned = state.owned.lock().map_err(|_| "lock".to_string())?;
    let alive = owned_alive(&mut owned);
    let port_open = tcp_open("127.0.0.1", HUB_PORT, Duration::from_millis(300));
    let token_now = load_token_from_home();
    let probe = match (port_open, token_now.as_deref()) {
        (true, Some(t)) => probe_hub("127.0.0.1", HUB_PORT, t),
        _ => Probe {
            health_name: None,
            auth: Auth::Skipped,
        },
    };
    let action = decide_occupancy(alive, port_open, probe.health_name.as_deref(), probe.auth);
    let kind = apply_decision(true, action)?;
    match kind {
        ApplyKind::Spawn => {
            let child = spawn_hub(resource.as_deref())?;
            *owned = Some(child);
            let token = wait_probe_auth_ok(Duration::from_secs(5)).ok_or_else(|| {
                quit_child(&mut owned);
                "spawn-timeout".to_string()
            })?;
            let pid = owned.as_ref().map(|c| c.id());
            Ok(finish_create(resource.as_deref(), token, kind, pid))
        }
        ApplyKind::Attach => {
            *owned = None;
            let token = load_token_from_home().ok_or_else(|| "token-missing".to_string())?;
            Ok(finish_create(resource.as_deref(), token, kind, None))
        }
        ApplyKind::ReuseOwned => {
            let token = load_token_from_home().ok_or_else(|| "token-missing".to_string())?;
            let pid = owned.as_ref().map(|c| c.id());
            Ok(finish_create(resource.as_deref(), token, kind, pid))
        }
    }
}

#[tauri::command]
pub fn join_fleet(app: tauri::AppHandle, uri: String, _state: tauri::State<'_, HubState>) -> Result<JoinFleetResult, String> {
    let (host, port, token) = parse_join_uri(&uri).map_err(|e| e.to_string())?;
    let shares = pick_share_candidates(&list_ifaces());
    let local_ips: Vec<String> = shares.iter().map(|s| s.ipv4.clone()).collect();
    let (cursor_hub_url, webview_origin, join_self) = resolve_hub_targets(true, &host, port, &local_ips);
    let (probe_host, probe_port) = if join_self {
        ("127.0.0.1", HUB_PORT)
    } else {
        (host.as_str(), port)
    };
    if !tcp_open(probe_host, probe_port, Duration::from_millis(400)) {
        return Err("unreachable".into());
    }
    let probe = probe_hub(probe_host, probe_port, &token);
    let action = decide_occupancy(false, true, probe.health_name.as_deref(), probe.auth);
    match apply_decision(false, action)? {
        ApplyKind::Attach | ApplyKind::ReuseOwned => {
            let existing = crate::attach::read_existing_hub_url();
            let overwrite = if join_self {
                existing.as_deref() != Some("127.0.0.1:7380")
            } else {
                true
            };
            let resource = resource_dir_from(&app);
            let _ = crate::attach::run_local_attach(
                resource.as_deref(),
                &cursor_hub_url,
                &token,
                overwrite,
                None,
            );
            Ok(JoinFleetResult {
                webview_origin,
                token,
                cursor_hub_url,
                join_self,
            })
        }
        ApplyKind::Spawn => Err(JOIN_MUST_NOT_SPAWN.into()),
    }
}

#[tauri::command]
pub fn quit_owned_hub(state: tauri::State<'_, HubState>) -> Result<(), String> {
    quit_owned_inner(&state);
    Ok(())
}

pub fn quit_owned_inner(state: &HubState) {
    if let Ok(mut owned) = state.owned.lock() {
        quit_child(&mut owned);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn occupancy_matches_desktop_core() {
        assert_eq!(
            decide_occupancy(true, true, Some("armada-hub"), Auth::Ok),
            OccupancyAction::ReuseOwned
        );
        assert_eq!(
            decide_occupancy(false, false, None, Auth::Skipped),
            OccupancyAction::Spawn
        );
        assert_eq!(
            decide_occupancy(false, true, Some("armada-hub"), Auth::Ok),
            OccupancyAction::Attach
        );
        assert_eq!(
            decide_occupancy(false, true, Some("armada-hub"), Auth::Unauthorized),
            OccupancyAction::BlockForeign
        );
        assert_eq!(
            decide_occupancy(false, true, Some("nginx"), Auth::Skipped),
            OccupancyAction::BlockBusy
        );
        assert_eq!(
            decide_occupancy(false, true, None, Auth::Skipped),
            OccupancyAction::BlockBusy
        );
    }

    #[test]
    fn join_must_not_spawn() {
        assert_eq!(apply_decision(false, OccupancyAction::Spawn), Err(JOIN_MUST_NOT_SPAWN));
        assert_eq!(apply_decision(true, OccupancyAction::Spawn), Ok(ApplyKind::Spawn));
        assert_eq!(apply_decision(false, OccupancyAction::Attach), Ok(ApplyKind::Attach));
    }

    #[test]
    fn quit_none_is_noop() {
        assert!(quit_pid(None).is_ok());
    }

    #[test]
    fn quit_terms_owned_pid() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        quit_pid(Some(pid)).unwrap();
        let status = child.wait().unwrap();
        assert!(!status.success() || !pid_alive(pid));
        assert!(!pid_alive(pid));
    }

    #[test]
    fn pick_share_drops_docker() {
        let rows = pick_share_candidates(&[
            ("docker0".into(), "172.17.0.1".into()),
            ("en0".into(), "192.168.1.23".into()),
            ("utun4".into(), "10.8.0.2".into()),
        ]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ipv4, "192.168.1.23");
        assert!(!rows[0].maybe_unreachable);
    }

    #[test]
    fn parse_join_uri_ok() {
        let token = "a".repeat(64);
        let s = format!("armada://join?hub=192.168.1.23:7380&token={token}");
        let (host, port, t) = parse_join_uri(&s).unwrap();
        assert_eq!(host, "192.168.1.23");
        assert_eq!(port, 7380);
        assert_eq!(t, token);
    }

    #[test]
    fn join_self_loopback() {
        let ips = vec!["192.168.1.23".into()];
        let (cursor, origin, join_self) = resolve_hub_targets(true, "192.168.1.23", 7380, &ips);
        assert!(join_self);
        assert_eq!(cursor, "127.0.0.1:7380");
        assert_eq!(origin, "127.0.0.1:7380");
    }

    #[test]
    fn may_write_requires_health_and_bearer() {
        assert!(!may_write_cursor_settings(&Probe {
            health_name: None,
            auth: Auth::Skipped,
        }));
        assert!(!may_write_cursor_settings(&Probe {
            health_name: Some("armada-hub".into()),
            auth: Auth::Unauthorized,
        }));
        assert!(may_write_cursor_settings(&Probe {
            health_name: Some("armada-hub".into()),
            auth: Auth::Ok,
        }));
    }
}
