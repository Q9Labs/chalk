import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FailureKind, failure } from "./model.mjs";

const execFileAsync = promisify(execFile);
const credentialTitle = /api[_ -]?credential/i;

export async function resolveLocalSfuCredentials({ enumerateVaults, enumerateItems, getItem, itemIsCandidate = defaultCandidate, selectCandidate } = {}) {
  if (!enumerateVaults || !enumerateItems || !getItem) throw failure(FailureKind.CONFIG, "SFU credential resolver is not configured", { stage: "secrets" });
  const candidates = [];
  for (const vault of await enumerateVaults()) {
    for (const item of await enumerateItems(vault)) {
      if (!isCredentialItem(item)) continue;
      const productionMarked = isProductionMarked(item, vault) && isChalkSfu(item, vault);
      const explicitlySelected = Boolean(selectCandidate?.(item, vault));
      if (productionMarked && !explicitlySelected) continue;
      if (!explicitlySelected && !itemIsCandidate(item, vault)) continue;
      if (productionMarked) throw failure(FailureKind.CONFIG, "production-marked SFU credentials cannot be selected for local dev", { stage: "secrets" });
      candidates.push({ vault, item });
    }
  }
  if (candidates.length !== 1) {
    throw failure(FailureKind.CONFIG, `expected exactly one local Chalk SFU API_CREDENTIAL item, found ${candidates.length}`, { stage: "secrets" });
  }
  const [{ vault, item }] = candidates;
  const full = await getItem({ vault, itemId: item.id });
  const appId = fieldValue(full, "app_id");
  const appSecret = fieldValue(full, "app_secret");
  if (!appId || !appSecret) throw failure(FailureKind.CONFIG, "local SFU API_CREDENTIAL must contain app_id and app_secret", { stage: "secrets" });
  return {
    appId,
    appSecret,
    source: { vault: vault.id || vault.name, itemId: item.id },
    redactions: [appId, appSecret],
  };
}

function defaultCandidate(item, vault) {
  const text = JSON.stringify({ item, vault }).toLowerCase();
  return isChalkSfu(item, vault) && /(local|development|dev)/.test(text);
}

function isChalkSfu(item, vault) {
  const text = JSON.stringify({ item, vault }).toLowerCase();
  return text.includes("chalk") && text.includes("sfu");
}

function isCredentialItem(item) {
  const category = String(item.category || item.type || "").toLowerCase();
  return category === "api_credential" || category === "api credential" || credentialTitle.test(item.title || item.name || "");
}

function isProductionMarked(item, vault) {
  const text = JSON.stringify({ item, vault }).toLowerCase();
  return /production|prod\b/.test(text);
}

function fieldValue(item, wanted) {
  const field = (item.fields || []).find((entry) => [entry.id, entry.label].some((name) => String(name || "").toLowerCase() === wanted));
  if (field?.value !== undefined) return String(field.value).trim();
  if (item[wanted] !== undefined) return String(item[wanted]).trim();
  return "";
}

export function createOpSecretResolver({ op = "op", env = process.env } = {}) {
  const json = async (args) => {
    const { stdout } = await execFileAsync(op, args, { env, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  return () =>
    resolveLocalSfuCredentials({
      enumerateVaults: async () => json(["vault", "list", "--format", "json"]),
      enumerateItems: async (vault) => json(["item", "list", "--vault", vault.id || vault.name, "--format", "json"]),
      getItem: async ({ vault, itemId }) => json(["item", "get", itemId, "--vault", vault.id || vault.name, "--format", "json"]),
    });
}
