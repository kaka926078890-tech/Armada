use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunAlertClicked {
    run_id: String,
    machine_id: String,
    workspace_root: String,
}

fn emit_clicked(run_id: &str, machine_id: &str, workspace_root: &str) {
    let Some(handle) = APP_HANDLE.get() else {
        return;
    };
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = handle.emit(
        "run-alert-clicked",
        RunAlertClicked {
            run_id: run_id.to_string(),
            machine_id: machine_id.to_string(),
            workspace_root: workspace_root.to_string(),
        },
    );
}

#[tauri::command]
pub fn show_run_alert(
    run_id: String,
    machine_id: String,
    workspace_root: String,
    title: String,
    body: String,
    launch_uri: Option<String>,
) {
    #[cfg(target_os = "macos")]
    {
        let _ = &launch_uri;
        macos::show(&run_id, &machine_id, &workspace_root, &title, &body);
    }
    #[cfg(windows)]
    windows_toast::show(
        &run_id,
        &machine_id,
        &workspace_root,
        &title,
        &body,
        launch_uri.as_deref().unwrap_or(""),
    );
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (
        run_id,
        machine_id,
        workspace_root,
        title,
        body,
        launch_uri,
    );
}

pub fn initialize(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
    #[cfg(target_os = "macos")]
    macos::initialize();
}

#[cfg(windows)]
mod windows_toast {
    use super::emit_clicked;
    use tauri_winrt_notification::Toast;

    const APP_ID: &str = "com.armada.desktop";

    fn xml_attr(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('\'', "&apos;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub fn show(
        run_id: &str,
        machine_id: &str,
        workspace_root: &str,
        title: &str,
        body: &str,
        launch_uri: &str,
    ) {
        let rid = run_id.to_string();
        let mid = machine_id.to_string();
        let root = workspace_root.to_string();
        let mut toast = Toast::new(APP_ID).title(title).text1(body);
        if !launch_uri.is_empty() {
            // Crate writes arguments into XML unescaped; URI query `&` would break LoadXml.
            toast = toast.add_button("打开", &xml_attr(launch_uri));
        }
        let _ = toast
            .on_activated(move |_action| {
                emit_clicked(&rid, &mid, &root);
                Ok(())
            })
            .show();
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::sync::{
        Once,
        atomic::{AtomicBool, Ordering},
    };

    use block2::RcBlock;
    use objc2::{
        AllocAnyThread, define_class, msg_send,
        rc::Retained,
        runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject},
    };
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString, ns_string};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    static AVAILABLE: AtomicBool = AtomicBool::new(false);

    fn center() -> Retained<UNUserNotificationCenter> {
        UNUserNotificationCenter::currentNotificationCenter()
    }

    define_class!(
        #[unsafe(super = NSObject)]
        #[name = "ArmadaRunAlertDelegate"]
        #[derive(Debug)]
        struct ArmadaRunAlertDelegate;

        unsafe impl NSObjectProtocol for ArmadaRunAlertDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for ArmadaRunAlertDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            unsafe fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                let options = UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound
                    | UNNotificationPresentationOptions::Banner;
                completion_handler.call((options,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            unsafe fn did_receive_notification(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let user_info = response.notification().request().content().userInfo();
                let run_id = ns_value(&user_info, "runId");
                let machine_id = ns_value(&user_info, "machineId");
                let workspace_root = ns_value(&user_info, "workspaceRoot");
                if let (Some(run_id), Some(machine_id), Some(workspace_root)) =
                    (run_id, machine_id, workspace_root)
                {
                    emit_clicked(&run_id, &machine_id, &workspace_root);
                }
                completion_handler.call(());
            }
        }
    );

    impl ArmadaRunAlertDelegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    fn ns_value(dict: &NSDictionary, key: &str) -> Option<String> {
        let value = dict.objectForKey(&NSString::from_str(key))?;
        value.downcast_ref::<NSString>().map(|s| s.to_string())
    }

    pub fn initialize() {
        static INIT: Once = Once::new();
        INIT.call_once(|| {
            let has_bundle = NSBundle::mainBundle().bundleIdentifier().is_some();
            if !has_bundle {
                return;
            }
            AVAILABLE.store(true, Ordering::Relaxed);
            center().requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &RcBlock::new(|ok: Bool, _err: *mut NSError| {
                    if ok.is_false() {
                        AVAILABLE.store(false, Ordering::Relaxed);
                    }
                }),
            );
            let delegate = ArmadaRunAlertDelegate::new();
            let delegate_proto = ProtocolObject::from_retained(delegate.clone());
            center().setDelegate(Some(&delegate_proto));
            let _ = Retained::into_raw(delegate);
        });
    }

    pub fn show(run_id: &str, machine_id: &str, workspace_root: &str, title: &str, body: &str) {
        if !AVAILABLE.load(Ordering::Relaxed) {
            return;
        }
        unsafe {
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(title));
            content.setBody(&NSString::from_str(body));
            let keys: [&NSString; 3] = [
                ns_string!("runId"),
                ns_string!("machineId"),
                ns_string!("workspaceRoot"),
            ];
            let run = NSString::from_str(run_id);
            let machine = NSString::from_str(machine_id);
            let root = NSString::from_str(workspace_root);
            let values: [&NSString; 3] = [&run, &machine, &root];
            let info = NSDictionary::from_slices(&keys, &values);
            let info = Retained::cast_unchecked::<NSDictionary>(info);
            content.setUserInfo(&info);
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(run_id),
                &content,
                None,
            );
            center().addNotificationRequest_withCompletionHandler(
                &request,
                Some(&RcBlock::new(move |err: *mut NSError| {
                    let _ = err;
                })),
            );
        }
    }
}
