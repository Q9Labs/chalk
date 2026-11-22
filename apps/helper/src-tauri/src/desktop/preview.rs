//! Development builds can open Settings in one onboarding state and save
//! PNGs of their own windows: `--preview=<state> [--snapshot=<dir>]`.
//! Real Helper windows are excluded from capture, so preview Settings is not.
//!
//! `--preview=sampler --snapshot=<dir>` writes `sampler.txt`: a timeline that
//! walks the real state machine and the real capture child through a grant
//! and a child crash, with Helper's process ID on every line.

use std::{path::PathBuf, time::Duration};

use tauri::{AppHandle, Manager};

use super::{apply, create_settings, Desktop};
use crate::permission::{Onboarding, ScreenAccess};

#[cfg(target_os = "macos")]
extern "C" {
    fn chalk_tile_snapshot(path: *const std::ffi::c_char) -> bool;
    fn chalk_webview_snapshot(window: *mut std::ffi::c_void, path: *const std::ffi::c_char);
    fn chalk_preview_settings_window(rect: *mut i32) -> u32;
}

const STATES: [&str; 5] = ["first_run", "needed", "settings", "later", "sampler"];

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
    if state == "sampler" {
        return run_sampler(app);
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
fn run_sampler(app: &AppHandle) -> tauri::Result<()> {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(dir) = snapshot_dir() {
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(dir.join("sampler.txt"), sampler_timeline());
        }
        app.exit(0);
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn run_sampler(_: &AppHandle) -> tauri::Result<()> {
    Err(std::io::Error::other("The capture child exists only on macOS.").into())
}

/// One line per half second. Window bounds come from this process and need no
/// permission, but Helper reports none while any window sits above the target,
/// and some displays always have one (the Dock's full-screen layer). Pixels
/// come from the capture child, which succeeds only where Screen Recording is
/// on for Helper.
#[cfg(target_os = "macos")]
fn sampler_timeline() -> String {
    use std::fmt::Write;

    use crate::{permission, sampler, window_follow};

    let _ = std::process::Command::new("/usr/bin/open")
        .args(["-a", "System Settings"])
        .status();
    std::thread::sleep(Duration::from_secs(3));
    // The window of another app, because Helper does not report its own windows.
    let mut listed = [0i32; 4];
    // The bridge fills four integers and never keeps the pointer.
    let window = u64::from(unsafe { chalk_preview_settings_window(listed.as_mut_ptr()) });
    let helper = std::process::id();

    let denied = Reading {
        in_process: false,
        fresh: false,
    };
    let granted_to_new_processes = Reading {
        in_process: false,
        fresh: true,
    };
    let mut onboarding = Onboarding::default();
    let mut log = String::new();
    let _ = writeln!(log, "helper pid {helper}, target window {window}");
    let _ = writeln!(
        log,
        "window list bounds (no permission needed): {},{} {}x{}",
        listed[0], listed[1], listed[2], listed[3]
    );
    let _ = writeln!(
        log,
        "this process can capture: {}",
        permission::in_process()
    );
    let _ = writeln!(
        log,
        "Follow captured window, no grant: {:?}",
        onboarding.ask(&denied)
    );

    let mut pixels = vec![0; window_follow::SAMPLES];
    let mut following = false;
    let mut crashed_child = None;
    for step in 0..12 {
        if step == 4 {
            let effects = onboarding.tick(true, &granted_to_new_processes);
            let _ = writeln!(log, "tick, grant seen by a new process: {effects:?}");
            permission::start_sampling();
            following = true;
        }
        if step == 8 {
            if let Some(child) = sampler::shared().child_id() {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-9", &child.to_string()])
                    .status();
                crashed_child = Some(child);
                let _ = writeln!(log, "killed capture child {child}");
            }
        }
        let mut now = [0i32; 4];
        // The bridge fills four integers and never keeps the pointer.
        unsafe { chalk_preview_settings_window(now.as_mut_ptr()) };
        let bounds = window_follow::observe(window)
            .map(|seen| {
                let rect = seen.bounds;
                format!("{},{} {}x{}", rect.x, rect.y, rect.width, rect.height)
            })
            .unwrap_or_else(|| "none".to_owned());
        let capture = following.then(|| sampler::shared().sample(window as u32, 0.0, &mut pixels));
        let _ = writeln!(
            log,
            "t={:>4}ms helper pid {} window list {},{} {}x{} observe [{bounds}] child {:?} pixels {}",
            step * 500,
            std::process::id(),
            now[0],
            now[1],
            now[2],
            now[3],
            sampler::shared().child_id(),
            match capture {
                None => "not asked yet",
                Some(true) => "received",
                Some(false) => "refused (permission or capture unavailable)",
            }
        );
        std::thread::sleep(Duration::from_millis(500));
    }
    permission::stop_sampling();
    let _ = writeln!(
        log,
        "stopped: capture child {:?}, helper pid still {}",
        sampler::shared().child_id(),
        std::process::id()
    );
    if let Some(child) = crashed_child {
        let _ = writeln!(log, "crashed child was {child}");
    }
    log
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
