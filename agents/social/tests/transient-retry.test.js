const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const retryLibPath = path.join(REPO_ROOT, "scripts", "lib", "transient-retry.sh");

function runShell(script, env = {}) {
  return execFileSync("bash", ["-lc", script], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("is_transient_connection_output matches DNS failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transient-retry-"));
  const outputFile = path.join(tempDir, "output.log");
  fs.writeFileSync(outputFile, "fatal: unable to access 'https://github.com/repo.git/': Could not resolve host: github.com\n");

  try {
    const result = runShell(
      `source "${retryLibPath}"; if is_transient_connection_output "${outputFile}"; then printf 'yes\\n'; else printf 'no\\n'; fi`,
    );
    assert.equal(result.trim(), "yes");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("is_transient_connection_output ignores non-network failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transient-retry-"));
  const outputFile = path.join(tempDir, "output.log");
  fs.writeFileSync(outputFile, "Missing required environment variable: LINKEDIN_ACCESS_TOKEN\n");

  try {
    const result = runShell(
      `source "${retryLibPath}"; if is_transient_connection_output "${outputFile}"; then printf 'yes\\n'; else printf 'no\\n'; fi`,
    );
    assert.equal(result.trim(), "no");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

test("run_with_transient_retry retries once after a transient connection failure", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "transient-retry-"));
  const stateFile = path.join(tempDir, "attempt.txt");

  try {
    const output = runShell(
      `
        source "${retryLibPath}"
        run_once() {
          local count=0
          if [[ -f "${stateFile}" ]]; then
            count="$(cat "${stateFile}")"
          fi
          count=$((count + 1))
          printf '%s' "$count" > "${stateFile}"
          if (( count == 1 )); then
            echo "Could not resolve host: github.com" >&2
            return 1
          fi
          echo "ok"
        }
        run_with_transient_retry "test command" run_once
      `,
      {
        HUSHLINE_SOCIAL_TRANSIENT_RETRY_INTERVAL_SECONDS: "0",
        HUSHLINE_SOCIAL_TRANSIENT_RETRY_MAX_ATTEMPTS: "2",
      },
    );

    assert.match(output, /Retrying in 0 seconds/);
    assert.match(output, /ok/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), "2");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});
