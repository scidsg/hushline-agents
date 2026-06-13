const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const scriptPath = path.join(REPO_ROOT, "scripts", "publish-daily-mastodon.js");
const {
  isRetryableMastodonRequestError,
  normalizeInstanceUrl,
  withMastodonRequestRetry,
} = require(scriptPath);

function runPublisher(args) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function writeArchivedPost(root, archiveKey, post) {
  const postDir = path.join(root, archiveKey);
  fs.mkdirSync(postDir, { recursive: true });
  fs.writeFileSync(path.join(postDir, "post.json"), JSON.stringify(post));
  return postDir;
}

test("publisher skips weekend dates cleanly", () => {
  const output = runPublisher(["--date", "2026-03-21", "--dry-run"]);
  assert.match(output, /Skipping Mastodon publication for weekend date 2026-03-21 \(saturday\)\./);
});

test("publisher can dry-run from a local daily archive", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mastodon-publish-"));
  const postDir = writeArchivedPost(tempRoot, "2026-03-20", {
    slot: "friday",
    planned_date: "2026-03-20",
    image_alt_text: "A rendered Hush Line social card.",
    social: {
      mastodon: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
    },
  });
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot, "--dry-run"]);
    assert.match(output, /Dry run: Mastodon publication prepared for 2026-03-20/);
    assert.match(output, /source: daily-archive/);
    assert.match(output, /visibility: public/);
    assert.match(output, /status length: 91/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher can dry-run text-only article archives", () => {
  const tempRootParent = fs.mkdtempSync(path.join(os.tmpdir(), "mastodon-publish-"));
  const tempRoot = path.join(tempRootParent, "previous-article-posts");
  writeArchivedPost(tempRoot, "2026-04-01", {
    slot: "wednesday",
    planned_date: "2026-04-01",
    publish_mode: "text",
    image_alt_text: "",
    social: {
      mastodon: "A whistleblower-related article worth reading.\nhttps://example.org/news\n\nSign up for Hush Line: https://hushline.app.",
    },
  });

  try {
    const output = runPublisher([
      "--date",
      "2026-04-01",
      "--date-root",
      tempRoot,
      "--visibility",
      "unlisted",
      "--dry-run",
    ]);
    assert.match(output, /source: article-archive/);
    assert.match(output, /publish mode: text/);
    assert.match(output, /visibility: unlisted/);
    assert.doesNotMatch(output, /image:/);
  } finally {
    fs.rmSync(tempRootParent, { force: true, recursive: true });
  }
});

test("publisher reports when no archived Mastodon post exists", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mastodon-publish-"));

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot]);
    assert.match(output, /No archived daily Mastodon post content found for 2026-03-20\./);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher skips local Mastodon publication records", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mastodon-publish-"));
  const postDir = writeArchivedPost(tempRoot, "2026-03-20", {
    slot: "friday",
    planned_date: "2026-03-20",
    image_alt_text: "A rendered Hush Line social card.",
    social: {
      mastodon: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
    },
  });
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");
  fs.writeFileSync(path.join(postDir, "mastodon-publication.json"), JSON.stringify({ platform: "mastodon" }));

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot]);
    assert.match(output, /already has a local Mastodon publication record; skipping publish\./);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("normalizes Mastodon instance URLs to https origins", () => {
  assert.equal(normalizeInstanceUrl("https://mastodon.social/@hushline"), "https://mastodon.social");
  assert.throws(() => normalizeInstanceUrl("http://mastodon.social"), /must use https/);
});

test("publisher marks transient Mastodon failures as retryable", () => {
  assert.equal(
    isRetryableMastodonRequestError(new Error("Mastodon API POST https://example.org/api/v1/statuses request failed: getaddrinfo ENOTFOUND example.org")),
    true,
  );
  assert.equal(
    isRetryableMastodonRequestError(new Error("Mastodon API POST https://example.org/api/v1/statuses failed with HTTP 401: unauthorized")),
    false,
  );
  assert.equal(
    isRetryableMastodonRequestError(new Error("Mastodon API POST https://example.org/api/v1/statuses failed with HTTP 503: unavailable")),
    true,
  );
});

test("publisher retries transient Mastodon request failures before succeeding", async () => {
  const attempts = [];
  const retries = [];

  const result = await withMastodonRequestRetry({
    attempts: 3,
    baseDelayMs: 1,
    onRetry({ attempt, nextAttempt }) {
      retries.push([attempt, nextAttempt]);
    },
    async run() {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) {
        throw new Error("Mastodon API POST https://example.org/api/v1/statuses request failed: getaddrinfo ENOTFOUND example.org");
      }

      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(retries, [[1, 2], [2, 3]]);
});
