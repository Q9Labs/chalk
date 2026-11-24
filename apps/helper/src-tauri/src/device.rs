use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use reqwest::{Client, StatusCode};
#[cfg(not(target_os = "windows"))]
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use ring::{
    digest::{digest, SHA256},
    rand::{SecureRandom, SystemRandom},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::JoinHandle;
use tokio::time::{sleep, timeout};

use crate::{attachment, credentials};

const REQUEST_LIFETIME: Duration = Duration::from_secs(300);
const REATTACH_INTERVAL: Duration = Duration::from_secs(12);
const OFFLINE: &str = "Could not reach Chalk to connect this device.";

#[derive(Clone, Default)]
pub struct DeviceConnection(Arc<Mutex<Connection>>);

#[derive(Default)]
struct Connection {
    task: Option<JoinHandle<()>>,
    view: DeviceView,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub available: bool,
    pub code: Option<String>,
    pub fingerprint: Option<String>,
    pub status: Option<&'static str>,
}

#[derive(Deserialize, Serialize)]
struct Registration {
    #[cfg(not(target_os = "windows"))]
    key: String,
    credential: String,
    registered: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCode {
    code: String,
    interval_seconds: u64,
}

#[derive(Deserialize)]
struct Poll {
    attachment: Option<Ticket>,
}

#[derive(Deserialize)]
struct Ticket {
    ticket: String,
}

fn api_origin() -> Result<&'static str, &'static str> {
    let value = option_env!("CHALK_HELPER_API_ORIGIN")
        .ok_or("Device codes are not configured in this build.")?;
    let url = tauri::Url::parse(value).map_err(|_| "Invalid Chalk API origin.")?;
    if url.scheme() != "https" || url.origin().ascii_serialization() != value {
        return Err("Device codes require an exact HTTPS API origin.");
    }
    Ok(value)
}

fn credential_target(origin: &str) -> String {
    format!("Chalk Helper device credentials v2: {origin}")
}

fn retire_legacy_credentials(origin: &str) -> Result<(), &'static str> {
    // The server invalidates all legacy registrations, including those on
    // installations that never upgrade. Never unwrap the old private keys.
    for prefix in [
        "Chalk Helper device credentials",
        "Chalk Helper protected device credentials",
    ] {
        credentials::clear(&format!("{prefix}: {origin}"))?;
    }
    Ok(())
}

pub fn retire_configured_legacy_credentials() {
    if let Ok(origin) = api_origin() {
        if retire_legacy_credentials(origin).is_err() {
            eprintln!("chalk-helper: legacy_device_credential_cleanup_failed");
        }
    }
}

impl DeviceConnection {
    pub fn view(&self) -> DeviceView {
        let mut view = self.0.lock().expect("device connection").view.clone();
        view.available = api_origin().is_ok();
        view
    }

    pub fn start(&self, tenant_id: &str) -> Result<(), &'static str> {
        let tenant = uuid::Uuid::parse_str(tenant_id.trim())
            .map_err(|_| "Paste the account ID shown in your Chalk call.")?;
        if tenant.is_nil() {
            return Err("Paste the account ID shown in your Chalk call.");
        }
        let origin = api_origin()?;
        let mut state = self.0.lock().expect("device connection");
        if let Some(task) = state.task.take() {
            task.abort();
        }
        state.view = DeviceView {
            status: Some("Requesting a device code…"),
            ..Default::default()
        };
        let owner = self.clone();
        state.task = Some(tauri::async_runtime::spawn(async move {
            let result = owner.connect(origin, tenant).await;
            owner.0.lock().expect("device connection").view = DeviceView {
                status: Some(result.err().unwrap_or("The device connection ended.")),
                ..Default::default()
            };
        }));
        Ok(())
    }

    pub fn clear(&self) -> Result<(), &'static str> {
        let origin = api_origin()?;
        let mut state = self.0.lock().expect("device connection");
        if let Some(task) = state.task.take() {
            task.abort();
        }
        retire_legacy_credentials(origin)?;
        let target = credential_target(origin);
        credentials::clear(&target)?;
        #[cfg(target_os = "windows")]
        crate::windows_key::DeviceSigner::clear(&target)?;
        state.view = DeviceView {
            status: Some("Device credential removed from this computer."),
            ..Default::default()
        };
        Ok(())
    }

    async fn connect(&self, origin: &str, tenant: uuid::Uuid) -> Result<(), &'static str> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| OFFLINE)?;
        let target = credential_target(origin);
        let name = if cfg!(target_os = "macos") {
            "Chalk Helper on Mac"
        } else {
            "Chalk Helper on Windows"
        };
        let (mut registration, existed) = {
            let _state = self.0.lock().expect("device connection");
            retire_legacy_credentials(origin)?;
            match credentials::read(&target)? {
                Some(data) => (
                    serde_json::from_slice::<Registration>(&data)
                        .map_err(|_| "Remove the unreadable device credential and try again.")?,
                    true,
                ),
                None => {
                    #[cfg(not(target_os = "windows"))]
                    let generated = EcdsaKeyPair::generate_pkcs8(
                        &ECDSA_P256_SHA256_FIXED_SIGNING,
                        &SystemRandom::new(),
                    )
                    .map_err(|_| "Could not create a device key.")?;
                    #[cfg(target_os = "windows")]
                    crate::windows_key::DeviceSigner::open(&target, true)?;
                    let registration = Registration {
                        #[cfg(not(target_os = "windows"))]
                        key: URL_SAFE_NO_PAD.encode(generated.as_ref()),
                        credential: secret()?,
                        registered: false,
                    };
                    save(&target, &registration)?;
                    (registration, false)
                }
            }
        };
        #[cfg(not(target_os = "windows"))]
        let (key, public_key) = {
            let document = URL_SAFE_NO_PAD
                .decode(&registration.key)
                .map_err(|_| "Could not read the device key.")?;
            let key = EcdsaKeyPair::from_pkcs8(
                &ECDSA_P256_SHA256_FIXED_SIGNING,
                &document,
                &SystemRandom::new(),
            )
            .map_err(|_| "Could not read the device key.")?;
            let public_key = URL_SAFE_NO_PAD.encode(key.public_key().as_ref());
            (Arc::new(key), public_key)
        };
        #[cfg(target_os = "windows")]
        let (key, public_key) = {
            let key = crate::windows_key::DeviceSigner::open(&target, false)?;
            let public_key = URL_SAFE_NO_PAD.encode(key.public_key()?);
            (Arc::new(key), public_key)
        };
        let poll_secret = secret()?;
        let start = |registered| {
            post::<DeviceCode>(
                &client,
                origin,
                "start",
                json!({
                    "name": name, "publicKey": public_key, "credential": registration.credential,
                    "pollSecret": poll_secret, "registered": registered, "tenantId": tenant.to_string()
                }),
            )
        };
        let code = match start(existed).await {
            Err(StatusCode::FORBIDDEN) if existed && !registration.registered => start(false).await,
            response => response,
        }.map_err(|status| match status {
            StatusCode::FORBIDDEN => "This device is no longer registered. Remove the local credential to register again.",
            StatusCode::TOO_MANY_REQUESTS => "Too many code requests. Try again in a minute.",
            _ => OFFLINE,
        })?;
        let delay = Duration::from_secs(code.interval_seconds.clamp(3, 30));
        let fingerprint = fingerprint(&public_key, &code.code, &tenant.to_string())?;
        self.0.lock().expect("device connection").view = DeviceView {
            code: Some(code.code),
            fingerprint: Some(fingerprint),
            status: Some("Approve this code in your signed-in Chalk call."),
            ..Default::default()
        };
        let mut until = Instant::now() + REQUEST_LIFETIME;
        let mut accepted = false;
        loop {
            sleep(delay + Duration::from_millis(100)).await;
            if Instant::now() >= until {
                return Err(if accepted {
                    "The device connection ended."
                } else {
                    "The device code expired."
                });
            }
            let poll = match post::<Poll>(
                &client,
                origin,
                "poll",
                json!({ "pollSecret": poll_secret }),
            )
            .await
            {
                Ok(poll) => poll,
                Err(StatusCode::FORBIDDEN) => {
                    return Err("The registration or share is no longer authorized.")
                }
                Err(StatusCode::TOO_MANY_REQUESTS) => {
                    sleep(delay).await;
                    continue;
                }
                Err(_) => return Err(OFFLINE),
            };
            let Some(ticket) = poll.attachment else {
                if accepted {
                    return Err("The share is no longer available.");
                }
                continue;
            };
            if !registration.registered {
                let _state = self.0.lock().expect("device connection");
                registration.registered = true;
                save(&target, &registration)?;
            }
            let mut received_state = false;
            let result = timeout(
                REATTACH_INTERVAL,
                attachment::receive(
                    ticket.ticket,
                    attachment::Signer::Device(key.clone()),
                    |frame| {
                        if frame.get("type").and_then(Value::as_str) == Some("annotation_state") {
                            received_state = true;
                            accepted = true;
                            until = Instant::now() + REQUEST_LIFETIME;
                            let mut state = self.0.lock().expect("device connection");
                            state.view.code = None;
                            state.view.fingerprint = None;
                            state.view.status =
                                Some("Connected to the share. Use the call preview for marks.");
                        }
                        true
                    },
                ),
            )
            .await;
            if matches!(result, Ok(Err(_))) || !received_state {
                return Err("Chalk Sync did not accept the device attachment.");
            }
        }
    }
}

async fn post<T: DeserializeOwned>(
    client: &Client,
    origin: &str,
    path: &str,
    body: Value,
) -> Result<T, StatusCode> {
    let unavailable = StatusCode::SERVICE_UNAVAILABLE;
    let mut response = client
        .post(format!(
            "{origin}/v1/screen-annotation/helper/device/{path}"
        ))
        .json(&body)
        .send()
        .await
        .map_err(|_| unavailable)?;
    if !response.status().is_success() {
        return Err(response.status());
    }
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable)? {
        if data.len() + chunk.len() > 8192 {
            return Err(unavailable);
        }
        data.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&data).map_err(|_| unavailable)
}

fn secret() -> Result<String, &'static str> {
    let mut raw = [0; 32];
    SystemRandom::new()
        .fill(&mut raw)
        .map_err(|_| "Could not create a device secret.")?;
    Ok(URL_SAFE_NO_PAD.encode(raw))
}

fn save(target: &str, registration: &Registration) -> Result<(), &'static str> {
    let data =
        serde_json::to_vec(registration).map_err(|_| "Could not prepare the device credential.")?;
    credentials::store(target, &data)
}

fn fingerprint(public_key: &str, code: &str, tenant: &str) -> Result<String, &'static str> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = code.replace('-', "");
    if code.len() != 8 || !code.bytes().all(|byte| ALPHABET.contains(&byte)) {
        return Err("Chalk returned an invalid device code.");
    }
    let hash = digest(
        &SHA256,
        format!("{public_key}\n{tenant}\n{code}").as_bytes(),
    );
    let mut accumulator = 0_u64;
    for &byte in &hash.as_ref()[..5] {
        accumulator = (accumulator << 8) | u64::from(byte);
    }
    Ok((0..8)
        .rev()
        .map(|shift| char::from(ALPHABET[((accumulator >> (shift * 5)) & 31) as usize]))
        .collect())
}
