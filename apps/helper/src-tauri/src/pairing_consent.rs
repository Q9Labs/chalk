use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    digest::{digest, SHA256},
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, UnparsedPublicKey, ED25519},
};

pub const VERSION: u8 = 2;

pub fn hash_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(digest(&SHA256, token.as_bytes()))
}

pub fn public_key(key: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD.decode(key).ok()?.try_into().ok()
}

pub fn transcript(
    challenge: &str,
    browser: &str,
    helper: &str,
    ticket: &str,
    attachment_hash: &str,
) -> String {
    format!(
        "chalk.helper.pair.v2\n{challenge}\n{browser}\n{helper}\n{}\n{attachment_hash}",
        hash_token(ticket)
    )
}

pub fn verifies(browser: &str, transcript: &str, proof: &str) -> bool {
    public_key(browser)
        .zip(URL_SAFE_NO_PAD.decode(proof).ok())
        .is_some_and(|(key, proof)| {
            UnparsedPublicKey::new(&ED25519, key)
                .verify(transcript.as_bytes(), &proof)
                .is_ok()
        })
}

pub fn fingerprint(transcript: &str) -> String {
    let hash = digest(&SHA256, transcript.as_bytes());
    let raw = hash.as_ref();
    format!("{:02X}{:02X}-{:02X}{:02X}", raw[0], raw[1], raw[2], raw[3])
}

pub fn confirmation_code() -> Result<String, ()> {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut random = [0u8; 16];
    SystemRandom::new().fill(&mut random).map_err(|_| ())?;
    Ok(random
        .into_iter()
        .map(|byte| char::from(ALPHABET[usize::from(byte & 31)]))
        .collect())
}

pub fn confirmation(
    key: &Ed25519KeyPair,
    transcript: &str,
    secret: &str,
    expiration: u64,
    code: &str,
) -> String {
    let proof = format!("chalk.helper.confirm.v2\n{transcript}\n{secret}\n{expiration}\n{code}");
    URL_SAFE_NO_PAD.encode(key.sign(proof.as_bytes()))
}

pub fn signed_status(key: &Ed25519KeyPair, secret: &str, sequence: u64, status: &str) -> String {
    let proof = format!("chalk.helper.status.v2\n{secret}\n{sequence}\n{status}");
    URL_SAFE_NO_PAD.encode(key.sign(proof.as_bytes()))
}
