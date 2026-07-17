import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const localManifestPath = path.join(repositoryRoot, "infrastructure/architecture-worker/.generated/manifest.json");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// This bounded integration probe collapses network and readiness failures into one retry result.
// fallow-ignore-next-line complexity
async function deploymentProbe(baseUrl, expectedBuildId) {
  try {
    const response = await fetch(baseUrl, { redirect: "manual" });
    const deployedBuildId = response.headers.get("x-chalk-atlas-build");
    const ready = response.status === 401 && (response.headers.get("content-type") || "").startsWith("text/html") && deployedBuildId === expectedBuildId;
    return { ready, error: ready ? null : new Error(`Expected anonymous 401 from build ${expectedBuildId} at ${baseUrl}; received ${response.status} from build ${deployedBuildId || "unknown"}.`) };
  } catch (error) {
    return { ready: false, error };
  }
}

// The loop is a fixed 30-second deployment propagation boundary with one success exit.
// fallow-ignore-next-line complexity
async function waitForDeployment(baseUrl, expectedBuildId) {
  let lastProbe;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    lastProbe = await deploymentProbe(baseUrl, expectedBuildId);
    if (lastProbe.ready) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw lastProbe?.error || new Error(`Deployment did not become ready: ${baseUrl}`);
}

// This probe intentionally keeps the login, cookie, and exact build check in one bounded network attempt.
// fallow-ignore-next-line complexity
async function authenticatedAttempt(baseUrl, accessCode, expectedBuildId) {
  const login = await fetch(new URL("/_auth/login", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl.origin,
      "User-Agent": "chalk-atlas-deploy-verifier/1",
    },
    body: new URLSearchParams({ accessCode, returnTo: "/" }),
  });
  if (login.status === 429) throw new Error("Deployment verification was rate limited while waiting for the authenticated build.");
  if (login.status !== 303) return { error: new Error(`Authenticated login returned ${login.status} while waiting for build ${expectedBuildId}.`) };
  const cookie = sessionCookie(login.headers.get("set-cookie") || "");
  const response = await fetch(baseUrl, { headers: { Cookie: cookie } });
  const html = await response.text();
  const ready = response.status === 200 && response.headers.get("x-chalk-atlas-build") === expectedBuildId;
  return ready ? { cookie, response, html } : { error: new Error(`Authenticated atlas returned ${response.status} from build ${response.headers.get("x-chalk-atlas-build") || "unknown"}.`) };
}

// The loop is capped below the Worker's ten-attempt rate-limit window.
// fallow-ignore-next-line complexity
async function authenticatedAtlas(baseUrl, accessCode, expectedBuildId) {
  let result;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    result = await authenticatedAttempt(baseUrl, accessCode, expectedBuildId);
    if (!result.error) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw result?.error || new Error(`Authenticated build ${expectedBuildId} did not become ready.`);
}

function sessionCookie(setCookie) {
  assert(setCookie.includes("__Host-chalk_atlas_session="), "Login did not issue the signed session cookie.");
  const requiredAttributes = ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"];
  const missingAttributes = requiredAttributes.filter((attribute) => !setCookie.includes(attribute));
  assert(missingAttributes.length === 0, `Session cookie is missing ${missingAttributes.join(", ")}.`);
  return setCookie.split(";", 1)[0];
}

async function verifyAssets(baseUrl, cookie, html, localManifest) {
  const assetPaths = Object.keys(localManifest.assets);
  for (const assetPath of assetPaths) {
    const expected = localManifest.assets[assetPath];
    assert(html.includes(assetPath), `Atlas HTML does not reference bundled asset ${assetPath}.`);
    const response = await fetch(new URL(assetPath, baseUrl), { headers: { Cookie: cookie } });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(response.status === 200, `Authenticated asset ${assetPath} must return 200, received ${response.status}.`);
    assert(response.headers.get("content-type") === expected.contentType, `Asset ${assetPath} content type differs from the build manifest.`);
    assert(response.headers.get("x-content-sha256") === expected.sha256, `Asset ${assetPath} integrity header differs from the build manifest.`);
    assert(sha256(bytes) === expected.sha256, `Asset ${assetPath} bytes differ from the build manifest.`);
  }
  return assetPaths.length;
}

export async function verifyDeployment(inputUrl, accessCode) {
  const baseUrl = new URL(inputUrl);
  baseUrl.pathname = "/";
  baseUrl.search = "";
  baseUrl.hash = "";
  const localManifest = JSON.parse(await readFile(localManifestPath, "utf8"));
  const assetPaths = Object.keys(localManifest.assets);
  assert(assetPaths.length > 0, "The local architecture bundle contains no assets.");
  await waitForDeployment(baseUrl, localManifest.buildId);

  const anonymousHtml = await fetch(baseUrl, { redirect: "manual" });
  const anonymousBody = await anonymousHtml.text();
  assert(anonymousHtml.status === 401, `Anonymous HTML must return 401, received ${anonymousHtml.status}.`);
  assert(anonymousBody.includes('action="/_auth/login"'), "Anonymous HTML did not render the access-code screen.");
  assert(anonymousHtml.headers.get("cache-control") === "no-store", "Anonymous access screen must not be cached.");

  const anonymousAsset = await fetch(new URL(assetPaths[0], baseUrl), { redirect: "manual" });
  assert(anonymousAsset.status === 401, `Anonymous asset must return 401, received ${anonymousAsset.status}.`);
  assert((await anonymousAsset.text()).includes("Architecture atlas"), "Anonymous asset denial did not return the access-code screen.");

  const { cookie, response: authenticatedHtml, html } = await authenticatedAtlas(baseUrl, accessCode, localManifest.buildId);
  assert(authenticatedHtml.headers.get("x-chalk-atlas-build") === localManifest.buildId, "Deployed HTML build ID does not match the local bundle.");
  assert((authenticatedHtml.headers.get("content-security-policy") || "").includes("script-src 'sha256-"), "Atlas CSP does not pin its inline script hash.");
  assert(!/\b(?:src|href)=["']\.\.?\//i.test(html), "Deployed atlas still contains a local relative asset reference.");

  const deployedManifestResponse = await fetch(new URL("/__atlas/manifest", baseUrl), { headers: { Cookie: cookie } });
  assert(deployedManifestResponse.status === 200, `Authenticated manifest must return 200, received ${deployedManifestResponse.status}.`);
  const deployedManifest = await deployedManifestResponse.json();
  assert(deployedManifest.buildId === localManifest.buildId, "Deployed manifest build ID does not match the local bundle.");

  const assetsVerified = await verifyAssets(baseUrl, cookie, html, localManifest);

  const result = { url: baseUrl.href, buildId: localManifest.buildId, assetsVerified, anonymousHtmlStatus: anonymousHtml.status, anonymousAssetStatus: anonymousAsset.status };
  console.log(`Verified protected architecture Worker ${result.buildId}: anonymous HTML/assets denied; ${result.assetsVerified} authenticated assets matched.`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const deploymentUrl = process.env.CHALK_ATLAS_URL;
  const accessCode = process.env.CHALK_ATLAS_ACCESS_CODE;
  if (!deploymentUrl || !accessCode) throw new Error("Set CHALK_ATLAS_URL and CHALK_ATLAS_ACCESS_CODE to verify a deployment.");
  await verifyDeployment(deploymentUrl, accessCode);
}
