use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

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
    digest::{digest, SHA256},
    rand::{SecureRandom, SystemRandom},
    signature::{UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use tokio::sync::oneshot;
use tokio_stream::{wrappers::IntervalStream, StreamExt};

const PORT: u16 = 47361;
const HOST: &str = "127.0.0.1:47361";
const VERSION: u8 = 1;
const LIFETIME: Duration = Duration::from_secs(60);
const AUDIENCE: &str = "screen_annotation_helper_local_v1";

#[derive(Clone)]
pub struct Pairing(Arc<PairingInner>);

struct PairingInner {
    origin: HeaderValue,
    issuer_key: [u8; 32],
    helper_public_key: String,
    state: Mutex<Local>,
}

#[derive(Default)]
struct Local {
    challenge: Option<Outstanding>,
    approval: Option<Approval>,
    session: Option<Session>,
}

struct Outstanding {
    challenge: String,
    until: Instant,
}

struct Approval {
    fingerprint: String,
    until: Instant,
    respond: oneshot::Sender<Option<String>>,
}

struct Session {
    secret: String,
    until: Instant,
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
    pair_ticket: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtectedHeader {
    alg: String,
    typ: String,
}

#[derive(Deserialize)]
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
        use ring::signature::KeyPair;
        Ok(Self(Arc::new(PairingInner {
            origin,
            issuer_key,
            helper_public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
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
            .layer(DefaultBodyLimit::max(8192))
            .layer(middleware::from_fn_with_state(
                self.clone(),
                request_boundary,
            ))
            .with_state(self)
    }

    pub fn fingerprint(&self) -> Option<String> {
        self.0
            .state
            .lock()
            .expect("pairing state")
            .approval
            .as_ref()
            .filter(|approval| approval.until > Instant::now() && !approval.respond.is_closed())
            .map(|approval| approval.fingerprint.clone())
    }

    pub fn decide(&self, fingerprint: &str, allowed: bool) {
        let mut state = self.0.state.lock().expect("pairing state");
        if state.approval.as_ref().is_some_and(|approval| {
            approval.until > Instant::now() && approval.fingerprint == fingerprint
        }) {
            if let Some(approval) = state.approval.take() {
                let secret = allowed.then(random_secret).and_then(Result::ok);
                if approval.respond.send(secret.clone()).is_ok() {
                    state.session = secret.map(|secret| Session {
                        secret,
                        until: Instant::now() + LIFETIME,
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
            .is_some_and(|session| session.until > Instant::now())
    }

    fn verify_ticket(&self, request: &Attach, challenge: &Outstanding) -> Option<Instant> {
        if challenge.until <= Instant::now()
            || request.challenge != challenge.challenge
            || request.pair_ticket.len() > 4096
        {
            return None;
        }
        let (signed, signature) = request.pair_ticket.rsplit_once('.')?;
        let (protected, encoded) = signed.split_once('.')?;
        let header: ProtectedHeader =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(protected).ok()?).ok()?;
        if header.alg != "EdDSA" || header.typ != "chalk-helper-pair-ticket+jwt" {
            return None;
        }
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        UnparsedPublicKey::new(&ED25519, self.0.issuer_key)
            .verify(signed.as_bytes(), &signature)
            .ok()?;
        let ticket: Ticket = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
        let now = utc_ms();
        let identifiers = [
            &ticket.tenant_id,
            &ticket.episode_id,
            &ticket.participant_id,
            &ticket.publication_id,
            &ticket.layer_id,
        ];
        if ticket.aud != AUDIENCE
            || ticket.role != "sharer"
            || ticket.version != VERSION
            || ticket.expires_at_ms <= now
            || ticket.expires_at_ms > now + LIFETIME.as_millis() as u64
            || ticket.challenge != challenge.challenge
            || ticket.origin.as_bytes() != self.0.origin.as_bytes()
            || ticket.helper_public_key != self.0.helper_public_key
            || ticket.generation == 0
            || identifiers
                .into_iter()
                .any(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control))
        {
            return None;
        }
        let ticket_until = Instant::now() + Duration::from_millis(ticket.expires_at_ms - now);
        Some(challenge.until.min(ticket_until))
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

fn fingerprint(key: &str, challenge: &str) -> String {
    let fingerprint = digest(&SHA256, format!("{key}.{challenge}").as_bytes());
    let raw = fingerprint.as_ref();
    format!("{:02X}{:02X}-{:02X}{:02X}", raw[0], raw[1], raw[2], raw[3])
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

async fn challenge(State(pairing): State<Pairing>) -> Result<Json<ChallengeResponse>, StatusCode> {
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
        (
            existing.challenge.clone(),
            utc_ms() + (existing.until - now).as_millis() as u64,
        )
    } else {
        let challenge = random_secret()?;
        state.challenge = Some(Outstanding {
            challenge: challenge.clone(),
            until: now + LIFETIME,
        });
        (challenge, utc_ms() + LIFETIME.as_millis() as u64)
    };
    Ok(Json(ChallengeResponse {
        version: VERSION,
        helper_public_key: pairing.0.helper_public_key.clone(),
        challenge,
        expires_at_ms,
    }))
}

async fn attach(
    State(pairing): State<Pairing>,
    Json(request): Json<Attach>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if request.version != VERSION {
        return Err(StatusCode::UPGRADE_REQUIRED);
    }
    let (receive, until) = {
        let mut state = pairing.0.state.lock().expect("pairing state");
        let challenge = state.challenge.as_ref().ok_or(StatusCode::UNAUTHORIZED)?;
        let until = pairing
            .verify_ticket(&request, challenge)
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let (respond, receive) = oneshot::channel();
        state.challenge = None;
        state.approval = Some(Approval {
            fingerprint: fingerprint(&pairing.0.helper_public_key, &request.challenge),
            until,
            respond,
        });
        (receive, until)
    };
    let Ok(Ok(Some(secret))) = tokio::time::timeout_at(until.into(), receive).await else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let now = Instant::now();
    let expires = pairing
        .session_until(&secret)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let lease_expires_at_ms = utc_ms() + expires.saturating_duration_since(now).as_millis() as u64;
    Ok(Json(
        serde_json::json!({ "sessionSecret": secret, "leaseExpiresAtMs": lease_expires_at_ms, "status": "unbound" }),
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
) -> Result<StatusCode, StatusCode> {
    let secret = bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let Exchange::Disconnect = exchange;
    let mut state = pairing.0.state.lock().expect("pairing state");
    if !state.session.as_ref().is_some_and(|session| {
        bool::from(session.secret.as_bytes().ct_eq(secret.as_bytes()))
            && session.until > Instant::now()
    }) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    state.session = None;
    Ok(StatusCode::NO_CONTENT)
}

async fn events(
    State(pairing): State<Pairing>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let secret = bearer(&headers).ok_or(StatusCode::UNAUTHORIZED)?.to_owned();
    pairing
        .session_until(&secret)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let ticks = IntervalStream::new(tokio::time::interval(Duration::from_secs(2)));
    let stream = ticks.map_while(move |_| {
        pairing.session_until(&secret)?;
        Some(Ok::<_, std::convert::Infallible>(
            Event::default().data(r#"{"type":"status","status":"unbound"}"#),
        ))
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

    fn signed_attach(challenge: &Value, issuer: &Ed25519KeyPair, audience: &str) -> String {
        let protected =
            URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"chalk-helper-pair-ticket+jwt"}"#);
        let claims = json!({
            "aud": audience,
            "expiresAtMs": utc_ms() + 30_000,
            "version": 1,
            "challenge": challenge["challenge"],
            "origin": ORIGIN,
            "helperPublicKey": challenge["helperPublicKey"],
            "role": "sharer",
            "tenantId": "test-tenant",
            "episodeId": "test-episode",
            "participantId": "test-participant",
            "generation": 1,
            "publicationId": "test-video",
            "layerId": "test-layer"
        });
        let signed = format!("{protected}.{}", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let signature = URL_SAFE_NO_PAD.encode(issuer.sign(signed.as_bytes()));
        json!({
            "version": 1,
            "challenge": challenge["challenge"],
            "pairTicket": format!("{signed}.{signature}")
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
    async fn attachment_needs_a_signed_audience_bound_ticket_and_local_approval() {
        let (pairing, key) = issuer();
        let router = pairing.clone().router();
        let hello = request("POST", "/v1/challenge")
            .body(Body::empty())
            .unwrap();
        let challenge = body(router.clone().oneshot(hello).await.unwrap()).await;
        assert_eq!(challenge["version"], 1);
        let attach = |body: String| {
            request("POST", "/v1/attach")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap()
        };
        let wrong_audience = signed_attach(&challenge, &key, "screen_annotation_helper_v1");
        assert_eq!(
            router
                .clone()
                .oneshot(attach(wrong_audience))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let valid = signed_attach(&challenge, &key, AUDIENCE);
        let mut pending = Box::pin(router.clone().oneshot(attach(valid.clone())));
        assert!(tokio::time::timeout(Duration::from_millis(5), &mut pending)
            .await
            .is_err());
        let code = pairing.fingerprint().expect("local consent required");
        assert_eq!(
            router
                .clone()
                .oneshot(attach(valid))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        pairing.decide(&code, true);
        let session = body(pending.await.unwrap()).await;
        let secret = session["sessionSecret"].as_str().unwrap();
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
}
