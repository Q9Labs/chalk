use crate::geometry::Rect;

const SIZE: usize = 72;
const SAMPLES: usize = SIZE * SIZE * 4;
pub const LANDMARK_COUNT: usize = 3 * 40;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Identity {
    pid: u32,
    birth: u64,
}

#[derive(Clone, Copy)]
pub struct Observation {
    pub bounds: Rect,
    pub identity: Identity,
    // The deepest covered pixel measured from the top of the outer window.
    covered_top: u32,
}

#[repr(C)]
#[derive(Default)]
struct NativeBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    pid: u32,
    birth: u64,
    covered_top: u32,
}

impl From<NativeBounds> for Observation {
    fn from(value: NativeBounds) -> Self {
        Self {
            bounds: Rect {
                x: value.x,
                y: value.y,
                width: value.width,
                height: value.height,
            },
            identity: Identity {
                pid: value.pid,
                birth: value.birth,
            },
            covered_top: value.covered_top,
        }
    }
}

pub fn ignore_overlay(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    platform::ignore_overlay(window)
}

pub fn request_capture_access() -> bool {
    platform::request_capture_access()
}

pub fn observe(id: u64) -> Option<Observation> {
    platform::bounds(id).map(Observation::from)
}

#[derive(Clone, Copy)]
pub struct Projection {
    outer_size: (u32, u32),
    top: u32,
}

impl Observation {
    pub fn project(self, projection: Projection) -> Option<Rect> {
        if self.covered_top > projection.top {
            return None;
        }
        projection.at(self.bounds)
    }
}

impl Projection {
    fn at(self, outer: Rect) -> Option<Rect> {
        if (outer.width, outer.height) != self.outer_size {
            return None;
        }
        Some(Rect {
            y: outer.y.checked_add(i32::try_from(self.top).ok()?)?,
            height: outer.height - self.top,
            ..outer
        })
    }
}

fn capture_projection(
    outer: Rect,
    (width, height): (u32, u32),
    can_crop_titlebar: bool,
) -> Option<Projection> {
    if !(320..=16_384).contains(&width) || !(240..=16_384).contains(&height) {
        return None;
    }
    let incoming = f64::from(width) / f64::from(height);
    let matches_aspect =
        |height: u32| (f64::from(outer.width) / f64::from(height) / incoming - 1.0).abs() <= 0.004;
    let top = if matches_aspect(outer.height) {
        0
    } else if can_crop_titlebar {
        // Some macOS capture sources omit the title bar. Infer the one top
        // inset consistent with the decoded aspect, then verify the pixels.
        let content_height = (f64::from(outer.width) / incoming).round() as u32;
        let top = outer.height.checked_sub(content_height)?;
        if top == 0 || top > outer.height / 5 || !matches_aspect(content_height) {
            return None;
        }
        top
    } else {
        return None;
    };
    Some(Projection {
        outer_size: (outer.width, outer.height),
        top,
    })
}

pub fn matching_projection(
    id: u64,
    observed: Observation,
    frame: (u32, u32),
    expected: &[i8],
) -> Option<Projection> {
    if expected.len() != LANDMARK_COUNT {
        return None;
    }
    let projection = capture_projection(observed.bounds, frame, cfg!(target_os = "macos"))?;
    observed.project(projection)?;
    let mut pixels = vec![0; SAMPLES];
    let top_fraction = f64::from(projection.top) / f64::from(observed.bounds.height);
    (platform::sample(id, top_fraction, &mut pixels) && landmarks_match(&pixels, expected))
        .then_some(projection)
}

fn landmarks_match(pixels: &[u8], expected: &[i8]) -> bool {
    let energy = |x, y| {
        let index = (y * SIZE + x) * 4;
        let [r, g, b, _] = <[u8; 4]>::try_from(&pixels[index..index + 4]).unwrap();
        (i16::from(r) + 2 * i16::from(g) + i16::from(b)) / 4
    };
    let mut actual = Vec::with_capacity(LANDMARK_COUNT);
    // Skip the toolbar, which macOS and Chromium can render differently.
    // Keep these positions in sync with the browser's preview landmarks.
    for (left, top) in [(3, 12), (48, 12), (3, 48)] {
        for y in 0..5 {
            for x in 0..5 {
                let px = left + x * 5;
                let py = top + y * 5;
                let centre = energy(px, py);
                if x < 4 {
                    actual.push((energy(px + 5, py) - centre) / 4);
                }
                if y < 4 {
                    actual.push((energy(px, py + 5) - centre) / 4);
                }
            }
        }
    }
    actual
        .chunks_exact(40)
        .zip(expected.chunks_exact(40))
        .all(|(native, preview)| {
            let mut distinct = 0;
            let mut disagreed = 0;
            for (&a, &b) in native.iter().zip(preview) {
                let b = i16::from(b);
                if a.abs().max(b.abs()) < 5 {
                    continue;
                }
                distinct += 1;
                if (a - b).abs() > 8 || a.signum() != b.signum() {
                    disagreed += 1;
                }
            }
            // Native and browser downsampling can put a sharp edge in
            // adjacent cells. Still require 75% agreement in each region.
            distinct >= 5 && disagreed * 4 <= distinct
        })
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{NativeBounds, SIZE};

    extern "C" {
        fn chalk_window_ignore_overlay(window: *mut std::ffi::c_void) -> bool;
        fn chalk_window_request_capture_access() -> bool;
        fn chalk_window_bounds(id: u32, output: *mut NativeBounds) -> bool;
        fn chalk_window_sample(id: u32, top_fraction: f64, output: *mut u8, size: usize) -> bool;
    }

    pub fn ignore_overlay(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        if unsafe { chalk_window_ignore_overlay(window.ns_window()?) } {
            Ok(())
        } else {
            Err(std::io::Error::other("The Helper overlay has no native window identity.").into())
        }
    }

    pub fn request_capture_access() -> bool {
        // Only called from the user’s explicit Follow action in native Settings.
        unsafe { chalk_window_request_capture_access() }
    }

    pub fn bounds(id: u64) -> Option<NativeBounds> {
        let id = u32::try_from(id).ok()?;
        let mut output = NativeBounds::default();
        // The bridge receives a writable struct and never retains its address.
        unsafe { chalk_window_bounds(id, &mut output) }.then_some(output)
    }

    pub fn sample(id: u64, top_fraction: f64, pixels: &mut [u8]) -> bool {
        let Ok(id) = u32::try_from(id) else {
            return false;
        };
        // The bridge copies only after the callback finishes; it never retains this buffer.
        unsafe { chalk_window_sample(id, top_fraction, pixels.as_mut_ptr(), SIZE) }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{NativeBounds, SIZE};
    use std::mem::{size_of, size_of_val};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HWND, RECT},
        Graphics::{
            Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
            Gdi::{
                CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
                GetDIBits, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
                BI_RGB, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
            },
        },
        System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        UI::WindowsAndMessaging::{
            GetLayeredWindowAttributes, GetWindow, GetWindowLongPtrW, GetWindowThreadProcessId,
            IsIconic, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_HWNDPREV, LWA_ALPHA,
            WS_EX_LAYERED,
        },
    };

    static LIVE_OVERLAY: AtomicUsize = AtomicUsize::new(0);

    pub fn ignore_overlay(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        LIVE_OVERLAY.store(window.hwnd()?.0 as usize, Ordering::Relaxed);
        Ok(())
    }

    fn handle(id: u64) -> HWND {
        usize::try_from(id).unwrap_or_default() as HWND
    }

    unsafe fn frame(hwnd: HWND) -> Option<RECT> {
        let mut rect = RECT::default();
        let ok = DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut rect as *mut RECT).cast(),
            size_of::<RECT>() as u32,
        );
        (ok == 0).then_some(rect)
    }

    unsafe fn visible(hwnd: HWND) -> bool {
        if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        // A window on another virtual desktop is DWM-cloaked.
        let mut cloaked = 0_u32;
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            (&mut cloaked as *mut u32).cast(),
            4,
        ) == 0
            && cloaked == 0
    }

    fn extent(rect: RECT) -> (i32, i32) {
        (
            rect.right.saturating_sub(rect.left),
            rect.bottom.saturating_sub(rect.top),
        )
    }

    pub fn request_capture_access() -> bool {
        true
    }

    pub fn bounds(id: u64) -> Option<NativeBounds> {
        // HWND is resolved afresh. DWM, thread/process queries and every returned
        // rectangle are checked; no owned window memory is dereferenced.
        unsafe {
            let hwnd = handle(id);
            if !visible(hwnd) {
                return None;
            }
            let rect = frame(hwnd)?;
            let (width, height) = extent(rect);
            if width < 320 || height < 240 {
                return None;
            }
            let mut pid = 0;
            if GetWindowThreadProcessId(hwnd, &mut pid) == 0 || pid == std::process::id() {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let (mut birth, mut exit, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            let ok = GetProcessTimes(process, &mut birth, &mut exit, &mut kernel, &mut user);
            CloseHandle(process);
            if ok == 0 {
                return None;
            }
            let mut above = GetWindow(hwnd, GW_HWNDPREV);
            for _ in 0..128 {
                if above.is_null() {
                    return Some(NativeBounds {
                        x: rect.left,
                        y: rect.top,
                        width: width as u32,
                        height: height as u32,
                        pid,
                        birth: (u64::from(birth.dwHighDateTime) << 32)
                            | u64::from(birth.dwLowDateTime),
                        covered_top: 0,
                    });
                }
                if above as usize != LIVE_OVERLAY.load(Ordering::Relaxed)
                    && visible(above)
                    && !fully_transparent(above)
                {
                    let other = frame(above)?;
                    let w = rect
                        .right
                        .min(other.right)
                        .saturating_sub(rect.left.max(other.left))
                        .max(0);
                    let h = rect
                        .bottom
                        .min(other.bottom)
                        .saturating_sub(rect.top.max(other.top))
                        .max(0);
                    if w > 0 && h > 0 {
                        return None;
                    }
                }
                above = GetWindow(above, GW_HWNDPREV);
            }
            None
        }
    }

    unsafe fn fully_transparent(hwnd: HWND) -> bool {
        if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_LAYERED == 0 {
            return false;
        }
        let (mut alpha, mut flags) = (0, 0);
        GetLayeredWindowAttributes(hwnd, std::ptr::null_mut(), &mut alpha, &mut flags) != 0
            && flags & LWA_ALPHA != 0
            && alpha == 0
    }

    #[cfg(test)]
    #[test]
    fn zero_opacity_layered_windows_do_not_cover() {
        use std::ptr::null_mut;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SetLayeredWindowAttributes, WS_POPUP,
        };

        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED,
                class.as_ptr(),
                std::ptr::null(),
                WS_POPUP,
                0,
                0,
                40,
                40,
                null_mut(),
                null_mut(),
                null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            assert_ne!(SetLayeredWindowAttributes(hwnd, 0, 0, LWA_ALPHA), 0);
            assert!(fully_transparent(hwnd));
            assert_ne!(SetLayeredWindowAttributes(hwnd, 0, 1, LWA_ALPHA), 0);
            assert!(!fully_transparent(hwnd));
            DestroyWindow(hwnd);
        }
    }

    pub fn sample(id: u64, _top_fraction: f64, pixels: &mut [u8]) -> bool {
        let Some(window) = bounds(id) else {
            return false;
        };
        // Sample the visible desktop rectangle of the verified HWND. Unlike
        // PrintWindow this never waits for another app's UI thread.
        unsafe {
            let desktop = std::ptr::null_mut();
            let source = GetDC(desktop);
            if source.is_null() {
                return false;
            }
            let scaled = CreateCompatibleDC(source);
            let bitmap = CreateCompatibleBitmap(source, SIZE as i32, SIZE as i32);
            let mut ok = false;
            if !scaled.is_null() && !bitmap.is_null() {
                let previous = SelectObject(scaled, bitmap);
                SetStretchBltMode(scaled, HALFTONE);
                let copied = !previous.is_null()
                    && StretchBlt(
                        scaled,
                        0,
                        0,
                        SIZE as i32,
                        SIZE as i32,
                        source,
                        window.x,
                        window.y,
                        window.width as i32,
                        window.height as i32,
                        SRCCOPY,
                    ) != 0;
                SelectObject(scaled, previous);
                if copied {
                    let mut info = BITMAPINFO::default();
                    let header = &mut info.bmiHeader;
                    header.biSize = size_of_val(header) as u32;
                    header.biWidth = SIZE as i32;
                    header.biHeight = -(SIZE as i32);
                    header.biPlanes = 1;
                    header.biBitCount = 32;
                    header.biCompression = BI_RGB;
                    ok = GetDIBits(
                        scaled,
                        bitmap,
                        0,
                        SIZE as u32,
                        pixels.as_mut_ptr().cast(),
                        &mut info,
                        DIB_RGB_COLORS,
                    ) == SIZE as i32;
                    for pixel in pixels.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                    }
                }
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            if !scaled.is_null() {
                DeleteDC(scaled);
            }
            ReleaseDC(desktop, source);
            ok
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::NativeBounds;

    pub fn ignore_overlay(_: &tauri::WebviewWindow) -> tauri::Result<()> {
        Err(std::io::Error::other("The Helper overlay has no native window identity.").into())
    }

    pub fn request_capture_access() -> bool {
        false
    }
    pub fn bounds(_: u64) -> Option<NativeBounds> {
        None
    }
    pub fn sample(_: u64, _: f64, _: &mut [u8]) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_projection_tracks_only_the_content_preview_verified() {
        let outer = Rect {
            x: -140,
            y: 373,
            width: 650,
            height: 317,
        };
        let content = Rect {
            y: 402,
            height: 288,
            ..outer
        };
        let projected =
            |frame, mac| capture_projection(outer, frame, mac).and_then(|proof| proof.at(outer));
        assert_eq!(projected((650, 317), true), Some(outer));
        assert_eq!(projected((650, 288), true), Some(content));
        assert_eq!(projected((650, 288), false), None);
        assert_eq!(projected((650, 360), true), None);
        assert_eq!(projected((650, 240), true), None);
        assert_eq!(projected((1300, 576), true), Some(content));
        let proof = capture_projection(outer, (650, 288), true).unwrap();
        assert_eq!(
            proof.at(Rect {
                x: -92,
                y: 40,
                ..outer
            }),
            Some(Rect {
                x: -92,
                y: 69,
                ..content
            })
        );
        assert_eq!(
            proof.at(Rect {
                width: 651,
                ..outer
            }),
            None
        );
        assert_eq!(
            proof.at(Rect {
                height: 318,
                ..outer
            }),
            None
        );
    }

    #[test]
    fn only_covers_intersecting_the_verified_content_block_projection() {
        let outer = Rect {
            x: 120,
            y: 243,
            width: 770,
            height: 507,
        };
        let observation = |covered_top| Observation {
            bounds: outer,
            identity: Identity { pid: 1, birth: 1 },
            covered_top,
        };
        let cropped = capture_projection(outer, (770, 475), true).unwrap();
        let uncropped = capture_projection(outer, (770, 507), true).unwrap();
        // The macOS window controls occupy the first 26 pixels, outside the capture.
        assert_eq!(observation(26).project(cropped).unwrap().y, 275);
        assert!(observation(26).project(uncropped).is_none());
        assert!(observation(33).project(cropped).is_none());
    }

    #[test]
    fn window_match_requires_three_textured_landmarks_of_the_same_orientation() {
        let mut pixels = vec![0; SAMPLES];
        assert!(!landmarks_match(&pixels, &[0; LANDMARK_COUNT]));
        for (left, top) in [(3, 12), (48, 12), (3, 48)] {
            for y in 0..5 {
                for x in 0..5 {
                    let pixel = ((top + y * 5) * SIZE + left + x * 5) * 4;
                    pixels[pixel..pixel + 3].fill(if (x + y) % 2 == 1 { 255 } else { 0 });
                }
            }
        }
        let mut expected = [0_i8; LANDMARK_COUNT];
        for landmark in expected.chunks_exact_mut(40) {
            // Both edges reverse direction at every step of the checkerboard.
            let mut values = landmark.iter_mut();
            for y in 0..5 {
                for x in 0..5 {
                    let edge = if (x + y) % 2 == 0 { 63 } else { -63 };
                    if x < 4 {
                        *values.next().unwrap() = edge;
                    }
                    if y < 4 {
                        *values.next().unwrap() = edge;
                    }
                }
            }
        }
        assert!(landmarks_match(&pixels, &expected));
        for edge in &mut expected[80..90] {
            *edge = -*edge;
        }
        assert!(landmarks_match(&pixels, &expected));
        expected[90] = -expected[90];
        assert!(!landmarks_match(&pixels, &expected));
    }
}

#[cfg(all(test, target_os = "macos"))]
#[test]
fn only_visible_app_covers_prevent_overlay() {
    extern "C" {
        fn chalk_window_test_cover(
            width: u32,
            height: u32,
            layer: i32,
            alpha: f64,
            full_display: bool,
            path: *const std::ffi::c_char,
        ) -> bool;
    }
    let dock = c"/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock";
    let app = c"/Applications/Dock.app/Contents/MacOS/Dock";
    let cover = |layer, alpha, full_display, path: &std::ffi::CStr| unsafe {
        chalk_window_test_cover(1, 8, layer, alpha, full_display, path.as_ptr())
    };
    assert!(!cover(20, 1., true, dock));
    assert!(cover(20, 1., true, app));
    assert!(cover(20, 1., false, dock));
    assert!(cover(0, 0.1, false, app));
    assert!(!cover(0, 0., false, app));
    assert!(!cover(-1, 1., false, app));
}
