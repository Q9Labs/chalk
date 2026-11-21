use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{desktop, geometry::Rect};

const PROBE_LIMIT: Duration = Duration::from_secs(4);
const UPDATE_LIMIT: Duration = Duration::from_secs(6);
pub const OVERLAY: &str = "ink-live";

#[derive(Default)]
pub struct Capture {
    frame: Option<(u32, u32)>,
    selected: Option<Rect>,
    probe: Option<Probe>,
    ready: bool,
    unsupported: bool,
    scene: Option<Scene>,
    drawing: bool,
    draft: Option<PenCommit>,
    commits: VecDeque<PenCommit>,
}

struct Probe {
    spec: ProbeSpec,
    started: Instant,
    protected: bool,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scene {
    marks: Value,
    presence: Value,
    sharer_id: String,
    paused: bool,
    fence: u64,
    can_draw: bool,
    server_at_ms: u64,
    #[serde(skip)]
    observed_at: Option<Instant>,
}

impl Scene {
    pub fn valid_for(&self, sharer: &str) -> bool {
        self.sharer_id == sharer
            && (1..=9_007_199_254_740_991).contains(&self.fence)
            && (1..=9_007_199_254_740_991).contains(&self.server_at_ms)
            && self
                .marks
                .as_array()
                .is_some_and(|marks| marks.len() <= 512)
            && self
                .presence
                .as_array()
                .is_some_and(|presence| presence.len() <= 128)
    }
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
    fence: u64,
    width: u32,
    points: Vec<InkPoint>,
}

impl Capture {
    pub fn describe(&mut self, surface: &str, width: u32, height: u32) -> Result<(), ()> {
        if self.frame.is_some()
            || self.unsupported
            || !(1..=16_384).contains(&width)
            || !(1..=16_384).contains(&height)
        {
            return Err(());
        }
        if surface == "monitor" {
            self.frame = Some((width, height));
        } else {
            self.unsupported = true;
        }
        Ok(())
    }

    pub fn offers_monitors(&self) -> bool {
        self.frame.is_some() && self.selected.is_none() && !self.unsupported
    }

    pub fn select(&mut self, bounds: Rect) -> Result<(), ()> {
        if !self.offers_monitors() || bounds.width < 320 || bounds.height < 240 {
            return Err(());
        }
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
        } else if self.selected.is_some() {
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
        let spec = ProbeSpec { nonce, points };
        self.probe = Some(Probe {
            spec: spec.clone(),
            started: Instant::now(),
            protected: false,
        });
        if desktop::show_live_overlay(app, bounds).is_err() {
            self.fail(app);
            return Err(());
        }
        Ok(spec)
    }

    pub fn protect(&mut self, app: &AppHandle, nonce: &str) -> Result<(), ()> {
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
        let mut scene = self.scene.clone().filter(|scene| {
            self.ready
                && scene
                    .observed_at
                    .is_some_and(|at| at.elapsed() < UPDATE_LIMIT)
        })?;
        let age = scene.observed_at?.elapsed().as_millis() as u64;
        scene.server_at_ms = scene.server_at_ms.saturating_add(age);
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

    pub fn update(&mut self, body: Scene, width: u32, height: u32) -> Result<(), ()> {
        if !self.ready || self.frame != Some((width, height)) {
            return Err(());
        }
        self.scene = Some(Scene {
            observed_at: Some(Instant::now()),
            ..body
        });
        Ok(())
    }

    pub fn can_draw(&self) -> bool {
        self.ready
            && self.scene.as_ref().is_some_and(|scene| {
                scene.can_draw
                    && scene
                        .observed_at
                        .is_some_and(|at| at.elapsed() < UPDATE_LIMIT)
            })
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

    pub fn projection_is_current(&self, app: &AppHandle) -> bool {
        self.selected.is_some_and(|bounds| {
            app.available_monitors().is_ok_and(|monitors| {
                monitors
                    .iter()
                    .any(|monitor| desktop::monitor_bounds(monitor) == bounds)
            })
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

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.hide();
    }
}
