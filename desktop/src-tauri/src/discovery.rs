use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use std::thread;
use tauri::{AppHandle, Emitter};

use crate::hub::HubState;

pub const SERVICE_TYPE: &str = "_armada._tcp.local.";
pub const TXT_VER: &str = "1";

#[derive(Default)]
pub struct DiscoveryState {
    daemon: Option<ServiceDaemon>,
    advertised_fullname: Option<String>,
    browsing: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetFound {
    pub id: String,
    pub name: String,
    pub ipv4: String,
    pub port: u16,
    pub join_uri: String,
}

#[derive(Clone, Serialize)]
pub struct FleetLost {
    pub id: String,
}

pub fn txt_pairs<'a>(ip: &'a str, token: &'a str) -> [(&'a str, &'a str); 3] {
    [("ip", ip), ("token", token), ("ver", TXT_VER)]
}

pub fn should_hide_own(advertised_ip: &str, local_ips: &[String]) -> bool {
    local_ips.iter().any(|ip| ip == advertised_ip)
}

pub fn sanitize_instance(raw: &str) -> String {
    let s: String = raw.chars().filter(|c| !c.is_control()).collect();
    let t = s.trim();
    if t.is_empty() {
        "Armada".into()
    } else {
        t.into()
    }
}

pub fn fleet_from_txt(
    id: &str,
    name: &str,
    port: u16,
    txt: &HashMap<String, String>,
    local_ips: &[String],
) -> Option<FleetFound> {
    let ipv4 = txt.get("ip")?.trim();
    let token = txt.get("token")?.trim();
    let ver = txt.get("ver")?.trim();
    if ver != TXT_VER || ipv4.is_empty() || token.is_empty() {
        return None;
    }
    if !ipv4.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    if should_hide_own(ipv4, local_ips) {
        return None;
    }
    let port = if port == 0 { 7380 } else { port };
    Some(FleetFound {
        id: id.to_string(),
        name: name.to_string(),
        ipv4: ipv4.to_string(),
        port,
        join_uri: format!("armada://join?hub={ipv4}:{port}&token={token}"),
    })
}

fn computer_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("scutil").args(["--get", "ComputerName"]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if !s.trim().is_empty() {
                    return sanitize_instance(&s);
                }
            }
        }
    }
    if let Ok(out) = Command::new("hostname").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if !s.trim().is_empty() {
                return sanitize_instance(&s);
            }
        }
    }
    "Armada".into()
}

fn daemon_of(state: &HubState) -> Result<ServiceDaemon, String> {
    let mut g = state.discovery.lock().map_err(|_| "lock".to_string())?;
    if let Some(d) = &g.daemon {
        return Ok(d.clone());
    }
    let d = ServiceDaemon::new().map_err(|_| "advertise-failed".to_string())?;
    g.daemon = Some(d.clone());
    Ok(d)
}

pub fn start_advertise(state: &HubState, ipv4: &str, token: &str) -> Result<(), String> {
    stop_advertise(state);
    let mdns = daemon_of(state)?;
    let instance = computer_name();
    let host = format!("{ipv4}.local.");
    let pairs = txt_pairs(ipv4, token);
    let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, ipv4, 7380, &pairs[..])
        .map_err(|_| "advertise-failed".to_string())?;
    let fullname = info.get_fullname().to_string();
    mdns.register(info).map_err(|_| "advertise-failed".to_string())?;
    let mut g = state.discovery.lock().map_err(|_| "lock".to_string())?;
    g.advertised_fullname = Some(fullname);
    Ok(())
}

pub fn stop_advertise(state: &HubState) {
    let (daemon, fullname) = match state.discovery.lock() {
        Ok(mut g) => (g.daemon.clone(), g.advertised_fullname.take()),
        Err(_) => return,
    };
    if let (Some(d), Some(name)) = (daemon, fullname) {
        let _ = d.unregister(&name);
    }
}

pub fn start_browse(app: AppHandle, state: &HubState, local_ips: Vec<String>) -> Result<(), String> {
    {
        let mut g = state.discovery.lock().map_err(|_| "lock".to_string())?;
        if g.browsing {
            return Ok(());
        }
        g.browsing = true;
    }
    let mdns = match daemon_of(state) {
        Ok(d) => d,
        Err(e) => {
            if let Ok(mut g) = state.discovery.lock() {
                g.browsing = false;
            }
            return Err(e);
        }
    };
    let receiver = match mdns.browse(SERVICE_TYPE) {
        Ok(r) => r,
        Err(_) => {
            if let Ok(mut g) = state.discovery.lock() {
                g.browsing = false;
            }
            return Err("advertise-failed".to_string());
        }
    };
    thread::Builder::new()
        .name("armada-mdns-browse".into())
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let id = info.get_fullname().to_string();
                        let name = instance_from_fullname(&id);
                        let mut txt = HashMap::new();
                        for p in info.get_properties().iter() {
                            txt.insert(p.key().to_string(), p.val_str().to_string());
                        }
                        if let Some(found) = fleet_from_txt(&id, &name, info.get_port(), &txt, &local_ips) {
                            let _ = app.emit("fleet-found", found);
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        let _ = app.emit("fleet-lost", FleetLost { id: fullname });
                    }
                    _ => {}
                }
            }
        })
        .map_err(|_| "advertise-failed".to_string())?;
    Ok(())
}

pub fn stop_browse(state: &HubState) {
    let daemon = match state.discovery.lock() {
        Ok(mut g) => {
            if !g.browsing {
                return;
            }
            g.browsing = false;
            g.daemon.clone()
        }
        Err(_) => return,
    };
    if let Some(d) = daemon {
        let _ = d.stop_browse(SERVICE_TYPE);
    }
}

pub fn shutdown(state: &HubState) {
    stop_advertise(state);
    stop_browse(state);
    if let Ok(mut g) = state.discovery.lock() {
        if let Some(d) = g.daemon.take() {
            let _ = d.shutdown();
        }
        g.browsing = false;
        g.advertised_fullname = None;
    }
}

fn instance_from_fullname(fullname: &str) -> String {
    match fullname.split_once('.') {
        Some((name, _)) if !name.is_empty() => name.to_string(),
        _ => "Armada".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_pairs_match_contract() {
        let p = txt_pairs("192.168.1.23", "tok");
        assert_eq!(p, [("ip", "192.168.1.23"), ("token", "tok"), ("ver", "1")]);
        assert_eq!(SERVICE_TYPE, "_armada._tcp.local.");
    }

    #[test]
    fn hide_own_and_parse_txt() {
        let local = vec!["192.168.1.23".into()];
        assert!(should_hide_own("192.168.1.23", &local));
        assert!(!should_hide_own("10.0.0.2", &local));

        let mut txt = HashMap::new();
        txt.insert("ip".into(), "10.0.0.2".into());
        txt.insert("token".into(), "ab".repeat(32));
        txt.insert("ver".into(), "1".into());
        let found = fleet_from_txt("N._armada._tcp.local.", "N", 0, &txt, &local).unwrap();
        assert_eq!(found.ipv4, "10.0.0.2");
        assert_eq!(found.port, 7380);
        assert_eq!(found.join_uri, format!("armada://join?hub=10.0.0.2:7380&token={}", "ab".repeat(32)));
        assert_eq!(found.name, "N");

        assert!(fleet_from_txt("N._armada._tcp.local.", "N", 7380, &txt, &["10.0.0.2".into()]).is_none());
        txt.insert("ver".into(), "2".into());
        assert!(fleet_from_txt("N._armada._tcp.local.", "N", 7380, &txt, &local).is_none());
    }

    #[test]
    fn sanitize_drops_controls_and_empty() {
        assert_eq!(sanitize_instance(" \n "), "Armada");
        assert_eq!(sanitize_instance("Studio\u{7} Mac"), "Studio Mac");
        assert_eq!(instance_from_fullname("Studio._armada._tcp.local."), "Studio");
    }
}
