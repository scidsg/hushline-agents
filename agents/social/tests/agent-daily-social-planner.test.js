const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const plannerScriptPath = path.join(REPO_ROOT, "scripts", "agent_daily_social_planner.sh");
const plannerWrapperPath = path.join(REPO_ROOT, "scripts", "run_daily_planner_launchd.sh");
const updateRunReposLibPath = path.join(REPO_ROOT, "scripts", "lib", "update-run-repos.sh");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

test("daily planner auto-syncs before rejecting a stale local screenshots manifest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-sync-"));
  const screenshotsRoot = path.join(tempRoot, "hushline-screenshots");
  const latestRoot = path.join(screenshotsRoot, "releases", "latest");
  const upstreamLatestRoot = path.join(tempRoot, "upstream", "releases", "latest");
  const freshCapturedAt = new Date().toISOString();

  fs.mkdirSync(path.join(screenshotsRoot, ".git"), { recursive: true });
  fs.mkdirSync(latestRoot, { recursive: true });
  fs.mkdirSync(path.join(upstreamLatestRoot, "guest"), { recursive: true });

  fs.writeFileSync(
    path.join(latestRoot, "manifest.json"),
    `${JSON.stringify({ capturedAt: "2000-01-01T00:00:00.000Z", release: "old", scenes: [] })}\n`,
  );
  fs.writeFileSync(
    path.join(upstreamLatestRoot, "manifest.json"),
    `${JSON.stringify({
      capturedAt: freshCapturedAt,
      release: "fresh",
      scenes: [{ files: [{ file: "guest/fresh-fold.png", mode: "fold" }] }],
    })}\n`,
  );
  fs.writeFileSync(path.join(upstreamLatestRoot, "guest", "fresh-fold.png"), "png");

  const testScript = [
    "set -euo pipefail",
    `export HUSHLINE_SCREENSHOTS_REPO_DIR=${shellQuote(screenshotsRoot)}`,
    `export HUSHLINE_CURRENT_SCREENSHOTS_DIR=${shellQuote(path.join(tempRoot, "missing-current"))}`,
    "export HUSHLINE_SCREENSHOT_MAX_AGE_DAYS=21",
    "export HUSHLINE_SCREENSHOT_AUTO_SYNC=1",
    "export HUSHLINE_ALLOW_STALE_SCREENSHOTS=0",
    `export HUSHLINE_SCREENSHOTS_BASE_URL=${shellQuote(`file://${upstreamLatestRoot}`)}`,
    `source ${shellQuote(plannerScriptPath)}`,
    "remote_manifest_status() {",
    "  local manifest_path=\"$1\"",
    "  local release=\"\"",
    "  release=\"$(node -e 'const fs=require(\"fs\"); const m=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\")); process.stdout.write(String(m.release || \"\"));' \"$manifest_path\")\"",
    "  if [[ \"$release\" == \"fresh\" ]]; then",
    "    printf '%s\\n' match",
    "  else",
    "    printf '%s\\n' mismatch",
    "  fi",
    "}",
    "verify_screenshot_source",
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    assert.match(output, /Local latest screenshots manifest is stale\. Syncing upstream latest snapshot\./);
    assert.match(output, /Local latest screenshots folder synced to upstream\./);
    const manifest = JSON.parse(fs.readFileSync(path.join(latestRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.release, "fresh");
    assert.equal(fs.readFileSync(path.join(latestRoot, "guest", "fresh-fold.png"), "utf8"), "png");
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily planner accepts fresh current screenshots before checking release manifest", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-current-"));
  const screenshotsRoot = path.join(tempRoot, "hushline-screenshots");
  const currentRoot = path.join(tempRoot, "current-screenshots");

  fs.mkdirSync(path.join(screenshotsRoot, ".git"), { recursive: true });
  fs.mkdirSync(path.join(currentRoot, "guest"), { recursive: true });
  fs.writeFileSync(
    path.join(currentRoot, "guest", "guest-directory-verified-desktop-light-fold.png"),
    "png",
  );

  const testScript = [
    "set -euo pipefail",
    `export HUSHLINE_SCREENSHOTS_REPO_DIR=${shellQuote(screenshotsRoot)}`,
    `export HUSHLINE_CURRENT_SCREENSHOTS_DIR=${shellQuote(currentRoot)}`,
    "export HUSHLINE_SCREENSHOT_MAX_AGE_DAYS=21",
    "export HUSHLINE_ALLOW_STALE_SCREENSHOTS=0",
    `source ${shellQuote(plannerScriptPath)}`,
    "verify_screenshot_source",
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    assert.match(output, /Current screenshots folder:/);
    assert.match(output, /fold_screenshots=1/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily repo update returns failure when either checkout update fails", () => {
  const testScript = [
    "set +e",
    `source ${shellQuote(updateRunReposLibPath)}`,
    "resolve_screenshots_repo_dir() { printf '%s\\n' /tmp/hushline-screenshots; }",
    "update_git_checkout() {",
    "  printf '%s\\n' \"$2\"",
    "  if [[ \"$2\" == \"hushline-social\" ]]; then",
    "    return 1",
    "  fi",
    "  return 0",
    "}",
    "update_daily_planning_repos /tmp/hushline-social 1 1",
    "printf 'rc:%s\\n' \"$?\"",
    "",
  ].join("\n");

  const output = execFileSync("bash", ["-c", testScript], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  assert.match(output, /hushline-social/);
  assert.match(output, /hushline-screenshots/);
  assert.match(output, /rc:1/);
});

test("daily planner wrapper stops when repo update fails under transient retry", () => {
  const wrapper = fs.readFileSync(plannerWrapperPath, "utf8");
  assert.match(wrapper, /update_repo \|\| return \$\?/);
});

test("daily planner treats content format validation failures as retryable", () => {
  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    "LAST_VALIDATION_OUTPUT='Error: Model returned content_format workflow_teardown, expected feature_benefit.'",
    "is_retryable_validation_failure",
    "LAST_VALIDATION_OUTPUT='Error: Unknown content format: missing.'",
    "is_retryable_validation_failure",
    "LAST_VALIDATION_OUTPUT='Error: Content format feature_benefit already reached the weekly cap for 2026-W12.'",
    "is_retryable_validation_failure",
    "",
  ].join("\n");

  assert.doesNotThrow(() => execFileSync("bash", ["-c", testScript], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));
});

test("daily planner treats hook and CTA cooldown validation failures as rewriteable", () => {
  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    "LAST_VALIDATION_OUTPUT='Error: Post opening hook for 2026-05-29 repeats 2026-05-28 within the 5-post hook cooldown.'",
    "is_retryable_validation_failure",
    "is_message_overlap_validation_failure",
    "LAST_VALIDATION_OUTPUT='Error: Post CTA pattern for 2026-05-29 repeats 2026-05-28 within the 1-post CTA cooldown.'",
    "is_retryable_validation_failure",
    "is_message_overlap_validation_failure",
    "",
  ].join("\n");

  assert.doesNotThrow(() => execFileSync("bash", ["-c", testScript], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));
});

test("daily planner rewrites archive-overlap failures before excluding the only screenshot", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-overlap-rewrite-"));
  const archiveKey = "2026-05-25";
  const archiveRoot = path.join(tempRoot, "previous-posts", archiveKey);

  fs.mkdirSync(archiveRoot, { recursive: true });

  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    `REPO_DIR=${shellQuote(tempRoot)}`,
    "DATE=2026-05-25",
    `ARCHIVE_KEY=${shellQuote(archiveKey)}`,
    "build_context() {",
    "  mkdir -p \"$REPO_DIR/previous-posts/$ARCHIVE_KEY\"",
    "  printf 'Base prompt\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/prompt.txt\"",
    "  printf '{\"candidate_screenshots\":[{\"file\":\"one.png\"}]}\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/context.json\"",
    "}",
    "run_codex_from_prompt() {",
    "  codex_count=$((codex_count + 1))",
    "  printf '{\"post\":{\"screenshot_file\":\"one.png\"}}\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/plan.json\"",
    "}",
    "validate_and_render() {",
    "  validate_count=$((validate_count + 1))",
    "  if (( validate_count == 1 )); then",
    "    LAST_VALIDATION_OUTPUT='Error: Post messaging for 2026-05-25 overlaps too heavily with recent archive 2026-04-21.'",
    "    return 1",
    "  fi",
    "  return 0",
    "}",
    "codex_count=0",
    "validate_count=0",
    "run_with_validation_retries",
    "printf 'codex:%s validate:%s excluded:%s\\n' \"$codex_count\" \"$validate_count\" \"${#EXCLUDED_SCREENSHOTS[@]}\"",
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    assert.match(output, /Archive-overlap validation requested a rewrite/);
    assert.match(output, /codex:2 validate:2 excluded:0/);
    assert.doesNotMatch(output, /Retrying daily planner with excluded screenshot/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily planner caps archive-overlap rewrites when Codex switches screenshots", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-overlap-cap-"));
  const archiveKey = "2026-05-25";

  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    `REPO_DIR=${shellQuote(tempRoot)}`,
    "DATE=2026-05-25",
    `ARCHIVE_KEY=${shellQuote(archiveKey)}`,
    "build_context() {",
    "  mkdir -p \"$REPO_DIR/previous-posts/$ARCHIVE_KEY\"",
    "  printf 'Base prompt\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/prompt.txt\"",
    "  printf '{\"candidate_screenshots\":[{\"file\":\"one.png\"},{\"file\":\"two.png\"}]}\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/context.json\"",
    "}",
    "run_codex_from_prompt() {",
    "  codex_count=$((codex_count + 1))",
    "  local screenshot='one.png'",
    "  if (( codex_count == 2 )); then",
    "    screenshot='two.png'",
    "  fi",
    "  printf '{\"post\":{\"screenshot_file\":\"%s\"}}\\n' \"$screenshot\" > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/plan.json\"",
    "}",
    "validate_and_render() {",
    "  validate_count=$((validate_count + 1))",
    "  if (( validate_count <= 2 )); then",
    "    LAST_VALIDATION_OUTPUT='Error: Post messaging for 2026-05-25 overlaps too heavily with recent archive 2026-04-21.'",
    "    return 1",
    "  fi",
    "  return 0",
    "}",
    "codex_count=0",
    "validate_count=0",
    "run_with_validation_retries",
    "printf 'codex:%s validate:%s excluded:%s first_excluded:%s\\n' \"$codex_count\" \"$validate_count\" \"${#EXCLUDED_SCREENSHOTS[@]}\" \"${EXCLUDED_SCREENSHOTS[0]:-}\"",
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    assert.match(output, /Archive-overlap validation requested a rewrite/);
    assert.match(output, /Retrying daily planner with excluded screenshot: two\.png/);
    assert.match(output, /codex:3 validate:3 excluded:1 first_excluded:two\.png/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily planner reports no alternate screenshot instead of rebuilding an empty context", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-no-alternate-"));
  const archiveKey = "2026-05-25";

  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    "set +e",
    `REPO_DIR=${shellQuote(tempRoot)}`,
    "DATE=2026-05-25",
    `ARCHIVE_KEY=${shellQuote(archiveKey)}`,
    "build_context() {",
    "  mkdir -p \"$REPO_DIR/previous-posts/$ARCHIVE_KEY\"",
    "  printf 'Base prompt\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/prompt.txt\"",
    "  printf '{\"candidate_screenshots\":[{\"file\":\"one.png\"}]}\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/context.json\"",
    "}",
    "run_codex_from_prompt() {",
    "  printf '{\"post\":{\"screenshot_file\":\"one.png\"}}\\n' > \"$REPO_DIR/previous-posts/$ARCHIVE_KEY/plan.json\"",
    "}",
    "validate_and_render() {",
    "  LAST_VALIDATION_OUTPUT='Error: Post messaging for 2026-05-25 overlaps too heavily with recent archive 2026-04-21.'",
    "  return 1",
    "}",
    "run_with_validation_retries",
    "printf 'rc:%s excluded:%s\\n' \"$?\" \"${#EXCLUDED_SCREENSHOTS[@]}\"",
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.match(output, /rc:1 excluded:0/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily planner recognizes editorial critic failures for rewrite handling", () => {
  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(plannerScriptPath)}`,
    "LAST_VALIDATION_OUTPUT='Error: Editorial critic score 8/16 is below threshold 12.'",
    "is_critic_validation_failure",
    "if is_retryable_validation_failure; then exit 1; fi",
    "",
  ].join("\n");

  assert.doesNotThrow(() => execFileSync("bash", ["-c", testScript], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }));
});
