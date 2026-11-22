#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod attachment;
mod credentials;
mod desktop;
mod device;
mod display_identity;
mod geometry;
mod helper_scene;
mod live;
mod pairing;
mod pairing_consent;
mod permission;
mod window_follow;
#[cfg(target_os = "windows")]
mod windows_key;

use desktop::{act, view};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_updater::UpdaterExt;

fn main() {
    // A new process answers whether it can capture the screen, so Helper can see a grant without restarting.
    if std::env::args().any(|arg| arg == permission::PROBE_FLAG) {
        std::process::exit(permission::probe_exit_code());
    }
    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        desktop::toggle_drawing(app);
                    }
                })
                .build(),
        )
        .manage(desktop::Desktop::default())
        .invoke_handler(tauri::generate_handler![view, act])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            if let (Some(endpoint), Some(key)) = (
                option_env!("CHALK_HELPER_UPDATE_ENDPOINT"),
                option_env!("CHALK_HELPER_UPDATE_PUBLIC_KEY"),
            ) {
                let endpoint: tauri::Url = endpoint.parse()?;
                if endpoint.scheme() != "https"
                    || endpoint.host_str().is_none()
                    || !endpoint.username().is_empty()
                    || endpoint.password().is_some()
                {
                    return Err("Helper updater requires an HTTPS manifest endpoint".into());
                }
                if key.trim().is_empty() {
                    return Err("Helper updater requires a pinned public key".into());
                }
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())?;
            }
            desktop::setup(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run Chalk Helper");
}

pub(crate) async fn check_for_update(app: tauri::AppHandle) -> Result<(), &'static str> {
    let endpoint = option_env!("CHALK_HELPER_UPDATE_ENDPOINT")
        .ok_or("No update channel is configured.")?
        .parse()
        .map_err(|_| "The update channel is invalid.")?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.build())
        .map_err(|_| "No update channel is configured.")?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|_| "Could not check for updates.")?
    else {
        return Ok(());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "Could not install the signed update.")?;
    app.restart();
}
