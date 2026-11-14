#!/usr/bin/env node
/**
 * Livento asset downloader and verifier (no dependencies, Node 22+).
 *
 * Reads public/assets/assets.json and, for every entry:
 *   - plain files (fonts, licenses): downloads `url`, checks the exact byte size
 *     and SHA-256 BEFORE writing, skips files that are already valid;
 *   - processed media (trail photos, GIF loops, posters; `processed: true`):
 *     checks the committed output in public/assets against `output.bytes` /
 *     `output.sha256`. `url`/`bytes`/`sha256` describe the SOURCE download.
 *
 * Usage
 *   npm run assets                  fonts + licenses, then check committed media
 *   npm run assets -- --sources     also re-download each media source and verify it
 *   npm run assets -- --build       re-create media from verified sources with
 *                                   ffmpeg-static and record the new output hashes
 *
 * Rules: 90 s timeout per download, nothing is written outside public/assets,
 * a failing URL is reported (and the run exits 1) — media is never substituted.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "public", "assets");
const MANIFEST = path.join(ASSETS, "assets.json");
const TIMEOUT_MS = 90_000;

const flags = new Set(process.argv.slice(2));
const CHECK_SOURCES = flags.has("--sources");
const BUILD = flags.has("--build");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Resolve a manifest path inside public/assets; refuse anything else. */
function inside(rel) {
  if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel)) {
    throw new Error(`refusing path "${rel}"`);
  }
  const abs = path.resolve(ASSETS, rel);
  if (!abs.startsWith(ASSETS + path.sep)) {
    throw new Error(`refusing path outside public/assets: "${rel}"`);
  }
  return abs;
}

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const matches = (buf, bytes, hash) => buf !== null && buf.length === bytes && sha256(buf) === hash;

/** Download `url` and return its bytes only if size and SHA-256 match. */
async function download(url, bytes, hash) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "livento-assets/1.0" },
    });
  } catch (error) {
    throw new Error(error.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000} s` : error.message);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== bytes) throw new Error(`expected ${bytes} bytes, got ${buf.length}`);
  const got = sha256(buf);
  if (got !== hash) throw new Error(`SHA-256 mismatch: expected ${hash}, got ${got}`);
  return buf;
}

/** Write next to the target, then rename, so a half-written file never looks valid. */
async function writeAtomic(file, buf) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, file);
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
}

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
const results = [];
const failures = [];
const sourceCache = new Map(); // url -> Buffer (verified)
let manifestChanged = false;
let ffmpegPath = null;
let workDir = null;

async function verifiedSource(entry) {
  if (!sourceCache.has(entry.url)) {
    sourceCache.set(entry.url, await download(entry.url, entry.bytes, entry.sha256));
  }
  return sourceCache.get(entry.url);
}

async function handleFile(entry, file) {
  if (matches(await readIfExists(file), entry.bytes, entry.sha256)) return "ok (already valid)";
  const buf = await download(entry.url, entry.bytes, entry.sha256);
  await writeAtomic(file, buf);
  return "downloaded + verified";
}

async function handleProcessed(entry, file) {
  if (BUILD) {
    if (!ffmpegPath) {
      ({ default: ffmpegPath } = await import("ffmpeg-static"));
      if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
    }
    workDir ??= await mkdtemp(path.join(os.tmpdir(), "livento-assets-"));
    const src = path.join(workDir, `src-${sha256(Buffer.from(entry.url)).slice(0, 12)}`);
    const out = path.join(workDir, path.basename(file));
    if ((await readIfExists(src)) === null) await writeFile(src, await verifiedSource(entry));
    const args = entry.ffmpeg.map((a) => a.replaceAll("{src}", src).replaceAll("{out}", out));
    await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    const buf = await readFile(out);
    await mkdir(path.dirname(file), { recursive: true });
    await copyFile(out, file);
    const output = { bytes: buf.length, sha256: sha256(buf) };
    if (entry.output?.sha256 !== output.sha256 || entry.output?.bytes !== output.bytes) {
      entry.output = output;
      manifestChanged = true;
    }
    return `built from verified source (${buf.length} bytes)`;
  }

  const notes = [];
  if (CHECK_SOURCES) {
    await verifiedSource(entry);
    notes.push("source verified");
  }
  const buf = await readIfExists(file);
  if (buf === null) throw new Error("committed output missing (run with --build)");
  if (!entry.output) throw new Error("no output hash recorded (run with --build)");
  if (!matches(buf, entry.output.bytes, entry.output.sha256)) {
    throw new Error("committed output does not match its recorded SHA-256 (run with --build)");
  }
  notes.unshift("ok (committed output verified)");
  return notes.join(", ");
}

try {
  for (const entry of manifest.assets) {
    let file;
    try {
      file = inside(entry.path);
      const status = entry.processed ? await handleProcessed(entry, file) : await handleFile(entry, file);
      results.push([entry.path, status]);
    } catch (error) {
      failures.push([entry.path, entry.url, error.message]);
      results.push([entry.path, `FAILED: ${error.message}`]);
    }
  }
  if (manifestChanged) {
    await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }
} finally {
  if (workDir) await rm(workDir, { recursive: true, force: true });
}

const width = Math.max(...results.map(([p]) => p.length));
for (const [p, status] of results) console.log(`${p.padEnd(width)}  ${status}`);
if (manifestChanged) console.log("\nUpdated output hashes in public/assets/assets.json");

if (failures.length) {
  console.error(`\n${failures.length} asset(s) failed. Nothing was substituted:`);
  for (const [p, url, message] of failures) console.error(`- ${p}\n  ${url}\n  ${message}`);
  process.exit(1);
}
console.log(`\nAll ${results.length} assets verified.`);
