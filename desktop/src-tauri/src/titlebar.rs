use std::fs;
use std::path::PathBuf;

/// Theme stored in `~/.armada/ui-prefs.json`. Missing or unknown values stay unset.
pub fn theme_from_prefs_json(text: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    match value.get("theme").and_then(|t| t.as_str()) {
        Some("light") => Some("light"),
        Some("dark") => Some("dark"),
        _ => None,
    }
}

fn prefs_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".armada").join("ui-prefs.json"))
}

#[tauri::command]
pub fn hub_ui_theme() -> Option<String> {
    let path = prefs_file()?;
    let text = fs::read_to_string(path).ok()?;
    theme_from_prefs_json(&text).map(str::to_string)
}

#[tauri::command]
pub fn set_titlebar_theme(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let light = match theme.as_str() {
        "light" => true,
        "dark" => false,
        other => return Err(format!("unknown theme {other}")),
    };
    let _ = window.set_theme(Some(if light { tauri::Theme::Light } else { tauri::Theme::Dark }));
    #[cfg(target_os = "macos")]
    set_window_appearance(&window, light);
    Ok(())
}

/// `Window.setTheme` only changes NSApplication. WKWebView keeps the title bar
/// on the window's own appearance, which stays dark after the page first paints.
#[cfg(target_os = "macos")]
fn set_window_appearance(window: &tauri::WebviewWindow, light: bool) {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;

    let Ok(ptr) = window.ns_window() else { return };
    if ptr.is_null() { return };
    let name = if light { "NSAppearanceNameAqua" } else { "NSAppearanceNameDarkAqua" };
    unsafe {
        let ns_name = NSString::from_str(name);
        let appearance: Option<Retained<AnyObject>> = msg_send![
            objc2::class!(NSAppearance),
            appearanceNamed: &*ns_name
        ];
        let Some(appearance) = appearance else { return };
        let win = ptr.cast::<AnyObject>();
        let _: () = msg_send![win, setAppearance: &*appearance];
        let content: Option<Retained<AnyObject>> = msg_send![win, contentView];
        if let Some(content) = content {
            let _: () = msg_send![&*content, setAppearance: &*appearance];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::theme_from_prefs_json;

    #[test]
    fn reads_light_and_dark_only() {
        assert_eq!(theme_from_prefs_json(r#"{"theme":"light"}"#), Some("light"));
        assert_eq!(theme_from_prefs_json(r#"{"theme":"dark","fontScale":"xlarge"}"#), Some("dark"));
        assert_eq!(theme_from_prefs_json(r#"{"theme":"sepia"}"#), None);
        assert_eq!(theme_from_prefs_json("not json"), None);
    }
}
