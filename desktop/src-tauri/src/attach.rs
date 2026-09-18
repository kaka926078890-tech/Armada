use crate::hub;
use serde::Serialize;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const HUB_PORT: u16 = 7380;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAttachResult {
    pub vsix: &'static str,
    pub hooks: &'static str,
    pub settings: &'static str,
    pub hub_url_written: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vsix_path: Option<String>,
}

pub fn hub_url_to_write<'a>(overwrite: bool, existing_hub: Option<&'a str>, hub_url: &'a str) -> &'a str {
    if overwrite {
        hub_url
    } else {
        existing_hub.unwrap_or(hub_url)
    }
}

pub fn should_write_cursor_settings(
    overwrite: bool,
    existing_hub: Option<&str>,
    existing_token: Option<&str>,
    hub_url: &str,
    token: &str,
) -> bool {
    let hub_to_write = hub_url_to_write(overwrite, existing_hub, hub_url);
    existing_hub != Some(hub_to_write) || existing_token != Some(token)
}

pub fn cursor_user_settings_path_for(os: &str, home: &Path, appdata: Option<&Path>) -> PathBuf {
    if os == "windows" {
        let base = appdata.unwrap_or(home);
        return base.join("Cursor").join("User").join("settings.json");
    }
    home.join("Library")
        .join("Application Support")
        .join("Cursor")
        .join("User")
        .join("settings.json")
}

pub(crate) fn real_cursor_settings_path() -> PathBuf {
    #[cfg(windows)]
    {
        let appdata = env::var_os("APPDATA").map(PathBuf::from);
        let home = PathBuf::from(env::var("USERPROFILE").unwrap_or_else(|_| ".".into()));
        return cursor_user_settings_path_for("windows", &home, appdata.as_deref());
    }
    let home = PathBuf::from(env::var("HOME").unwrap_or_else(|_| ".".into()));
    cursor_user_settings_path_for("macos", &home, None)
}

pub fn merge_armada_settings(raw: &str, hub_url: &str, token: &str) -> Result<(String, bool), String> {
    let mut obj: serde_json::Map<String, serde_json::Value> = if raw.trim().is_empty() {
        serde_json::Map::new()
    } else {
        match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => return Err("settings-invalid".into()),
        }
    };
    let changed = obj.get("armada.hubUrl").and_then(|v| v.as_str()) != Some(hub_url)
        || obj.get("armada.token").and_then(|v| v.as_str()) != Some(token);
    obj.insert(
        "armada.hubUrl".into(),
        serde_json::Value::String(hub_url.to_string()),
    );
    obj.insert(
        "armada.token".into(),
        serde_json::Value::String(token.to_string()),
    );
    let pretty = serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())?;
    Ok((format!("{pretty}\n"), changed))
}

fn existing_keys(raw: &str) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return (None, None);
    };
    (
        v.get("armada.hubUrl").and_then(|x| x.as_str()).map(str::to_string),
        v.get("armada.token").and_then(|x| x.as_str()).map(str::to_string),
    )
}

pub fn apply_cursor_settings(
    settings_path: &Path,
    hub_url: &str,
    token: &str,
    overwrite: bool,
) -> Result<&'static str, String> {
    let raw = fs::read_to_string(settings_path).unwrap_or_default();
    let (existing_hub, existing_token) = existing_keys(&raw);
    if !should_write_cursor_settings(
        overwrite,
        existing_hub.as_deref(),
        existing_token.as_deref(),
        hub_url,
        token,
    ) {
        return Ok("ok");
    }
    let hub_to_write = hub_url_to_write(overwrite, existing_hub.as_deref(), hub_url);
    let (json, _) = merge_armada_settings(&raw, hub_to_write, token)?;
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if settings_path.is_file() {
        let bak = settings_path
            .parent()
            .unwrap_or(settings_path)
            .join("settings.json.bak.armada");
        fs::copy(settings_path, bak).map_err(|e| e.to_string())?;
    }
    fs::write(settings_path, json).map_err(|e| e.to_string())?;
    Ok("ok")
}

pub fn classify_vsix_cli(success: bool, stdout: &str, stderr: &str) -> &'static str {
    let blob = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if success && (blob.contains("already installed") || blob.contains("skipped")) {
        return "skipped-same-version";
    }
    if success {
        "ok"
    } else {
        "manual-path-shown"
    }
}

pub fn vsix_semver(path: &Path) -> Option<(u64, u64, u64)> {
    let stem = path.file_stem()?.to_str()?;
    let ver = stem.rsplit_once('-')?.1;
    let mut parts = ver.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn vsix_rank(path: &Path) -> (u8, u64, u64, u64) {
    match vsix_semver(path) {
        Some((major, minor, patch)) => (1, major, minor, patch),
        None => (0, 0, 0, 0),
    }
}

pub fn find_latest_vsix(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut best: Option<((u8, u64, u64, u64), PathBuf)> = None;
    for root in roots {
        let Ok(rd) = fs::read_dir(root) else {
            continue;
        };
        for ent in rd.filter_map(|e| e.ok()) {
            let path = ent.path();
            if path.extension().and_then(|x| x.to_str()) != Some("vsix") {
                continue;
            }
            let rank = vsix_rank(&path);
            match &best {
                None => best = Some((rank, path)),
                Some((prev, _)) if rank > *prev => best = Some((rank, path)),
                _ => {}
            }
        }
    }
    best.map(|(_, path)| path)
}

pub fn find_vsix(roots: &[PathBuf]) -> Option<PathBuf> {
    if let Ok(p) = env::var("ARMADA_VSIX") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    find_latest_vsix(roots)
}

pub fn vsix_install_cli_args(vsix: &Path, force: bool) -> Vec<String> {
    let mut args = vec![
        "--install-extension".into(),
        vsix.to_string_lossy().into_owned(),
    ];
    if force {
        args.push("--force".into());
    }
    args
}

pub fn installed_armada_agent_semver(extensions_dir: &Path) -> Option<(u64, u64, u64)> {
    let rd = fs::read_dir(extensions_dir).ok()?;
    let mut best: Option<(u64, u64, u64)> = None;
    for ent in rd.filter_map(|e| e.ok()) {
        let name = ent.file_name();
        let Some(s) = name.to_str() else { continue };
        let Some(rest) = s.strip_prefix("armada.armada-agent-") else { continue };
        let mut parts = rest.split('.');
        let Some(major) = parts.next()?.parse().ok() else { continue };
        let Some(minor) = parts.next()?.parse().ok() else { continue };
        let Some(patch) = parts.next()?.parse().ok() else { continue };
        if parts.next().is_some() {
            continue;
        }
        let ver = (major, minor, patch);
        best = Some(match best {
            None => ver,
            Some(prev) if ver > prev => ver,
            Some(prev) => prev,
        });
    }
    best
}

pub fn vsix_needs_install(
    bundled: (u64, u64, u64),
    installed: Option<(u64, u64, u64)>,
) -> bool {
    match installed {
        None => true,
        Some(v) => v < bundled,
    }
}

pub fn vsix_install_via_unpack(os: &str) -> bool {
    os == "windows"
}

pub fn armada_agent_extension_dir(extensions_dir: &Path, ver: (u64, u64, u64)) -> PathBuf {
    extensions_dir.join(format!(
        "armada.armada-agent-{}.{}.{}",
        ver.0, ver.1, ver.2
    ))
}

pub fn cursor_extension_file_url(fs_path: &str) -> String {
    let n = fs_path.replace('\\', "/");
    if n.len() >= 2 && n.as_bytes()[1] == b':' {
        let drive = n.as_bytes()[0].to_ascii_lowercase() as char;
        return format!("file:///{drive}%3A{}", &n[2..]);
    }
    if n.starts_with('/') {
        format!("file://{n}")
    } else {
        format!("file:///{n}")
    }
}

pub fn upsert_armada_agent_extension_json(
    raw: &str,
    version: &str,
    relative_location: &str,
    fs_path: &str,
    now_ms: u64,
) -> Result<String, String> {
    let mut arr = if raw.trim().is_empty() {
        Vec::new()
    } else {
        match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Array(a)) => a,
            _ => return Err("extensions-json-invalid".into()),
        }
    };
    let posix = {
        let n = fs_path.replace('\\', "/");
        if n.len() >= 2 && n.as_bytes()[1] == b':' {
            format!("/{}{}", n.chars().next().unwrap().to_ascii_lowercase(), &n[1..])
        } else {
            n
        }
    };
    let location = serde_json::json!({
        "$mid": 1,
        "fsPath": fs_path,
        "_sep": 1,
        "external": cursor_extension_file_url(fs_path),
        "path": posix,
        "scheme": "file",
    });
    let mut found = false;
    for item in arr.iter_mut() {
        let id = item
            .get("identifier")
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str());
        if id != Some("armada.armada-agent") {
            continue;
        }
        item["version"] = serde_json::Value::String(version.into());
        item["relativeLocation"] = serde_json::Value::String(relative_location.into());
        item["location"] = location.clone();
        let md = item
            .as_object_mut()
            .ok_or("extensions-json-invalid")?
            .entry("metadata")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(obj) = md.as_object_mut() {
            obj.insert("installedTimestamp".into(), serde_json::json!(now_ms));
            obj.insert("source".into(), serde_json::json!("vsix"));
            obj.insert("pinned".into(), serde_json::json!(true));
        }
        found = true;
        break;
    }
    if !found {
        arr.push(serde_json::json!({
            "identifier": { "id": "armada.armada-agent" },
            "version": version,
            "relativeLocation": relative_location,
            "location": location,
            "metadata": {
                "isApplicationScoped": false,
                "isMachineScoped": false,
                "isBuiltin": false,
                "installedTimestamp": now_ms,
                "pinned": true,
                "source": "vsix"
            }
        }));
    }
    serde_json::to_string(&arr).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn unpack_vsix_to_dir(vsix: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(vsix).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().replace('\\', "/");
        if name.split('/').any(|p| p == "..") {
            continue;
        }
        let out_rel = if name == "extension.vsixmanifest" {
            PathBuf::from(".vsixmanifest")
        } else if let Some(rel) = name.strip_prefix("extension/") {
            if rel.is_empty() {
                continue;
            }
            PathBuf::from(rel)
        } else {
            continue;
        };
        let out_path = dest.join(out_rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    if !dest.join("package.json").is_file() {
        return Err("vsix-missing-package".into());
    }
    Ok(())
}

pub fn install_vsix_by_unpack(
    vsix: &Path,
    extensions_dir: &Path,
    ver: (u64, u64, u64),
) -> Result<(), String> {
    let dest = armada_agent_extension_dir(extensions_dir, ver);
    unpack_vsix_to_dir(vsix, &dest)?;
    let json_path = extensions_dir.join("extensions.json");
    let raw = fs::read_to_string(&json_path).unwrap_or_default();
    let version = format!("{}.{}.{}", ver.0, ver.1, ver.2);
    let relative = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("armada.armada-agent")
        .to_string();
    let fs_path = dest.to_string_lossy().into_owned();
    let next = upsert_armada_agent_extension_json(&raw, &version, &relative, &fs_path, now_ms())?;
    fs::write(&json_path, next).map_err(|e| e.to_string())?;
    Ok(())
}

fn cursor_extensions_dir() -> PathBuf {
    if let Ok(p) = env::var("ARMADA_CURSOR_EXTENSIONS") {
        return PathBuf::from(p);
    }
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cursor").join("extensions")
}

pub fn vsix_search_roots(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = resource_dir {
        roots.push(dir.to_path_buf());
        roots.push(dir.join("extension"));
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    roots.push(manifest.join("../../extension"));
    roots.push(manifest.join("../../extension/dist"));
    roots
}

pub fn is_gui_cursor_exe(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("Cursor.exe"))
        .unwrap_or(false)
}

fn cursor_cli_candidates() -> Vec<PathBuf> {
    let mut v = vec![PathBuf::from("cursor")];
    if let Ok(home) = env::var("HOME") {
        let home = PathBuf::from(home);
        v.push(home.join(".local/bin/cursor"));
    }
    v.push(PathBuf::from("/usr/local/bin/cursor"));
    v.push(PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/cursor"));
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        v.push(local.join("Programs/cursor/resources/app/bin/cursor.cmd"));
        v.push(local.join("Programs/Cursor/resources/app/bin/cursor.cmd"));
    }
    v
}

const HOOKS_INSTALL_TIMEOUT: Duration = Duration::from_secs(8);
const VSIX_INSTALL_TIMEOUT: Duration = Duration::from_secs(8);

pub fn should_skip_windows_hooks_strip(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    !(lower.contains("armada-spool.ps1")
        || lower.contains("armada-spool.sh")
        || lower.contains("armada-spool.exe"))
}

pub fn apply_gui_child_stdio(cmd: &mut Command) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn apply_gui_child_capture(cmd: &mut Command) {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn wait_child(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return Some(st),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

pub fn run_child_timeout(cmd: &mut Command, timeout: Duration) -> &'static str {
    apply_gui_child_stdio(cmd);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return "failed",
    };
    match wait_child(&mut child, timeout) {
        Some(st) if st.success() => "ok",
        _ => "failed",
    }
}

fn try_install_vsix(cli: &Path, vsix: &Path, force: bool) -> Option<(bool, String, String)> {
    let mut cmd = Command::new(cli);
    cmd.args(vsix_install_cli_args(vsix, force));
    apply_gui_child_capture(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let status = wait_child(&mut child, VSIX_INSTALL_TIMEOUT);
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    Some((ok, stdout, stderr))
}

pub fn probe_vsix_cli_chain<F>(
    vsix: &Path,
    clis: &[PathBuf],
    mut try_one: F,
) -> (&'static str, Option<String>)
where
    F: FnMut(&Path, &Path) -> Option<(bool, String, String)>,
{
    let path_s = vsix.display().to_string();
    for cli in clis {
        if is_gui_cursor_exe(cli) {
            continue;
        }
        let Some((ok, stdout, stderr)) = try_one(cli, vsix) else {
            continue;
        };
        let status = classify_vsix_cli(ok, &stdout, &stderr);
        if status != "manual-path-shown" {
            return (status, None);
        }
    }
    ("manual-path-shown", Some(path_s))
}

pub fn install_vsix_from_roots(roots: &[PathBuf]) -> (&'static str, Option<String>) {
    install_vsix_from_roots_in(roots, &cursor_extensions_dir())
}

pub fn install_vsix_from_roots_in(
    roots: &[PathBuf],
    extensions_dir: &Path,
) -> (&'static str, Option<String>) {
    let Some(vsix) = find_vsix(roots) else {
        return ("manual-path-shown", None);
    };
    let bundled = vsix_semver(&vsix);
    let installed = installed_armada_agent_semver(extensions_dir);
    if let Some(ver) = bundled {
        if !vsix_needs_install(ver, installed) {
            return ("skipped-same-version", None);
        }
        if vsix_install_via_unpack(std::env::consts::OS) {
            return match install_vsix_by_unpack(&vsix, extensions_dir, ver) {
                Ok(()) => ("ok", None),
                Err(_) => ("manual-path-shown", Some(vsix.display().to_string())),
            };
        }
    }
    let force = matches!(installed, Some(v) if bundled.map(|b| v < b).unwrap_or(false));
    probe_vsix_cli_chain(&vsix, &cursor_cli_candidates(), |cli, path| {
        try_install_vsix(cli, path, force)
    })
}

pub fn install_vsix(resource_dir: Option<&Path>) -> (&'static str, Option<String>) {
    install_vsix_from_roots(&vsix_search_roots(resource_dir))
}

pub fn resolve_hooks_dir(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Ok(p) = env::var("ARMADA_DESKTOP_HOOKS_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("install.sh").is_file() || pb.join("install.ps1").is_file() {
            return Ok(pb);
        }
        return Err("hooks-root-missing".into());
    }
    if let Some(dir) = resource_dir {
        let p = dir.join("hooks");
        if p.join("install.sh").is_file() || p.join("install.ps1").is_file() {
            return Ok(p);
        }
    }
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hooks");
    if p.join("install.sh").is_file() || p.join("install.ps1").is_file() {
        return Ok(p);
    }
    Err("hooks-root-missing".into())
}

fn windows_hooks_json_path(home: Option<&Path>) -> PathBuf {
    let base = home.map(Path::to_path_buf).unwrap_or_else(|| {
        PathBuf::from(env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
    });
    base.join(".cursor").join("hooks.json")
}

pub fn run_hooks_install(script: &Path, home: Option<&Path>) -> &'static str {
    if script.extension().and_then(|s| s.to_str()) == Some("ps1") {
        let raw = fs::read_to_string(windows_hooks_json_path(home)).unwrap_or_default();
        if should_skip_windows_hooks_strip(&raw) {
            return "ok";
        }
    }
    let mut cmd = if script.extension().and_then(|s| s.to_str()) == Some("ps1") {
        let mut c = Command::new("powershell");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        c.arg(script);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg(script);
        c
    };
    if let Some(h) = home {
        cmd.env("HOME", h);
        cmd.env("USERPROFILE", h);
    }
    let timeout = if script.extension().and_then(|s| s.to_str()) == Some("ps1") {
        HOOKS_INSTALL_TIMEOUT
    } else {
        Duration::from_secs(30)
    };
    run_child_timeout(&mut cmd, timeout)
}

fn split_hub(hub_url: &str) -> (String, u16) {
    let mut s = hub_url.trim();
    for prefix in ["http://", "https://", "HTTP://", "HTTPS://"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest;
            break;
        }
    }
    s = s.trim_end_matches('/');
    if let Some((h, p)) = s.rsplit_once(':') {
        if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
            return (h.to_string(), p.parse().unwrap_or(HUB_PORT));
        }
    }
    (s.to_string(), HUB_PORT)
}

pub fn run_local_attach_gated(
    allowed: bool,
    resource_dir: Option<&Path>,
    hub_url: &str,
    token: &str,
    overwrite_cursor_hub_url: bool,
    settings_path: &Path,
    hooks_home: Option<&Path>,
) -> Result<LocalAttachResult, String> {
    if !allowed {
        return Err("not-authorized".into());
    }
    let raw = fs::read_to_string(settings_path).unwrap_or_default();
    let (existing_hub, _) = existing_keys(&raw);
    let hub_url_written =
        hub_url_to_write(overwrite_cursor_hub_url, existing_hub.as_deref(), hub_url).to_string();
    let settings = match apply_cursor_settings(settings_path, hub_url, token, overwrite_cursor_hub_url) {
        Ok(_) => "ok",
        Err(_) => "failed",
    };
    let (vsix, vsix_path) = install_vsix(resource_dir);
    let hooks = match resolve_hooks_dir(resource_dir) {
        Ok(dir) => {
            let script = if cfg!(windows) {
                dir.join("install.ps1")
            } else {
                dir.join("install.sh")
            };
            run_hooks_install(&script, hooks_home)
        }
        Err(_) => "failed",
    };
    Ok(LocalAttachResult {
        vsix,
        hooks,
        settings,
        hub_url_written,
        vsix_path,
    })
}

pub fn run_local_attach(
    resource_dir: Option<&Path>,
    hub_url: &str,
    token: &str,
    overwrite_cursor_hub_url: bool,
    settings_path: Option<&Path>,
) -> Result<LocalAttachResult, String> {
    let (host, port) = split_hub(hub_url);
    let probe = hub::probe_hub(&host, port, token);
    let path = settings_path
        .map(|p| p.to_path_buf())
        .unwrap_or_else(real_cursor_settings_path);
    run_local_attach_gated(
        hub::may_write_cursor_settings(&probe),
        resource_dir,
        hub_url,
        token,
        overwrite_cursor_hub_url,
        &path,
        None,
    )
}

pub(crate) fn read_existing_hub_url() -> Option<String> {
    read_existing_creds().0
}

pub(crate) fn read_existing_creds() -> (Option<String>, Option<String>) {
    let raw = fs::read_to_string(real_cursor_settings_path()).unwrap_or_default();
    existing_keys(&raw)
}

#[tauri::command]
pub fn local_attach(
    app: tauri::AppHandle,
    hub_url: String,
    token: String,
    overwrite_cursor_hub_url: bool,
) -> Result<LocalAttachResult, String> {
    use tauri::Manager;
    let resource = app.path().resource_dir().ok();
    run_local_attach(
        resource.as_deref(),
        &hub_url,
        &token,
        overwrite_cursor_hub_url,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::{Auth, Probe};
    use std::io::Write;

    fn scratch(label: &str) -> PathBuf {
        let p = env::temp_dir().join(format!(
            "armada-t10-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_minimal_vsix(path: &Path, version: &str) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("extension/package.json", opts).unwrap();
        zip.write_all(
            format!(r#"{{"name":"armada-agent","version":"{version}"}}"#).as_bytes(),
        )
        .unwrap();
        zip.start_file("extension.vsixmanifest", opts).unwrap();
        zip.write_all(b"<PackageManifest/>").unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn merge_preserves_unrelated_and_only_two_keys() {
        let (json, changed) =
            merge_armada_settings("{\n  \"editor.fontSize\": 14\n}\n", "127.0.0.1:7380", "ab").unwrap();
        assert!(changed);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["editor.fontSize"], 14);
        assert_eq!(v["armada.hubUrl"], "127.0.0.1:7380");
        assert_eq!(v["armada.token"], "ab");
        assert!(v.get("armada.cdpPort").is_none());
    }

    #[test]
    fn overwrite_false_equal_keys_skips_write() {
        assert!(!should_write_cursor_settings(
            false,
            Some("127.0.0.1:7380"),
            Some("ab"),
            "127.0.0.1:7380",
            "ab",
        ));
    }

    #[test]
    fn overwrite_false_token_rotation_still_writes() {
        assert!(should_write_cursor_settings(
            false,
            Some("127.0.0.1:7380"),
            Some("old"),
            "127.0.0.1:7380",
            "new",
        ));
    }

    #[test]
    fn overwrite_false_keeps_loopback_if_lan_hub_passed() {
        assert!(!should_write_cursor_settings(
            false,
            Some("127.0.0.1:7380"),
            Some("ab"),
            "192.168.1.23:7380",
            "ab",
        ));
    }

    #[test]
    fn macos_and_windows_cursor_paths() {
        let mac = cursor_user_settings_path_for("macos", Path::new("/Users/a"), None);
        assert_eq!(
            mac,
            PathBuf::from("/Users/a/Library/Application Support/Cursor/User/settings.json")
        );
        let win = cursor_user_settings_path_for(
            "windows",
            Path::new("C:/Users/a"),
            Some(Path::new("C:/Users/a/AppData/Roaming")),
        );
        assert_eq!(
            win,
            PathBuf::from("C:/Users/a/AppData/Roaming/Cursor/User/settings.json")
        );
    }

    #[test]
    fn backup_then_write_two_keys() {
        let dir = scratch("bak");
        let path = dir.join("settings.json");
        fs::write(&path, "{\n  \"editor.fontSize\": 14\n}\n").unwrap();
        apply_cursor_settings(&path, "127.0.0.1:7380", "tok", true).unwrap();
        let bak = dir.join("settings.json.bak.armada");
        assert!(bak.is_file());
        let orig: serde_json::Value = serde_json::from_str(&fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(orig["editor.fontSize"], 14);
        assert!(orig.get("armada.hubUrl").is_none());
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["editor.fontSize"], 14);
        assert_eq!(v["armada.hubUrl"], "127.0.0.1:7380");
        assert_eq!(v["armada.token"], "tok");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skip_write_does_not_create_backup() {
        let dir = scratch("skip");
        let path = dir.join("settings.json");
        let raw = "{\n  \"armada.hubUrl\": \"127.0.0.1:7380\",\n  \"armada.token\": \"ab\"\n}\n";
        fs::write(&path, raw).unwrap();
        apply_cursor_settings(&path, "127.0.0.1:7380", "ab", false).unwrap();
        assert!(!dir.join("settings.json.bak.armada").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn classify_vsix_statuses() {
        assert_eq!(
            classify_vsix_cli(true, "Extension 'armada.armada-agent' is already installed.", ""),
            "skipped-same-version"
        );
        assert_eq!(classify_vsix_cli(true, "successfully installed", ""), "ok");
        assert_eq!(classify_vsix_cli(false, "", "not found"), "manual-path-shown");
    }

    fn find_vsix_no_env(roots: &[PathBuf]) -> Option<PathBuf> {
        let saved = env::var("ARMADA_VSIX").ok();
        env::remove_var("ARMADA_VSIX");
        let got = find_vsix(roots);
        match saved {
            Some(v) => env::set_var("ARMADA_VSIX", v),
            None => env::remove_var("ARMADA_VSIX"),
        }
        got
    }

    #[test]
    fn find_vsix_prefers_semver_not_lexicographic_filename() {
        let dir = scratch("vsix-semver");
        fs::write(dir.join("armada-agent-0.4.8.vsix"), b"old").unwrap();
        fs::write(dir.join("armada-agent-0.4.12.vsix"), b"new").unwrap();
        let got = find_vsix_no_env(&[dir.clone()]).expect("vsix");
        assert_eq!(got.file_name().unwrap(), "armada-agent-0.4.12.vsix");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_vsix_picks_highest_semver_across_roots() {
        let resources = scratch("vsix-res");
        let repo = scratch("vsix-ext");
        fs::write(resources.join("armada-agent-0.4.8.vsix"), b"bundled").unwrap();
        fs::write(repo.join("armada-agent-0.4.12.vsix"), b"source").unwrap();
        let got = find_vsix_no_env(&[resources.clone(), repo.clone()]).expect("vsix");
        assert_eq!(got.file_name().unwrap(), "armada-agent-0.4.12.vsix");
        let _ = fs::remove_dir_all(&resources);
        let _ = fs::remove_dir_all(&repo);
    }

    #[test]
    fn vsix_install_cli_force_only_when_requested() {
        let vsix = PathBuf::from("/tmp/armada-agent-0.4.12.vsix");
        assert_eq!(
            vsix_install_cli_args(&vsix, true),
            [
                "--install-extension",
                "/tmp/armada-agent-0.4.12.vsix",
                "--force"
            ]
        );
        assert_eq!(
            vsix_install_cli_args(&vsix, false),
            ["--install-extension", "/tmp/armada-agent-0.4.12.vsix"]
        );
    }

    #[test]
    fn vsix_skips_cli_when_installed_semver_is_current() {
        let dir = scratch("exts-current");
        fs::create_dir_all(dir.join("armada.armada-agent-0.4.23")).unwrap();
        assert_eq!(
            installed_armada_agent_semver(&dir),
            Some((0, 4, 23))
        );
        assert!(!vsix_needs_install((0, 4, 23), Some((0, 4, 23))));
        assert!(vsix_needs_install((0, 4, 23), Some((0, 4, 22))));
        assert!(vsix_needs_install((0, 4, 23), None));
        let roots = scratch("vsix-skip");
        fs::write(roots.join("armada-agent-0.4.23.vsix"), b"x").unwrap();
        let (status, _) = install_vsix_from_roots_in(&[roots.clone()], &dir);
        assert_eq!(status, "skipped-same-version");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&roots);
    }

    #[cfg(windows)]
    #[test]
    fn windows_join_unpacks_newer_vsix_without_cli() {
        let dir = scratch("exts-old-win");
        fs::create_dir_all(dir.join("armada.armada-agent-0.4.21")).unwrap();
        let roots = scratch("vsix-new-win");
        write_minimal_vsix(&roots.join("armada-agent-0.4.23.vsix"), "0.4.23");
        let (status, path) = install_vsix_from_roots_in(&[roots.clone()], &dir);
        assert_eq!(status, "ok");
        assert!(path.is_none());
        assert!(dir.join("armada.armada-agent-0.4.23/package.json").is_file());
        let rec: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("extensions.json")).unwrap()).unwrap();
        assert_eq!(rec[0]["version"], "0.4.23");
        assert_eq!(rec[0]["relativeLocation"], "armada.armada-agent-0.4.23");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&roots);
    }

    #[test]
    fn missing_vsix_is_manual_path_shown() {
        let dir = scratch("novsix");
        let (status, path) = install_vsix_from_roots(&[dir.clone()]);
        assert_eq!(status, "manual-path-shown");
        match path {
            None => {}
            Some(p) => {
                assert!(
                    !p.ends_with(".vsix"),
                    "must not invent a vsix file path, got {p}"
                );
                assert_eq!(PathBuf::from(&p), dir);
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vsix_cli_skips_missing_candidate_then_succeeds() {
        let vsix = PathBuf::from("/tmp/real-armada.vsix");
        let clis = [PathBuf::from("missing"), PathBuf::from("app-cursor")];
        let mut seen = Vec::new();
        let (status, path) = probe_vsix_cli_chain(&vsix, &clis, |cli, _| {
            seen.push(cli.to_path_buf());
            if cli == Path::new("missing") {
                None
            } else {
                Some((true, "successfully installed".into(), String::new()))
            }
        });
        assert_eq!(status, "ok");
        assert!(path.is_none());
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn vsix_cli_does_not_stop_at_first_failing_process() {
        let vsix = PathBuf::from("/tmp/real-armada.vsix");
        let clis = [
            PathBuf::from("path-cursor"),
            PathBuf::from("app-cursor"),
            PathBuf::from("win-cursor"),
        ];
        let mut seen = Vec::new();
        let (status, path) = probe_vsix_cli_chain(&vsix, &clis, |cli, _| {
            seen.push(cli.to_path_buf());
            if cli == Path::new("path-cursor") {
                Some((false, String::new(), "command failed".into()))
            } else if cli == Path::new("app-cursor") {
                Some((true, "successfully installed".into(), String::new()))
            } else {
                panic!("must not probe remaining candidates after success");
            }
        });
        assert_eq!(status, "ok");
        assert!(path.is_none());
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn vsix_cli_all_fail_is_manual_with_real_vsix_path() {
        let vsix = PathBuf::from("/tmp/real-armada.vsix");
        let clis = [PathBuf::from("a"), PathBuf::from("b")];
        let (status, path) = probe_vsix_cli_chain(&vsix, &clis, |_, _| {
            Some((false, String::new(), "nope".into()))
        });
        assert_eq!(status, "manual-path-shown");
        assert_eq!(path.as_deref(), Some("/tmp/real-armada.vsix"));
    }

    #[test]
    fn is_gui_cursor_exe_detects_windows_app() {
        assert!(is_gui_cursor_exe(Path::new(
            r"C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe"
        )));
        assert!(is_gui_cursor_exe(Path::new(r"C:\Cursor.exe")));
        assert!(!is_gui_cursor_exe(Path::new("cursor")));
        assert!(!is_gui_cursor_exe(Path::new(
            r"C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd"
        )));
    }

    #[test]
    fn vsix_install_via_unpack_is_windows_only() {
        assert!(vsix_install_via_unpack("windows"));
        assert!(!vsix_install_via_unpack("macos"));
        assert!(!vsix_install_via_unpack("linux"));
    }

    #[test]
    fn upsert_armada_agent_extension_json_updates_existing() {
        let raw = r#"[{"identifier":{"id":"anysphere.remote-ssh"},"version":"1.0.0"},{"identifier":{"id":"armada.armada-agent"},"version":"0.4.21","relativeLocation":"armada.armada-agent-0.4.21"}]"#;
        let next = upsert_armada_agent_extension_json(
            raw,
            "0.4.23",
            "armada.armada-agent-0.4.23",
            r"c:\Users\PC\.cursor\extensions\armada.armada-agent-0.4.23",
            11,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&next).unwrap();
        assert_eq!(v[0]["identifier"]["id"], "anysphere.remote-ssh");
        assert_eq!(v[1]["version"], "0.4.23");
        assert_eq!(v[1]["relativeLocation"], "armada.armada-agent-0.4.23");
        assert_eq!(v[1]["metadata"]["source"], "vsix");
        assert_eq!(
            v[1]["location"]["external"],
            "file:///c%3A/Users/PC/.cursor/extensions/armada.armada-agent-0.4.23"
        );
    }

    #[test]
    fn unpack_vsix_writes_package_json_and_manifest() {
        let dir = scratch("unpack-vsix");
        let vsix = dir.join("armada-agent-0.4.23.vsix");
        write_minimal_vsix(&vsix, "0.4.23");
        let dest = dir.join("out");
        unpack_vsix_to_dir(&vsix, &dest).unwrap();
        assert_eq!(
            fs::read_to_string(dest.join("package.json")).unwrap(),
            r#"{"name":"armada-agent","version":"0.4.23"}"#
        );
        assert!(dest.join(".vsixmanifest").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_vsix_skips_gui_cursor_exe() {
        let vsix = PathBuf::from("/tmp/real-armada.vsix");
        let clis = [
            PathBuf::from(r"C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe"),
            PathBuf::from(r"C:\Users\me\AppData\Local\Programs\cursor\resources\app\bin\cursor.cmd"),
        ];
        let mut seen = Vec::new();
        let (status, path) = probe_vsix_cli_chain(&vsix, &clis, |cli, _| {
            seen.push(cli.to_path_buf());
            Some((true, "successfully installed".into(), String::new()))
        });
        assert_eq!(status, "ok");
        assert!(path.is_none());
        assert_eq!(seen.len(), 1);
        assert!(seen[0].ends_with("cursor.cmd"));
    }

    #[test]
    fn cursor_cli_candidates_follow_spec_order() {
        let displays: Vec<String> = cursor_cli_candidates()
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        assert_eq!(displays[0], "cursor");
        let app_i = displays
            .iter()
            .position(|s| s.contains("Cursor.app/Contents/Resources/app/bin/cursor"));
        assert!(app_i.is_some(), "macOS Cursor.app CLI must be a candidate");
        assert!(app_i.unwrap() > 0);
        assert!(
            displays.iter().all(|s| !s.ends_with("Cursor.exe") && !s.ends_with("cursor.exe")),
            "join must not spawn Cursor GUI: {displays:?}"
        );
        if let Ok(local) = env::var("LOCALAPPDATA") {
            let cmd = format!("{local}/Programs/cursor/resources/app/bin/cursor.cmd");
            let cmd_i = displays.iter().position(|s| s == &cmd || s.ends_with("cursor.cmd"));
            assert!(cmd_i.is_some(), "windows cursor.cmd must remain a candidate");
            assert!(app_i.unwrap() < cmd_i.unwrap());
        }
    }

    #[test]
    fn overwrite_false_lan_input_reports_loopback_hub_url_written() {
        let dir = scratch("hubwritten");
        let path = dir.join("settings.json");
        fs::write(
            &path,
            "{\n  \"armada.hubUrl\": \"127.0.0.1:7380\",\n  \"armada.token\": \"ab\"\n}\n",
        )
        .unwrap();
        let r = run_local_attach_gated(
            true,
            Some(&dir),
            "192.168.1.23:7380",
            "ab",
            false,
            &path,
            Some(&dir),
        )
        .unwrap();
        assert_eq!(r.hub_url_written, "127.0.0.1:7380");
        assert_eq!(r.settings, "ok");
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk["armada.hubUrl"], "127.0.0.1:7380");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn gate_false_does_not_write_settings() {
        let dir = scratch("gate");
        let path = dir.join("settings.json");
        fs::write(&path, "{}\n").unwrap();
        let err = run_local_attach_gated(
            false,
            None,
            "127.0.0.1:7380",
            "secret-token",
            true,
            &path,
            Some(&dir),
        )
        .unwrap_err();
        assert_eq!(err, "not-authorized");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{}\n");
        assert!(!dir.join("settings.json.bak.armada").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn result_json_matches_spec_shape() {
        let r = LocalAttachResult {
            vsix: "manual-path-shown",
            hooks: "ok",
            settings: "ok",
            hub_url_written: "127.0.0.1:7380".into(),
            vsix_path: Some("/tmp/armada-agent.vsix".into()),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["vsix"], "manual-path-shown");
        assert_eq!(v["hooks"], "ok");
        assert_eq!(v["settings"], "ok");
        assert_eq!(v["hubUrlWritten"], "127.0.0.1:7380");
        assert!(v.get("vsixPath").is_some());
    }

    #[test]
    fn may_write_matches_probe_gate() {
        assert!(!hub::may_write_cursor_settings(&Probe {
            health_name: Some("armada-hub".into()),
            auth: Auth::Unauthorized,
        }));
        assert!(hub::may_write_cursor_settings(&Probe {
            health_name: Some("armada-hub".into()),
            auth: Auth::Ok,
        }));
    }

    #[test]
    fn windows_hooks_strip_skipped_when_already_clean() {
        assert!(should_skip_windows_hooks_strip(""));
        assert!(should_skip_windows_hooks_strip(
            r#"{"version":1,"hooks":{"stop":[],"sessionStart":[]}}"#,
        ));
        assert!(should_skip_windows_hooks_strip(
            r#"{"hooks":{"stop":[{"command":"other.ps1"}]}}"#,
        ));
    }

    #[test]
    fn windows_hooks_strip_runs_when_spool_command_present() {
        assert!(!should_skip_windows_hooks_strip(
            r#"{"hooks":{"stop":[{"command":"C:\\hooks\\armada-spool.ps1"}]}}"#,
        ));
        assert!(!should_skip_windows_hooks_strip(
            r#"{"hooks":{"afterShellExecution":[{"command":"armada-spool.exe"}]}}"#,
        ));
    }

    #[test]
    fn gui_child_wait_times_out_and_kills() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping", "-n", "20", "127.0.0.1"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("20");
            c
        };
        apply_gui_child_stdio(&mut cmd);
        let status = run_child_timeout(&mut cmd, Duration::from_millis(400));
        assert_eq!(status, "failed");
    }

    #[test]
    fn hooks_install_sh_merges_without_rust_event_list() {
        let dir = scratch("hooks");
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hooks/install.sh");
        if !script.is_file() {
            return;
        }
        let status = run_hooks_install(&script, Some(&dir));
        assert_eq!(status, "ok");
        let hooks_json = dir.join(".cursor").join("hooks.json");
        assert!(hooks_json.is_file());
        let raw = fs::read_to_string(&hooks_json).unwrap();
        assert!(raw.contains("armada-spool.sh"));
        let _ = fs::remove_dir_all(&dir);
    }
}
