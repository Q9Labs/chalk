import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const entryPath = path.join(repositoryRoot, "architecture.html");
const outputDirectory = path.join(repositoryRoot, "infrastructure/architecture-worker/.generated");
const outputPath = path.join(outputDirectory, "atlas.ts");
const manifestPath = path.join(outputDirectory, "manifest.json");
const assets = new Map();

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256Base64 = (value) => createHash("sha256").update(value).digest("base64");
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isBundledReference(reference) {
  return !/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(reference) && !reference.startsWith("data:");
}

function contentType(filePath, bytes) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ico" && bytes.subarray(1, 4).toString("ascii") === "PNG") return "image/png";
  const detected = CONTENT_TYPES[extension];
  if (detected) return detected;
  throw new Error(`Unsupported architecture asset type: ${path.relative(repositoryRoot, filePath)}`);
}

function resolveLocalReference(reference, parentPath) {
  const cleanReference = reference.split(/[?#]/, 1)[0];
  const resolved = cleanReference.startsWith("/") ? path.join(repositoryRoot, cleanReference) : path.resolve(path.dirname(parentPath), cleanReference);
  const relative = path.relative(repositoryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Architecture asset escapes the repository: ${reference}`);
  return resolved;
}

async function replaceAsync(input, expression, replacement) {
  const matches = [...input.matchAll(expression)];
  if (!matches.length) return input;
  const replacements = await Promise.all(matches.map((match) => replacement(match)));
  let cursor = 0;
  let output = "";
  matches.forEach((match, index) => {
    output += input.slice(cursor, match.index) + replacements[index];
    cursor = match.index + match[0].length;
  });
  return output + input.slice(cursor);
}

async function bundleAsset(reference, parentPath) {
  const sourcePath = resolveLocalReference(reference, parentPath);
  const sourceKey = path.relative(repositoryRoot, sourcePath).split(path.sep).join("/");
  if (assets.has(sourceKey)) return assets.get(sourceKey).path;

  let bytes = await readFile(sourcePath);
  if (path.extname(sourcePath).toLowerCase() === ".css") {
    const rewritten = await rewriteCss(bytes.toString("utf8"), sourcePath);
    bytes = Buffer.from(rewritten);
  }
  const digest = sha256(bytes);
  const safeName = path.basename(sourcePath).replace(/[^a-zA-Z0-9._-]/g, "-");
  const publicPath = `/assets/${digest.slice(0, 16)}-${safeName}`;
  assets.set(sourceKey, {
    path: publicPath,
    source: sourceKey,
    contentType: contentType(sourcePath, bytes),
    sha256: digest,
    sha256Base64: sha256Base64(bytes),
    bytes,
  });
  return publicPath;
}

async function rewriteCss(css, sourcePath) {
  return replaceAsync(css, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (match) => {
    const reference = match[2].trim();
    if (!isBundledReference(reference)) return match[0];
    return `url("${await bundleAsset(reference, sourcePath)}")`;
  });
}

async function rewriteAssetTag(match) {
  return replaceAsync(match[0], /\b(src|href)=(['"])([^'"]+)\2/gi, async (attributeMatch) => {
    const reference = attributeMatch[3].trim();
    if (!isBundledReference(reference)) return attributeMatch[0];
    const publicPath = await bundleAsset(reference, entryPath);
    return `${attributeMatch[1]}=${attributeMatch[2]}${publicPath}${attributeMatch[2]}`;
  });
}

let html = await readFile(entryPath, "utf8");
html = await replaceAsync(html, /<(?:link|script|img|source|video|audio)\b[^>]*>/gi, rewriteAssetTag);
html = await rewriteCss(html, entryPath);

const unresolved = [...html.matchAll(/\b(?:src|href)=(['"])((?:\.\.?\/|\/[^/])[^'"]*)\1/gi)].filter((match) => !match[2].startsWith("/assets/")).map((match) => match[0]);
if (unresolved.length) throw new Error(`Unbundled local architecture references remain: ${unresolved.join(", ")}`);

const scriptHashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => `'sha256-${sha256Base64(match[1])}'`);
const styleHashes = [...html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi)].map((match) => `'sha256-${sha256Base64(match[1])}'`);
const assetRecords = Object.fromEntries(
  [...assets.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((asset) => [
      asset.path,
      {
        source: asset.source,
        contentType: asset.contentType,
        sha256: asset.sha256,
        sha256Base64: asset.sha256Base64,
        size: asset.bytes.length,
        base64: asset.bytes.toString("base64"),
      },
    ]),
);
const buildId = sha256(
  `${html}\n${Object.values(assetRecords)
    .map((asset) => asset.sha256)
    .join("\n")}`,
).slice(0, 20);
const csp = [
  "default-src 'none'",
  `script-src ${scriptHashes.join(" ") || "'none'"}`,
  `style-src-elem ${styleHashes.join(" ") || "'none'"}`,
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  outputPath,
  `// Generated by scripts/architecture-worker/build.mjs. Do not edit.\nexport const ATLAS_HTML = ${JSON.stringify(html)};\nexport const ATLAS_BUILD_ID = ${JSON.stringify(buildId)};\nexport const ATLAS_CSP = ${JSON.stringify(csp)};\nexport const ASSET_RECORDS = ${JSON.stringify(assetRecords, null, 2)} as const;\n`,
);
await writeFile(
  manifestPath,
  `${JSON.stringify(
    {
      buildId,
      htmlSha256: sha256(html),
      assets: Object.fromEntries(Object.entries(assetRecords).map(([assetPath, asset]) => [assetPath, { source: asset.source, contentType: asset.contentType, sha256: asset.sha256, size: asset.size }])),
    },
    null,
    2,
  )}\n`,
);

console.log(`Built architecture Worker payload ${buildId}: ${Buffer.byteLength(html)} HTML bytes and ${assets.size} bundled assets.`);
