use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use ring::rand::{SecureRandom, SystemRandom};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{
    desktop,
    display_identity::Display,
    geometry::Rect,
    helper_scene::Scene,
    window_follow::{self, Identity, Observation, Projection},
};

const PROBE_LIMIT: Duration = Duration::from_secs(4);
const UPDATE_LIMIT: Duration = Duration::from_secs(6);
pub const OVERLAY: &str = "ink-live";

#[derive(Default)]
pub struct Capture {
    frame: Option<(u32, u32)>,
    window: Option<FollowWindow>,
    selected: Option<Rect>,
    display: Option<Display>,
    probe: Option<Probe>,
    ready: bool,
    unsupported: bool,
    scene: Option<Scene>,
    drawing: bool,
    draft: Option<PenCommit>,
    commits: VecDeque<PenCommit>,
}

struct FollowWindow {
    id: u64,
    identity: Option<Identity>,
    match_sample: Option<WindowMatch>,
    projection: Option<Projection>,
}

impl FollowWindow {
    fn projection_on_screen(&self) -> Option<(Rect, Rect)> {
        let projection = self.projection?;
        let observed = window_follow::observe(self.id)
            .filter(|current| Some(current.identity) == self.identity)?;
        Some((observed.bounds, projection.at(observed.bounds)?))
    }
}

struct WindowMatch {
    observed: Observation,
    projection: Projection,
    frame: (u32, u32),
    checked_at: Instant,
}

struct Probe {
    spec: ProbeSpec,
    started: Instant,
    protected: bool,
    painted: bool,
}

#[derive(Clone, Serialize)]
pub struct ProbeSpec {
    nonce: String,
    points: [Landmark; 3],
}

#[derive(Clone, Serialize)]
struct Landmark {
    x: f64,
    y: f64,
    rgb: [u8; 3],
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Overlay {
    Probe {
        bounds: Rect,
        spec: ProbeSpec,
    },
    Ink {
        bounds: Rect,
        scene: Scene,
        draft: Vec<InkPoint>,
    },
}

#[derive(Clone, Serialize)]
pub struct InkPoint {
    x: u32,
    y: u32,
}

#[derive(Clone, Serialize)]
pub struct PenCommit {
    pub fence: u64,
    pub width: u32,
    pub points: Vec<InkPoint>,
}

impl Capture {
    pub fn describe(
        &mut self,
        surface: &str,
        width: u32,
        height: u32,
        window_id: Option<&str>,
    ) -> Result<(), ()> {
        if self.frame.is_some()
            || self.unsupported
            || !(1..=16_384).contains(&width)
            || !(1..=16_384).contains(&height)
        {
            return Err(());
        }
        if surface == "monitor" {
            self.frame = Some((width, height));
        } else if let ("window", Some(id)) = (
            surface,
            window_id
                .and_then(|raw| raw.parse::<u64>().ok())
                .filter(|&id| id > 0),
        ) {
            self.frame = Some((width, height));
            self.window = Some(FollowWindow {
                id,
                identity: None,
                match_sample: None,
                projection: None,
            });
        } else {
            self.unsupported = true;
        }
        Ok(())
    }

    pub fn offers_window(&self) -> bool {
        !self.unsupported
            && self
                .window
                .as_ref()
                .is_some_and(|window| window.identity.is_none())
    }

    pub fn enable_follow(&mut self) -> Result<(), &'static str> {
        let window = self
            .window
            .as_mut()
            .filter(|window| window.identity.is_none())
            .ok_or("Bring the captured window to the front, then try again.")?;
        window.identity = Some(
            window_follow::observe(window.id)
                .ok_or("Bring the captured window to the front, then try again.")?
                .identity,
        );
        Ok(())
    }

    pub fn window_id(&self) -> Option<(u64, Identity)> {
        self.window
            .as_ref()
            .and_then(|window| Some((window.id, window.identity?)))
    }

    pub fn record_window_match(
        &mut self,
        observed: Observation,
        projection: Projection,
        frame: (u32, u32),
    ) -> Result<(), ()> {
        let window = self
            .window
            .as_mut()
            .filter(|window| window.identity == Some(observed.identity))
            .ok_or(())?;
        window.match_sample = Some(WindowMatch {
            observed,
            projection,
            frame,
            checked_at: Instant::now(),
        });
        Ok(())
    }

    pub fn start_window_probe(&mut self, app: &AppHandle) -> Result<ProbeSpec, ()> {
        let WindowMatch {
            observed,
            projection,
            frame,
            checked_at,
        } = self
            .window
            .as_mut()
            .and_then(|window| window.match_sample.take())
            .ok_or(())?;
        if checked_at.elapsed() > Duration::from_secs(2) {
            return Err(());
        }
        let (id, identity) = self.window_id().ok_or(())?;
        if self.ready
            || self.probe.is_some()
            || self.unsupported
            || observed.identity != identity
            || !window_follow::observe(id).is_some_and(|current| {
                current.identity == identity && current.bounds == observed.bounds
            })
            || !app.available_monitors().is_ok_and(|monitors| {
                monitors.iter().any(|monitor| {
                    observed.bounds.intersect(desktop::monitor_bounds(monitor))
                        == Some(observed.bounds)
                })
            })
        {
            return Err(());
        }
        let bounds = projection.at(observed.bounds).ok_or(())?;
        let spec = make_probe()?;
        if desktop::show_live_overlay(app, bounds, true).is_err() {
            self.await_window(app);
            return Err(());
        }
        self.frame = Some(frame);
        self.window.as_mut().ok_or(())?.projection = Some(projection);
        self.selected = Some(bounds);
        self.probe = Some(Probe {
            spec: spec.clone(),
            started: Instant::now(),
            protected: true,
            painted: false,
        });
        Ok(spec)
    }

    pub fn reconcile_window(&mut self, app: &AppHandle) -> bool {
        let Some(window) = self
            .window
            .as_ref()
            .filter(|window| window.identity.is_some())
        else {
            return false;
        };
        let Some(old) = self.selected else {
            return true;
        };
        if let Some((outer, next)) = window.projection_on_screen() {
            if next == old && self.allows_window() {
                self.disable_stale_input(app);
                return true;
            }
            if self.ready
                && !self.drawing
                && app.available_monitors().is_ok_and(|monitors| {
                    monitors.iter().any(|monitor| {
                        outer.intersect(desktop::monitor_bounds(monitor)) == Some(outer)
                    })
                })
                && desktop::show_live_overlay(app, next, true).is_ok()
            {
                self.selected = Some(next);
                return true;
            }
        }
        self.await_window(app);
        true
    }

    pub fn await_window(&mut self, app: &AppHandle) {
        self.ready = false;
        self.selected = None;
        if let Some(window) = self.window.as_mut() {
            window.projection = None;
            window.match_sample = None;
        }
        self.probe = None;
        self.scene = None;
        self.draft = None;
        self.commits.clear();
        self.drawing = false;
        hide(app);
    }

    pub fn offers_monitors(&self) -> bool {
        self.frame.is_some()
            && self.window.is_none()
            && self.selected.is_none()
            && !self.unsupported
    }

    pub fn select(&mut self, bounds: Rect) -> Result<(), ()> {
        if !self.offers_monitors() || bounds.width < 320 || bounds.height < 240 {
            return Err(());
        }
        self.display = Some(Display::at(bounds).ok_or(())?);
        self.selected = Some(bounds);
        Ok(())
    }

    pub fn status(&self) -> &'static str {
        if self.unsupported
            || self
                .probe
                .as_ref()
                .is_some_and(|p| !self.ready && p.started.elapsed() >= PROBE_LIMIT)
        {
            "unsupported_surface"
        } else if self.ready {
            "ready"
        } else if self.selected.is_some() || self.window_id().is_some() {
            "calibrating"
        } else {
            "unbound"
        }
    }

    pub fn start(&mut self, app: &AppHandle) -> Result<ProbeSpec, ()> {
        let bounds = self.selected.ok_or(())?;
        if self.probe.is_some() || self.unsupported {
            return Err(());
        }
        let spec = make_probe()?;
        self.probe = Some(Probe {
            spec: spec.clone(),
            started: Instant::now(),
            protected: false,
            painted: false,
        });
        if desktop::show_live_overlay(app, bounds, false).is_err() {
            self.fail(app);
            return Err(());
        }
        Ok(spec)
    }

    pub fn acknowledge_paint(&mut self, nonce: &str) {
        if let Some(probe) = self
            .probe
            .as_mut()
            .filter(|probe| probe.spec.nonce == nonce && probe.started.elapsed() < PROBE_LIMIT)
        {
            probe.painted = true;
        }
    }

    pub fn painted(&self, nonce: &str) -> Result<(), ()> {
        self.probe
            .as_ref()
            .filter(|probe| {
                probe.painted && probe.spec.nonce == nonce && probe.started.elapsed() < PROBE_LIMIT
            })
            .map(|_| ())
            .ok_or(())
    }

    pub fn protect(&mut self, app: &AppHandle, nonce: &str) -> Result<(), ()> {
        self.painted(nonce)?;
        let probe = self
            .probe
            .as_mut()
            .filter(|probe| {
                !probe.protected
                    && probe.started.elapsed() < PROBE_LIMIT
                    && probe.spec.nonce == nonce
            })
            .ok_or(())?;
        let window = app.get_webview_window(OVERLAY).ok_or(())?;
        if desktop::verify_capture_affinity(&window).is_err() {
            self.fail(app);
            return Err(());
        }
        probe.protected = true;
        Ok(())
    }

    pub fn complete(&mut self, app: &AppHandle, nonce: &str) -> Result<(), ()> {
        self.painted(nonce)?;
        let probe = self
            .probe
            .as_ref()
            .filter(|probe| {
                probe.protected
                    && probe.started.elapsed() < PROBE_LIMIT
                    && probe.spec.nonce == nonce
            })
            .ok_or(())?;
        let _ = probe;
        if self.window.is_some() && !self.projection_is_current() {
            self.await_window(app);
            return Err(());
        }
        let window = app.get_webview_window(OVERLAY).ok_or(())?;
        if desktop::verify_capture_affinity(&window).is_err() {
            self.fail(app);
            return Err(());
        }
        self.ready = true;
        self.probe = None;
        Ok(())
    }

    pub fn fail(&mut self, app: &AppHandle) {
        self.unsupported = true;
        self.ready = false;
        self.scene = None;
        self.draft = None;
        self.commits.clear();
        self.drawing = false;
        self.probe = None;
        hide(app);
    }

    pub fn get_overlay(&self) -> Option<Overlay> {
        let bounds = self.selected?;
        if let Some(probe) = self
            .probe
            .as_ref()
            .filter(|p| p.started.elapsed() < PROBE_LIMIT)
        {
            return Some(Overlay::Probe {
                bounds,
                spec: probe.spec.clone(),
            });
        }
        let mut scene = self
            .scene
            .clone()
            .filter(|scene| self.ready && scene.observed_at.elapsed() < UPDATE_LIMIT)?;
        scene.render_now();
        let draft = self
            .draft
            .as_ref()
            .filter(|draft| draft.fence == scene.fence)
            .map(|draft| draft.points.clone())
            .unwrap_or_default();
        Some(Overlay::Ink {
            bounds,
            scene,
            draft,
        })
    }

    pub fn accept_scene(&mut self, snapshot: Scene) {
        match &mut self.scene {
            Some(scene) => scene.refresh(snapshot),
            None => self.scene = Some(snapshot),
        }
    }

    pub fn scene_mut(&mut self) -> Option<&mut Scene> {
        self.scene.as_mut()
    }

    pub fn suspend_scene(&mut self) {
        self.scene = None;
        self.draft = None;
        self.commits.clear();
        self.drawing = false;
        self.probe = None;
    }

    pub fn restore_visibility(&mut self, app: &AppHandle) {
        if !self.ready || !self.projection_is_current() {
            return;
        }
        if let (Some(bounds), Some(window)) = (self.selected, app.get_webview_window(OVERLAY)) {
            if !window.is_visible().unwrap_or(false)
                && desktop::show_live_overlay(app, bounds, true).is_err()
            {
                self.fail(app);
            }
        }
    }

    pub fn can_draw(&self) -> bool {
        self.ready
            && self
                .scene
                .as_ref()
                .is_some_and(|scene| scene.can_draw && scene.observed_at.elapsed() < UPDATE_LIMIT)
    }

    pub fn toggle_drawing(&mut self, app: &AppHandle) -> Result<(), ()> {
        self.set_drawing(app, !self.drawing)
    }

    pub fn set_drawing(&mut self, app: &AppHandle, active: bool) -> Result<(), ()> {
        let window = app.get_webview_window(OVERLAY).ok_or(())?;
        let active = active && self.can_draw();
        if active && desktop::verify_capture_affinity(&window).is_err() {
            self.fail(app);
            return Err(());
        }
        self.drawing = false;
        self.draft = None;
        if window.set_ignore_cursor_events(!active).is_err() {
            self.fail(app);
            return Err(());
        }
        self.drawing = active;
        Ok(())
    }

    pub fn add_point(&mut self, x: f64, y: f64, begin: bool) {
        if !self.drawing || !self.can_draw() {
            return;
        }
        let (Some(bounds), Some(scene)) = (self.selected, self.scene.as_ref()) else {
            return;
        };
        if !(0.0..f64::from(bounds.width)).contains(&x)
            || !(0.0..f64::from(bounds.height)).contains(&y)
        {
            return;
        }
        const UNITS: f64 = 65_535.0;
        if begin {
            self.draft = Some(PenCommit {
                fence: scene.fence,
                width: (4.0 * UNITS / f64::from(bounds.width))
                    .round()
                    .clamp(32.0, 3277.0) as u32,
                points: Vec::new(),
            });
        }
        if let Some(draft) = self
            .draft
            .as_mut()
            .filter(|draft| draft.fence == scene.fence && draft.points.len() < 384)
        {
            draft.points.push(InkPoint {
                x: (x / f64::from(bounds.width) * UNITS).round() as u32,
                y: (y / f64::from(bounds.height) * UNITS).round() as u32,
            });
        }
    }

    pub fn finish_stroke(&mut self, app: &AppHandle) {
        if let Some(draft) = self
            .draft
            .take()
            .filter(|draft| !draft.points.is_empty() && self.can_draw())
        {
            if self.commits.len() < 8 {
                self.commits.push_back(draft);
            }
        }
        let _ = self.set_drawing(app, false);
    }

    pub fn drain_commit(&mut self) -> Option<PenCommit> {
        self.commits.pop_front()
    }

    pub fn disable_stale_input(&mut self, app: &AppHandle) {
        if self.drawing && !self.can_draw() {
            let _ = self.set_drawing(app, false);
        }
    }

    pub fn projection_is_current(&self) -> bool {
        if let Some(window) = &self.window {
            return window
                .projection_on_screen()
                .is_some_and(|(_, content)| Some(content) == self.selected);
        }
        self.display.as_ref().is_some_and(|selected| {
            Display::at(selected.bounds).is_some_and(|current| selected.is_same(&current))
        })
    }

    pub fn allows_window(&self) -> bool {
        self.ready
            || self
                .probe
                .as_ref()
                .is_some_and(|p| p.started.elapsed() < PROBE_LIMIT)
    }
}

fn make_probe() -> Result<ProbeSpec, ()> {
    let mut random = [0u8; 19];
    SystemRandom::new().fill(&mut random).map_err(|_| ())?;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let nonce = URL_SAFE_NO_PAD.encode(&random[..16]);
    // Distinct saturated hues occupy different regions of the monitor.
    // The nonce rotates the order; a stale calibration cannot be reused.
    let palette = [
        [255, 0, 96],
        [0, 232, 72],
        [16, 80, 255],
        [255, 200, 0],
        [216, 16, 255],
        [0, 225, 235],
    ];
    let points = [(0.18, 0.22), (0.76, 0.30), (0.39, 0.73)]
        .into_iter()
        .zip(random[16..].iter())
        .map(|((x, y), byte)| Landmark {
            x,
            y,
            rgb: palette[usize::from(*byte) % palette.len()],
        })
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| ())?;
    Ok(ProbeSpec { nonce, points })
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.hide();
    }
}
