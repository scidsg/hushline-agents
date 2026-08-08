const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const plannerScriptPath = path.join(REPO_ROOT, "scripts", "agent_daily_social_planner.sh");
const linkedinPublisherScriptPath = path.join(REPO_ROOT, "scripts", "agent_daily_linkedin_publisher.sh");
const linkedinWrapperPath = path.join(REPO_ROOT, "scripts", "run_daily_linkedin_launchd.sh");
const plannerWrapperPath = path.join(REPO_ROOT, "scripts", "run_daily_planner_launchd.sh");
const pushArchiveScriptPath = path.join(REPO_ROOT, "scripts", "push_previous_posts_archive.sh");
const socialRepoRunLockLibPath = path.join(
  REPO_ROOT,
  "scripts",
  "lib",
  "social-repo-run-lock.sh",
);
const updateRunReposLibPath = path.join(REPO_ROOT, "scripts", "lib", "update-run-repos.sh");

test("daily planner forwards the weekend override to the Node planner", () => {
  const planner = fs.readFileSync(plannerScriptPath, "utf8");
  const buildContext = planner.slice(
    planner.indexOf("build_context() {"),
    planner.indexOf("\n}\n", planner.indexOf("build_context() {")),
  );

  assert.match(buildContext, /ALLOW_WEEKEND == 1/);
  assert.match(buildContext, /cmd\+=\(--allow-weekend\)/);
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function execFilePromise(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stderr, stdout });
    });
  });
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

test("shared social repository lock serializes independent runner processes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-repo-run-lock-"));
  const socialRepo = path.join(tempRoot, "hushline-social");
  const criticalDir = path.join(tempRoot, "critical");
  const orderPath = path.join(tempRoot, "order.txt");
  const overlapPath = path.join(tempRoot, "overlap.txt");

  fs.mkdirSync(path.join(socialRepo, ".tmp"), { recursive: true });

  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(socialRepoRunLockLibPath)}`,
    "run_critical_section() {",
    `  if ! mkdir ${shellQuote(criticalDir)} 2>/dev/null; then`,
    `    printf 'overlap\\n' >> ${shellQuote(overlapPath)}`,
    "    return 1",
    "  fi",
    `  printf '%s\\n' \"$$\" >> ${shellQuote(orderPath)}`,
    "  sleep 1",
    `  rmdir ${shellQuote(criticalDir)}`,
    "}",
    `with_social_repo_run_lock ${shellQuote(socialRepo)} test-run run_critical_section`,
    "",
  ].join("\n");

  try {
    const runs = await Promise.all([
      execFilePromise("bash", ["-c", testScript], { cwd: REPO_ROOT, encoding: "utf8" }),
      execFilePromise("bash", ["-c", testScript], { cwd: REPO_ROOT, encoding: "utf8" }),
    ]);

    assert.equal(fs.existsSync(overlapPath), false);
    assert.equal(fs.readFileSync(orderPath, "utf8").trim().split("\n").length, 2);
    assert.equal(runs.some(({ stdout }) => stdout.includes("Waiting for the shared")), true);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily repo update preserves unarchived publication records", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-planner-publication-guard-"));
  const socialRepo = path.join(tempRoot, "hushline-social");
  const publicationPath = path.join(
    socialRepo,
    "previous-posts",
    "2026-07-23",
    "linkedin-publication.json",
  );

  try {
    fs.mkdirSync(path.dirname(publicationPath), { recursive: true });
    execFileSync("git", ["init", "-b", "main", socialRepo]);
    execFileSync("git", ["-C", socialRepo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", socialRepo, "config", "user.name", "Test Runner"]);
    fs.writeFileSync(path.join(socialRepo, "README.md"), "archive\n");
    execFileSync("git", ["-C", socialRepo, "add", "README.md"]);
    execFileSync("git", [
      "-c",
      "commit.gpgsign=false",
      "-C",
      socialRepo,
      "commit",
      "-m",
      "Initial archive",
    ]);
    fs.writeFileSync(publicationPath, "{\"platform\":\"linkedin\"}\n");

    const testScript = [
      "set +e",
      `source ${shellQuote(updateRunReposLibPath)}`,
      `update_git_checkout ${shellQuote(socialRepo)} hushline-social 1 1`,
      "printf 'rc:%s\\n' \"$?\"",
      "",
    ].join("\n");
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    assert.match(output, /rc:1/);
    assert.equal(fs.existsSync(publicationPath), true);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("archive push helper targets the configured social archive checkout", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-archive-push-root-"));
  const socialRepo = path.join(tempRoot, "hushline-social");
  const archiveDir = path.join(socialRepo, "previous-posts", "2026-07-23");

  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main", socialRepo]);
    execFileSync("git", ["-C", socialRepo, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", socialRepo, "config", "user.name", "Test Runner"]);
    execFileSync("git", [
      "-C",
      socialRepo,
      "remote",
      "add",
      "origin",
      "https://github.com/scidsg/hushline-social.git",
    ]);
    fs.writeFileSync(path.join(archiveDir, "post.json"), "{\"date\":\"2026-07-23\"}\n");

    const output = execFileSync(
      pushArchiveScriptPath,
      ["--date", "2026-07-23", "--dry-run"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HUSHLINE_SOCIAL_REPO_DIR: socialRepo,
        },
      },
    );

    assert.match(output, /would commit previous-posts\/2026-07-23/);
    assert.doesNotMatch(output, /Archive folder not found/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily planner wrapper stops when repo update fails under transient retry", () => {
  const wrapper = fs.readFileSync(plannerWrapperPath, "utf8");
  assert.match(wrapper, /update_repo \|\| return \$\?/);
});

test("daily LinkedIn publisher plans a missing daily archive before publishing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publisher-"));
  const socialRepo = path.join(tempRoot, "hushline-social");
  const agentsRepo = path.join(tempRoot, "hushline-agents");
  const plannerStub = path.join(agentsRepo, "agents", "social", "scripts", "agent_daily_social_planner.sh");
  const postPath = path.join(socialRepo, "previous-posts", "2026-06-17", "post.json");

  fs.mkdirSync(path.dirname(plannerStub), { recursive: true });
  fs.mkdirSync(socialRepo, { recursive: true });
  fs.writeFileSync(
    plannerStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "date_arg=''",
      "archive_key=''",
      "while [[ $# -gt 0 ]]; do",
      "  case \"$1\" in",
      "    --date) date_arg=\"$2\"; shift 2 ;;",
      "    --archive-key) archive_key=\"$2\"; shift 2 ;;",
      "    --no-push) shift ;;",
      "    *) shift ;;",
      "  esac",
      "done",
      "archive_key=\"${archive_key:-$date_arg}\"",
      "mkdir -p \"$HUSHLINE_SOCIAL_REPO_DIR/previous-posts/$archive_key\"",
      "printf '{\"slot\":\"wednesday\",\"planned_date\":\"%s\",\"social\":{\"linkedin\":\"planned\"}}\\n' \"$date_arg\" > \"$HUSHLINE_SOCIAL_REPO_DIR/previous-posts/$archive_key/post.json\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const testScript = [
    "set -euo pipefail",
    `source ${shellQuote(linkedinPublisherScriptPath)}`,
    `AGENTS_REPO_DIR=${shellQuote(agentsRepo)}`,
    `REPO_DIR=${shellQuote(socialRepo)}`,
    "export HUSHLINE_SOCIAL_REPO_DIR=\"$REPO_DIR\"",
    "DATE_OVERRIDE=2026-06-17",
    "ARCHIVE_KEY=2026-06-17",
    "DATE_ROOT=previous-posts",
    "DRY_RUN=0",
    "ALLOW_WEEKEND=0",
    "ensure_daily_archive_ready",
    `test -f ${shellQuote(postPath)}`,
    "",
  ].join("\n");

  try {
    const output = execFileSync("bash", ["-c", testScript], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    assert.match(output, /Daily archive missing before LinkedIn publish; planning it now:/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("daily LinkedIn wrapper proceeds when the archive is still missing", () => {
  const wrapper = fs.readFileSync(linkedinWrapperPath, "utf8");
  assert.match(wrapper, /Proceeding to the daily LinkedIn publisher so it can plan the missing archive\./);
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
