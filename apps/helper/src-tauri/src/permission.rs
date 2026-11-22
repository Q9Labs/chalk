//! Screen Recording onboarding for window follow.
//!
//! macOS asks for the permission only when a sharer follows a shared window.
//! `Onboarding` is a plain state machine over a `ScreenAccess` provider so the
//! flow is tested without System Settings. `System` is the real provider.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

pub const PROBE_FLAG: &str = "--check-screen-recording";
const RESUME_FILE: &str = "resume.json";
const RESUME_FRESH: Duration = Duration::from_secs(10 * 60);

/// What the process may capture. A process started after a grant sees it at
/// once. A running process keeps its old answer until it restarts.
pub trait ScreenAccess {
    fn in_process(&self) -> bool;
    fn fresh_process(&self) -> bool;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Needed,
    SettingsOpen,
    Restarting,
    Later,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    ShowPanel,
    OpenSettings,
    HideTile,
    Follow,
    Restart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Proceed,
    Panel,
}

#[derive(Serialize)]
pub struct View {
    phase: Phase,
    resumed: bool,
}

#[derive(Default)]
pub struct Onboarding {
    phase: Phase,
    asked_this_share: bool,
    resumed: bool,
}

impl Onboarding {
    pub fn after_restart(resumed: bool) -> Self {
        Self {
            resumed,
            ..Self::default()
        }
    }

    pub fn view(&self) -> View {
        View {
            phase: self.phase,
            resumed: self.resumed,
        }
    }

    /// True while the machine waits for a grant, so only then is a fresh
    /// process worth starting.
    pub fn watching(&self) -> bool {
        matches!(self.phase, Phase::Needed | Phase::SettingsOpen)
    }

    /// The sharer asked to follow the window.
    pub fn ask(&mut self, access: &impl ScreenAccess) -> Ask {
        self.asked_this_share = true;
        if access.in_process() {
            self.phase = Phase::Idle;
            return Ask::Proceed;
        }
        if !self.watching() {
            self.phase = Phase::Needed;
        }
        Ask::Panel
    }

    pub fn open_settings(&mut self) -> Vec<Effect> {
        if self.phase == Phase::Idle || self.phase == Phase::Restarting {
            return Vec::new();
        }
        self.phase = Phase::SettingsOpen;
        vec![Effect::OpenSettings]
    }

    /// The sharer chose to wait. Nothing asks again until a new share or an
    /// explicit follow request.
    pub fn later(&mut self) -> Vec<Effect> {
        if !self.watching() {
            return Vec::new();
        }
        self.phase = Phase::Later;
        vec![Effect::HideTile]
    }

    /// Runs about once a second with whether a window share is active.
    pub fn tick(&mut self, window_share: bool, access: &impl ScreenAccess) -> Vec<Effect> {
        if !window_share {
            self.asked_this_share = false;
            if matches!(self.phase, Phase::Idle | Phase::Restarting) {
                return Vec::new();
            }
            self.phase = Phase::Idle;
            return vec![Effect::HideTile];
        }
        self.resumed = false;
        match self.phase {
            Phase::Needed | Phase::SettingsOpen if access.in_process() => {
                self.phase = Phase::Idle;
                vec![Effect::HideTile, Effect::Follow]
            }
            Phase::Needed | Phase::SettingsOpen if access.fresh_process() => {
                self.phase = Phase::Restarting;
                vec![Effect::HideTile, Effect::Restart]
            }
            Phase::Idle if !self.asked_this_share && !access.in_process() => {
                self.asked_this_share = true;
                self.phase = Phase::Needed;
                vec![Effect::ShowPanel]
            }
            _ => Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
struct Resume {
    at_ms: u64,
}

pub fn resume_path(config_dir: &Path) -> PathBuf {
    config_dir.join(RESUME_FILE)
}

pub fn write_resume(path: &Path, now_ms: u64) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec(&Resume { at_ms: now_ms })?)
}

/// Reads and removes the restart note. It is true only for a recent one.
pub fn take_resume(path: &Path, now_ms: u64) -> bool {
    let note = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Resume>(&bytes).ok());
    let _ = fs::remove_file(path);
    note.is_some_and(|note| now_ms.saturating_sub(note.at_ms) <= RESUME_FRESH.as_millis() as u64)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A process started with `PROBE_FLAG` answers whether it can capture the
/// screen and exits. The running Helper starts one to see a new grant.
pub fn probe_exit_code() -> i32 {
    i32::from(!platform::in_process())
}

/// One reading of the system, so the state machine can run under a lock
/// while the slow check happens outside it.
pub struct Observed {
    in_process: bool,
    fresh_process: bool,
}

impl Observed {
    pub fn take(watching: bool) -> Self {
        let in_process = System.in_process();
        Self {
            in_process,
            fresh_process: watching && !in_process && System.fresh_process(),
        }
    }
}

impl ScreenAccess for Observed {
    fn in_process(&self) -> bool {
        self.in_process
    }

    fn fresh_process(&self) -> bool {
        self.fresh_process
    }
}

pub struct System;

impl ScreenAccess for System {
    fn in_process(&self) -> bool {
        platform::in_process()
    }

    fn fresh_process(&self) -> bool {
        platform::fresh_process()
    }
}

/// Call on the main thread.
pub fn open_system_settings() {
    platform::open_system_settings();
}

/// Call on the main thread.
pub fn show_tile() {
    platform::show_tile();
}

/// Call on the main thread.
pub fn hide_tile() {
    platform::hide_tile();
}

pub fn reveal_in_finder() {
    platform::reveal_in_finder();
}

pub fn relaunch(app: &tauri::AppHandle, resume: &Path) {
    if let Err(error) = write_resume(resume, now_ms()) {
        eprintln!("chalk-helper: resume_note_failed {error}");
    }
    platform::relaunch(app);
}

#[cfg(target_os = "macos")]
mod platform {
    use std::{
        ffi::{c_char, CString},
        path::PathBuf,
        process::Command,
    };

    extern "C" {
        fn chalk_screen_access() -> bool;
        fn chalk_tile_show(bundle: *const c_char);
        fn chalk_tile_hide();
    }

    const SCREEN_RECORDING_PANE: &str =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

    pub fn in_process() -> bool {
        // Plain query of this process's capture access; it never prompts.
        unsafe { chalk_screen_access() }
    }

    pub fn fresh_process() -> bool {
        std::env::current_exe()
            .ok()
            .and_then(|exe| Command::new(exe).arg(super::PROBE_FLAG).status().ok())
            .is_some_and(|status| status.success())
    }

    pub fn open_system_settings() {
        if Command::new("/usr/bin/open")
            .arg(SCREEN_RECORDING_PANE)
            .status()
            .is_err()
        {
            eprintln!("chalk-helper: system_settings_unavailable");
        }
    }

    /// The `.app` that contains this executable, when it runs from one.
    fn bundle() -> Option<PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let bundle = exe.ancestors().nth(3)?;
        (bundle.extension()? == "app").then(|| bundle.to_path_buf())
    }

    pub fn show_tile() {
        let Some(path) = bundle().and_then(|bundle| CString::new(bundle.to_str()?).ok()) else {
            eprintln!("chalk-helper: tile_needs_app_bundle");
            return;
        };
        // The bridge copies the path before it returns.
        unsafe { chalk_tile_show(path.as_ptr()) }
    }

    pub fn hide_tile() {
        unsafe { chalk_tile_hide() }
    }

    pub fn reveal_in_finder() {
        if let Some(bundle) = bundle() {
            let _ = Command::new("/usr/bin/open").arg("-R").arg(bundle).status();
        }
    }

    /// Start a new instance once this one has released the pairing port.
    pub fn relaunch(app: &tauri::AppHandle) {
        let Some(bundle) = bundle() else {
            app.restart();
        };
        let wait_then_open = format!(
            "while kill -0 {} 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$1\"",
            std::process::id()
        );
        if Command::new("/bin/sh")
            .args(["-c", &wait_then_open, "sh"])
            .arg(bundle)
            .spawn()
            .is_err()
        {
            app.restart();
        }
        app.exit(0);
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    // Windows has no capture permission, so a share needs nothing from the sharer.
    pub fn in_process() -> bool {
        true
    }

    pub fn fresh_process() -> bool {
        true
    }

    pub fn open_system_settings() {}

    pub fn show_tile() {}

    pub fn hide_tile() {}

    pub fn reveal_in_finder() {}

    pub fn relaunch(app: &tauri::AppHandle) {
        app.restart();
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[derive(Default)]
    struct Fake {
        in_process: Cell<bool>,
        fresh: Cell<bool>,
        fresh_calls: Cell<u32>,
    }

    impl ScreenAccess for Fake {
        fn in_process(&self) -> bool {
            self.in_process.get()
        }

        fn fresh_process(&self) -> bool {
            self.fresh_calls.set(self.fresh_calls.get() + 1);
            self.fresh.get()
        }
    }

    #[test]
    fn granted_access_follows_without_a_panel() {
        let fake = Fake::default();
        fake.in_process.set(true);
        let mut onboarding = Onboarding::default();
        assert_eq!(onboarding.ask(&fake), Ask::Proceed);
        assert_eq!(onboarding.view().phase, Phase::Idle);
        assert!(onboarding.tick(true, &fake).is_empty());
    }

    #[test]
    fn a_window_share_without_access_shows_the_panel_once() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        assert_eq!(onboarding.tick(true, &fake), vec![Effect::ShowPanel]);
        assert_eq!(onboarding.view().phase, Phase::Needed);
        assert!(onboarding.tick(true, &fake).is_empty());
    }

    #[test]
    fn the_sharer_can_open_settings_and_the_grant_is_seen_without_a_click() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        assert_eq!(onboarding.ask(&fake), Ask::Panel);
        assert_eq!(onboarding.open_settings(), vec![Effect::OpenSettings]);
        assert_eq!(onboarding.view().phase, Phase::SettingsOpen);
        assert!(onboarding.tick(true, &fake).is_empty());

        fake.fresh.set(true);
        assert_eq!(
            onboarding.tick(true, &fake),
            vec![Effect::HideTile, Effect::Restart]
        );
        assert_eq!(onboarding.view().phase, Phase::Restarting);
        assert!(onboarding.tick(true, &fake).is_empty());
    }

    #[test]
    fn a_grant_the_running_process_can_use_needs_no_restart() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        onboarding.open_settings();
        fake.in_process.set(true);
        fake.fresh.set(true);
        assert_eq!(
            onboarding.tick(true, &fake),
            vec![Effect::HideTile, Effect::Follow]
        );
        assert_eq!(onboarding.view().phase, Phase::Idle);
    }

    #[test]
    fn a_fresh_process_is_started_only_while_waiting_for_a_grant() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        assert!(!onboarding.watching());
        onboarding.tick(false, &fake);
        onboarding.tick(true, &fake);
        assert!(onboarding.watching());
        assert_eq!(fake.fresh_calls.get(), 0);
        onboarding.tick(true, &fake);
        assert_eq!(fake.fresh_calls.get(), 1);
    }

    #[test]
    fn later_does_not_nag_during_the_share_and_asks_again_for_the_next() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.tick(true, &fake);
        assert_eq!(onboarding.later(), vec![Effect::HideTile]);
        for _ in 0..5 {
            assert!(onboarding.tick(true, &fake).is_empty());
        }
        assert_eq!(onboarding.view().phase, Phase::Later);

        assert!(onboarding.tick(false, &fake).len() == 1);
        assert_eq!(onboarding.view().phase, Phase::Idle);
        assert_eq!(onboarding.tick(true, &fake), vec![Effect::ShowPanel]);
    }

    #[test]
    fn an_explicit_follow_request_brings_the_panel_back_after_later() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.tick(true, &fake);
        onboarding.later();
        assert_eq!(onboarding.ask(&fake), Ask::Panel);
        assert_eq!(onboarding.view().phase, Phase::Needed);
    }

    #[test]
    fn ending_the_share_closes_the_panel() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.tick(true, &fake);
        onboarding.open_settings();
        assert_eq!(onboarding.tick(false, &fake), vec![Effect::HideTile]);
        assert_eq!(onboarding.view().phase, Phase::Idle);
    }

    #[test]
    fn a_restart_keeps_the_note_until_the_next_share_starts() {
        let fake = Fake::default();
        fake.in_process.set(true);
        let mut onboarding = Onboarding::after_restart(true);
        assert!(onboarding.view().resumed);
        onboarding.tick(true, &fake);
        assert!(!onboarding.view().resumed);
    }

    #[test]
    fn a_recent_restart_note_is_used_once() {
        let dir = tempdir("resume-fresh");
        let path = resume_path(&dir);
        write_resume(&path, 1_000).unwrap();
        assert!(take_resume(&path, 1_000 + 60_000));
        assert!(!take_resume(&path, 1_000 + 60_000));
    }

    #[test]
    fn a_stale_or_damaged_restart_note_is_ignored_and_removed() {
        let dir = tempdir("resume-stale");
        let path = resume_path(&dir);
        write_resume(&path, 1_000).unwrap();
        assert!(!take_resume(
            &path,
            1_000 + RESUME_FRESH.as_millis() as u64 + 1
        ));
        assert!(!path.exists());
        fs::write(&path, b"not json").unwrap();
        assert!(!take_resume(&path, 1_000));
        assert!(!path.exists());
    }

    #[test]
    fn this_platform_provider_matches_its_permission_model() {
        let granted = System.in_process();
        if cfg!(not(target_os = "macos")) {
            assert!(granted && System.fresh_process());
        }
    }

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("chalk-helper-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
