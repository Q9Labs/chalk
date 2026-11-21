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
        }
    }
}

pub fn request_capture_access() -> bool {
    platform::request_capture_access()
}

pub fn observe(id: u64) -> Option<Observation> {
    platform::bounds(id).map(Observation::from)
}

pub fn matches(id: u64, expected: &[i8]) -> bool {
    if expected.len() != LANDMARK_COUNT {
        return false;
    }
    let mut pixels = vec![0; SAMPLES];
    if !platform::sample(id, &mut pixels) {
        return false;
    }
    landmarks_match(&pixels, expected)
}

fn landmarks_match(pixels: &[u8], expected: &[i8]) -> bool {
    let energy = |x, y| {
        let index = (y * SIZE + x) * 4;
        let [r, g, b, _] = <[u8; 4]>::try_from(&pixels[index..index + 4]).unwrap();
        (i16::from(r) + 2 * i16::from(g) + i16::from(b)) / 4
    };
    let mut actual = Vec::with_capacity(LANDMARK_COUNT);
    for (left, top) in [(3, 3), (48, 3), (3, 48)] {
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
        fn chalk_window_request_capture_access() -> bool;
        fn chalk_window_bounds(id: u32, output: *mut NativeBounds) -> bool;
        fn chalk_window_sample(id: u32, output: *mut u8, size: usize) -> bool;
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

    pub fn sample(id: u64, pixels: &mut [u8]) -> bool {
        let Ok(id) = u32::try_from(id) else {
            return false;
        };
        // The bridge copies only after the callback finishes; it never retains this buffer.
        unsafe { chalk_window_sample(id, pixels.as_mut_ptr(), SIZE) }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{NativeBounds, SIZE};
    use std::mem::{size_of, size_of_val};
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
            GetWindow, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GW_HWNDPREV,
        },
    };

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
            let mut covered = 0_i64;
            let area = i64::from(width) * i64::from(height);
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
                    });
                }
                let mut other_pid = 0;
                GetWindowThreadProcessId(above, &mut other_pid);
                if other_pid != std::process::id() && visible(above) {
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
                    covered += i64::from(w) * i64::from(h);
                    if covered * 100 > area * 8 {
                        return None;
                    }
                }
                above = GetWindow(above, GW_HWNDPREV);
            }
            None
        }
    }

    pub fn sample(id: u64, pixels: &mut [u8]) -> bool {
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

    pub fn request_capture_access() -> bool {
        false
    }
    pub fn bounds(_: u64) -> Option<NativeBounds> {
        None
    }
    pub fn sample(_: u64, _: &mut [u8]) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_match_requires_three_textured_landmarks_of_the_same_orientation() {
        let mut pixels = vec![0; SAMPLES];
        assert!(!landmarks_match(&pixels, &[0; LANDMARK_COUNT]));
        for (left, top) in [(3, 3), (48, 3), (3, 48)] {
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
