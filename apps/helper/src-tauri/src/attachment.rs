use std::{sync::Arc, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use ring::{digest, signature::Ed25519KeyPair};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    #[serde(rename = "type")]
    kind: String,
    version: u8,
    nonce: String,
}

struct Endpoint(tauri::Url);

impl Endpoint {
    fn configured() -> Result<Self, &'static str> {
        let origin = option_env!("CHALK_HELPER_SYNC_ORIGIN").ok_or("No Helper Sync origin.")?;
        let mut url = tauri::Url::parse(origin).map_err(|_| "Invalid Helper Sync origin.")?;
        if url.scheme() != "wss" || url.origin().ascii_serialization() != origin {
            return Err("Helper Sync needs an exact WSS origin.");
        }
        url.set_path("/v1/screen-annotation/helper");
        Ok(Self(url))
    }
}

fn prove(challenge: Challenge, ticket: &str, key: &Ed25519KeyPair) -> Result<Value, &'static str> {
    if challenge.version != 1 {
        return Err("update_required");
    }
    if challenge.kind != "annotation_helper_challenge"
        || !URL_SAFE_NO_PAD
            .decode(&challenge.nonce)
            .is_ok_and(|bytes| bytes.len() == 32)
    {
        return Err("invalid_challenge");
    }
    let ticket_hash = digest::digest(&digest::SHA256, ticket.as_bytes());
    let message = format!(
        "chalk.screen_annotation.helper.v1\n{}\n{}",
        challenge.nonce,
        URL_SAFE_NO_PAD.encode(ticket_hash.as_ref())
    );
    let proof = URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).as_ref());
    Ok(json!({"type":"annotation_helper_attach","version":1,"ticket": ticket,"proof":proof}))
}

pub async fn receive(
    ticket: String,
    key: Arc<Ed25519KeyPair>,
    mut update: impl FnMut(Value) -> bool,
) -> Result<(), &'static str> {
    let endpoint = Endpoint::configured()?;
    let config = WebSocketConfig::default()
        .max_frame_size(Some(512 * 1024))
        .max_message_size(Some(512 * 1024));
    let (mut socket, _) = timeout(
        Duration::from_secs(4),
        tokio_tungstenite::connect_async_with_config(endpoint.0.as_str(), Some(config), true),
    )
    .await
    .map_err(|_| "sync_timeout")?
    .map_err(|_| "sync_unavailable")?;
    let Some(Ok(Message::Text(frame))) = timeout(Duration::from_secs(4), socket.next())
        .await
        .map_err(|_| "sync_timeout")?
    else {
        return Err("missing_challenge");
    };
    let challenge: Challenge = serde_json::from_str(&frame).map_err(|_| "invalid_challenge")?;
    let attach = prove(challenge, &ticket, &key)?;
    socket
        .send(Message::Text(attach.to_string().into()))
        .await
        .map_err(|_| "sync_unavailable")?;

    while let Some(frame) = socket.next().await {
        match frame.map_err(|_| "sync_unavailable")? {
            Message::Text(frame) => {
                let value: Value = serde_json::from_str(&frame).map_err(|_| "invalid_frame")?;
                if !update(value) {
                    break;
                }
            }
            Message::Ping(_) => socket.flush().await.map_err(|_| "sync_unavailable")?,
            Message::Close(_) => break,
            _ => return Err("invalid_frame"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::{
        rand::SystemRandom,
        signature::{KeyPair, UnparsedPublicKey, ED25519},
    };

    #[test]
    fn proof_matches_the_sync_transcript_and_is_nonce_bound() {
        let random = SystemRandom::new();
        let document = Ed25519KeyPair::generate_pkcs8(&random).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
        let nonce = URL_SAFE_NO_PAD.encode([9; 32]);
        let ticket = "header.payload.signature";
        let signed = prove(
            Challenge {
                kind: "annotation_helper_challenge".into(),
                version: 1,
                nonce: nonce.clone(),
            },
            ticket,
            &key,
        )
        .unwrap();
        let verifier = UnparsedPublicKey::new(&ED25519, key.public_key().as_ref());
        let signature = URL_SAFE_NO_PAD
            .decode(signed["proof"].as_str().unwrap())
            .unwrap();
        let hash =
            URL_SAFE_NO_PAD.encode(digest::digest(&digest::SHA256, ticket.as_bytes()).as_ref());
        let transcript = format!("chalk.screen_annotation.helper.v1\n{nonce}\n{hash}");
        assert!(verifier.verify(transcript.as_bytes(), &signature).is_ok());
        let different = format!(
            "chalk.screen_annotation.helper.v1\n{}\n{hash}",
            URL_SAFE_NO_PAD.encode([8; 32])
        );
        assert!(verifier.verify(different.as_bytes(), &signature).is_err());
    }
}
