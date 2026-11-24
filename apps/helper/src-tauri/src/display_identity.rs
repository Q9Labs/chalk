use crate::geometry::Rect;

#[derive(Debug, PartialEq)]
pub struct Display {
    pub bounds: Rect,
    identity: String,
    scale: (u32, u32),
}

impl Display {
    pub fn at(bounds: Rect) -> Option<Self> {
        let (identity, scale) = native_identity(bounds)?;
        Some(Self {
            bounds,
            identity,
            scale,
        })
    }

    pub fn is_same(&self, current: &Self) -> bool {
        self == current
    }
}

#[cfg(target_os = "macos")]
fn native_identity(bounds: Rect) -> Option<(String, (u32, u32))> {
    extern "C" {
        fn chalk_display_identity(x: i32, y: i32, width: u32, height: u32, output: *mut u8)
            -> bool;
    }
    let mut output = [0_u8; 37];
    if !unsafe {
        chalk_display_identity(
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            output.as_mut_ptr(),
        )
    } {
        return None;
    }
    Some((String::from_utf8(output[..36].to_vec()).ok()?, (0, 0)))
}

#[cfg(target_os = "windows")]
fn native_identity(bounds: Rect) -> Option<(String, (u32, u32))> {
    use std::mem::size_of;
    use windows_sys::Win32::{
        Foundation::RECT,
        Graphics::Gdi::{
            EnumDisplayDevicesW, GetMonitorInfoW, MonitorFromRect, DISPLAY_DEVICEW,
            DISPLAY_DEVICE_ACTIVE, MONITORINFOEXW, MONITOR_DEFAULTTONULL,
        },
        UI::{
            HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
            WindowsAndMessaging::EDD_GET_DEVICE_INTERFACE_NAME,
        },
    };

    let rect = RECT {
        left: bounds.x,
        top: bounds.y,
        right: bounds.x.checked_add(i32::try_from(bounds.width).ok()?)?,
        bottom: bounds.y.checked_add(i32::try_from(bounds.height).ok()?)?,
    };
    let mut monitor = MONITORINFOEXW::default();
    monitor.monitorInfo.cbSize = size_of::<MONITORINFOEXW>() as u32;
    let mut device = DISPLAY_DEVICEW {
        cb: size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    unsafe {
        let handle = MonitorFromRect(&rect, MONITOR_DEFAULTTONULL);
        if handle.is_null()
            || GetMonitorInfoW(handle, &mut monitor.monitorInfo) == 0
            || (rect.left, rect.top, rect.right, rect.bottom)
                != (
                    monitor.monitorInfo.rcMonitor.left,
                    monitor.monitorInfo.rcMonitor.top,
                    monitor.monitorInfo.rcMonitor.right,
                    monitor.monitorInfo.rcMonitor.bottom,
                )
        {
            return None;
        }
        let (mut dpi_x, mut dpi_y) = (0, 0);
        if GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) != 0
            || dpi_x == 0
            || dpi_y == 0
        {
            return None;
        }
        let mut identity = None;
        for index in 0..16 {
            if EnumDisplayDevicesW(
                monitor.szDevice.as_ptr(),
                index,
                &mut device,
                EDD_GET_DEVICE_INTERFACE_NAME,
            ) == 0
            {
                return Some((identity?, (dpi_x, dpi_y)));
            }
            if device.StateFlags & DISPLAY_DEVICE_ACTIVE != 0 {
                let end = device.DeviceID.iter().position(|c| *c == 0)?;
                if end == 0 || identity.is_some() {
                    return None;
                }
                identity = Some(String::from_utf16(&device.DeviceID[..end]).ok()?);
            }
        }
        None
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn native_identity(_: Rect) -> Option<(String, (u32, u32))> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_equal_size_replacement_at_the_same_coordinates_cannot_reuse_the_probe() {
        let bounds = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let selected = Display {
            bounds,
            identity: "selected".into(),
            scale: (96, 96),
        };
        let replacement = Display {
            bounds,
            identity: "different".into(),
            scale: (96, 96),
        };
        assert!(!selected.is_same(&replacement));
        let rescaled = Display {
            scale: (144, 144),
            ..selected
        };
        let original_scale = Display {
            scale: (96, 96),
            identity: rescaled.identity.clone(),
            ..rescaled
        };
        assert!(!original_scale.is_same(&rescaled));
    }
}
