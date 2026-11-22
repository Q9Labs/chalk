import type { Challenge } from "./screen-annotation-helper-bridge";

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

function bytes(message: string) {
  return new TextEncoder().encode(message);
}

async function hash(message: string) {
  return encode(await crypto.subtle.digest("SHA-256", bytes(message)));
}

export async function startConsent() {
  const keys = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const browserPublicKey = encode(await crypto.subtle.exportKey("raw", keys.publicKey));
  return {
    browserPublicKey,
    async provesKey(origin: string, challenge: Challenge) {
      if (!challenge.keyProof) return false;
      try {
        const key = await crypto.subtle.importKey("raw", decode(challenge.helperPublicKey), "Ed25519", false, ["verify"]);
        const message = `chalk.helper.key.v1\n${origin}\n${browserPublicKey}\n${challenge.challenge}\n${challenge.expiresAtMs}`;
        return await crypto.subtle.verify("Ed25519", key, decode(challenge.keyProof), bytes(message));
      } catch {
        return false;
      }
    },
    async bind(challenge: Challenge, pairTicket: string, attachmentTicket: string, remembered: boolean) {
      const attachmentHash = await hash(attachmentTicket);
      const transcript = ["chalk.helper.pair.v2", challenge.challenge, browserPublicKey, challenge.helperPublicKey, await hash(pairTicket), attachmentHash].join("\n");
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(transcript))).slice(0, 4), (byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();
      // The browser cannot verify a loopback responder's code signature.
      // An explicitly approved same-user impostor is outside this boundary.
      const helperKey = await crypto.subtle.importKey("raw", decode(challenge.helperPublicKey), "Ed25519", false, ["verify"]);
      let lastSequence = 0;
      return {
        async verifyStatus(secret: string, event: { readonly sequence: number; readonly status: string; readonly signature: string }) {
          const proof = `chalk.helper.status.v2
${secret}
${event.sequence}
${event.status}`;
          if (event.sequence <= lastSequence || !(await crypto.subtle.verify("Ed25519", helperKey, decode(event.signature), bytes(proof)))) {
            throw new Error("Chalk Helper status was not authenticated.");
          }
          lastSequence = event.sequence;
        },
        attachmentHash,
        fingerprint: `${fingerprint.slice(0, 4)}-${fingerprint.slice(4)}`,
        browserProof: encode(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes(transcript))),
        async confirm(code: string | null, reply: { readonly sessionSecret: string; readonly leaseExpiresAtMs: number; readonly confirmation: string }) {
          const normalized = code?.replaceAll("-", "").trim().toUpperCase() ?? "";
          if (remembered ? code !== null : !/^[A-HJ-NP-Z2-9]{16}$/.test(normalized)) {
            throw new Error("Invalid Helper confirmation code.");
          }
          const message = `chalk.helper.confirm.v2\n${transcript}\n${reply.sessionSecret}\n${reply.leaseExpiresAtMs}\n${normalized}`;
          if (!(await crypto.subtle.verify("Ed25519", helperKey, decode(reply.confirmation), bytes(message)))) {
            throw new Error("Chalk Helper did not confirm this tab and share.");
          }
        },
      };
    },
  };
}
