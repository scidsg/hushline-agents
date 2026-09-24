#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("node:child_process");

const DEFAULT_BASE_URL =
  "https://raw.githubusercontent.com/scidsg/hushline-screenshots/main/releases/latest";
const CURL_USER_AGENT = "hushline-social-sync/1.0";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGES = 256;

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.HUSHLINE_SCREENSHOTS_BASE_URL || DEFAULT_BASE_URL,
    dest: path.resolve(process.env.HUSHLINE_SCREENSHOT_CACHE_DIR || path.join(os.homedir(), ".cache", "hushline", "screenshots", "latest")),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--dest") {
      args.dest = path.resolve(process.cwd(), argv[index + 1]);
      index += 1;
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/sync-latest-screenshots.js",
      "  node scripts/sync-latest-screenshots.js --dest /tmp/current-screenshots",
      "",
      "Behavior:",
      "  - Downloads the upstream latest manifest from hushline-screenshots",
      "  - Downloads all fold-mode PNGs referenced by that manifest",
      "  - Replaces a disposable cache (64 MiB maximum); never clones a repository",
      "",
    ].join("\n"),
  );
}

function runCurl(args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, {
      stdio: captureStdout ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        reject(new Error("Missing required command: curl"));
        return;
      }
      reject(error);
    });

    if (captureStdout) {
      child.stdout.on("data", (chunk) => {
        stdout.push(chunk);
      });
    }

    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(message || `curl exited with code ${code}`));
        return;
      }

      resolve(captureStdout ? Buffer.concat(stdout) : Buffer.alloc(0));
    });
  });
}

function curlArgs(url) {
  return [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--retry",
    "2",
    "--retry-delay",
    "1",
    "--connect-timeout",
    "10",
    "--max-time",
    "60",
    "--user-agent",
    CURL_USER_AGENT,
    url,
  ];
}

async function fetchText(url) {
  const buffer = await runCurl([...curlArgs(url), "--max-filesize", String(MAX_MANIFEST_BYTES)], { captureStdout: true });
  if (buffer.length > MAX_MANIFEST_BYTES) throw new Error("Screenshot manifest exceeds size limit.");
  return buffer.toString("utf8");
}

async function downloadFile(url, destination, maxBytes = MAX_IMAGE_BYTES) {
  const temporaryDestination = `${destination}.tmp`;
  await runCurl([...curlArgs(url), "--max-filesize", String(maxBytes), "--output", temporaryDestination]);
  if (fs.statSync(temporaryDestination).size > maxBytes) throw new Error("Screenshot exceeds size limit.");
  fs.renameSync(temporaryDestination, destination);
}

function validateManifestFilePath(file) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("Screenshot manifest contains an invalid fold file path.");
  }

  if (file.includes("\0") || file.includes("\\")) {
    throw new Error(`Screenshot manifest contains an unsafe fold file path: ${file}`);
  }

  const normalized = path.posix.normalize(file);
  if (
    normalized !== file ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Screenshot manifest contains an unsafe fold file path: ${file}`);
  }

  return normalized;
}

function resolveUnderRoot(root, file) {
  const destination = path.resolve(root, file);
  const relative = path.relative(root, destination);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write screenshot outside staging directory: ${file}`);
  }

  return destination;
}

function foldFilesFromManifest(manifest) {
  const files = new Set(["manifest.json"]);

  for (const scene of manifest.scenes || []) {
    for (const file of scene.files || []) {
      if (file.mode === "fold") {
        files.add(validateManifestFilePath(file.file));
      }
    }
  }

  if (files.size - 1 > MAX_IMAGES) throw new Error("Screenshot manifest exceeds image count limit.");
  return [...files].sort();
}

function swapDestination(stagedDest, dest) {
  const parentDir = path.dirname(dest);
  const backupDest = path.join(
    parentDir,
    `.latest-backup-${process.pid}-${Date.now()}`,
  );
  const hadExistingDest = fs.existsSync(dest);

  fs.mkdirSync(parentDir, { recursive: true });

  if (hadExistingDest) {
    fs.renameSync(dest, backupDest);
  }

  try {
    fs.renameSync(stagedDest, dest);
    fs.rmSync(backupDest, { force: true, recursive: true });
  } catch (error) {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { force: true, recursive: true });
    }
    if (hadExistingDest && fs.existsSync(backupDest)) {
      fs.renameSync(backupDest, dest);
    }
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await fetchText(`${args.baseUrl}/manifest.json`));
  const files = foldFilesFromManifest(manifest);
  if (files.length < 2) throw new Error("Online screenshot manifest has no fold screenshots.");
  fs.mkdirSync(path.dirname(args.dest), { recursive: true });
  const stagingRoot = fs.mkdtempSync(
    path.join(path.dirname(args.dest), ".latest-sync-"),
  );
  const stagedDest = path.join(stagingRoot, path.basename(args.dest));
  const imageFiles = files.filter((file) => file !== "manifest.json");

  try {
    fs.mkdirSync(stagedDest, { recursive: true });

    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    let remaining = MAX_CACHE_BYTES - Buffer.byteLength(manifestText);
    // Sequential downloads enforce an aggregate disk bound even on failure.
    for (const file of imageFiles) {
      if (remaining <= 0) throw new Error("Screenshot cache exceeds size limit.");
      const destination = resolveUnderRoot(stagedDest, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await downloadFile(`${args.baseUrl}/${file}`, destination, Math.min(MAX_IMAGE_BYTES, remaining));
      remaining -= fs.statSync(destination).size;
    }
    fs.writeFileSync(path.join(stagedDest, "manifest.json"), manifestText);
    swapDestination(stagedDest, args.dest);
  } finally {
    fs.rmSync(stagingRoot, { force: true, recursive: true });
  }

  process.stdout.write(
    [
      `Synced latest screenshots into ${args.dest}`,
      `Release: ${manifest.release}`,
      `Captured at: ${manifest.capturedAt}`,
      `Fold screenshots: ${imageFiles.length}`,
      "",
    ].join("\n"),
  );
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_CACHE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  curlArgs,
  downloadFile,
  fetchText,
  foldFilesFromManifest,
  main,
  parseArgs,
  resolveUnderRoot,
  runCurl,
  swapDestination,
  validateManifestFilePath,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
