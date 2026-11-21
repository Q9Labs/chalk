#[cfg(any(target_os = "macos", target_os = "windows"))]
const ACCOUNT: &str = "Chalk Helper";

#[cfg(target_os = "macos")]
pub fn read(target: &str) -> Result<Option<Vec<u8>>, &'static str> {
    use security_framework::passwords::get_generic_password;
    match get_generic_password(target, ACCOUNT) {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(_) => Err("Could not read the Chalk Helper credential from Keychain."),
    }
}

#[cfg(target_os = "macos")]
pub fn store(target: &str, data: &[u8]) -> Result<(), &'static str> {
    extern "C" {
        fn chalk_store_credential(
            target: *const std::ffi::c_char,
            data: *const u8,
            len: usize,
        ) -> bool;
    }
    let error = "Could not save the Chalk Helper credential to Keychain.";
    let target = std::ffi::CString::new(target).map_err(|_| error)?;
    if unsafe { chalk_store_credential(target.as_ptr(), data.as_ptr(), data.len()) } {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(target_os = "macos")]
pub fn clear(target: &str) -> Result<(), &'static str> {
    match security_framework::passwords::delete_generic_password(target, ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("Could not remove the Chalk Helper credential from Keychain."),
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::ACCOUNT;
    use crate::windows_key;
    use std::{io, ptr, slice};
    use windows_sys::Win32::{
        Foundation::ERROR_NOT_FOUND,
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain([0]).collect()
    }

    fn not_found() -> bool {
        io::Error::last_os_error().raw_os_error() == Some(ERROR_NOT_FOUND as i32)
    }

    pub fn read(target: &str) -> Result<Option<Vec<u8>>, &'static str> {
        let target = wide(target);
        let mut entry = ptr::null_mut();
        // Credential Manager owns the returned buffer until CredFree.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut entry) } == 0 {
            return if not_found() {
                Ok(None)
            } else {
                Err("Could not read the Chalk Helper credential from Credential Manager.")
            };
        }
        let data = unsafe {
            let credential = &*entry;
            let data = if credential.CredentialBlobSize == 0 {
                Vec::new()
            } else {
                slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                )
                .to_vec()
            };
            CredFree(entry.cast());
            data
        };
        windows_key::unseal(&target, &data).map(Some)
    }

    pub fn store(target: &str, data: &[u8]) -> Result<(), &'static str> {
        let mut target = wide(target);
        let mut account = wide(ACCOUNT);
        let mut data = windows_key::seal(&target, data)?;
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: data.len() as u32,
            CredentialBlob: data.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: account.as_mut_ptr(),
            ..Default::default()
        };
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err("Could not save the Chalk Helper credential to Credential Manager.");
        }
        Ok(())
    }

    pub fn clear(target: &str) -> Result<(), &'static str> {
        let target = wide(target);
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } != 0 || not_found() {
            return windows_key::forget(&target);
        }
        Err("Could not remove the Chalk Helper credential from Credential Manager.")
    }
}

#[cfg(target_os = "windows")]
pub use windows::{clear, read, store};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn read(_: &str) -> Result<Option<Vec<u8>>, &'static str> {
    Err("Device credentials are not supported on this operating system.")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn store(_: &str, _: &[u8]) -> Result<(), &'static str> {
    Err("Device credentials are not supported on this operating system.")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn clear(_: &str) -> Result<(), &'static str> {
    Err("Device credentials are not supported on this operating system.")
}
