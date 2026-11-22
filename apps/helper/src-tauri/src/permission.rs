//! Screen Recording onboarding for window follow.
//!
//! macOS asks for the permission only when a sharer follows a shared window.
//! `Onboarding` is a plain state machine over a `ScreenAccess` provider so the
//! flow is tested without System Settings. `System` is the real provider.
//!
//! Helper never restarts for a grant. A process started after the grant sees
//! it, so Helper keeps running and captures through the `sampler` child.

use serde::Serialize;

pub const PROBE_FLAG: &str = "--check-screen-recording";

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
    Later,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    OpenSettings,
    HideTile,
    Follow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    Proceed,
    Panel,
}

#[derive(Serialize)]
pub struct View {
    phase: Phase,
}

#[derive(Default)]
pub struct Onboarding {
    phase: Phase,
    /// A new process saw a grant this one cannot use. Later shares skip the panel.
    granted_to_new_processes: bool,
}

impl Onboarding {
    pub fn view(&self) -> View {
        View { phase: self.phase }
    }

    /// True while the machine waits for a grant, so only then is a fresh
    /// process worth starting.
    pub fn watching(&self) -> bool {
        matches!(self.phase, Phase::Needed | Phase::SettingsOpen)
    }

    /// The sharer asked to follow the window.
    pub fn ask(&mut self, access: &impl ScreenAccess) -> Ask {
        if access.in_process() || self.granted_to_new_processes {
            self.phase = Phase::Idle;
            return Ask::Proceed;
        }
        if !self.watching() {
            self.phase = Phase::Needed;
        }
        Ask::Panel
    }

    pub fn open_settings(&mut self) -> Vec<Effect> {
        if self.phase == Phase::Idle {
            return Vec::new();
        }
        self.phase = Phase::SettingsOpen;
        vec![Effect::OpenSettings]
    }

    /// The sharer chose to wait. Only another explicit follow request asks again.
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
            if self.phase == Phase::Idle {
                return Vec::new();
            }
            self.phase = Phase::Idle;
            return vec![Effect::HideTile];
        }
        match self.phase {
            Phase::Needed | Phase::SettingsOpen
                if access.in_process() || access.fresh_process() =>
            {
                self.granted_to_new_processes = !access.in_process();
                self.phase = Phase::Idle;
                vec![Effect::HideTile, Effect::Follow]
            }
            _ => Vec::new(),
        }
    }
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

/// Whether this running process can capture the screen.
#[cfg(all(target_os = "macos", feature = "fixture"))]
pub fn in_process() -> bool {
    platform::in_process()
}

/// Start or replace the capture child while a granted window follow is active.
pub fn start_sampling() {
    platform::start_sampling();
}

/// Stop the capture child when the share ends.
pub fn stop_sampling() {
    platform::stop_sampling();
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

    pub fn start_sampling() {
        crate::sampler::shared().start();
    }

    pub fn stop_sampling() {
        crate::sampler::shared().stop();
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

    pub fn start_sampling() {}

    pub fn stop_sampling() {}
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
    fn a_window_share_without_access_waits_for_the_sharer_to_choose_follow() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        assert!(onboarding.tick(true, &fake).is_empty());
        assert_eq!(onboarding.view().phase, Phase::Idle);
        assert_eq!(onboarding.ask(&fake), Ask::Panel);
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
            vec![Effect::HideTile, Effect::Follow]
        );
        assert_eq!(onboarding.view().phase, Phase::Idle);
        assert!(onboarding.tick(true, &fake).is_empty());
    }

    #[test]
    fn a_grant_only_a_new_process_can_use_never_asks_for_a_restart() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        fake.fresh.set(true);
        let effects = onboarding.tick(true, &fake);
        assert_eq!(effects, vec![Effect::HideTile, Effect::Follow]);
        assert!(!fake.in_process.get());
    }

    #[test]
    fn after_such_a_grant_the_next_share_goes_straight_to_follow() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        fake.fresh.set(true);
        onboarding.tick(true, &fake);
        onboarding.tick(false, &fake);

        assert!(onboarding.tick(true, &fake).is_empty());
        assert_eq!(onboarding.ask(&fake), Ask::Proceed);
        assert_eq!(onboarding.view().phase, Phase::Idle);
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
        assert!(!onboarding.watching());
        onboarding.ask(&fake);
        assert!(onboarding.watching());
        assert_eq!(fake.fresh_calls.get(), 0);
        onboarding.tick(true, &fake);
        assert_eq!(fake.fresh_calls.get(), 1);
    }

    #[test]
    fn later_does_not_nag_during_the_share_and_asks_again_for_the_next() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        assert_eq!(onboarding.later(), vec![Effect::HideTile]);
        for _ in 0..5 {
            assert!(onboarding.tick(true, &fake).is_empty());
        }
        assert_eq!(onboarding.view().phase, Phase::Later);

        assert!(onboarding.tick(false, &fake).len() == 1);
        assert_eq!(onboarding.view().phase, Phase::Idle);
        assert!(onboarding.tick(true, &fake).is_empty());
        assert_eq!(onboarding.ask(&fake), Ask::Panel);
    }

    #[test]
    fn an_explicit_follow_request_brings_the_panel_back_after_later() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        onboarding.later();
        assert_eq!(onboarding.ask(&fake), Ask::Panel);
        assert_eq!(onboarding.view().phase, Phase::Needed);
    }

    #[test]
    fn ending_the_share_closes_the_panel() {
        let fake = Fake::default();
        let mut onboarding = Onboarding::default();
        onboarding.ask(&fake);
        onboarding.open_settings();
        assert_eq!(onboarding.tick(false, &fake), vec![Effect::HideTile]);
        assert_eq!(onboarding.view().phase, Phase::Idle);
    }

    #[test]
    fn this_platform_provider_matches_its_permission_model() {
        let granted = System.in_process();
        if cfg!(not(target_os = "macos")) {
            assert!(granted && System.fresh_process());
        }
    }
}
