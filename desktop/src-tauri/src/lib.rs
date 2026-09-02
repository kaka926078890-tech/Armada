mod attach;
mod cursor;
mod hub;
mod run_alert;

use hub::HubState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(HubState::default())
        .setup(|app| {
            run_alert::initialize(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hub::create_fleet,
            hub::join_fleet,
            hub::quit_owned_hub,
            attach::local_attach,
            cursor::cdp_status,
            cursor::open_workspace,
            cursor::pick_workspace,
            run_alert::show_run_alert
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            hub::quit_owned_inner(&app_handle.state::<HubState>());
        }
    });
}
