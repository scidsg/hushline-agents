"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOCIAL_ROOT = path.resolve(__dirname, "..");
const RENDERERS = [
  "scripts/lib/render-social-post.js",
  "scripts/lib/verified-user-post.js",
];

test("social renderers load ESM Puppeteer without disabling the browser sandbox", () => {
  for (const relativePath of RENDERERS) {
    const source = fs.readFileSync(path.join(SOCIAL_ROOT, relativePath), "utf8");
    assert.match(source, /await import\("puppeteer-core"\)/);
    assert.doesNotMatch(source, /--no-sandbox/);
    assert.doesNotMatch(source, /--disable-setuid-sandbox/);
  }
});

test("the social runtime lockfile excludes the vulnerable extract-zip package", () => {
  const lockfile = fs.readFileSync(path.join(SOCIAL_ROOT, "package-lock.json"), "utf8");
  assert.doesNotMatch(lockfile, /node_modules\/extract-zip/);
});
