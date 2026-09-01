use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const CDP_HOST: &str = "127.0.0.1";
const CDP_PORT_DEFAULT: u16 = 9222;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CdpStatus {
    Ready,
    Zombie,
    Absent,
}

impl CdpStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CdpStatus::Ready => "ready",
            CdpStatus::Zombie => "zombie",
            CdpStatus::Absent => "absent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenPlan {
    OpenExisting {
        program: String,
        args: Vec<String>,
        wait: bool,
    },
    BlockZombie,
    RunLauncher {
        program: String,
        args: Vec<String>,
    },
}

impl OpenPlan {
    pub fn uses_launcher(&self) -> bool {
        matches!(self, OpenPlan::RunLauncher { .. })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn argv_blob(&self) -> String {
        match self {
            OpenPlan::OpenExisting { program, args, .. } | OpenPlan::RunLauncher { program, args } => {
                format!("{program} {}", args.join(" "))
            }
            OpenPlan::BlockZombie => String::new(),
        }
    }
}

pub fn cdp_port() -> u16 {
    env::var("ARMADA_CDP_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(CDP_PORT_DEFAULT)
}

pub fn classify_cdp(cdp_ok: bool, cursor_alive: bool) -> CdpStatus {
    if cdp_ok {
        CdpStatus::Ready
    } else if cursor_alive {
        CdpStatus::Zombie
    } else {
        CdpStatus::Absent
    }
}

pub fn macos_cursor_alive_from_pgrep(success: bool) -> bool {
    success
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_cursor_alive_from_tasklist(stdout: &str) -> bool {
    stdout.lines().any(|l| {
        let t = l.trim().to_ascii_lowercase();
        t.starts_with("cursor.exe")
    })
}

fn cursor_process_alive() -> bool {
    #[cfg(windows)]
    {
        for name in ["Cursor.exe", "cursor.exe"] {
            let out = Command::new("tasklist")
                .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
                .output();
            if let Ok(o) = out {
                if windows_cursor_alive_from_tasklist(&String::from_utf8_lossy(&o.stdout)) {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        Command::new("pgrep")
            .args(["-x", "Cursor"])
            .status()
            .map(|s| macos_cursor_alive_from_pgrep(s.success()))
            .unwrap_or(false)
    }
}

pub fn probe_cdp() -> bool {
    crate::hub::tcp_open(CDP_HOST, cdp_port(), Duration::from_millis(300))
}

pub fn current_cdp_status() -> CdpStatus {
    classify_cdp(probe_cdp(), cursor_process_alive())
}

pub fn path_is_absolute(abs_path: &str, os: &str) -> bool {
    if os == "windows" {
        let b = abs_path.as_bytes();
        if abs_path.starts_with("\\\\") || abs_path.starts_with("//") {
            return true;
        }
        b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/')
    } else {
        abs_path.starts_with('/')
    }
}

pub fn require_abs_dir(abs_path: &str) -> Result<(), String> {
    let os = current_os();
    if !path_is_absolute(abs_path, os) {
        return Err("path-not-absolute".into());
    }
    if !Path::new(abs_path).is_dir() {
        return Err("path-not-dir".into());
    }
    Ok(())
}

pub fn resolve_launcher(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "armada-cursor.ps1"
    } else {
        "armada-cursor.sh"
    };
    if let Ok(p) = env::var("ARMADA_DESKTOP_SCRIPTS_ROOT") {
        let pb = PathBuf::from(p).join(name);
        if pb.is_file() {
            return Ok(pb);
        }
        return Err("launcher-missing".into());
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("scripts").join(name);
        if bundled.is_file() {
            return Ok(bundled);
        }
        let flat = dir.join(name);
        if flat.is_file() {
            return Ok(flat);
        }
    }
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts").join(name);
    if repo.is_file() {
        return Ok(repo);
    }
    Err("launcher-missing".into())
}

fn windows_cursor_exe() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(local) = env::var("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("Programs/cursor/Cursor.exe"));
        candidates.push(local.join("Programs/Cursor/Cursor.exe"));
    }
    if let Ok(pf) = env::var("ProgramFiles") {
        candidates.push(PathBuf::from(pf).join("Cursor/Cursor.exe"));
    }
    if let Ok(pfx) = env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(pfx).join("Cursor/Cursor.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

pub fn plan_open(
    status: CdpStatus,
    abs_path: &str,
    launcher: Option<&Path>,
    os: &str,
    cursor_exe: Option<&Path>,
) -> Result<OpenPlan, String> {
    if !path_is_absolute(abs_path, os) {
        return Err("path-not-absolute".into());
    }
    match status {
        CdpStatus::Zombie => Ok(OpenPlan::BlockZombie),
        CdpStatus::Ready => {
            if os == "windows" {
                let exe = cursor_exe.ok_or("cursor-missing")?;
                Ok(OpenPlan::OpenExisting {
                    program: exe.to_string_lossy().into_owned(),
                    args: vec![abs_path.to_string()],
                    wait: false,
                })
            } else {
                Ok(OpenPlan::OpenExisting {
                    program: "open".into(),
                    args: vec!["-na".into(), "Cursor".into(), "--args".into(), abs_path.to_string()],
                    wait: true,
                })
            }
        }
        CdpStatus::Absent => {
            let launcher = launcher.ok_or("launcher-missing")?;
            if os == "windows" {
                Ok(OpenPlan::RunLauncher {
                    program: "powershell".into(),
                    args: vec![
                        "-NoProfile".into(),
                        "-NonInteractive".into(),
                        "-ExecutionPolicy".into(),
                        "Bypass".into(),
                        "-File".into(),
                        launcher.to_string_lossy().into_owned(),
                        abs_path.to_string(),
                    ],
                })
            } else {
                Ok(OpenPlan::RunLauncher {
                    program: "sh".into(),
                    args: vec![launcher.to_string_lossy().into_owned(), abs_path.to_string()],
                })
            }
        }
    }
}

pub fn execute_plan<F>(plan: OpenPlan, mut spawn: F) -> Result<(), String>
where
    F: FnMut(&str, &[String], bool) -> Result<bool, String>,
{
    match plan {
        OpenPlan::BlockZombie => Err("zombie".into()),
        OpenPlan::OpenExisting { program, args, wait } => {
            let ok = spawn(&program, &args, wait)?;
            if ok {
                Ok(())
            } else {
                Err("open-failed".into())
            }
        }
        OpenPlan::RunLauncher { program, args } => {
            let _ = spawn(&program, &args, false)?;
            Ok(())
        }
    }
}

fn real_spawn(program: &str, args: &[String], wait: bool) -> Result<bool, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    if wait {
        cmd.status()
            .map(|s| s.success())
            .map_err(|e| format!("open-failed:{e}"))
    } else {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.spawn().map(|_| true).map_err(|e| format!("spawn-failed:{e}"))
    }
}

fn resource_dir_from(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().resource_dir().ok()
}

#[tauri::command]
pub fn cdp_status() -> Result<&'static str, String> {
    Ok(current_cdp_status().as_str())
}

#[tauri::command]
pub fn open_workspace(app: tauri::AppHandle, abs_path: String) -> Result<(), String> {
    require_abs_dir(&abs_path)?;
    let status = current_cdp_status();
    if matches!(status, CdpStatus::Ready | CdpStatus::Zombie) {
        let plan = plan_open(status, &abs_path, None, current_os(), windows_cursor_exe().as_deref())?;
        debug_assert!(!plan.uses_launcher());
        return execute_plan(plan, real_spawn);
    }
    let launcher = resolve_launcher(resource_dir_from(&app).as_deref())?;
    let plan = plan_open(
        status,
        &abs_path,
        Some(&launcher),
        current_os(),
        windows_cursor_exe().as_deref(),
    )?;
    execute_plan(plan, real_spawn)
}

#[tauri::command]
pub fn pick_workspace() -> Result<String, String> {
    #[cfg(windows)]
    {
        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }",
            ])
            .output()
            .map_err(|_| "pick-failed".to_string())?;
        if !out.status.success() {
            return Err("cancelled".into());
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            return Err("cancelled".into());
        }
        return Ok(s);
    }
    #[cfg(not(windows))]
    {
        let out = Command::new("osascript")
            .args(["-e", "POSIX path of (choose folder)"])
            .output()
            .map_err(|_| "pick-failed".to_string())?;
        if !out.status.success() {
            return Err("cancelled".into());
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
        if s.is_empty() {
            return Err("cancelled".into());
        }
        Ok(s)
    }
}

fn current_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "macos"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch(label: &str) -> PathBuf {
        let p = env::temp_dir().join(format!(
            "armada-t12-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn classify_matches_spec() {
        assert_eq!(classify_cdp(true, true), CdpStatus::Ready);
        assert_eq!(classify_cdp(true, false), CdpStatus::Ready);
        assert_eq!(classify_cdp(false, true), CdpStatus::Zombie);
        assert_eq!(classify_cdp(false, false), CdpStatus::Absent);
    }

    #[test]
    fn as_str_is_ipc_contract() {
        assert_eq!(CdpStatus::Ready.as_str(), "ready");
        assert_eq!(CdpStatus::Zombie.as_str(), "zombie");
        assert_eq!(CdpStatus::Absent.as_str(), "absent");
    }

    #[test]
    fn ready_macos_is_open_na_not_launcher() {
        let plan = plan_open(
            CdpStatus::Ready,
            "/tmp/ws",
            Some(Path::new("/repo/scripts/armada-cursor.sh")),
            "macos",
            None,
        )
        .unwrap();
        assert!(!plan.uses_launcher());
        let blob = plan.argv_blob();
        assert!(blob.contains("open"));
        assert!(blob.contains("-na"));
        assert!(blob.contains("Cursor"));
        assert!(blob.contains("/tmp/ws"));
        assert!(!blob.contains("armada-cursor"));
        assert!(!blob.contains("remote-debugging-port"));
    }

    #[test]
    fn ready_windows_is_exe_path_not_launcher() {
        let plan = plan_open(
            CdpStatus::Ready,
            r"C:\ws",
            Some(Path::new(r"C:\scripts\armada-cursor.ps1")),
            "windows",
            Some(Path::new(r"C:\Cursor.exe")),
        )
        .unwrap();
        assert!(!plan.uses_launcher());
        let blob = plan.argv_blob();
        assert!(blob.contains(r"C:\Cursor.exe"));
        assert!(blob.contains(r"C:\ws"));
        assert!(!blob.contains("armada-cursor"));
        assert!(!blob.contains("remote-debugging-port"));
    }

    #[test]
    fn zombie_never_spawns_launcher() {
        let plan = plan_open(
            CdpStatus::Zombie,
            "/tmp/ws",
            Some(Path::new("/repo/scripts/armada-cursor.sh")),
            "macos",
            None,
        )
        .unwrap();
        assert!(!plan.uses_launcher());
        assert_eq!(plan, OpenPlan::BlockZombie);
        let called = AtomicUsize::new(0);
        let err = execute_plan(plan, |_, _, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        })
        .unwrap_err();
        assert_eq!(err, "zombie");
        assert_eq!(called.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn absent_runs_shell_or_ps1_with_abs_path() {
        let sh = plan_open(
            CdpStatus::Absent,
            "/tmp/ws",
            Some(Path::new("/repo/scripts/armada-cursor.sh")),
            "macos",
            None,
        )
        .unwrap();
        assert!(sh.uses_launcher());
        let blob = sh.argv_blob();
        assert!(blob.contains("armada-cursor.sh"));
        assert!(blob.contains("/tmp/ws"));

        let ps = plan_open(
            CdpStatus::Absent,
            r"C:\ws",
            Some(Path::new(r"C:\scripts\armada-cursor.ps1")),
            "windows",
            None,
        )
        .unwrap();
        assert!(ps.uses_launcher());
        let blob = ps.argv_blob();
        assert!(blob.contains("armada-cursor.ps1"));
        assert!(blob.contains("-File"));
        assert!(blob.contains(r"C:\ws"));
    }

    #[test]
    fn ready_and_zombie_plan_without_launcher_path() {
        let ready = plan_open(CdpStatus::Ready, "/tmp/ws", None, "macos", None).unwrap();
        assert!(!ready.uses_launcher());
        let zombie = plan_open(CdpStatus::Zombie, "/tmp/ws", None, "macos", None).unwrap();
        assert!(!zombie.uses_launcher());
        let missing = plan_open(CdpStatus::Absent, "/tmp/ws", None, "macos", None).unwrap_err();
        assert_eq!(missing, "launcher-missing");
    }

    #[test]
    fn execute_absent_spawns_launcher_without_waiting() {
        let plan = plan_open(
            CdpStatus::Absent,
            "/tmp/ws",
            Some(Path::new("/repo/scripts/armada-cursor.sh")),
            "macos",
            None,
        )
        .unwrap();
        let mut wait_flag = true;
        execute_plan(plan, |program, args, wait| {
            wait_flag = wait;
            assert_eq!(program, "sh");
            assert!(args.iter().any(|a| a.ends_with("armada-cursor.sh")));
            assert!(args.iter().any(|a| a == "/tmp/ws"));
            Ok(true)
        })
        .unwrap();
        assert!(!wait_flag);
    }

    #[test]
    fn require_abs_dir_rejects_relative() {
        assert_eq!(require_abs_dir("rel/ws").unwrap_err(), "path-not-absolute");
        let dir = scratch("dir");
        require_abs_dir(dir.to_str().unwrap()).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_absolute_is_os_aware() {
        assert!(path_is_absolute("/tmp/ws", "macos"));
        assert!(!path_is_absolute("rel/ws", "macos"));
        assert!(path_is_absolute(r"C:\ws", "windows"));
        assert!(path_is_absolute("D:/ws", "windows"));
        assert!(!path_is_absolute("/tmp/ws", "windows"));
        assert!(!path_is_absolute("rel\\ws", "windows"));
    }

    #[test]
    fn resolve_launcher_finds_repo_scripts() {
        let p = resolve_launcher(None).unwrap();
        assert!(p.is_file());
        let name = p.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("armada-cursor."));
    }

    #[test]
    fn windows_tasklist_detects_cursor_exe() {
        assert!(windows_cursor_alive_from_tasklist(
            "Cursor.exe                    1234 Console                    1     99,000 K\n"
        ));
        assert!(!windows_cursor_alive_from_tasklist(
            "INFO: No tasks are running which match the specified criteria.\n"
        ));
        assert!(macos_cursor_alive_from_pgrep(true));
        assert!(!macos_cursor_alive_from_pgrep(false));
    }
}
