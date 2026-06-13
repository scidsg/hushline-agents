const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");

test("docs drift checker passes for the committed repo state", () => {
  const output = execFileSync(process.execPath, ["scripts/check-docs-drift.js"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  assert.match(output, /Docs and launchd schedule are in sync\./);
});
