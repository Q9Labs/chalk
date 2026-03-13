#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const DEFAULT_MODEL = process.env.CODE_INDEX_MODEL ?? "embeddinggemma";
const OLLAMA_URL = (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/$/, "");
const INDEX_ROOT = path.join(process.cwd(), ".code-index");
const INDEX_FILE = path.join(INDEX_ROOT, "index.json");
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".md", ".mdx", ".json", ".yaml", ".yml", ".css"]);
const IGNORED_DIRS = new Set([".git", ".turbo", "node_modules", "dist", "build", "coverage", ".next", ".expo", ".gradle", ".code-index", "apps/docs_backup"]);
const SPLIT_PATTERN = /^(#{1,3}\s+.+|(export\s+default\s+)?(async\s+)?function\s+\w+|export\s+(type|interface|enum|class)\s+\w+|class\s+\w+|interface\s+\w+|type\s+\w+\s*=|enum\s+\w+|func\s+(\([^)]*\)\s*)?\w+|type\s+\w+\s+struct|const\s+\(|var\s+\()/;
const MAX_CHARS = 1800;
const WINDOW_LINES = 80;
const WINDOW_OVERLAP = 18;
const MERGE_TARGET_CHARS = 900;

type Chunk = {
  id: string;
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  symbol: string;
  text: string;
  hash: string;
};

type IndexedChunk = Chunk & { vector: number[] };

type IndexData = {
  version: 1;
  model: string;
  createdAt: string;
  root: string;
  chunkCount: number;
  dimension: number;
  chunks: IndexedChunk[];
};

type SearchResult = IndexedChunk & { score: number };

type ParsedArgs = {
  command: "index" | "search" | "stats";
  positionals: string[];
  model: string;
  topK: number;
};

export function chunkSource(filePath: string, source: string): Chunk[] {
  const lines = source.split(/\r?\n/);
  const boundaries = new Set([0]);
  for (let index = 0; index < lines.length; index += 1) {
    if (SPLIT_PATTERN.test(lines[index])) boundaries.add(index);
  }
  const starts = [...boundaries].sort((left, right) => left - right);
  const chunks: Chunk[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] ?? lines.length;
    pushChunkWindows(chunks, filePath, lines, start, end);
  }
  return mergeSmallChunks(chunks.length > 0 ? chunks : [buildChunk(filePath, lines, 0, lines.length)]);
}

function pushChunkWindows(chunks: Chunk[], filePath: string, lines: string[], start: number, end: number) {
  const section = lines.slice(start, end).join("\n").trim();
  if (!section) return;
  if (section.length <= MAX_CHARS) {
    chunks.push(buildChunk(filePath, lines, start, end));
    return;
  }
  for (let windowStart = start; windowStart < end; windowStart += WINDOW_LINES - WINDOW_OVERLAP) {
    const windowEnd = Math.min(end, windowStart + WINDOW_LINES);
    chunks.push(buildChunk(filePath, lines, windowStart, windowEnd));
    if (windowEnd === end) break;
  }
}

function buildChunk(filePath: string, lines: string[], start: number, end: number): Chunk {
  const content = lines.slice(start, end).join("\n").trim();
  const symbol = pickSymbol(lines.slice(start, Math.min(end, start + 4)));
  const hash = createHash("sha256").update(`${filePath}:${start}:${content}`).digest("hex").slice(0, 16);
  return {
    id: `${filePath}:${start + 1}-${end}`,
    path: filePath,
    language: path.extname(filePath).slice(1) || "text",
    startLine: start + 1,
    endLine: end,
    symbol,
    text: content,
    hash,
  };
}

function pickSymbol(lines: string[]) {
  const joined = lines.join("\n");
  const match = joined.match(/^#{1,3}\s+(.+)$/m) ?? joined.match(/(?:function|class|interface|enum|type)\s+([A-Za-z0-9_]+)/m) ?? joined.match(/(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/m) ?? joined.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/m) ?? joined.match(/^type\s+([A-Za-z0-9_]+)/m);
  return match?.[1] ?? "file";
}

async function walkFiles(currentPath: string, root = currentPath): Promise<string[]> {
  const entries = await readdir(currentPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && ![".github"].includes(entry.name)) continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolutePath, root)));
      continue;
    }
    const extension = path.extname(entry.name);
    if (!ALLOWED_EXTENSIONS.has(extension)) continue;
    files.push(path.relative(root, absolutePath));
  }
  return files;
}

async function loadChunks(inputs: string[]) {
  const files = inputs.length > 0 ? await expandInputs(inputs) : await walkFiles(process.cwd());
  const chunks: Chunk[] = [];
  for (const relativePath of files) {
    const absolutePath = path.resolve(process.cwd(), relativePath);
    const source = await readFile(absolutePath, "utf8").catch(() => "");
    if (!source || source.length > 250_000) continue;
    chunks.push(...chunkSource(relativePath, source));
  }
  return chunks;
}

async function expandInputs(inputs: string[]) {
  const files = new Set<string>();
  for (const input of inputs) {
    const absolutePath = path.resolve(process.cwd(), input);
    const details = await stat(absolutePath).catch(() => null);
    if (!details) continue;
    if (details.isDirectory()) {
      for (const file of await walkFiles(absolutePath, process.cwd())) files.add(file);
      continue;
    }
    if (ALLOWED_EXTENSIONS.has(path.extname(absolutePath))) {
      files.add(path.relative(process.cwd(), absolutePath));
    }
  }
  return [...files].sort();
}

async function embedTexts(model: string, input: string[]) {
  const data = await requestJson<{ embeddings?: number[][] }>(`${OLLAMA_URL}/api/embed`, { model, input });
  if (!data.embeddings?.length) throw new Error("Ollama returned no embeddings.");
  return data.embeddings;
}

async function runIndex(args: ParsedArgs) {
  const chunks = await loadChunks(args.positionals);
  if (chunks.length === 0) throw new Error("No indexable files found.");
  const previousIndex = await readIndex().catch(() => null);
  const cachedVectors = previousIndex?.model === args.model ? new Map(previousIndex.chunks.map((chunk) => [chunk.hash, chunk.vector])) : new Map<string, number[]>();
  const indexed: IndexedChunk[] = [];
  const pending = chunks.filter((chunk) => !cachedVectors.has(chunk.hash));

  for (const chunk of chunks) {
    const cachedVector = cachedVectors.get(chunk.hash);
    if (cachedVector) indexed.push({ ...chunk, vector: cachedVector });
  }

  for (let index = 0; index < pending.length; index += 24) {
    const batch = pending.slice(index, index + 24);
    const embeddings = await embedTexts(args.model, batch.map(toEmbeddingInput));
    indexed.push(...batch.map((chunk, batchIndex) => ({ ...chunk, vector: embeddings[batchIndex] })));
    process.stdout.write(`Embedded ${Math.min(index + batch.length, pending.length)}/${pending.length} new chunks\r`);
  }

  indexed.sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine);
  await mkdir(INDEX_ROOT, { recursive: true });
  const data: IndexData = {
    version: 1,
    model: args.model,
    createdAt: new Date().toISOString(),
    root: process.cwd(),
    chunkCount: indexed.length,
    dimension: indexed[0]?.vector.length ?? 0,
    chunks: indexed,
  };
  await writeFile(INDEX_FILE, JSON.stringify(data, null, 2));
  console.log(`\nSaved ${data.chunkCount} chunks to ${path.relative(process.cwd(), INDEX_FILE)} using ${data.model}. Reused ${indexed.length - pending.length}, embedded ${pending.length}.`);
}

async function runSearch(args: ParsedArgs) {
  const query = args.positionals.join(" ").trim();
  if (!query) throw new Error('Provide a search query. Example: bun run code:search "join flow retry"');
  const data = await readIndex();
  const [queryVector] = await embedTexts(data.model, [query]);
  const results = data.chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(query, queryVector, chunk) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, args.topK);
  printResults(query, results);
}

async function runStats() {
  const data = await readIndex();
  console.log(JSON.stringify({ model: data.model, chunkCount: data.chunkCount, dimension: data.dimension, createdAt: data.createdAt }, null, 2));
}

function scoreChunk(query: string, queryVector: number[], chunk: IndexedChunk) {
  const semantic = cosineSimilarity(queryVector, chunk.vector);
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1);
  const pathText = chunk.path.toLowerCase();
  const symbolText = chunk.symbol.toLowerCase();
  const bodyText = chunk.text.toLowerCase();
  const weightedHits = terms.reduce((score, term) => {
    return score + countOccurrences(pathText, term) * 4 + countOccurrences(symbolText, term) * 3 + countOccurrences(bodyText, term);
  }, 0);
  const lexical = terms.length === 0 ? 0 : Math.min(1, weightedHits / (terms.length * 4));
  const exactBoost = terms.some((term) => symbolText === term || pathText.includes(term)) ? 0.1 : 0;
  const markdownPenalty = chunk.path.endsWith(".md") || chunk.path.endsWith(".mdx") ? 0.04 : 0;
  return semantic * 0.62 + lexical * 0.38 + exactBoost - markdownPenalty;
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function printResults(query: string, results: SearchResult[]) {
  console.log(`Top ${results.length} results for "${query}"\n`);
  for (const result of results) {
    const preview = result.text.split("\n").slice(0, 6).join("\n");
    console.log(`${result.score.toFixed(3)}  ${result.path}:${result.startLine}  [${result.symbol}]`);
    console.log(indent(preview));
    console.log("");
  }
}

function indent(text: string) {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function toEmbeddingInput(chunk: Chunk) {
  return [`path: ${chunk.path}`, `symbol: ${chunk.symbol}`, `lines: ${chunk.startLine}-${chunk.endLine}`, chunk.text].join("\n");
}

function countOccurrences(text: string, term: string) {
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

function mergeSmallChunks(chunks: Chunk[]) {
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    const previous = merged.at(-1);
    if (!previous || previous.path !== chunk.path || previous.text.length >= MERGE_TARGET_CHARS || (previous.symbol !== "file" && chunk.symbol !== "file")) {
      merged.push(chunk);
      continue;
    }
    merged[merged.length - 1] = {
      ...previous,
      id: `${previous.path}:${previous.startLine}-${chunk.endLine}`,
      endLine: chunk.endLine,
      text: `${previous.text}\n\n${chunk.text}`,
      hash: createHash("sha256").update(`${previous.path}:${previous.startLine}:${previous.text}\n\n${chunk.text}`).digest("hex").slice(0, 16),
    };
  }
  return merged;
}

async function readIndex() {
  const data = await readFile(INDEX_FILE, "utf8").catch(() => "");
  if (!data) throw new Error(`Index missing. Run: bun run code:index`);
  return JSON.parse(data) as IndexData;
}

function requestJson<T>(url: string, body: object) {
  return new Promise<T>((resolve, reject) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 500) >= 400) {
            reject(new Error(`Ollama embed failed: ${response.statusCode} ${response.statusMessage ?? ""}\n${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(120_000, () => request.destroy(new Error("Ollama embed request timed out after 120s.")));
    request.write(payload);
    request.end();
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (!command || !["index", "search", "stats"].includes(command)) {
    throw new Error("Usage: bun run code-index.ts <index|search|stats> [args] [--model embeddinggemma] [--top 8]");
  }
  const positionals: string[] = [];
  let model = DEFAULT_MODEL;
  let topK = 8;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--model") {
      model = rest[index + 1] ?? model;
      index += 1;
      continue;
    }
    if (token === "--top") {
      topK = Number.parseInt(rest[index + 1] ?? "8", 10) || 8;
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  return { command: command as ParsedArgs["command"], positionals, model, topK };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const command = args.command === "index" ? runIndex(args) : args.command === "search" ? runSearch(args) : runStats();
  command.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
