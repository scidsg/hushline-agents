const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const scriptPath = path.join(REPO_ROOT, "scripts", "publish-daily-bluesky.js");
const {
  isRetryableBlueskyRequestError,
  normalizeServiceUrl,
  parseUrlFacets,
  withBlueskyRequestRetry,
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
  assert.match(output, /Skipping Bluesky publication for weekend date 2026-03-21 \(saturday\)\./);
});

test("publisher can dry-run from a local daily archive", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bluesky-publish-"));
  const postDir = writeArchivedPost(tempRoot, "2026-03-20", {
    slot: "friday",
    planned_date: "2026-03-20",
    image_alt_text: "A rendered Hush Line social card.",
    social: {
      bluesky: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
    },
  });
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot, "--dry-run"]);
    assert.match(output, /Dry run: Bluesky publication prepared for 2026-03-20/);
    assert.match(output, /source: daily-archive/);
    assert.match(output, /status length: 91/);
    assert.match(output, /facets: 1/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher can dry-run text-only article archives", () => {
  const tempRootParent = fs.mkdtempSync(path.join(os.tmpdir(), "bluesky-publish-"));
  const tempRoot = path.join(tempRootParent, "previous-article-posts");
  writeArchivedPost(tempRoot, "2026-04-01", {
    slot: "wednesday",
    planned_date: "2026-04-01",
    publish_mode: "text",
    image_alt_text: "",
    social: {
      bluesky: "A whistleblower-related article worth reading.\nhttps://example.org/news\n\nSign up for Hush Line: https://hushline.app.",
    },
  });

  try {
    const output = runPublisher(["--date", "2026-04-01", "--date-root", tempRoot, "--dry-run"]);
    assert.match(output, /source: article-archive/);
    assert.match(output, /publish mode: text/);
    assert.doesNotMatch(output, /image:/);
    assert.match(output, /facets: 2/);
  } finally {
    fs.rmSync(tempRootParent, { force: true, recursive: true });
  }
});

test("publisher reports when no archived Bluesky post exists", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bluesky-publish-"));

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot]);
    assert.match(output, /No archived daily Bluesky post content found for 2026-03-20\./);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publisher skips local Bluesky publication records", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bluesky-publish-"));
  const postDir = writeArchivedPost(tempRoot, "2026-03-20", {
    slot: "friday",
    planned_date: "2026-03-20",
    image_alt_text: "A rendered Hush Line social card.",
    social: {
      bluesky: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
    },
  });
  fs.writeFileSync(path.join(postDir, "social-card@2x.png"), "png");
  fs.writeFileSync(path.join(postDir, "bluesky-publication.json"), JSON.stringify({ platform: "bluesky" }));

  try {
    const output = runPublisher(["--date", "2026-03-20", "--date-root", tempRoot]);
    assert.match(output, /already has a local Bluesky publication record; skipping publish\./);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("normalizes Bluesky service URLs to https origins", () => {
  assert.equal(normalizeServiceUrl("https://bsky.social/xrpc"), "https://bsky.social");
  assert.throws(() => normalizeServiceUrl("http://bsky.social"), /must use https/);
});

test("parses Bluesky URL facets with UTF-8 byte offsets", () => {
  const text = "Signal boost: https://hushline.app/ ✅";
  const facets = parseUrlFacets(text);

  assert.equal(facets.length, 1);
  assert.deepEqual(facets[0].features, [
    {
      $type: "app.bsky.richtext.facet#link",
      uri: "https://hushline.app/",
    },
  ]);
  assert.deepEqual(facets[0].index, {
    byteEnd: Buffer.byteLength("Signal boost: https://hushline.app/", "utf8"),
    byteStart: Buffer.byteLength("Signal boost: ", "utf8"),
  });
});

test("publisher marks transient Bluesky failures as retryable", () => {
  assert.equal(
    isRetryableBlueskyRequestError(new Error("Bluesky API POST https://bsky.social/xrpc/com.atproto.repo.createRecord request failed: getaddrinfo ENOTFOUND bsky.social")),
    true,
  );
  assert.equal(
    isRetryableBlueskyRequestError(new Error("Bluesky API POST https://bsky.social/xrpc/com.atproto.repo.createRecord failed with HTTP 401: unauthorized")),
    false,
  );
  assert.equal(
    isRetryableBlueskyRequestError(new Error("Bluesky API POST https://bsky.social/xrpc/com.atproto.repo.createRecord failed with HTTP 503: unavailable")),
    true,
  );
});

test("publisher retries transient Bluesky request failures before succeeding", async () => {
  const attempts = [];
  const retries = [];

  const result = await withBlueskyRequestRetry({
    attempts: 3,
    baseDelayMs: 1,
    onRetry({ attempt, nextAttempt }) {
      retries.push([attempt, nextAttempt]);
    },
    async run() {
      attempts.push(attempts.length + 1);
      if (attempts.length < 3) {
        throw new Error("Bluesky API POST https://bsky.social/xrpc/com.atproto.repo.createRecord request failed: getaddrinfo ENOTFOUND bsky.social");
      }

      return "ok";
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(retries, [[1, 2], [2, 3]]);
});
