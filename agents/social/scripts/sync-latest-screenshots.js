#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("node:child_process");

const DEFAULT_BASE_URL =
  "https://raw.githubusercontent.com/scidsg/hushline-screenshots/main/releases/latest";
const CURL_USER_AGENT = "hushline-social-sync/1.0";

function parseArgs(argv) {
  const args = {
    baseUrl: process.env.HUSHLINE_SCREENSHOTS_BASE_URL || DEFAULT_BASE_URL,
    dest: path.resolve(process.cwd(), "..", "hushline-screenshots", "releases", "latest"),
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
      "  node scripts/sync-latest-screenshots.js --dest ../hushline-screenshots/releases/latest",
      "",
      "Behavior:",
      "  - Downloads the upstream latest manifest from hushline-screenshots",
      "  - Downloads all fold-mode PNGs referenced by that manifest",
      "  - Writes them into the local latest screenshots folder",
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
  const buffer = await runCurl(curlArgs(url), { captureStdout: true });
  return buffer.toString("utf8");
}

async function downloadFile(url, destination) {
  const temporaryDestination = `${destination}.tmp`;
  await runCurl([...curlArgs(url), "--output", temporaryDestination]);
  fs.renameSync(temporaryDestination, destination);
}

function foldFilesFromManifest(manifest) {
  const files = new Set(["manifest.json"]);

  for (const scene of manifest.scenes || []) {
    for (const file of scene.files || []) {
      if (file.mode === "fold") {
        files.add(file.file);
      }
    }
  }

  return [...files].sort();
}

async function downloadWithConcurrency(files, worker) {
  const concurrency = 8;
  let cursor = 0;

  async function runWorker() {
    while (cursor < files.length) {
      const current = cursor;
      cursor += 1;
      await worker(files[current], current);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, () => runWorker()),
  );
}

function swapDestination(stagedDest, dest) {
  const parentDir = path.dirname(dest);
  const backupDest = path.join(
    parentDir,
    `.latest-backup-${process.pid}-${Date.now()}`,
  );
  const hadExistingDest = fs.existsSync(dest);
  const backupReadme = path.join(backupDest, "README.md");
  const nextReadme = path.join(dest, "README.md");

  fs.mkdirSync(parentDir, { recursive: true });

  if (hadExistingDest) {
    fs.renameSync(dest, backupDest);
  }

  try {
    fs.renameSync(stagedDest, dest);
    if (hadExistingDest && fs.existsSync(backupReadme) && !fs.existsSync(nextReadme)) {
      fs.copyFileSync(backupReadme, nextReadme);
    }
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
  const stagingRoot = fs.mkdtempSync(
    path.join(path.dirname(args.dest), ".latest-sync-"),
  );
  const stagedDest = path.join(stagingRoot, path.basename(args.dest));
  const imageFiles = files.filter((file) => file !== "manifest.json");

  try {
    fs.mkdirSync(stagedDest, { recursive: true });

    await downloadWithConcurrency(imageFiles, async (file) => {
      const destination = path.join(stagedDest, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      await downloadFile(`${args.baseUrl}/${file}`, destination);
    });

    fs.writeFileSync(
      path.join(stagedDest, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
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
  curlArgs,
  downloadFile,
  downloadWithConcurrency,
  fetchText,
  foldFilesFromManifest,
  main,
  parseArgs,
  runCurl,
  swapDestination,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
