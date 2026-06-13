const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const scriptPath = path.join(REPO_ROOT, "scripts", "publish-daily-linkedin.js");
const {
  isRetryableLinkedInRequestError,
  resolveLinkedInVersionCandidates,
  withLinkedInRequestRetry,
  withLinkedInVersionFallback,
} = require(scriptPath);

function runPublisher(args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("publisher skips weekend dates cleanly", () => {
  const output = runPublisher(["--date", "2026-03-21", "--dry-run"]);
  assert.match(output, /Skipping LinkedIn publication for weekend date 2026-03-21 \(saturday\)\./);
});

test("publisher allows explicit weekend overrides for verified-user archives", () => {
  const tempRootParent = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publish-"));
  const tempRoot = path.join(tempRootParent, "previous-verified-user-posts");
  const postDir = path.join(tempRoot, "2026-03-21");
  fs.mkdirSync(postDir, { recursive: true });

  fs.writeFileSync(
    path.join(postDir, "post.json"),
    JSON.stringify({
      slot: "verified-user-weekly",
      planned_date: "2026-03-21",
      image_alt_text: "A rendered verified-user social card.",
      social: {
        linkedin: "🤩 Verified Member Highlight!\n\nJordan is an investigative reporter.\n\nTo send Jordan a tip, go to https://tips.hushline.app/to/jordan.",
      },
    }),
  );
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");

  try {
    const output = runPublisher([
      "--date",
      "2026-03-21",
      "--date-root",
      tempRoot,
      "--allow-weekend",
      "--dry-run",
    ]);
    assert.match(output, /Dry run: LinkedIn publication prepared for 2026-03-21/);
    assert.match(output, /source: verified-user-archive/);
  } finally {
    fs.rmSync(tempRootParent, { force: true, recursive: true });
  }
});

test("publisher can dry-run from a dedicated article archive lane", () => {
  const tempRootParent = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publish-"));
  const tempRoot = path.join(tempRootParent, "previous-article-posts");
  const postDir = path.join(tempRoot, "2026-04-01");
  fs.mkdirSync(postDir, { recursive: true });

  fs.writeFileSync(
    path.join(postDir, "post.json"),
    JSON.stringify({
      slot: "wednesday",
      planned_date: "2026-04-01",
      publish_mode: "text",
      image_alt_text: "",
      social: {
        linkedin: "We just published an article about whether a personal server tip line is the right fit. Read it here 👉 https://hushline.app/library/blog/example",
      },
    }),
  );

  try {
    const output = runPublisher([
      "--date",
      "2026-04-01",
      "--date-root",
      tempRoot,
      "--dry-run",
    ]);
    assert.match(output, /Dry run: LinkedIn publication prepared for 2026-04-01/);
    assert.match(output, /source: article-archive/);
    assert.match(output, /publish mode: text/);
  } finally {
    fs.rmSync(tempRootParent, { force: true, recursive: true });
  }
});

test("publisher can dry-run from a local daily archive without a publication record", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publish-"));
  const postDir = path.join(tempRoot, "2026-03-20");
  fs.mkdirSync(postDir, { recursive: true });

  fs.writeFileSync(
    path.join(postDir, "post.json"),
    JSON.stringify({
      slot: "friday",
      planned_date: "2026-03-20",
      image_alt_text: "A rendered Hush Line social card.",
      social: {
        linkedin: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
      },
    }),
  );
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot, "--dry-run"]);
    assert.match(output, /Dry run: LinkedIn publication prepared for 2026-03-20/);
    assert.match(output, /source: daily-archive/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher can dry-run from a suffixed daily archive container for the same planned date", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publish-"));
  const postDir = path.join(tempRoot, "2026-03-20-1");
  fs.mkdirSync(postDir, { recursive: true });

  fs.writeFileSync(
    path.join(postDir, "post.json"),
    JSON.stringify({
      slot: "friday",
      planned_date: "2026-03-20",
      image_alt_text: "A rendered Hush Line social card.",
      social: {
        linkedin: "A second same-day post. Learn more at https://hushline.app/.",
      },
    }),
  );
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");

  try {
    const output = runPublisher([
      "--date",
      "2026-03-20",
      "--archive-key",
      "2026-03-20-1",
      "--date-root",
      tempRoot,
      "--dry-run",
    ]);
    assert.match(output, /Dry run: LinkedIn publication prepared for 2026-03-20/);
    assert.match(output, /container: 2026-03-20-1/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher reports when no archived daily post exists for the requested date", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "linkedin-publish-"));

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot]);
    assert.match(output, /No archived daily LinkedIn post content found for 2026-03-20\./);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher version selection falls back to the previous month when no explicit override is set", () => {
  assert.deepEqual(
    resolveLinkedInVersionCandidates("", new Date(2026, 3, 1)),
    ["202604", "202603"],
  );
});

test("publisher rejects explicit LinkedIn version overrides that are not YYYYMM", () => {
  assert.throws(
    () => resolveLinkedInVersionCandidates("20260401", new Date(2026, 3, 1)),
    /LINKEDIN_API_VERSION must use YYYYMM format\./,
  );
});

test("publisher retries the previous month when LinkedIn reports the current version is inactive", async () => {
  const attemptedVersions = [];
  const retriedVersions = [];

  const result = await withLinkedInVersionFallback({
    now: new Date(2026, 3, 1),
    onRetry: ({ currentVersion, nextVersion }) => {
      retriedVersions.push([currentVersion, nextVersion]);
    },
    requestedVersion: "",
    async run(version) {
      attemptedVersions.push(version);

      if (version === "202604") {
        throw new Error(
          'LinkedIn API POST https://api.linkedin.com/rest/images?action=initializeUpload failed with 426: {"status":426,"code":"NONEXISTENT_VERSION","message":"Requested version 20260401 is not active"}',
        );
      }

      return version;
    },
  });

  assert.equal(result, "202603");
  assert.deepEqual(attemptedVersions, ["202604", "202603"]);
  assert.deepEqual(retriedVersions, [["202604", "202603"]]);
});

test("publisher marks transient DNS failures as retryable", () => {
  assert.equal(
    isRetryableLinkedInRequestError(new Error("LinkedIn API POST https://api.linkedin.com/rest/images request failed: getaddrinfo ENOTFOUND api.linkedin.com")),
    true,
  );
  assert.equal(
    isRetryableLinkedInRequestError(new Error("LinkedIn API POST https://api.linkedin.com/rest/posts failed with 401: unauthorized")),
    false,
  );
});

test("publisher retries transient request failures before succeeding", async () => {
  const attempts = [];
  const retries = [];

  const result = await withLinkedInRequestRetry({
    attempts: 3,
    baseDelayMs: 1,
    onRetry({ attempt, nextAttempt }) {
      retries.push([attempt, nextAttempt]);
    },
    async run() {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) {
        throw new Error("LinkedIn API POST https://api.linkedin.com/rest/images request failed: getaddrinfo ENOTFOUND api.linkedin.com");
      }

      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(retries, [[1, 2], [2, 3]]);
});
