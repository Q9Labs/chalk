import { chmod, mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { FailureKind, failure } from "./model.mjs";
import { writeJsonAtomic } from "./ownership.mjs";

export function identityPaths(config) {
  const root = join(config.runtimeRoot, "identity");
  return {
    root,
    signingPrivateKey: join(root, "signing-ed25519.pem"),
    signingPrivateKeyRaw: join(root, "signing-ed25519.raw"),
    signingPublicKeyring: join(root, "signing-public-keyring.json"),
    caKey: join(root, "local-ca-key.pem"),
    caCertificate: join(root, "local-ca.pem"),
    apiCertificate: join(root, "api-server.pem"),
    apiKey: join(root, "api-server-key.pem"),
    syncCertificate: join(root, "sync-client.pem"),
    syncKey: join(root, "sync-client-key.pem"),
  };
}

export function identityEnvironment({ paths, privateKey, publicKeyring, issuer = "http://chalk.local", audience = "chalk-sync", kid = "local-dev", trustDomain = "chalk.local", providerBridgeAddress = "127.0.0.1:8444" } = {}) {
  return {
    CHALK_SYNC_TOKEN_ISSUER: issuer,
    CHALK_SYNC_TOKEN_AUDIENCE: audience,
    CHALK_SYNC_TOKEN_KEY_ID: kid,
    CHALK_SYNC_TOKEN_PRIVATE_KEY: privateKey,
    CHALK_MEDIA_TOKEN_VERIFICATION_KEYS: JSON.stringify(publicKeyring || {}),
    CHALK_SYNC_TOKEN_PUBLIC_KEYS: JSON.stringify(publicKeyring || {}),
    CHALK_PROVIDER_BRIDGE_ADDRESS: providerBridgeAddress,
    CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE: paths.apiCertificate,
    CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE: paths.apiKey,
    CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE: paths.caCertificate,
    CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN: trustDomain,
    CHALK_SYNC_PROVIDER_BRIDGE_URL: `https://${providerBridgeAddress}`,
    CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE: paths.syncCertificate,
    CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE: paths.syncKey,
    CHALK_SYNC_PROVIDER_BRIDGE_CAFILE: paths.caCertificate,
  };
}

export async function generateSigningIdentity({ paths, kid = "local-dev", keyPair = generateKeyPairSync } = {}) {
  if (!paths?.signingPrivateKey || !paths?.signingPublicKeyring) throw failure(FailureKind.CONFIG, "signing identity paths are not configured", { stage: "identity" });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = keyPair("ed25519");
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const seedBytes = Buffer.from(privateJwk.d, "base64url");
  const rawPublicBytes = Buffer.from(publicJwk.x, "base64url");
  if (seedBytes.length !== 32 || rawPublicBytes.length !== 32) throw failure(FailureKind.CONFIG, "generated Ed25519 key has an invalid raw length", { stage: "identity" });
  const rawPrivate = Buffer.concat([seedBytes, rawPublicBytes]).toString("base64url");
  const rawPublic = rawPublicBytes.toString("base64url");
  await writeFile(paths.signingPrivateKey, privatePem, { encoding: "utf8", mode: 0o600 });
  await writeFile(paths.signingPrivateKeyRaw, rawPrivate, { encoding: "utf8", mode: 0o600 });
  await chmod(paths.signingPrivateKey, 0o600);
  await writeJsonAtomic(paths.signingPublicKeyring, { [kid]: rawPublic }, { redacted: false });
  return { kid, privateKeyPath: paths.signingPrivateKey, privateKeyRawPath: paths.signingPrivateKeyRaw, publicKeyringPath: paths.signingPublicKeyring, rawPrivateKey: rawPrivate, rawPublicKey: rawPublic, publicKeyring: { [kid]: rawPublic } };
}

async function generateLocalCertificates({ paths, runOpenSSL } = {}) {
  if (!runOpenSSL) throw failure(FailureKind.CONFIG, "local certificate generator is not configured", { stage: "identity" });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await runOpenSSL({ role: "ca", output: paths.caCertificate });
  await runOpenSSL({ role: "api-server", output: paths.apiCertificate, key: paths.apiKey, ca: paths.caCertificate, san: "URI:spiffe://chalk.local/api" });
  await runOpenSSL({ role: "sync-client", output: paths.syncCertificate, key: paths.syncKey, ca: paths.caCertificate, san: "URI:spiffe://chalk.local/sync" });
  return paths;
}
