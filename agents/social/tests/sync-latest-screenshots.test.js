const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const scriptPath = path.join(REPO_ROOT, "scripts", "sync-latest-screenshots.js");

test("sync-latest-screenshots replaces the cache and removes obsolete files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "latest-sync-"));
  const destDir = path.join(tempRoot, "releases", "latest");
  const sourceDir = path.join(tempRoot, "source", "releases", "latest");
  fs.mkdirSync(path.join(destDir, "stale-owner"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "guest"), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, "admin"), { recursive: true });
  fs.writeFileSync(path.join(destDir, "README.md"), "local readme\n");
  fs.writeFileSync(path.join(destDir, "manifest.json"), "{\"release\":\"old\"}\n");
  fs.writeFileSync(path.join(destDir, "stale-owner", "stale.png"), "stale");

  const manifest = {
    release: "v9.9.9",
    capturedAt: "2026-03-27T12:00:00.000Z",
    scenes: [
      {
        files: [
          { file: "guest/one-fold.png", mode: "fold" },
          { file: "guest/two-full.png", mode: "full" },
        ],
      },
      {
        files: [
          { file: "admin/two-fold.png", mode: "fold" },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(sourceDir, "guest", "one-fold.png"), "one");
  fs.writeFileSync(path.join(sourceDir, "admin", "two-fold.png"), "two");
  const baseUrl = `file://${sourceDir}`;

  try {
    const output = execFileSync(
      process.execPath,
      [scriptPath, "--base-url", baseUrl, "--dest", destDir],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );

    assert.match(output, /Synced latest screenshots into/);
    assert.match(output, /Release: v9.9.9/);

    const nextManifest = JSON.parse(
      fs.readFileSync(path.join(destDir, "manifest.json"), "utf8"),
    );
    assert.equal(nextManifest.release, "v9.9.9");
    assert.equal(
      fs.readFileSync(path.join(destDir, "guest", "one-fold.png"), "utf8"),
      "one",
    );
    assert.equal(
      fs.readFileSync(path.join(destDir, "admin", "two-fold.png"), "utf8"),
      "two",
    );
    assert.equal(fs.existsSync(path.join(destDir, "README.md")), false);
    assert.equal(fs.existsSync(path.join(destDir, "stale-owner")), false);
    assert.equal(fs.existsSync(path.join(destDir, "guest", "two-full.png")), false);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("sync-latest-screenshots rejects manifest paths that escape staging", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "latest-sync-traversal-"));
  const destDir = path.join(tempRoot, "releases", "latest");
  const sourceDir = path.join(tempRoot, "source", "releases", "latest");
  const victimPath = path.join(tempRoot, "victim.txt");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(victimPath, "original\n");

  const manifest = {
    release: "v9.9.9",
    capturedAt: "2026-03-27T12:00:00.000Z",
    scenes: [
      {
        files: [{ file: "../../victim.txt", mode: "fold" }],
      },
    ],
  };
  fs.writeFileSync(path.join(sourceDir, "manifest.json"), JSON.stringify(manifest));

  try {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [scriptPath, "--base-url", `file://${sourceDir}`, "--dest", destDir],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: "pipe",
        },
      ),
      /unsafe fold file path/,
    );
    assert.equal(fs.readFileSync(victimPath, "utf8"), "original\n");
    assert.equal(fs.existsSync(destDir), false);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("online cache rejects oversized images and preserves the previous snapshot", () => {
  const { MAX_IMAGE_BYTES } = require("../scripts/sync-latest-screenshots");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bounded-screenshots-"));
  const source = path.join(root, "source");
  const dest = path.join(root, "cache", "latest");
  fs.mkdirSync(source);
  fs.mkdirSync(dest, {recursive: true});
  fs.writeFileSync(path.join(dest, "old-fold.png"), "previous");
  fs.writeFileSync(path.join(source, "huge-fold.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({
    scenes: [{files: [{mode: "fold", file: "huge-fold.png"}]}],
  }));
  try {
    assert.throws(() => execFileSync(process.execPath,
      [scriptPath, "--base-url", `file://${source}`, "--dest", dest],
      {stdio: "pipe"}));
    assert.equal(fs.readFileSync(path.join(dest, "old-fold.png"), "utf8"), "previous");
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ["latest"]);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("online cache rejects excessive manifest image counts before downloading", () => {
  const { foldFilesFromManifest, MAX_IMAGES } = require("../scripts/sync-latest-screenshots");
  assert.throws(() => foldFilesFromManifest({scenes: [{files: Array.from(
    {length: MAX_IMAGES + 1}, (_, i) => ({mode: "fold", file: `${i}-fold.png`}),
  )}]}), /image count limit/);
});
