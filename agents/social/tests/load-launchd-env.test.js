const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function runShell(script, env = {}) {
  return execFileSync(
    "bash",
    ["-lc", script],
    {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
}

test("load-launchd-env uses repo-local env file when no override is set", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-env-"));
  const repoDir = path.join(tempRoot, "repo");
  const scriptsLibDir = path.join(repoDir, "scripts", "lib");
  fs.mkdirSync(scriptsLibDir, { recursive: true });
  fs.copyFileSync(
    path.join(path.resolve(__dirname, ".."), "scripts", "lib", "load-launchd-env.sh"),
    path.join(scriptsLibDir, "load-launchd-env.sh"),
  );
  fs.writeFileSync(
    path.join(repoDir, ".env.launchd"),
    "LINKEDIN_ACCESS_TOKEN=repo-token\nLINKEDIN_AUTHOR_URN=urn:li:person:test\n",
  );

  try {
    const output = runShell(
      [
        `source "${path.join(repoDir, "scripts", "lib", "load-launchd-env.sh")}"`,
        `load_launchd_env_file "${repoDir}"`,
        'printf "ENV_FILE=%s\\n" "$HUSHLINE_SOCIAL_ENV_FILE"',
        'printf "TOKEN=%s\\n" "$LINKEDIN_ACCESS_TOKEN"',
        'printf "AUTHOR=%s\\n" "$LINKEDIN_AUTHOR_URN"',
      ].join("\n"),
    );

    assert.match(output, new RegExp(`ENV_FILE=${repoDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.env\\.launchd`));
    assert.match(output, /TOKEN=repo-token/);
    assert.match(output, /AUTHOR=urn:li:person:test/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("load-launchd-env fails when explicit override path is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-env-"));
  const repoDir = path.join(tempRoot, "repo");
  const scriptsLibDir = path.join(repoDir, "scripts", "lib");
  fs.mkdirSync(scriptsLibDir, { recursive: true });
  fs.copyFileSync(
    path.join(path.resolve(__dirname, ".."), "scripts", "lib", "load-launchd-env.sh"),
    path.join(scriptsLibDir, "load-launchd-env.sh"),
  );
  fs.writeFileSync(
    path.join(repoDir, ".env.launchd"),
    "LINKEDIN_ACCESS_TOKEN=repo-token\nLINKEDIN_AUTHOR_URN=urn:li:person:test\n",
  );

  try {
    assert.throws(
      () => runShell(
        [
          "set -e",
          `source "${path.join(repoDir, "scripts", "lib", "load-launchd-env.sh")}"`,
          `load_launchd_env_file "${repoDir}"`,
        ].join("\n"),
        { HUSHLINE_SOCIAL_ENV_FILE: path.join(tempRoot, "missing.env") },
      ),
      /HUSHLINE_SOCIAL_ENV_FILE points to a missing file/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
