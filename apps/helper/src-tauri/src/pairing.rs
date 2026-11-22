use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{geometry::Rect, helper_scene::Scene, live};
use crate::{pairing_consent as consent, window_follow};
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter};
use tokio::{
    sync::{mpsc, oneshot, Semaphore},
    task::JoinHandle,
};
use tokio_stream::{wrappers::IntervalStream, StreamExt};

const PORT: u16 = 47361;
const HOST: &str = "127.0.0.1:47361";
const VERSION: u8 = 1;
const LIFETIME: Duration = Duration::from_secs(60);
const ISSUER_CLOCK_TOLERANCE: Duration = Duration::from_secs(1);
const AUDIENCE: &str = "screen_annotation_helper_local_v1";

#[derive(Clone)]
pub struct Pairing(Arc<PairingInner>);

struct PairingInner {
    origin: HeaderValue,
    issuer_key: [u8; 32],
    helper_public_key: String,
    key: Arc<Ed25519KeyPair>,
    app: Mutex<Option<AppHandle>>,
    window_sample: Arc<Semaphore>,
    state: Mutex<Local>,
}

#[derive(Default)]
struct Local {
    challenge: Option<Outstanding>,
    approval: Option<Approval>,
    session: Option<Session>,
}

struct Outstanding {
    browser_public_key: String,
    challenge: String,
    until: Instant,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    fingerprint: String,
    confirmation_code: String,
}

struct Approval {
    prompt: ApprovalPrompt,
    attachment_hash: String,
    until: Instant,
    respond: oneshot::Sender<Option<String>>,
    ticket: Ticket,
}

struct Session {
    secret: String,
    until: Instant,
    ticket: Ticket,
    attachment_hash: Option<String>,
    commands: Option<mpsc::Sender<serde_json::Value>>,
    next_attachment: u64,
    attachment: Option<JoinHandle<()>>,
    status: &'static str,
    capture: live::Capture,
}

impl Session {
    fn authorizes(&self, secret: &str) -> bool {
        bool::from(self.secret.as_bytes().ct_eq(secret.as_bytes())) && self.until > Instant::now()
    }

    fn usable(&self) -> bool {
        self.until > Instant::now() && self.status == "unbound"
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(task) = self.attachment.take() {
            task.abort();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChallengeRequest {
    browser_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    version: u8,
    helper_public_key: String,
    challenge: String,
    expires_at_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attach {
    version: u8,
    challenge: String,
    browser_proof: String,
    pair_ticket: String,
    attachment_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedHeader {
    alg: String,
    typ: String,
    #[serde(rename = "kid")]
    _kid: Option<String>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ticket {
    aud: String,
    expires_at_ms: u64,
    version: u8,
    challenge: String,
    origin: String,
    helper_public_key: String,
    role: String,
    tenant_id: String,
    space_id: String,
    episode_id: String,
    participant_id: String,
    generation: u64,
    publication_id: String,
    layer_id: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Exchange {
    Disconnect,
    #[serde(rename = "capture")]
    Describe {
        surface: String,
        width: u32,
        height: u32,
        #[serde(rename = "windowId")]
        window_id: Option<String>,
    },
    WindowSample {
        width: u32,
        height: u32,
        landmarks: Vec<i8>,
    },
    ProbeStart,
    ProbePainted {
        nonce: String,
    },
    WindowProbeStart,
    ProbeProtect {
        nonce: String,
    },
    ProbeComplete {
        nonce: String,
    },
    ProbeAbort,
    Authorize {
        #[serde(rename = "attachmentTicket")]
        attachment_ticket: String,
    },
    Refresh {
        #[serde(rename = "pairTicket")]
        pair_ticket: String,
        #[serde(rename = "attachmentTicket")]
        attachment_ticket: String,
    },
}

#[derive(Deserialize)]
struct AttachmentTicket {
    aud: String,
    role: String,
    version: u8,
    tenant_id: String,
    space_id: String,
    episode_id: String,
    participant_id: String,
    participant_generation: u64,
    publication_id: String,
    layer_id: String,
    exp: u64,
    cnf: AttachmentConfirmation,
}

#[derive(Deserialize)]
struct AttachmentConfirmation {
    jwk: AttachmentKey,
}

#[derive(Deserialize)]
struct AttachmentKey {
    kty: String,
    crv: String,
    x: String,
}

impl Pairing {
    pub fn configured() -> Result<Option<Self>, &'static str> {
        let origin = option_env!("CHALK_HELPER_WEB_ORIGIN");
        let issuer = option_env!("CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY");
        match (origin, issuer) {
            (None, None) => Ok(None),
            (Some(origin), Some(key)) => Self::new(origin, key).map(Some),
            _ => Err("Configure both the Chalk origin and the pair-ticket verification key."),
        }
    }

    fn new(origin: &str, issuer: &str) -> Result<Self, &'static str> {
        if !tauri::Url::parse(origin).is_ok_and(|url| {
            url.scheme() == "https" && url.origin().ascii_serialization() == origin
        }) {
            return Err("Pairing requires an exact HTTPS Origin.");
        }
        let origin = HeaderValue::from_str(origin).map_err(|_| "Chalk Origin is invalid.")?;
        let issuer_key = URL_SAFE_NO_PAD
            .decode(issuer)
            .ok()
            .and_then(|key| key.try_into().ok())
            .ok_or("Pair-ticket public key is invalid.")?;
        let rng = SystemRandom::new();
        let document = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng)
            .map_err(|_| "Could not make a Helper key.")?;
        let key = ring::signature::Ed25519KeyPair::from_pkcs8(document.as_ref())
            .map_err(|_| "Could not read the Helper key.")?;
        Ok(Self(Arc::new(PairingInner {
            origin,
            issuer_key,
            helper_public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
            key: Arc::new(key),
            app: Mutex::default(),
            window_sample: Arc::new(Semaphore::new(1)),
            state: Mutex::default(),
        })))
    }

    pub async fn serve(self) {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, PORT);
        match tokio::net::TcpListener::bind(address).await {
            Ok(listener) => {
                if axum::serve(listener, self.router()).await.is_err() {
                    eprintln!("chalk-helper: pairing_listener_failed");
                }
            }
            Err(_) => eprintln!("chalk-helper: pairing_listener_unavailable"),
        }
    }

    fn router(self) -> Router {
        Router::new()
            .route("/v1/challenge", post(challenge))
            .route("/v1/attach", post(attach))
            .route("/v1/exchange", post(exchange))
            .route("/v1/events", get(events))
            .layer(DefaultBodyLimit::max(512 * 1024))
            .layer(middleware::from_fn_with_state(
                self.clone(),
                request_boundary,
            ))
            .with_state(self)
    }

    pub fn approval_prompt(&self) -> Option<ApprovalPrompt> {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .approval
            .as_ref()
            .filter(|approval| approval.until > Instant::now() && !approval.respond.is_closed())
            .map(|approval| approval.prompt.clone())
    }

    pub fn decide(&self, fingerprint: &str, allowed: bool) {
        let mut state = self.0.state.lock().expect("pairing state");
        if state.approval.as_ref().is_some_and(|approval| {
            approval.until > Instant::now() && approval.prompt.fingerprint == fingerprint
        }) {
            if let Some(approval) = state.approval.take() {
                let secret = allowed.then(random_secret).and_then(Result::ok);
                if approval.respond.send(secret.clone()).is_ok() {
                    state.session = secret.map(|secret| Session {
                        secret,
                        until: approval.until,
                        ticket: approval.ticket,
                        attachment_hash: Some(approval.attachment_hash),
                        commands: None,
                        next_attachment: 0,
                        attachment: None,
                        status: "waiting_for_sync",
                        capture: live::Capture::default(),
                    });
                }
            }
        }
    }

    pub fn connected(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .is_some_and(Session::usable)
    }

    pub fn set_app(&self, app: AppHandle) {
        *self.0.app.lock().expect("app handle") = Some(app);
    }

    pub fn upkeep(&self) -> bool {
        let Some(app) = self.0.app.lock().expect("app handle").clone() else {
            return false;
        };
        let pairing = self.clone();
        let owner = app.clone();
        app.run_on_main_thread(move || {
            let mut state = pairing.0.state.lock().expect("pairing state");
            let live = state.session.as_mut().filter(|session| session.usable());
            if let Some(session) = live {
                session.capture.restore_visibility(&owner);
                if session.capture.reconcile_window(&owner) {
                    return;
                }
                if session.capture.allows_window() {
                    session.capture.disable_stale_input(&owner);
                    if !session.capture.projection_is_current() {
                        session.capture.fail(&owner);
                    }
                    return;
                }
            }
            live::hide(&owner);
        })
        .is_ok()
    }

    pub fn overlay(&self) -> Option<live::Overlay> {
        let state = self.0.state.lock().expect("pairing state");
        let session = state.session.as_ref().filter(|session| session.usable())?;
        session.capture.get_overlay()
    }

    pub fn with_capture(&self, callback: impl FnOnce(&mut live::Capture)) {
        let mut state = self.0.state.lock().expect("pairing state");
        if let Some(session) = state.session.as_mut().filter(|session| session.usable()) {
            callback(&mut session.capture);
            if let (Some(pen), Some(commands)) = (session.capture.drain_commit(), &session.commands)
            {
                let _ = commands.try_send(serde_json::json!({
                    "type":"annotation_command", "operation_id": uuid::Uuid::now_v7(),
                    "layer_id": session.ticket.layer_id, "fence": pen.fence,
                    "command": {"kind":"commit", "draft":{
                        "mark_id": uuid::Uuid::new_v4(), "lifetime":"fade", "color":"#ffffff",
                        "width":pen.width, "shape":{"kind":"pen","points":pen.points}
                    }}
                }));
            }
        }
    }

    pub fn can_draw(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .is_some_and(|session| session.usable() && session.capture.can_draw())
    }

    pub fn offers_monitors(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .is_some_and(|session| session.usable() && session.capture.offers_monitors())
    }

    pub fn offers_window(&self) -> bool {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .is_some_and(|session| session.usable() && session.capture.offers_window())
    }

    pub fn enable_follow(&self) -> Result<(), &'static str> {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_mut()
            .filter(|session| session.usable())
            .ok_or("No active window share.")?
            .capture
            .enable_follow()
    }

    async fn sample_window(
        &self,
        secret: String,
        width: u32,
        height: u32,
        landmarks: Vec<i8>,
    ) -> Result<Response, StatusCode> {
        if landmarks.len() != window_follow::LANDMARK_COUNT {
            return Err(StatusCode::BAD_REQUEST);
        }
        let (id, identity) = self
            .0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .filter(|session| session.authorizes(&secret) && session.usable())
            .and_then(|session| session.capture.window_id())
            .ok_or(StatusCode::CONFLICT)?;
        let permitted = self
            .0
            .window_sample
            .clone()
            .try_acquire_owned()
            .map_err(|_| StatusCode::CONFLICT)?;
        let sample = tokio::task::spawn_blocking(move || {
            let _permit = permitted;
            let before =
                window_follow::observe(id).filter(|observed| observed.identity == identity)?;
            let projection =
                window_follow::matching_projection(id, before.bounds, (width, height), &landmarks)?;
            let observed = window_follow::observe(id).filter(|current| {
                current.identity == identity && current.bounds == before.bounds
            })?;
            Some((observed, projection))
        })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        let Some((observed, projection)) = sample else {
            return Ok(StatusCode::NO_CONTENT.into_response());
        };

        let mut state = self.0.state.lock().expect("pairing state");
        let capture = &mut state
            .session
            .as_mut()
            .filter(|session| session.authorizes(&secret) && session.usable())
            .ok_or(StatusCode::UNAUTHORIZED)?
            .capture;
        capture
            .record_window_match(observed, projection, (width, height))
            .map_err(|_| StatusCode::CONFLICT)?;
        Ok(Json(serde_json::json!({"matched":true})).into_response())
    }

    pub fn select_monitor(&self, bounds: Rect) -> Result<(), ()> {
        let mut state = self.0.state.lock().expect("pairing state");
        let session = state
            .session
            .as_mut()
            .filter(|session| session.usable())
            .ok_or(())?;
        session.capture.select(bounds)
    }

    async fn update_probe(&self, secret: String, action: Exchange) -> Result<Response, StatusCode> {
        let app = self
            .0
            .app
            .lock()
            .expect("app handle")
            .clone()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
        let pairing = self.clone();
        let owner = app.clone();
        let (respond, receive) = oneshot::channel();
        let queued_at = Instant::now();
        app.run_on_main_thread(move || {
            if matches!(action, Exchange::ProbeStart | Exchange::WindowProbeStart)
                && (queued_at.elapsed() > Duration::from_millis(200) || respond.is_closed())
            {
                let _ = respond.send(Err(StatusCode::CONFLICT));
                return;
            }
            let mut state = pairing.0.state.lock().expect("pairing state");
            let aborting = matches!(action, Exchange::ProbeAbort);
            let response = state
                .session
                .as_mut()
                .filter(|session| session.authorizes(&secret) && (aborting || session.usable()))
                .ok_or(StatusCode::UNAUTHORIZED)
                .and_then(|session| {
                    let capture = &mut session.capture;
                    if !matches!(action, Exchange::ProbeAbort | Exchange::WindowProbeStart)
                        && !capture.projection_is_current()
                    {
                        if capture.window_id().is_some() {
                            capture.await_window(&owner);
                        } else {
                            capture.fail(&owner);
                        }
                        return Err(StatusCode::CONFLICT);
                    }
                    match action {
                        Exchange::ProbeStart => {
                            capture.start(&owner).map(|spec| Json(spec).into_response())
                        }
                        Exchange::WindowProbeStart => capture
                            .start_window_probe(&owner)
                            .map(|spec| Json(spec).into_response()),
                        Exchange::ProbePainted { nonce } => capture
                            .painted(&nonce)
                            .map(|()| StatusCode::NO_CONTENT.into_response()),
                        Exchange::ProbeProtect { nonce } => capture
                            .protect(&owner, &nonce)
                            .map(|()| StatusCode::NO_CONTENT.into_response()),
                        Exchange::ProbeComplete { nonce } => capture
                            .complete(&owner, &nonce)
                            .map(|()| StatusCode::NO_CONTENT.into_response()),
                        Exchange::ProbeAbort => {
                            if capture.window_id().is_some() {
                                capture.await_window(&owner);
                            } else {
                                capture.fail(&owner);
                            }
                            Ok(StatusCode::NO_CONTENT.into_response())
                        }
                        _ => Err(()),
                    }
                    .map_err(|()| StatusCode::CONFLICT)
                });
            let _ = respond.send(response);
        })
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        receive.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
    }

    fn signed_payload<'a>(&self, token: &'a str, expected_type: &str) -> Option<&'a str> {
        if token.len() > 4096 {
            return None;
        }
        let (signed, signature) = token.rsplit_once('.')?;
        let (protected, payload) = signed.split_once('.')?;
        let header: ProtectedHeader =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(protected).ok()?).ok()?;
        if header.alg != "EdDSA" || header.typ != expected_type {
            return None;
        }
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        UnparsedPublicKey::new(&ED25519, self.0.issuer_key)
            .verify(signed.as_bytes(), &signature)
            .ok()?;
        Some(payload)
    }

    fn verify_ticket(&self, encoded: &str) -> Option<(Ticket, Instant)> {
        let encoded = self.signed_payload(encoded, "chalk-helper-pair-ticket+jwt")?;
        let ticket: Ticket = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
        let now = utc_ms();
        let identifiers = [
            &ticket.tenant_id,
            &ticket.space_id,
            &ticket.episode_id,
            &ticket.participant_id,
            &ticket.layer_id,
        ];
        let lifetime = ticket_lifetime(ticket.expires_at_ms, now)?;
        if ticket.aud != AUDIENCE
            || ticket.role != "sharer"
            || ticket.version != VERSION
            || ticket.origin.as_bytes() != self.0.origin.as_bytes()
            || ticket.helper_public_key != self.0.helper_public_key
            || ticket.generation == 0
            || ticket.publication_id.is_empty()
            || ticket.publication_id.len() > 512
            || identifiers
                .into_iter()
                .any(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control))
        {
            return None;
        }
        Some((ticket, Instant::now() + lifetime))
    }

    fn verify_attachment(&self, encoded: &str, local: &Ticket) -> Option<Duration> {
        let payload = self.signed_payload(encoded, "JWT")?;
        let ticket: AttachmentTicket =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
        let expires = ticket.exp.checked_mul(1000)?;
        let lifetime = ticket_lifetime(expires, utc_ms())?;
        if ticket.aud != "screen_annotation_helper_v1"
            || ticket.role != "sharer"
            || ticket.version != VERSION
            || ticket.tenant_id != local.tenant_id
            || ticket.space_id != local.space_id
            || ticket.episode_id != local.episode_id
            || ticket.participant_id != local.participant_id
            || ticket.participant_generation != local.generation
            || ticket.publication_id != local.publication_id
            || ticket.layer_id != local.layer_id
            || expires > local.expires_at_ms
            || ticket.cnf.jwk.kty != "OKP"
            || ticket.cnf.jwk.crv != "Ed25519"
            || ticket.cnf.jwk.x != local.helper_public_key
        {
            return None;
        }
        Some(lifetime)
    }

    fn connect_attachment(&self, session: &mut Session, token: String, lifetime: Duration) {
        if let Some(task) = session.attachment.take() {
            task.abort();
        }
        session.next_attachment += 1;
        let serial = session.next_attachment;
        let pairing = Arc::downgrade(&self.0);
        let app = self.0.app.lock().expect("app handle").clone();
        let key = Arc::clone(&self.0.key);
        let secret = session.secret.clone();
        let (commands, receiver) = mpsc::channel(8);
        session.commands = Some(commands.clone());
        session.attachment = Some(tokio::spawn(async move {
            let receive = crate::attachment::receive_with_commands(token, key, receiver, |frame| {
                let Some(pairing) = pairing.upgrade() else {
                    return false;
                };
                let mut state = pairing.state.lock().expect("pairing state");
                let Some(session) = state.session.as_mut().filter(|session| {
                    session.authorizes(&secret) && session.next_attachment == serial
                }) else {
                    return false;
                };
                match frame["type"].as_str() {
                    Some("annotation_state") => {
                        let Some(snapshot) = Scene::snapshot(
                            &frame,
                            &session.ticket.layer_id,
                            &session.ticket.publication_id,
                            &session.ticket.participant_id,
                        ) else {
                            return false;
                        };
                        session.capture.accept_scene(snapshot);
                        session.status = "unbound";
                    }
                    Some("annotation_changed")
                        if session.usable() && frame["layer_id"] == session.ticket.layer_id =>
                    {
                        if session
                            .capture
                            .scene_mut()
                            .and_then(|scene| scene.apply(&frame))
                            .is_none()
                        {
                            session.capture.suspend_scene();
                        }
                    }
                    Some("annotation_presence")
                        if session.usable() && frame["layer_id"] == session.ticket.layer_id =>
                    {
                        if let Some(scene) = session.capture.scene_mut() {
                            scene.presence(frame);
                        }
                    }
                    Some("annotation_receipt") if session.usable() => return true,
                    _ => return false,
                }
                drop(state);
                if let Some(app) = &app {
                    // Wake the renderer; it reads the latest protected view itself.
                    let _ = app.emit_to(live::OVERLAY, "chalk-overlay-changed", ());
                }
                true
            });
            let result = tokio::time::timeout(lifetime, receive).await;
            if let Some(pairing) = pairing.upgrade() {
                let mut state = pairing.state.lock().expect("pairing state");
                if let Some(session) = state
                    .session
                    .as_mut()
                    .filter(|session| session.secret == secret && session.next_attachment == serial)
                {
                    session.status = match result {
                        Ok(Err("update_required")) => "update_required",
                        _ => "disconnected",
                    };
                }
            }
        }));
    }

    fn session_until(&self, secret: &str) -> Option<Instant> {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .session
            .as_ref()
            .filter(|session| {
                bool::from(session.secret.as_bytes().ct_eq(secret.as_bytes()))
                    && session.until > Instant::now()
            })
            .map(|session| session.until)
    }
}

fn ticket_lifetime(expires_at_ms: u64, now_ms: u64) -> Option<Duration> {
    let remaining = Duration::from_millis(expires_at_ms.checked_sub(now_ms)?);
    // Allow a small difference between issuer and Helper wall clocks, but
    // never grant more than the normal lease or accept an expired ticket.
    (!remaining.is_zero() && remaining <= LIFETIME + ISSUER_CLOCK_TOLERANCE)
        .then_some(remaining.min(LIFETIME))
}

fn utc_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn random_secret() -> Result<String, StatusCode> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn exact_header<'a>(headers: &'a HeaderMap, name: header::HeaderName) -> Option<&'a HeaderValue> {
    let all = headers.get_all(name);
    let mut values = all.iter();
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

async fn request_boundary(
    State(pairing): State<Pairing>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if exact_header(headers, header::ORIGIN) != Some(&pairing.0.origin)
        || !exact_header(headers, header::HOST).is_some_and(|host| host == HOST)
        || headers.contains_key(header::COOKIE)
        || request.uri().query().is_some()
        || request.uri().authority().is_some()
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    let mut response = if request.method() == Method::OPTIONS {
        let method = match request.uri().path() {
            "/v1/challenge" | "/v1/attach" | "/v1/exchange" => "POST",
            "/v1/events" => "GET",
            _ => return StatusCode::NOT_FOUND.into_response(),
        };
        if !exact_header(headers, header::ACCESS_CONTROL_REQUEST_METHOD)
            .is_some_and(|value| value == method)
            || headers
                .get_all(header::ACCESS_CONTROL_REQUEST_HEADERS)
                .iter()
                .any(|value| {
                    value.to_str().map_or(true, |value| {
                        value.split(',').any(|name| {
                            !matches!(
                                name.trim().to_ascii_lowercase().as_str(),
                                "content-type" | "authorization"
                            )
                        })
                    })
                })
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static(method),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization"),
        );
        if exact_header(
            headers,
            header::HeaderName::from_static("access-control-request-private-network"),
        )
        .is_some_and(|value| value == "true")
        {
            response.headers_mut().insert(
                header::HeaderName::from_static("access-control-allow-private-network"),
                HeaderValue::from_static("true"),
            );
        }
        response
    } else {
        next.run(request).await
    };
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        pairing.0.origin.clone(),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn challenge(
    State(pairing): State<Pairing>,
    Json(request): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, StatusCode> {
    consent::public_key(&request.browser_public_key).ok_or(StatusCode::BAD_REQUEST)?;
    let now = Instant::now();
    let mut state = pairing.0.state.lock().expect("pairing state");
    if state
        .approval
        .as_ref()
        .is_some_and(|approval| approval.until > now && !approval.respond.is_closed())
        || state
            .session
            .as_ref()
            .is_some_and(|session| session.until > now)
    {
        return Err(StatusCode::CONFLICT);
    }
    let existing = state
        .challenge
        .as_ref()
        .filter(|challenge| challenge.until > now);
    let (challenge, expires_at_ms) = if let Some(existing) = existing {
        if existing.browser_public_key != request.browser_public_key {
            return Err(StatusCode::CONFLICT);
        }
        (
            existing.challenge.clone(),
            utc_ms() + (existing.until - now).as_millis() as u64,
        )
    } else {
        let challenge = random_secret()?;
        state.challenge = Some(Outstanding {
            browser_public_key: request.browser_public_key,
            challenge: challenge.clone(),
            until: now + LIFETIME,
        });
        (challenge, utc_ms() + LIFETIME.as_millis() as u64)
    };
    Ok(Json(ChallengeResponse {
        version: consent::VERSION,
        helper_public_key: pairing.0.helper_public_key.clone(),
        challenge,
        expires_at_ms,
    }))
}

async fn attach(
    State(pairing): State<Pairing>,
    Json(request): Json<Attach>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if request.version != consent::VERSION {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }
    consent::public_key(&request.attachment_hash).ok_or(StatusCode::BAD_REQUEST)?;
    let (ticket, ticket_until) = pairing
        .verify_ticket(&request.pair_ticket)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let (receive, until, transcript, code) = {
        let mut state = pairing.0.state.lock().expect("pairing state");
        let challenge = state.challenge.as_ref().ok_or(StatusCode::UNAUTHORIZED)?;
        if challenge.until <= Instant::now()
            || request.challenge != challenge.challenge
            || ticket.challenge != challenge.challenge
        {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let transcript = consent::transcript(
            &request.challenge,
            &challenge.browser_public_key,
            &pairing.0.helper_public_key,
            &request.pair_ticket,
            &request.attachment_hash,
        );
        if !consent::verifies(
            &challenge.browser_public_key,
            &transcript,
            &request.browser_proof,
        ) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        let code = consent::confirmation_code().map_err(|()| StatusCode::INTERNAL_SERVER_ERROR)?;
        let prompt = ApprovalPrompt {
            fingerprint: consent::fingerprint(&transcript),
            confirmation_code: code
                .as_bytes()
                .chunks(4)
                .map(|part| std::str::from_utf8(part).expect("base32"))
                .collect::<Vec<_>>()
                .join("-"),
        };
        let until = challenge.until.min(ticket_until);
        let (respond, receive) = oneshot::channel();
        state.challenge = None;
        state.approval = Some(Approval {
            prompt,
            attachment_hash: request.attachment_hash,
            until,
            respond,
            ticket,
        });
        (receive, until, transcript, code)
    };
    if let Some(app) = pairing.0.app.lock().expect("app handle").clone() {
        let owner = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = crate::desktop::show_settings(&owner);
        });
    }
    let Ok(Ok(Some(secret))) = tokio::time::timeout_at(until.into(), receive).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let now = Instant::now();
    let mut state = pairing.0.state.lock().expect("pairing state");
    let session = state
        .session
        .as_mut()
        .filter(|session| session.secret == secret && session.until > now)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let lease_expires_at_ms =
        utc_ms() + session.until.saturating_duration_since(now).as_millis() as u64;
    let confirmation = consent::confirmation(
        &pairing.0.key,
        &transcript,
        &secret,
        lease_expires_at_ms,
        &code,
    );
    Ok(Json(
        serde_json::json!({ "sessionSecret": secret, "leaseExpiresAtMs": lease_expires_at_ms, "confirmation": confirmation }),
    ))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let secret = exact_header(headers, header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")?;
    (secret.len() == 43).then_some(secret)
}

async fn exchange(
    State(pairing): State<Pairing>,
    headers: HeaderMap,
    Json(exchange): Json<Exchange>,
) -> Result<Response, StatusCode> {
    let secret = bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    if let Exchange::WindowSample {
        width,
        height,
        landmarks,
    } = exchange
    {
        return pairing
            .sample_window(secret.to_owned(), width, height, landmarks)
            .await;
    }
    if matches!(
        exchange,
        Exchange::ProbeStart
            | Exchange::WindowProbeStart
            | Exchange::ProbePainted { .. }
            | Exchange::ProbeProtect { .. }
            | Exchange::ProbeComplete { .. }
            | Exchange::ProbeAbort
    ) {
        return pairing.update_probe(secret.to_owned(), exchange).await;
    }
    let mut state = pairing.0.state.lock().expect("pairing state");
    let session = state
        .session
        .as_mut()
        .filter(|session| session.authorizes(secret))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    match exchange {
        Exchange::Disconnect => state.session = None,
        Exchange::Describe {
            surface,
            width,
            height,
            window_id,
        } => {
            if !session.usable() {
                return Err(StatusCode::CONFLICT);
            }
            session
                .capture
                .describe(&surface, width, height, window_id.as_deref())
                .map_err(|()| StatusCode::CONFLICT)?;
        }
        Exchange::Authorize { attachment_ticket } => {
            let hash = consent::hash_token(&attachment_ticket);
            let valid_hash = session
                .attachment_hash
                .as_ref()
                .is_some_and(|expected| bool::from(expected.as_bytes().ct_eq(hash.as_bytes())));
            if !valid_hash {
                return Err(StatusCode::UNAUTHORIZED);
            }
            let lifetime = pairing
                .verify_attachment(&attachment_ticket, &session.ticket)
                .ok_or(StatusCode::UNAUTHORIZED)?;
            session.attachment_hash = None;
            pairing.connect_attachment(
                session,
                attachment_ticket,
                lifetime.min(session.until.saturating_duration_since(Instant::now())),
            );
        }
        Exchange::ProbeStart
        | Exchange::WindowProbeStart
        | Exchange::ProbePainted { .. }
        | Exchange::ProbeProtect { .. }
        | Exchange::ProbeComplete { .. }
        | Exchange::ProbeAbort
        | Exchange::WindowSample { .. } => {
            return Err(StatusCode::BAD_REQUEST);
        }
        Exchange::Refresh {
            pair_ticket,
            attachment_ticket,
        } => {
            let (ticket, until) = pairing
                .verify_ticket(&pair_ticket)
                .ok_or(StatusCode::UNAUTHORIZED)?;
            let lifetime = pairing
                .verify_attachment(&attachment_ticket, &ticket)
                .ok_or(StatusCode::UNAUTHORIZED)?;
            let Ticket { expires_at_ms, .. } = ticket;
            if (Ticket {
                expires_at_ms: session.ticket.expires_at_ms,
                ..ticket
            }) != session.ticket
                || expires_at_ms <= session.ticket.expires_at_ms
                || !session.usable()
            {
                return Err(StatusCode::UNAUTHORIZED);
            }
            session.ticket.expires_at_ms = expires_at_ms;
            session.until = until;
            session.status = "waiting_for_sync";
            session.capture.suspend_scene();
            pairing.connect_attachment(
                session,
                attachment_ticket,
                lifetime.min(until.saturating_duration_since(Instant::now())),
            );
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn events(
    State(pairing): State<Pairing>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let secret = bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?.to_owned();
    pairing
        .session_until(&secret)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let ticks = IntervalStream::new(tokio::time::interval(Duration::from_millis(80)));
    let mut last_status = "";
    let mut sequence = 0;
    let mut last_heartbeat = Instant::now() - Duration::from_secs(5);
    let stream = ticks.map_while(move |_| {
        let mut state = pairing.0.state.lock().expect("pairing state");
        let session = state
            .session
            .as_mut()
            .filter(|session| session.authorizes(&secret))?;
        let status = if session.usable() {
            session.capture.status()
        } else {
            session.status
        };
        let event = if status != last_status || last_heartbeat.elapsed() >= Duration::from_secs(2) {
            last_status = status;
            last_heartbeat = Instant::now();
            sequence += 1;
            let signature = consent::signed_status(&pairing.0.key, &secret, sequence, status);
            Event::default().data(serde_json::json!({"type":"status","status":status,"sequence":sequence,"signature":signature}).to_string())
        } else {
            Event::default().comment("pulse")
        };
        Some(Ok::<_, std::convert::Infallible>(event))
    });
    Ok(Sse::new(stream).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    const ORIGIN: &str = "https://chalk.example";

    fn issuer() -> (Pairing, Ed25519KeyPair) {
        let rng = SystemRandom::new();
        let seed = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(seed.as_ref()).unwrap();
        let pairing =
            Pairing::new(ORIGIN, &URL_SAFE_NO_PAD.encode(key.public_key().as_ref())).unwrap();
        (pairing, key)
    }

    fn request(method: &str, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, HOST)
            .header(header::ORIGIN, ORIGIN)
    }

    async fn body(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 8192).await.unwrap()).unwrap()
    }

    fn browser_key() -> Ed25519KeyPair {
        let seed = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(seed.as_ref()).unwrap()
    }

    fn hello(browser: &Ed25519KeyPair) -> Request<Body> {
        request("POST", "/v1/challenge")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({
                    "browserPublicKey": URL_SAFE_NO_PAD.encode(browser.public_key())
                })
                .to_string(),
            ))
            .unwrap()
    }

    fn signed_attach(
        challenge: &Value,
        issuer: &Ed25519KeyPair,
        browser: &Ed25519KeyPair,
        audience: &str,
        expires_at_ms: u64,
    ) -> String {
        let protected =
            URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"chalk-helper-pair-ticket+jwt"}"#);
        let claims = json!({
            "aud": audience,
            "expiresAtMs": expires_at_ms,
            "version": 1,
            "challenge": challenge["challenge"],
            "origin": ORIGIN,
            "helperPublicKey": challenge["helperPublicKey"],
            "role": "sharer",
            "tenantId": "test-tenant",
            "spaceId": "test-space",
            "episodeId": "test-episode",
            "participantId": "test-participant",
            "generation": 1,
            "publicationId": "test-video",
            "layerId": "test-layer"
        });
        let signed = format!("{protected}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let signature = URL_SAFE_NO_PAD.encode(issuer.sign(signed.as_bytes()));
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
        let claims = URL_SAFE_NO_PAD.encode(
            json!({
                "aud":"screen_annotation_helper_v1","role":"sharer","version":1,
                "tenant_id":"test-tenant","space_id":"test-space","episode_id":"test-episode",
                "participant_id":"test-participant","participant_generation":1,
                "publication_id":"test-video","layer_id":"test-layer","exp":(utc_ms()+20_000)/1000,
                "cnf":{"jwk":{"kty":"OKP","crv":"Ed25519","x":challenge["helperPublicKey"]}}
            })
            .to_string(),
        );
        let attachment = format!("{header}.{claims}");
        let proof = URL_SAFE_NO_PAD.encode(issuer.sign(attachment.as_bytes()));
        let pair = format!("{signed}.{signature}");
        let attachment_hash = consent::hash_token(&format!("{attachment}.{proof}"));
        let transcript = consent::transcript(
            challenge["challenge"].as_str().unwrap(),
            &URL_SAFE_NO_PAD.encode(browser.public_key()),
            challenge["helperPublicKey"].as_str().unwrap(),
            &pair,
            &attachment_hash,
        );
        json!({
            "version": consent::VERSION,
            "challenge": challenge["challenge"],
            "pairTicket": pair,
            "attachmentHash": attachment_hash,
            "browserProof": URL_SAFE_NO_PAD.encode(browser.sign(transcript.as_bytes()))
        })
        .to_string()
    }

    #[tokio::test]
    async fn exact_origin_and_numeric_host_gate_requests_and_preflight() {
        let (pairing, _) = issuer();
        let router = pairing.router();
        for (origin, host, path) in [
            ("https://chalk.example.attacker.test", HOST, "/v1/challenge"),
            ("null", HOST, "/v1/challenge"),
            (ORIGIN, "localhost:47361", "/v1/challenge"),
            (ORIGIN, HOST, "/v1/challenge?ticket=secret"),
        ] {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            assert!(!response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        }
        let duplicate = request("POST", "/v1/challenge")
            .header(header::ORIGIN, ORIGIN)
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.clone().oneshot(duplicate).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let preflight = request("OPTIONS", "/v1/attach")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
            .body(Body::empty())
            .unwrap();
        let response = router.oneshot(preflight).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
        assert!(!response
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    }

    #[tokio::test]
    async fn outstanding_challenge_is_not_given_to_another_tab() {
        let (pairing, _) = issuer();
        let router = pairing.router();
        let first = router.clone().oneshot(hello(&browser_key())).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);
        let other_tab = router.oneshot(hello(&browser_key())).await.unwrap();
        assert_eq!(other_tab.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn signed_ticket_tolerates_small_clock_skew_without_extending_the_lease() {
        let (pairing, key) = issuer();
        let browser = browser_key();
        let challenge = body(
            pairing
                .clone()
                .router()
                .oneshot(hello(&browser))
                .await
                .unwrap(),
        )
        .await;
        let accepts = |remaining_ms: i64| {
            let expiry = utc_ms().checked_add_signed(remaining_ms).unwrap();
            let body: Value =
                serde_json::from_str(&signed_attach(&challenge, &key, &browser, AUDIENCE, expiry))
                    .unwrap();
            pairing.verify_ticket(body["pairTicket"].as_str().unwrap())
        };
        let (_, until) = accepts(60_500).expect("a signed ticket from a clock 500 ms ahead");
        assert!(until.saturating_duration_since(Instant::now()) <= LIFETIME);
        assert!(
            accepts(65_000).is_none(),
            "large clock differences fail closed"
        );
        assert!(
            accepts(-500).is_none(),
            "an expired ticket does not get a grace period"
        );
    }

    #[tokio::test]
    async fn attachment_needs_a_signed_audience_bound_ticket_and_local_approval() {
        let (pairing, key) = issuer();
        let router = pairing.clone().router();
        let browser = browser_key();
        let challenge = body(router.clone().oneshot(hello(&browser)).await.unwrap()).await;
        assert_eq!(challenge["version"], consent::VERSION);
        let attach = |body: String| {
            request("POST", "/v1/attach")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        let wrong_audience = signed_attach(
            &challenge,
            &key,
            &browser,
            "screen_annotation_helper_v1",
            utc_ms() + 30_000,
        );
        assert_eq!(
            router
                .clone()
                .oneshot(attach(wrong_audience))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let valid = signed_attach(&challenge, &key, &browser, AUDIENCE, utc_ms() + 30_000);
        let mut pending = Box::pin(router.clone().oneshot(attach(valid.clone())));
        assert!(tokio::time::timeout(Duration::from_millis(5), &mut pending)
            .await
            .is_err());
        let approval = pairing.approval_prompt().expect("local consent required");
        let valid: Value = serde_json::from_str(&valid).unwrap();
        let pair = valid["pairTicket"].as_str().unwrap();
        let attachment_hash = valid["attachmentHash"].as_str().unwrap();
        let public_key = challenge["helperPublicKey"].as_str().unwrap();
        let transcript = consent::transcript(
            challenge["challenge"].as_str().unwrap(),
            &URL_SAFE_NO_PAD.encode(browser.public_key()),
            public_key,
            pair,
            attachment_hash,
        );
        assert_eq!(approval.fingerprint, consent::fingerprint(&transcript));
        let replay = router
            .clone()
            .oneshot(attach(valid.to_string()))
            .await
            .unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        pairing.decide(&approval.fingerprint, true);
        let session = body(pending.await.unwrap()).await;
        let secret = session["sessionSecret"].as_str().unwrap();
        let expiration = session["leaseExpiresAtMs"].as_u64().unwrap();
        let code = approval.confirmation_code.replace('-', "");
        let proof = session["confirmation"].as_str().unwrap();
        let witness =
            format!("chalk.helper.confirm.v2\n{transcript}\n{secret}\n{expiration}\n{code}");
        assert!(consent::verifies(public_key, &witness, proof));
        assert!(!consent::verifies(
            public_key,
            &witness.replace(attachment_hash, "altered"),
            proof
        ));
        assert!(!consent::verifies(
            public_key,
            &witness.replace(&code, "unauthorized"),
            proof
        ));
        assert!(
            !pairing.connected(),
            "native Allow alone is not Sync acceptance"
        );
        let authenticated = |method, path| {
            request(method, path).header(header::AUTHORIZATION, format!("Bearer {secret}"))
        };
        let no_bearer = request("GET", "/v1/events").body(Body::empty()).unwrap();
        assert_eq!(
            router.clone().oneshot(no_bearer).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let events = authenticated("GET", "/v1/events")
            .body(Body::empty())
            .unwrap();
        let response = router.clone().oneshot(events).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream"
        );
        let disconnect = authenticated("POST", "/v1/exchange")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"type":"disconnect"}"#))
            .unwrap();
        assert_eq!(
            router.clone().oneshot(disconnect).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
        let events = authenticated("GET", "/v1/events")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.oneshot(events).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
    #[tokio::test]
    async fn denial_does_not_open_a_session_or_make_the_challenge_reusable() {
        let (pairing, key) = issuer();
        let router = pairing.clone().router();
        let browser = browser_key();
        let challenge = body(router.clone().oneshot(hello(&browser)).await.unwrap()).await;
        let signed = signed_attach(&challenge, &key, &browser, AUDIENCE, utc_ms() + 30_000);
        let attach = || {
            request("POST", "/v1/attach")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(signed.clone()))
                .unwrap()
        };
        let mut pending = Box::pin(router.clone().oneshot(attach()));
        assert!(tokio::time::timeout(Duration::from_millis(5), &mut pending)
            .await
            .is_err());
        let fingerprint = pairing
            .approval_prompt()
            .expect("confirmation appears")
            .fingerprint;
        pairing.decide(&fingerprint, false);
        assert_eq!(pending.await.unwrap().status(), StatusCode::UNAUTHORIZED);
        assert!(!pairing.connected());
        assert_eq!(
            router.oneshot(attach()).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
