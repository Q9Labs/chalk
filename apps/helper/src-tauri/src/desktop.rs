use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    App, AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::{
    check_for_update,
    device::{DeviceConnection, DeviceView},
    geometry::{Dock, Point, Rect, Segment},
    live,
    pairing::Pairing,
    permission::{self, Ask, Effect},
};

#[cfg(feature = "fixture")]
mod preview;

const MAX_STROKES: usize = 64;
const MAX_POINTS: usize = 512;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Style {
    Pill,
    #[default]
    Island,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
struct Preferences {
    style: Style,
    dock: Dock,
}

#[derive(Clone, Serialize)]
struct Stroke {
    points: Vec<Point>,
    color: &'static str,
    author: &'static str,
    ends_at_ms: u64,
}

#[derive(Default)]
pub struct Desktop(Mutex<Local>);

#[derive(Default)]
struct Local {
    preferences: Preferences,
    preferences_file: Option<PathBuf>,
    fixture: Option<Fixture>,
    pairing: Option<Pairing>,
    hotkey: bool,
    update_status: Option<&'static str>,
    device: DeviceConnection,
    permission: permission::Onboarding,
}

struct Fixture {
    work_area: Rect,
    segments: Vec<Segment>,
    strokes: Vec<Stroke>,
    draft: Vec<Point>,
    draft_window: Option<String>,
    drawing: bool,
    paused: bool,
    color: &'static str,
    dragging: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    preferences: Preferences,
    segment: Option<Segment>,
    strokes: Vec<Stroke>,
    draft: Vec<Point>,
    drawing: bool,
    paused: bool,
    color: &'static str,
    hotkey: bool,
    fixture: bool,
    approval: Option<crate::pairing::ApprovalPrompt>,
    connected: bool,
    live_drawing_available: bool,
    monitors: Vec<MonitorView>,
    capture_status: Option<&'static str>,
    launch_at_login: bool,
    can_follow_window: bool,
    overlay: Option<live::Overlay>,
    update_available: bool,
    update_status: Option<&'static str>,
    device: Option<DeviceView>,
    permission: Option<permission::View>,
}

#[derive(Serialize)]
struct MonitorView {
    name: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Disconnect,
    SetLaunchAtLogin { enabled: bool },
    ChangeStyle { style: Style },
    CheckForUpdate,
    StartDeviceCode { tenant_id: String },
    ForgetDevice,
    DecidePairing { fingerprint: String, allowed: bool },
    SelectMonitor { index: usize },
    FollowWindow,
    OpenScreenRecordingSettings,
    LaterScreenRecording,
    ShowAppInFinder,
    ToggleLiveDraw,
    ChangeColor { color: PenColor },
    ToggleDraw,
    CancelDraw,
    ShowHudMenu,
    BeginDrag,
    Drag,
    EndDrag,
    ProbePainted { nonce: String },
    BeginStroke { x: f64, y: f64 },
    AddPoint { x: f64, y: f64 },
    FinishStroke,
    CancelStroke,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PenColor {
    Blue,
    Yellow,
    Red,
    White,
}

impl PenColor {
    fn hex(self) -> &'static str {
        match self {
            Self::Blue => "#7da5ff",
            Self::Yellow => "#ffd765",
            Self::Red => "#ff737d",
            Self::White => "#ffffff",
        }
    }
}

pub fn setup(app: &mut App) -> tauri::Result<()> {
    let preferences_file = app.path().app_config_dir()?.join("control.json");
    let preferences = fs::read(&preferences_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .filter(|preferences| (0.0..=1.0).contains(&preferences.dock.offset))
        .unwrap_or_default();
    {
        let state = app.state::<Desktop>();
        let mut local = state.0.lock().expect("Helper state");
        local.preferences = preferences;
        local.preferences_file = Some(preferences_file);
    }

    let handle = app.handle();
    let settings = MenuItemBuilder::with_id("settings", "Settings…").build(handle)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Chalk Helper").build(handle)?;
    let menu = MenuBuilder::new(handle)
        .items(&[&settings, &quit])
        .build()?;
    TrayIconBuilder::new()
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray.png"
        ))?)
        .icon_as_template(true)
        .tooltip("Chalk Helper")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "settings" => {
                let _ = show_settings(app);
            }
            _ => {}
        })
        .build(handle)?;
    #[cfg(feature = "fixture")]
    if let Some(state) = preview::requested() {
        return preview::run(handle, &state);
    }
    if cfg!(feature = "fixture") && std::env::args().any(|arg| arg == "--fixture") {
        create_settings(handle)?;
        show_settings(handle)?;
        start_fixture(handle)?;
        return Ok(());
    }

    let pairing = Pairing::configured().map_err(|error| {
        tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, error))
    })?;
    // WebView2 can deadlock when a window is constructed inside a GUI callback.
    // Create both windows off the GUI thread; capture requests can only use the prepared overlay.
    let owner = handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::device::retire_configured_legacy_credentials();
        let settings = create_settings(&owner);
        if pairing.is_some() && create_live_overlay(&owner).is_err() {
            eprintln!("Chalk Helper could not prepare the live overlay.");
        }
        let app = owner.clone();
        let _ = owner.run_on_main_thread(move || {
            if settings.is_err() || show_settings(&app).is_err() {
                eprintln!("Chalk Helper could not open Settings.");
            }
            if let Some(pairing) = pairing {
                app.state::<Desktop>()
                    .0
                    .lock()
                    .expect("Helper state")
                    .pairing = Some(pairing.clone());
                tauri::async_runtime::spawn(watch_permission(app.clone(), pairing.clone()));
                pairing.set_app(app);
                let upkeep = pairing.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        if !upkeep.upkeep() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
                    }
                });
                tauri::async_runtime::spawn(pairing.serve());
            }
        });
    });

    Ok(())
}

/// Notice a grant without asking the sharer to return and click again.
async fn watch_permission(app: AppHandle, pairing: Pairing) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let watching = app
            .state::<Desktop>()
            .0
            .lock()
            .expect("Helper state")
            .permission
            .watching();
        let Ok(access) =
            tauri::async_runtime::spawn_blocking(move || permission::Observed::take(watching))
                .await
        else {
            continue;
        };
        let sampling = pairing.window_sampling();
        let effects = app
            .state::<Desktop>()
            .0
            .lock()
            .expect("Helper state")
            .permission
            .tick(sampling.is_some(), &access);
        match sampling {
            Some(true) => permission::start_sampling(),
            Some(false) => (),
            None => permission::stop_sampling(),
        }
        apply(&app, effects);
    }
}

fn apply(app: &AppHandle, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::OpenSettings => {
                let _ = app.run_on_main_thread(|| {
                    permission::open_system_settings();
                    permission::show_tile();
                });
            }
            Effect::HideTile => {
                let _ = app.run_on_main_thread(permission::hide_tile);
            }
            Effect::Follow => {
                let pairing = app
                    .state::<Desktop>()
                    .0
                    .lock()
                    .expect("Helper state")
                    .pairing
                    .clone();
                if pairing.is_some_and(|pairing| pairing.enable_follow().is_ok()) {
                    permission::start_sampling();
                    if let Some(settings) = app.get_webview_window("settings") {
                        let _ = settings.hide();
                    }
                }
            }
        }
    }
}

fn create_settings(app: &AppHandle) -> tauri::Result<()> {
    let window = window(app, "settings")
        .title("Chalk Helper")
        .inner_size(460.0, 640.0)
        .center()
        .content_protected(true)
        .visible(false)
        .resizable(false)
        .build()?;
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide.hide();
        }
    });
    Ok(())
}

pub(crate) fn show_settings(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_webview_window("settings")
        .ok_or_else(|| std::io::Error::other("Chalk Helper Settings are not ready."))?;
    verify_capture_affinity(&window)?;
    window.show()?;
    window.set_focus()
}

fn window<'a>(app: &'a AppHandle, label: &str) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .on_navigation(is_local_window_navigation)
}

fn is_local_window_navigation(url: &tauri::Url) -> bool {
    // Tauri uses the pathless custom-protocol origin on macOS for index.html.
    let bundled = match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => matches!(url.path(), "" | "/" | "/index.html"),
        ("http", Some("tauri.localhost")) => matches!(url.path(), "/" | "/index.html"),
        _ => false,
    };
    bundled
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

fn floating(app: &AppHandle, label: &str, focusable: bool) -> tauri::Result<WebviewWindow> {
    let window = window(app, label)
        .title("Chalk Helper")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(focusable)
        .content_protected(true)
        .visible(false)
        .build()?;
    verify_capture_affinity(&window)?;
    Ok(window)
}

fn create_live_overlay(app: &AppHandle) -> tauri::Result<()> {
    window(app, live::OVERLAY)
        .title("Chalk Helper calibration")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()?;
    Ok(())
}

pub(crate) fn overlay_bounds(window: &WebviewWindow) -> tauri::Result<Rect> {
    let size = window.inner_size()?;
    let position = window.inner_position()?;
    Ok(Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

pub(crate) fn show_live_overlay(
    app: &AppHandle,
    bounds: Rect,
    protected: bool,
) -> tauri::Result<()> {
    let overlay = app
        .get_webview_window(live::OVERLAY)
        .ok_or_else(|| std::io::Error::other("Chalk Helper live overlay is not ready."))?;
    if protected {
        verify_capture_affinity(&overlay)?;
    } else {
        overlay.set_content_protected(false)?;
    }
    place(&overlay, bounds)?;
    overlay.set_focusable(false)?;

    overlay.set_ignore_cursor_events(true)?;
    if overlay_bounds(&overlay)? != bounds {
        return Err(
            std::io::Error::other("Monitor overlay does not align with the display.").into(),
        );
    }
    overlay.show()?;
    crate::window_follow::ignore_overlay(&overlay)
}

#[cfg(target_os = "windows")]
pub(crate) fn verify_capture_affinity(window: &WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    let handle = window.hwnd()?;
    let mut affinity = 0;
    // The HWND was created in this Tauri process and stays alive for this call.
    if unsafe { SetWindowDisplayAffinity(handle.0, WDA_EXCLUDEFROMCAPTURE) } == 0
        || unsafe { GetWindowDisplayAffinity(handle.0, &mut affinity) } == 0
        || affinity != WDA_EXCLUDEFROMCAPTURE
    {
        let _ = window.hide();
        return Err(std::io::Error::other("Windows did not apply capture exclusion.").into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn verify_capture_affinity(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::{NSWindow, NSWindowSharingType};

    // Called on the main thread with a live Tauri-owned NSWindow.
    let native = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
    native.setSharingType(NSWindowSharingType::None);
    if native.sharingType() != NSWindowSharingType::None {
        return Err(std::io::Error::other("macOS did not apply capture exclusion.").into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn verify_capture_affinity(_window: &WebviewWindow) -> tauri::Result<()> {
    Err(std::io::Error::other("Capture exclusion is unavailable.").into())
}

pub(crate) fn monitor_bounds(monitor: &Monitor) -> Rect {
    Rect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

fn start_fixture(app: &AppHandle) -> tauri::Result<()> {
    let Some(primary) = app.primary_monitor()? else {
        return Ok(());
    };
    let work = primary.work_area();
    let work_area = Rect {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    let frame = monitor_bounds(&primary);
    let segments: Vec<_> = app
        .available_monitors()?
        .iter()
        .filter_map(|monitor| Segment::new(frame, monitor_bounds(monitor)))
        .collect();
    for (index, segment) in segments.iter().enumerate() {
        let overlay = floating(app, &format!("ink-{index}"), false)?;
        place(&overlay, segment.bounds)?;
        overlay.set_focusable(false)?;

        overlay.set_ignore_cursor_events(true)?;
        let handle = app.clone();
        overlay.on_window_event(move |event| {
            if matches!(event, WindowEvent::Focused(false)) {
                let _ = set_drawing(&handle, false);
            }
        });
    }
    let hud = floating(app, "hud", false)?;
    let handle = app.clone();
    hud.on_menu_event(move |_, event| {
        let state = handle.state::<Desktop>();
        let mut local = state.0.lock().expect("Helper state");
        let Some(fixture) = local.fixture.as_mut() else {
            return;
        };
        match event.id().as_ref() {
            "control-pause" => {
                fixture.paused = !fixture.paused;
                drop(local);
                let _ = set_drawing(&handle, false);
            }
            "control-clear" => {
                fixture.strokes.clear();
                fixture.draft.clear();
                fixture.draft_window = None;
            }
            "control-island" | "control-pill" => {
                local.preferences.style = if event.id().as_ref() == "control-pill" {
                    Style::Pill
                } else {
                    Style::Island
                };
                let _ = save_preferences(&local);
                drop(local);
                let _ = layout_controls(&handle);
            }
            _ => {}
        }
    });
    floating(app, "draw-bar", false)?;
    {
        let state = app.state::<Desktop>();
        let mut local = state.0.lock().expect("Helper state");
        local.hotkey = app
            .global_shortcut()
            .register("CommandOrControl+Shift+9")
            .is_ok();
        local.fixture = Some(Fixture {
            work_area,
            segments,
            strokes: vec![Stroke {
                points: vec![
                    Point { x: 0.31, y: 0.41 },
                    Point { x: 0.35, y: 0.46 },
                    Point { x: 0.43, y: 0.37 },
                ],
                color: PenColor::Blue.hex(),
                author: "viewer",
                ends_at_ms: u64::MAX,
            }],
            draft: Vec::new(),
            draft_window: None,
            drawing: false,
            paused: false,
            color: PenColor::White.hex(),
            dragging: false,
        });
    }
    layout_controls(app)?;
    for window in app.webview_windows().values() {
        if window.label() != "draw-bar" {
            window.show()?;
        }
    }
    Ok(())
}

fn place(window: &WebviewWindow, bounds: Rect) -> tauri::Result<()> {
    window.set_size(PhysicalSize::new(bounds.width, bounds.height))?;
    window.set_position(PhysicalPosition::new(bounds.x, bounds.y))
}

fn layout_controls(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Desktop>();
    let local = state.0.lock().expect("Helper state");
    let Some(fixture) = &local.fixture else {
        return Ok(());
    };
    let work = fixture.work_area;
    let preferences = local.preferences;
    drop(local);

    let hud = app.get_webview_window("hud").expect("fixture control");
    let bar = app
        .get_webview_window("draw-bar")
        .expect("fixture draw bar");
    let scale = hud.scale_factor()?;
    let scaled = |logical: u32| (f64::from(logical) * scale).round() as u32;
    let major = match preferences.style {
        Style::Island => 246,
        Style::Pill => 160,
    };
    let (width, height) = if preferences.dock.edge.vertical() {
        (scaled(42), scaled(major))
    } else {
        (scaled(major), scaled(42))
    };
    let (x, y) = preferences.dock.position(work, width, height);
    place(
        &hud,
        Rect {
            x,
            y,
            width,
            height,
        },
    )?;
    let width = scaled(258);
    let height = scaled(44);
    let (x, y) = Dock {
        edge: crate::geometry::Edge::Bottom,
        offset: 0.5,
    }
    .position(work, width, height + scaled(12));
    place(
        &bar,
        Rect {
            x,
            y,
            width,
            height,
        },
    )?;
    Ok(())
}

fn save_preferences(local: &Local) -> Result<(), String> {
    let Some(path) = &local.preferences_file else {
        return Ok(());
    };
    let parent = path.parent().expect("config directory");
    fs::create_dir_all(parent).map_err(|_| "Could not create Helper settings.")?;
    let bytes = serde_json::to_vec(&local.preferences).map_err(|_| "Could not encode settings.")?;
    fs::write(path, bytes).map_err(|_| "Could not save Helper settings.".into())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn set_drawing(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    let state = app.state::<Desktop>();
    {
        let mut local = state.0.lock().expect("Helper state");
        let Some(fixture) = local.fixture.as_mut() else {
            return Ok(());
        };
        let enabled = enabled && !fixture.paused;
        if fixture.drawing == enabled {
            return Ok(());
        }
        fixture.drawing = enabled;
        fixture.draft.clear();
        fixture.draft_window = None;
    }
    let drawing = state
        .0
        .lock()
        .expect("Helper state")
        .fixture
        .as_ref()
        .is_some_and(|fixture| fixture.drawing);
    let windows = app.webview_windows();
    for (label, window) in &windows {
        let result = if label.starts_with("ink-") {
            window
                .set_focusable(drawing)
                .and_then(|()| window.set_ignore_cursor_events(!drawing))
        } else if label == "draw-bar" {
            if drawing {
                window.show()
            } else {
                window.hide()
            }
        } else {
            continue;
        };
        if let Err(error) = result {
            let mut local = state.0.lock().expect("Helper state");
            if let Some(fixture) = &mut local.fixture {
                fixture.drawing = false;
            }
            drop(local);
            for (label, window) in &windows {
                if label.starts_with("ink-") || label == "draw-bar" {
                    let _ = window.hide();
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub fn toggle_drawing(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = handle.state::<Desktop>();
        let drawing = state
            .0
            .lock()
            .expect("Helper state")
            .fixture
            .as_ref()
            .is_some_and(|fixture| fixture.drawing);
        if set_drawing(&handle, !drawing).is_ok() && !drawing {
            if let Some(overlay) = handle.get_webview_window("ink-0") {
                let _ = overlay.set_focus();
            }
        }
    });
}

fn segment_index(label: &str) -> Option<usize> {
    label.strip_prefix("ink-")?.parse().ok()
}

fn allowed(label: &str, action: &Action) -> bool {
    match action {
        Action::ChangeStyle { .. } => matches!(label, "settings" | "hud"),
        Action::CheckForUpdate
        | Action::Disconnect
        | Action::SetLaunchAtLogin { .. }
        | Action::StartDeviceCode { .. }
        | Action::ForgetDevice
        | Action::DecidePairing { .. }
        | Action::FollowWindow
        | Action::OpenScreenRecordingSettings
        | Action::LaterScreenRecording
        | Action::ShowAppInFinder
        | Action::SelectMonitor { .. }
        | Action::ToggleLiveDraw => label == "settings",
        Action::ChangeColor { .. } => label == "draw-bar",
        Action::ToggleDraw
        | Action::ShowHudMenu
        | Action::BeginDrag
        | Action::Drag
        | Action::EndDrag => label == "hud",
        Action::CancelDraw => {
            matches!(label, "draw-bar" | live::OVERLAY) || segment_index(label).is_some()
        }
        Action::ProbePainted { .. } => label == live::OVERLAY,
        Action::BeginStroke { .. }
        | Action::AddPoint { .. }
        | Action::FinishStroke
        | Action::CancelStroke => label == live::OVERLAY || segment_index(label).is_some(),
    }
}

#[tauri::command]
pub fn view(window: WebviewWindow, state: tauri::State<'_, Desktop>) -> View {
    let mut local = state.0.lock().expect("Helper state");
    let mut view = View {
        preferences: local.preferences,
        segment: None,
        strokes: Vec::new(),
        draft: Vec::new(),
        drawing: false,
        paused: false,
        color: PenColor::White.hex(),
        live_drawing_available: local.pairing.as_ref().is_some_and(Pairing::can_draw),
        hotkey: local.hotkey,
        fixture: local.fixture.is_some(),
        approval: (window.label() == "settings")
            .then(|| local.pairing.as_ref()?.approval_prompt())
            .flatten(),
        connected: local.pairing.as_ref().is_some_and(Pairing::connected),
        can_follow_window: window.label() == "settings"
            && local.pairing.as_ref().is_some_and(Pairing::offers_window),
        monitors: if window.label() == "settings"
            && local.pairing.as_ref().is_some_and(Pairing::offers_monitors)
        {
            window
                .available_monitors()
                .unwrap_or_default()
                .into_iter()
                .enumerate()
                .map(|(index, monitor)| MonitorView {
                    name: monitor
                        .name()
                        .cloned()
                        .unwrap_or_else(|| format!("Display {}", index + 1)),
                    width: monitor.size().width,
                    height: monitor.size().height,
                })
                .collect()
        } else {
            Vec::new()
        },
        capture_status: (window.label() == "settings")
            .then(|| local.pairing.as_ref()?.capture_status())
            .flatten(),
        launch_at_login: window.label() == "settings"
            && window
                .app_handle()
                .autolaunch()
                .is_enabled()
                .unwrap_or(false),
        overlay: (window.label() == live::OVERLAY)
            .then(|| local.pairing.as_ref()?.overlay())
            .flatten(),
        update_available: crate::updater_config().is_some(),
        update_status: local.update_status,
        device: (window.label() == "settings").then(|| local.device.view()),
        permission: (window.label() == "settings").then(|| local.permission.view()),
    };
    if let Some(fixture) = local.fixture.as_mut() {
        view.drawing = fixture.drawing;
        view.paused = fixture.paused;
        view.color = fixture.color;
        if let Some(segment) =
            segment_index(window.label()).and_then(|index| fixture.segments.get(index))
        {
            fixture
                .strokes
                .retain(|stroke| stroke.ends_at_ms > now_ms());
            view.segment = Some(*segment);
            view.strokes.clone_from(&fixture.strokes);
            view.draft.clone_from(&fixture.draft);
        }
    }
    view
}

#[tauri::command]
pub fn act(
    window: WebviewWindow,
    state: tauri::State<'_, Desktop>,
    action: Action,
) -> Result<(), String> {
    let label = window.label();
    if !allowed(label, &action) {
        return Err("Action is not available in this window.".into());
    }
    let app = window.app_handle();
    let mut local = state.0.lock().expect("Helper state");
    if matches!(label, live::OVERLAY) || matches!(action, Action::ToggleLiveDraw) {
        let pairing = local.pairing.clone().ok_or("No Helper session.")?;
        let app = app.clone();
        drop(local);
        return app
            .clone()
            .run_on_main_thread(move || {
                pairing.with_capture(|capture| match action {
                    Action::ToggleLiveDraw => {
                        let _ = capture.toggle_drawing(&app);
                    }
                    Action::ProbePainted { nonce } => capture.acknowledge_paint(&nonce),
                    Action::BeginStroke { x, y } => capture.add_point(x, y, true),
                    Action::AddPoint { x, y } => capture.add_point(x, y, false),
                    Action::FinishStroke => capture.finish_stroke(&app),
                    Action::CancelStroke | Action::CancelDraw => {
                        let _ = capture.set_drawing(&app, false);
                    }
                    _ => {}
                })
            })
            .map_err(|error| error.to_string());
    }
    match action {
        Action::StartDeviceCode { tenant_id } => {
            return local.device.start(&tenant_id).map_err(str::to_owned)
        }
        Action::ForgetDevice => return local.device.clear().map_err(str::to_owned),
        Action::DecidePairing {
            fingerprint,
            allowed,
        } => {
            if let Some(pairing) = local.pairing.as_ref() {
                pairing.decide(&fingerprint, allowed);
            }
            return Ok(());
        }
        Action::Disconnect => {
            if let Some(pairing) = local.pairing.as_ref() {
                pairing.disconnect();
            }
            return Ok(());
        }
        Action::SetLaunchAtLogin { enabled } => {
            let manager = app.autolaunch();
            let result = if enabled {
                manager.enable()
            } else {
                manager.disable()
            };
            return result.map_err(|_| "Could not change the login setting.".to_owned());
        }
        Action::FollowWindow => {
            let pairing = local.pairing.clone().ok_or("No Helper session.")?;
            drop(local);
            if !pairing.offers_window() {
                return Err("No active window share.".into());
            }
            let ask = state
                .0
                .lock()
                .expect("Helper state")
                .permission
                .ask(&permission::System);
            if ask == Ask::Panel {
                return Ok(());
            }
            pairing.enable_follow().map_err(str::to_owned)?;
            permission::start_sampling();
            let _ = window.hide();
            return Ok(());
        }
        Action::OpenScreenRecordingSettings => {
            let effects = local.permission.open_settings();
            drop(local);
            apply(app, effects);
            return Ok(());
        }
        Action::LaterScreenRecording => {
            let effects = local.permission.later();
            drop(local);
            apply(app, effects);
            return Ok(());
        }
        Action::ShowAppInFinder => {
            drop(local);
            permission::reveal_in_finder();
            return Ok(());
        }
        Action::SelectMonitor { index } => {
            let monitors = window
                .available_monitors()
                .map_err(|error| error.to_string())?;
            let bounds = monitors
                .get(index)
                .map(monitor_bounds)
                .ok_or("The display changed.")?;
            local
                .pairing
                .as_ref()
                .ok_or("No Helper session.")?
                .select_monitor(bounds)
                .map_err(|_| "The display could not be selected.".to_owned())?;
            return Ok(());
        }
        Action::CheckForUpdate => {
            if local.update_status == Some("Checking for updates…") {
                return Ok(());
            }
            local.update_status = Some("Checking for updates…");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let message = match check_for_update(app.clone()).await {
                    Ok(()) => "Chalk Helper is up to date.",
                    Err("No update channel is configured.") => "Updates are off in this build.",
                    Err(_) => "Could not update Chalk Helper.",
                };
                app.state::<Desktop>()
                    .0
                    .lock()
                    .expect("Helper state")
                    .update_status = Some(message);
            });
            return Ok(());
        }
        Action::ChangeStyle { style } => {
            local.preferences.style = style;
            save_preferences(&local)?;
            drop(local);
            return layout_controls(app).map_err(|error| error.to_string());
        }
        _ => {}
    }
    let Some(fixture) = local.fixture.as_mut() else {
        return Err("No verified capture is attached.".into());
    };
    match action {
        Action::ToggleDraw => {
            drop(local);
            toggle_drawing(app);
        }
        Action::CancelDraw => {
            drop(local);
            set_drawing(app, false).map_err(|error| error.to_string())?;
        }
        Action::ShowHudMenu => {
            let pause_label = if fixture.paused {
                "Resume marks"
            } else {
                "Pause marks"
            };
            let style = local.preferences.style;
            drop(local);
            let popup = || -> tauri::Result<()> {
                let pause = MenuItemBuilder::with_id("control-pause", pause_label).build(app)?;
                let clear = MenuItemBuilder::with_id("control-clear", "Clear marks").build(app)?;
                let island = tauri::menu::CheckMenuItemBuilder::with_id("control-island", "Island")
                    .checked(matches!(style, Style::Island))
                    .build(app)?;
                let pill = tauri::menu::CheckMenuItemBuilder::with_id("control-pill", "Pill")
                    .checked(matches!(style, Style::Pill))
                    .build(app)?;
                let menu = MenuBuilder::new(app)
                    .items(&[&pause, &clear])
                    .separator()
                    .items(&[&island, &pill])
                    .build()?;
                window.popup_menu(&menu)
            };
            popup().map_err(|error| error.to_string())?;
        }
        Action::ChangeColor { color } => fixture.color = color.hex(),
        Action::BeginDrag => fixture.dragging = true,
        Action::Drag | Action::EndDrag if fixture.dragging => {
            let position = window
                .cursor_position()
                .map_err(|error| error.to_string())?;
            let point = Point {
                x: position.x,
                y: position.y,
            };
            let work = fixture.work_area;
            if matches!(action, Action::EndDrag) {
                fixture.dragging = false;
                local.preferences.dock = Dock::snap(work, point);
                save_preferences(&local)?;
                drop(local);
                layout_controls(app).map_err(|error| error.to_string())?;
            } else {
                let size = window.inner_size().map_err(|error| error.to_string())?;
                let x = ((point.x - f64::from(size.width) / 2.0).round() as i32).clamp(
                    work.x,
                    work.x + work.width.saturating_sub(size.width) as i32,
                );
                let y = ((point.y - f64::from(size.height) / 2.0).round() as i32).clamp(
                    work.y,
                    work.y + work.height.saturating_sub(size.height) as i32,
                );
                drop(local);
                window
                    .set_position(PhysicalPosition::new(x, y))
                    .map_err(|error| error.to_string())?;
            }
        }
        Action::BeginStroke { x, y } | Action::AddPoint { x, y } if fixture.drawing => {
            let point = segment_index(label)
                .and_then(|index| fixture.segments.get(index))
                .and_then(|segment| segment.frame_point(Point { x, y }));
            if matches!(action, Action::BeginStroke { .. }) {
                fixture.draft.clear();
                fixture.draft_window = point.map(|_| label.to_owned());
            }
            if fixture.draft_window.as_deref() == Some(label) && fixture.draft.len() < MAX_POINTS {
                fixture.draft.extend(point);
            }
        }
        Action::FinishStroke if fixture.draft_window.as_deref() == Some(label) => {
            fixture.draft_window = None;
            let points = std::mem::take(&mut fixture.draft);
            if !points.is_empty() {
                if fixture.strokes.len() == MAX_STROKES {
                    fixture.strokes.remove(0);
                }
                fixture.strokes.push(Stroke {
                    points,
                    color: fixture.color,
                    author: "sharer",
                    ends_at_ms: now_ms() + 10_000,
                });
            }
        }
        Action::CancelStroke if fixture.draft_window.as_deref() == Some(label) => {
            fixture.draft.clear();
            fixture.draft_window = None;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_local_window_navigation;
    use tauri::Url;

    #[test]
    fn windows_and_macos_can_navigate_to_the_bundled_renderer() {
        for url in [
            "http://tauri.localhost/",
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
        ] {
            assert!(
                is_local_window_navigation(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[test]
    fn helper_windows_do_not_navigate_outside_the_bundled_entrypoint() {
        for url in [
            "https://localhost/",
            "https://tauri.localhost/",
            "http://localhost/",
            "tauri://localhost.example/",
            "tauri://user@localhost",
            "tauri://localhost:1234",
            "tauri://localhost/elsewhere.html",
            "tauri://localhost?from=outside",
            "tauri://localhost#outside",
        ] {
            assert!(
                !is_local_window_navigation(&Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }
}
