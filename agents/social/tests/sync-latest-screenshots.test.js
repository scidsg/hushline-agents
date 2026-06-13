const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const scriptPath = path.join(REPO_ROOT, "scripts", "sync-latest-screenshots.js");

test("sync-latest-screenshots stages files and preserves README.md", async () => {
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
    assert.equal(
      fs.readFileSync(path.join(destDir, "README.md"), "utf8"),
      "local readme\n",
    );
    assert.equal(fs.existsSync(path.join(destDir, "stale-owner")), false);
    assert.equal(fs.existsSync(path.join(destDir, "guest", "two-full.png")), false);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
