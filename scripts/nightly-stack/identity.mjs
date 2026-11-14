// Generates the throwaway identity of one Nightly stack: the token signing key, a private CA with the certificates the API,
// Sync and the Chalk SFU use between them, and the env file of each service. Nothing is stored; the machine takes it all away.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, announceIp, databaseUrl, apiPort, syncPort, bridgePort, sfuControlPort, sfuMediaPort] = process.argv.slice(2);
const kid = "nightly-stack";
const issuer = `http://127.0.0.1:${apiPort}`;
const trustDomain = "chalk.local";
const apiIdentity = `spiffe://${trustDomain}/api`;
const syncIdentity = `spiffe://${trustDomain}/sync`;

function openssl(...args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
}

function issue(name, ca, { subject, usage, san }) {
  const key = join(dir, `${name}.key`);
  const csr = join(dir, `${name}.csr`);
  const extension = join(dir, `${name}.ext`);
  writeFileSync(extension, `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=${usage}\nsubjectAltName=${san}\n`);
  openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", key);
  openssl("req", "-new", "-key", key, "-subj", `/CN=${subject}`, "-out", csr);
  openssl("x509", "-req", "-in", csr, "-CA", ca.cert, "-CAkey", ca.key, "-CAcreateserial", "-days", "1", "-extfile", extension, "-out", join(dir, `${name}.crt`));
  return { key, cert: join(dir, `${name}.crt`) };
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const ca = { key: join(dir, "ca.key"), cert: join(dir, "ca.crt") };
openssl("genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", ca.key);
openssl("req", "-x509", "-new", "-key", ca.key, "-subj", "/CN=chalk nightly stack CA", "-days", "1", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign", "-out", ca.cert);
// One identity serves the provider bridge and the API's client calls to the Chalk SFU, as it does in a real deployment.
const api = issue("api", ca, { subject: "chalk-api", usage: "serverAuth,clientAuth", san: `URI:${apiIdentity},IP:127.0.0.1,DNS:localhost` });
const sync = issue("sync-client", ca, { subject: "chalk-sync", usage: "clientAuth", san: `URI:${syncIdentity}` });
const sfu = issue("sfu-server", ca, { subject: "chalk-sfu", usage: "serverAuth", san: "DNS:chalk-sfu,IP:127.0.0.1" });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
const rawPublic = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
const signingKey = Buffer.concat([seed, rawPublic]).toString("base64url");
const keyring = JSON.stringify({ [kid]: rawPublic.toString("base64url") });
const systemToken = randomBytes(24).toString("hex");

// A container reads these as uid 65532, so each service gets a directory with its own readable copies.
function share(name, files) {
  const target = join(dir, name);
  mkdirSync(target, { recursive: true });
  for (const [to, from] of Object.entries(files)) {
    execFileSync("cp", [from, join(target, to)]);
    chmodSync(join(target, to), 0o644);
  }
}
share("api", { "server.crt": api.cert, "server.key": api.key, "client-ca.crt": ca.cert });
share("sync", { "sync-client.crt": sync.cert, "sync-client.key": sync.key, "ca.crt": ca.cert });
share("sfu", { "server.crt": sfu.cert, "server.key": sfu.key, "client-ca.crt": ca.cert });

function env(name, values) {
  const file = join(dir, name);
  writeFileSync(file, `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
}

env("api.env", {
  CHALK_API_ADDR: `127.0.0.1:${apiPort}`,
  CHALK_API_ENV: "local",
  CHALK_API_LOCAL_SYSTEM_TOKEN: systemToken,
  CHALK_API_REQUEST_LOGS: "errors",
  CHALK_API_CORS_ALLOWED_ORIGINS: `http://127.0.0.1:${apiPort}`,
  CHALK_DATABASE_URL: databaseUrl,
  CHALK_REDIS_URL: "redis://127.0.0.1:6379/0",
  CHALK_SYNC_TOKEN_ISSUER: issuer,
  CHALK_SYNC_TOKEN_AUDIENCE: "chalk-sync",
  CHALK_SYNC_TOKEN_KEY_ID: kid,
  CHALK_SYNC_TOKEN_PRIVATE_KEY: signingKey,
  CHALK_MEDIA_TOKEN_VERIFICATION_KEYS: keyring,
  CHALK_PROVIDER_BRIDGE_ADDRESS: `127.0.0.1:${bridgePort}`,
  CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE: "/run/chalk/provider-bridge/server.crt",
  CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE: "/run/chalk/provider-bridge/server.key",
  CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE: "/run/chalk/provider-bridge/client-ca.crt",
  CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN: trustDomain,
  CHALK_DEFAULT_MEDIA_PLANE: "chalk_sfu",
  CHALK_NEW_SPACE_MEDIA_PLANE: "chalk_sfu",
  // Recording and transcription need the recorder fleet, which this stack does not start.
  CHALK_NEW_SPACE_RECORDING_POLICY: "disabled",
  CHALK_NEW_SPACE_TRANSCRIPTION_POLICY: "disabled",
  CHALK_SFU_ENABLED: "true",
  CHALK_SFU_ALLOWED_SPACES: "*",
  CHALK_SFU_CLOUDFLARE_OVERFLOW: "false",
  CHALK_SFU_APPLICATION_ID: "nightly-stack",
  CHALK_SFU_NODES: `local=https://127.0.0.1:${sfuControlPort}`,
  CHALK_SFU_SERVER_NAME: "chalk-sfu",
  CHALK_SFU_CA_FILE: "/run/chalk/provider-bridge/client-ca.crt",
  CHALK_SFU_CLIENT_CERT_FILE: "/run/chalk/provider-bridge/server.crt",
  CHALK_SFU_CLIENT_KEY_FILE: "/run/chalk/provider-bridge/server.key",
});

env("sync.env", {
  CHALK_SYNC_PORT: syncPort,
  CHALK_SYNC_BIND_IP: "127.0.0.1",
  CHALK_SYNC_LOCAL_PARITY: "true",
  CHALK_DATABASE_URL: databaseUrl,
  CHALK_SYNC_TOKEN_ISSUER: issuer,
  CHALK_SYNC_TOKEN_AUDIENCE: "chalk-sync",
  CHALK_SYNC_TOKEN_PUBLIC_KEYS: keyring,
  CHALK_SYNC_MAX_WAL_LAG_BYTES: "0",
  CHALK_SYNC_PROVIDER_BRIDGE_URL: `https://127.0.0.1:${bridgePort}`,
  CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE: "/run/chalk/sync/sync-client.crt",
  CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE: "/run/chalk/sync/sync-client.key",
  CHALK_SYNC_PROVIDER_BRIDGE_CAFILE: "/run/chalk/sync/ca.crt",
});

env("sfu.env", {
  SFU_CONTROL_ADDR: `127.0.0.1:${sfuControlPort}`,
  SFU_UDP_ADDR: `:${sfuMediaPort}`,
  SFU_TCP_ADDR: `:${sfuMediaPort}`,
  SFU_ANNOUNCE_IPS: announceIp,
  SFU_ICE_LOOPBACK: "true",
  SFU_TLS_CERT_FILE: "/run/chalk-sfu/server.crt",
  SFU_TLS_KEY_FILE: "/run/chalk-sfu/server.key",
  SFU_CLIENT_CA_FILE: "/run/chalk-sfu/client-ca.crt",
  SFU_CLIENT_IDENTITY: apiIdentity,
  SFU_NODE_SIZE: "s-2vcpu-2gb",
  SFU_ENVIRONMENT: "nightly",
});

writeFileSync(join(dir, "system-token"), systemToken, { mode: 0o600 });
