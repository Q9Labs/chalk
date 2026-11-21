// Credential Manager stores ciphertext only. A different app running as this
// account can still request unwrapping, but Windows must authorize private key
// use interactively; the non-exportable wrapping key never enters Helper.
use std::{mem::size_of_val, ptr};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::{NTE_BAD_KEYSET, NTE_NOT_FOUND},
        Security::Cryptography::{
            NCryptCreatePersistedKey, NCryptDecrypt, NCryptDeleteKey, NCryptEncrypt,
            NCryptFinalizeKey, NCryptFreeObject, NCryptGetProperty, NCryptOpenKey,
            NCryptOpenStorageProvider, NCryptSetProperty, BCRYPT_OAEP_PADDING_INFO,
            BCRYPT_SHA256_ALGORITHM, MS_KEY_STORAGE_PROVIDER, NCRYPT_EXPORT_POLICY_PROPERTY,
            NCRYPT_LENGTH_PROPERTY, NCRYPT_PAD_OAEP_FLAG, NCRYPT_RSA_ALGORITHM, NCRYPT_SILENT_FLAG,
            NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG, NCRYPT_UI_POLICY, NCRYPT_UI_POLICY_PROPERTY,
        },
    },
};

const SEALED_BYTES: usize = 384;
const ERROR: &str = "Windows could not protect the Chalk Helper credential. Use the call preview.";

struct Handle(usize);

impl Drop for Handle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe { NCryptFreeObject(self.0) };
        }
    }
}

impl Handle {
    fn storage() -> Result<Self, &'static str> {
        let mut provider = Self(0);
        if unsafe { NCryptOpenStorageProvider(&mut provider.0, MS_KEY_STORAGE_PROVIDER, 0) } != 0 {
            return Err(ERROR);
        }
        Ok(provider)
    }

    fn key(&self, name: &[u16]) -> Result<Option<Self>, &'static str> {
        let mut key = Self(0);
        match unsafe { NCryptOpenKey(self.0, &mut key.0, name.as_ptr(), 0, NCRYPT_SILENT_FLAG) } {
            0 => Ok(Some(key)),
            NTE_BAD_KEYSET | NTE_NOT_FOUND => Ok(None),
            _ => Err(ERROR),
        }
    }

    fn create_key(&self, name: &[u16]) -> Result<Self, &'static str> {
        let mut key = Self(0);
        let policy = NCRYPT_UI_POLICY {
            dwVersion: 1,
            dwFlags: NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG,
            pszCreationTitle: w!("Protect Chalk Helper"),
            pszFriendlyName: w!("Chalk Helper device credential"),
            pszDescription: w!("Confirm to unlock your registered Chalk Helper device."),
        };
        let length = (SEALED_BYTES as u32 * 8).to_ne_bytes();
        let export_policy = 0_u32.to_ne_bytes();
        unsafe {
            if NCryptCreatePersistedKey(
                self.0,
                &mut key.0,
                NCRYPT_RSA_ALGORITHM,
                name.as_ptr(),
                0,
                0,
            ) != 0
                || NCryptSetProperty(key.0, NCRYPT_LENGTH_PROPERTY, length.as_ptr(), 4, 0) != 0
                || NCryptSetProperty(
                    key.0,
                    NCRYPT_EXPORT_POLICY_PROPERTY,
                    export_policy.as_ptr(),
                    4,
                    0,
                ) != 0
                || NCryptSetProperty(
                    key.0,
                    NCRYPT_UI_POLICY_PROPERTY,
                    (&policy as *const NCRYPT_UI_POLICY).cast(),
                    size_of_val(&policy) as u32,
                    0,
                ) != 0
                || NCryptFinalizeKey(key.0, 0) != 0
            {
                return Err(ERROR);
            }
        }
        Ok(key)
    }

    fn check_policy(&self) -> Result<(), &'static str> {
        let mut policy = [0_u8; 4096];
        let mut export = [0_u8; 4];
        let mut size = 0;
        unsafe {
            if NCryptGetProperty(
                self.0,
                NCRYPT_UI_POLICY_PROPERTY,
                policy.as_mut_ptr(),
                policy.len() as u32,
                &mut size,
                NCRYPT_SILENT_FLAG,
            ) != 0
                || size < 8
                || u32::from_ne_bytes(policy[4..8].try_into().map_err(|_| ERROR)?)
                    & NCRYPT_UI_FORCE_HIGH_PROTECTION_FLAG
                    == 0
                || NCryptGetProperty(
                    self.0,
                    NCRYPT_EXPORT_POLICY_PROPERTY,
                    export.as_mut_ptr(),
                    export.len() as u32,
                    &mut size,
                    NCRYPT_SILENT_FLAG,
                ) != 0
                || size != 4
                || export != [0; 4]
            {
                return Err(ERROR);
            }
        }
        Ok(())
    }
}

fn with_padding(key: Handle, data: &[u8], encrypt: bool) -> Result<Vec<u8>, &'static str> {
    key.check_policy()?;
    let padding = BCRYPT_OAEP_PADDING_INFO {
        pszAlgId: BCRYPT_SHA256_ALGORITHM,
        pbLabel: ptr::null_mut(),
        cbLabel: 0,
    };
    let mut output = vec![0; SEALED_BYTES];
    let mut length = 0;
    let operation = if encrypt {
        NCryptEncrypt
    } else {
        NCryptDecrypt
    };
    let flags = if encrypt {
        NCRYPT_PAD_OAEP_FLAG | NCRYPT_SILENT_FLAG
    } else {
        NCRYPT_PAD_OAEP_FLAG
    };
    if unsafe {
        operation(
            key.0,
            data.as_ptr(),
            data.len().try_into().map_err(|_| ERROR)?,
            (&padding as *const BCRYPT_OAEP_PADDING_INFO).cast(),
            output.as_mut_ptr(),
            SEALED_BYTES as u32,
            &mut length,
            flags,
        )
    } != 0
        || length == 0
        || length as usize > output.len()
    {
        return Err(ERROR);
    }
    output.truncate(length as usize);
    Ok(output)
}

pub fn seal(name: &[u16], plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    let provider = Handle::storage()?;
    let key = match provider.key(name)? {
        Some(key) => key,
        None => provider.create_key(name)?,
    };
    with_padding(key, plaintext, true)
}

pub fn unseal(name: &[u16], ciphertext: &[u8]) -> Result<Vec<u8>, &'static str> {
    if ciphertext.len() != SEALED_BYTES {
        return Err(ERROR);
    }
    let key = Handle::storage()?.key(name)?.ok_or(ERROR)?;
    with_padding(key, ciphertext, false)
}

pub fn forget(name: &[u16]) -> Result<(), &'static str> {
    if let Some(mut key) = Handle::storage()?.key(name)? {
        if unsafe { NCryptDeleteKey(key.0, 0) } != 0 {
            return Err(ERROR);
        }
        key.0 = 0;
    }
    Ok(())
}
