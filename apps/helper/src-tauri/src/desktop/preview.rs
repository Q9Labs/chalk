//! Development builds can open Settings in one onboarding state and save
//! PNGs of their own windows: `--preview=<state> [--snapshot=<dir>]`.
//! Real Helper windows are excluded from capture, so preview Settings is not.

use std::{path::PathBuf, time::Duration};

use tauri::{AppHandle, Manager};

use super::{apply, create_settings, Desktop};
use crate::permission::{Onboarding, ScreenAccess};

#[cfg(target_os = "macos")]
extern "C" {
    fn chalk_tile_snapshot(path: *const std::ffi::c_char) -> bool;
    fn chalk_webview_snapshot(window: *mut std::ffi::c_void, path: *const std::ffi::c_char);
}

const STATES: [&str; 6] = [
    "first_run",
    "needed",
    "settings",
    "restarting",
    "resumed",
    "later",
];

struct Reading {
    in_process: bool,
    fresh: bool,
}

impl ScreenAccess for Reading {
    fn in_process(&self) -> bool {
        self.in_process
    }

    fn fresh_process(&self) -> bool {
        self.fresh
    }
}

pub fn requested() -> Option<String> {
    std::env::args().find_map(|arg| arg.strip_prefix("--preview=").map(str::to_owned))
}

fn snapshot_dir() -> Option<PathBuf> {
    std::env::args().find_map(|arg| arg.strip_prefix("--snapshot=").map(PathBuf::from))
}

pub fn run(app: &AppHandle, state: &str) -> tauri::Result<()> {
    if !STATES.contains(&state) {
        return Err(std::io::Error::other(format!("Unknown preview state {state}.")).into());
    }
    create_settings(app)?;
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| std::io::Error::other("Settings are not ready."))?;
    window.set_content_protected(false)?;
    window.show()?;

    let denied = Reading {
        in_process: false,
        fresh: false,
    };
    let granted_after_restart = Reading {
        in_process: false,
        fresh: true,
    };
    let mut onboarding = Onboarding::default();
    let mut effects = Vec::new();
    match state {
        "needed" => {
            onboarding.ask(&denied);
        }
        "settings" => {
            onboarding.ask(&denied);
            effects = onboarding.open_settings();
        }
        "restarting" => {
            onboarding.ask(&denied);
            onboarding.open_settings();
            // The restart effect is dropped: a preview must not restart itself.
            onboarding.tick(true, &granted_after_restart);
        }
        "resumed" => onboarding = Onboarding::after_restart(true),
        "later" => {
            onboarding.ask(&denied);
            onboarding.later();
        }
        _ => {}
    }
    app.state::<Desktop>()
        .0
        .lock()
        .expect("Helper state")
        .permission = onboarding;
    apply(app, effects);

    let app = app.clone();
    let state = state.to_owned();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        if let Some(dir) = snapshot_dir() {
            snapshot(&app, &dir, &state);
            std::thread::sleep(Duration::from_millis(1500));
            app.exit(0);
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn snapshot(app: &AppHandle, dir: &std::path::Path, state: &str) {
    let _ = std::fs::create_dir_all(dir);
    let panel = dir.join(format!("{state}.png"));
    let tile = dir.join(format!("{state}-tile.png"));
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let (Some(window), Some(panel), Some(tile)) = (
            handle.get_webview_window("settings"),
            std::ffi::CString::new(panel.to_string_lossy().as_bytes()).ok(),
            std::ffi::CString::new(tile.to_string_lossy().as_bytes()).ok(),
        ) else {
            return;
        };
        if let Ok(native) = window.ns_window() {
            // The paths are copied before each call returns.
            unsafe {
                chalk_webview_snapshot(native, panel.as_ptr());
                chalk_tile_snapshot(tile.as_ptr());
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_: &AppHandle, _: &std::path::Path, _: &str) {}
