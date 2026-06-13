#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  REPO_ROOT,
  archiveKeyDate,
  getWeekdayLabel,
  isValidArchiveKey,
  isWeekendDate,
  readJson,
  writeJson,
} = require("./lib/social-common");

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {
    allowWeekend: false,
    archiveKey: null,
    date: todayString(),
    dateRoot: path.join(REPO_ROOT, "previous-posts"),
    dryRun: false,
    force: false,
    visibility: process.env.MASTODON_VISIBILITY || "public",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--date") {
      args.date = argv[index + 1];
      index += 1;
    } else if (value === "--archive-key") {
      args.archiveKey = argv[index + 1];
      index += 1;
    } else if (value === "--date-root") {
      args.dateRoot = path.resolve(REPO_ROOT, argv[index + 1]);
      index += 1;
    } else if (value === "--visibility") {
      args.visibility = argv[index + 1];
      index += 1;
    } else if (value === "--allow-weekend") {
      args.allowWeekend = true;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error("`--date` must use YYYY-MM-DD format.");
  }

  args.archiveKey = args.archiveKey || args.date;

  if (!isValidArchiveKey(args.archiveKey)) {
    throw new Error("`--archive-key` must use YYYY-MM-DD or YYYY-MM-DD-N format.");
  }

  if (archiveKeyDate(args.archiveKey) !== args.date) {
    throw new Error("`--archive-key` must start with the requested `--date`.");
  }

  if (!["public", "unlisted", "private", "direct"].includes(args.visibility)) {
    throw new Error("`--visibility` must be one of: public, unlisted, private, direct.");
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/publish-daily-mastodon.js",
      "  node scripts/publish-daily-mastodon.js --date 2026-03-18",
      "  node scripts/publish-daily-mastodon.js --date 2026-03-18 --archive-key 2026-03-18-1",
      "  node scripts/publish-daily-mastodon.js --date 2026-03-30 --date-root previous-verified-user-posts --allow-weekend",
      "  node scripts/publish-daily-mastodon.js --dry-run",
      "",
      "Behavior:",
      "  - Publishes from previous-posts/YYYY-MM-DD by default",
      "  - Can also publish article and verified-user archives via --date-root",
      "",
      "Environment:",
      "  MASTODON_INSTANCE_URL    Instance origin, for example https://mastodon.social",
      "  MASTODON_ACCESS_TOKEN    OAuth user token with write:statuses and write:media scopes",
      "  MASTODON_VISIBILITY      Optional, defaults to public",
      "",
    ].join("\n"),
  );
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeInstanceUrl(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    throw new Error("MASTODON_INSTANCE_URL is required.");
  }

  const url = new URL(rawValue);
  if (url.protocol !== "https:") {
    throw new Error("MASTODON_INSTANCE_URL must use https.");
  }

  return url.origin;
}

function getDailyPostDir(args) {
  return path.join(args.dateRoot, args.archiveKey);
}

function getRepoArchiveRootName(args) {
  const resolvedDateRoot = path.resolve(args.dateRoot);
  const relativeRoot = path.relative(REPO_ROOT, resolvedDateRoot);
  if (relativeRoot && !relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot)) {
    return relativeRoot;
  }

  return null;
}

function archiveKindLabel(args) {
  const archiveRootName = path.basename(args.dateRoot);
  if (archiveRootName === "previous-verified-user-posts") {
    return "Verified-user archive";
  }
  if (archiveRootName === "previous-article-posts") {
    return "Article-share archive";
  }
  return "Daily archive";
}

function publicationRecordPath(args) {
  return path.join(getDailyPostDir(args), "mastodon-publication.json");
}

function localPublicationRecordExists(args) {
  return fs.existsSync(publicationRecordPath(args));
}

function remotePublicationRecordExists(args) {
  const archiveRootName = getRepoArchiveRootName(args);

  if (!archiveRootName) {
    return { published: false };
  }

  const remote = process.env.HUSHLINE_SOCIAL_ARCHIVE_REMOTE || "origin";
  const branch = process.env.HUSHLINE_SOCIAL_ARCHIVE_BRANCH || "main";
  const recordPath = `${archiveRootName}/${args.archiveKey}/mastodon-publication.json`;
  const remoteRef = `refs/remotes/${remote}/${branch}`;

  try {
    execFileSync("git", ["fetch", "--quiet", remote, `${branch}:${remoteRef}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    execFileSync("git", ["cat-file", "-e", `${remote}/${branch}:${recordPath}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return { archiveRootName, branch, published: true, remote };
  } catch {
    return { archiveRootName, branch, published: false, remote };
  }
}

function resolveArchivedDailyPost(args) {
  const outputDir = getDailyPostDir(args);
  const postPath = path.join(outputDir, "post.json");
  const imagePath = path.join(outputDir, "social-card@2x.png");
  const archiveRootName = path.basename(args.dateRoot);

  if (!fs.existsSync(postPath)) {
    return null;
  }

  return {
    imagePath,
    outputDir,
    post: readJson(postPath),
    summaryLabel: args.archiveKey,
    type:
      archiveRootName === "previous-verified-user-posts"
        ? "verified-user-archive"
        : archiveRootName === "previous-article-posts"
          ? "article-archive"
          : "daily-archive",
  };
}

function writePublicationRecord(args, { mediaIds, status }) {
  writeJson(publicationRecordPath(args), {
    archive_key: args.archiveKey,
    media_ids: mediaIds,
    platform: "mastodon",
    planned_date: args.date,
    published_at: new Date().toISOString(),
    status_id: status.id || "",
    status_url: status.url || status.uri || "",
    visibility: args.visibility,
  });
}

function isRetryableMastodonRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504)\b/.test(message);
}

async function withMastodonRequestRetry({
  attempts = Number(process.env.HUSHLINE_SOCIAL_MASTODON_REQUEST_RETRY_ATTEMPTS || 4),
  baseDelayMs = Number(process.env.HUSHLINE_SOCIAL_MASTODON_REQUEST_RETRY_DELAY_MS || 1500),
  onRetry = () => {},
  run,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableMastodonRequestError(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * attempt;
      onRetry({ attempt, delayMs, error, nextAttempt: attempt + 1 });
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Mastodon request retry exhausted without an error.");
}

async function mastodonRequest({ body, headers = {}, instanceUrl, method, pathOrUrl, token }) {
  const isAbsolute = /^https?:\/\//.test(pathOrUrl);
  const url = isAbsolute ? pathOrUrl : `${instanceUrl}${pathOrUrl}`;
  const response = await withMastodonRequestRetry({
    onRetry: ({ attempt, delayMs, nextAttempt, error }) => {
      process.stderr.write(
        `Mastodon request attempt ${attempt} failed for ${method} ${url}: ${error.message}. Retrying attempt ${nextAttempt} in ${delayMs}ms.\n`,
      );
    },
    async run() {
      try {
        return await fetch(url, {
          body,
          headers: {
            Authorization: `Bearer ${token}`,
            ...headers,
          },
          method,
        });
      } catch (error) {
        const causeMessage =
          error && error.cause && error.cause.message
            ? error.cause.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`Mastodon API ${method} ${url} request failed: ${causeMessage}`);
      }
    },
  });

  if (!response.ok && response.status !== 206) {
    const errorText = await response.text();
    throw new Error(`Mastodon API ${method} ${url} failed with HTTP ${response.status}: ${errorText}`);
  }

  return response;
}

async function uploadMedia({ altText, imagePath, instanceUrl, token }) {
  const imageBuffer = fs.readFileSync(imagePath);
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), path.basename(imagePath));
  if (altText) {
    formData.append("description", altText);
  }

  const response = await mastodonRequest({
    body: formData,
    instanceUrl,
    method: "POST",
    pathOrUrl: "/api/v2/media",
    token,
  });

  const media = await response.json();
  if (!media.id) {
    throw new Error("Mastodon media upload response did not include an attachment id.");
  }

  if (response.status === 202 || !media.url) {
    return waitForMediaProcessed({ instanceUrl, mediaId: media.id, token });
  }

  return media;
}

async function waitForMediaProcessed({ instanceUrl, mediaId, token }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await mastodonRequest({
      instanceUrl,
      method: "GET",
      pathOrUrl: `/api/v1/media/${encodeURIComponent(mediaId)}`,
      token,
    });

    if (response.status === 206) {
      await sleep(2000);
      continue;
    }

    const media = await response.json();
    if (media.url) {
      return media;
    }

    await sleep(2000);
  }

  throw new Error(`Timed out waiting for Mastodon media to finish processing: ${mediaId}`);
}

function idempotencyKey(args) {
  const archiveRootName = getRepoArchiveRootName(args) || path.basename(args.dateRoot);
  return `hushline-${archiveRootName}-${args.archiveKey}-mastodon`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

async function createMastodonStatus({ args, instanceUrl, mediaIds, statusText, token }) {
  const formData = new FormData();
  formData.append("status", statusText);
  formData.append("visibility", args.visibility);
  for (const mediaId of mediaIds) {
    formData.append("media_ids[]", mediaId);
  }

  const response = await mastodonRequest({
    body: formData,
    headers: {
      "Idempotency-Key": idempotencyKey(args),
    },
    instanceUrl,
    method: "POST",
    pathOrUrl: "/api/v1/statuses",
    token,
  });

  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (isWeekendDate(args.date) && !args.allowWeekend) {
    process.stdout.write(`Skipping Mastodon publication for weekend date ${args.date} (${getWeekdayLabel(args.date)}).\n`);
    return;
  }

  const resolved = resolveArchivedDailyPost(args);

  if (!resolved) {
    process.stdout.write(`No archived daily Mastodon post content found for ${args.archiveKey}.\n`);
    return;
  }

  const {
    imagePath,
    post,
    summaryLabel,
    type,
  } = resolved;
  const publishMode = String(post.publish_mode || "image");
  const imageRequired = publishMode !== "text";
  const statusText = String(post.social?.mastodon || "").trim();

  if (!statusText) {
    throw new Error(`Archived post is missing Mastodon copy: ${summaryLabel}`);
  }

  if (imageRequired && !fs.existsSync(imagePath)) {
    throw new Error(`Rendered image not found for ${post.slot}: ${imagePath}`);
  }

  if (!args.force && localPublicationRecordExists(args)) {
    process.stdout.write(`${archiveKindLabel(args)} container ${args.archiveKey} already has a local Mastodon publication record; skipping publish.\n`);
    return;
  }

  const remotePublished = remotePublicationRecordExists(args);
  if (remotePublished.published && !args.force) {
    process.stdout.write(
      `${archiveKindLabel(args)} container ${args.archiveKey} already has a Mastodon publication record on ${remotePublished.remote}/${remotePublished.branch}; skipping publish.\n`,
    );
    return;
  }

  if (args.dryRun) {
    process.stdout.write(
      [
        `Dry run: Mastodon publication prepared for ${args.date}`,
        `- source: ${type}`,
        `- container: ${summaryLabel}`,
        `- slot: ${post.slot}`,
        `- publish mode: ${publishMode}`,
        `- visibility: ${args.visibility}`,
        ...(imageRequired ? [`- image: ${path.relative(REPO_ROOT, imagePath)}`] : []),
        `- status length: ${statusText.length}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const instanceUrl = normalizeInstanceUrl(requireEnv("MASTODON_INSTANCE_URL"));
  const token = requireEnv("MASTODON_ACCESS_TOKEN");
  const mediaIds = [];

  if (imageRequired) {
    const media = await uploadMedia({
      altText: String(post.image_alt_text || ""),
      imagePath,
      instanceUrl,
      token,
    });
    mediaIds.push(media.id);
  }

  const status = await createMastodonStatus({
    args,
    instanceUrl,
    mediaIds,
    statusText,
    token,
  });
  writePublicationRecord(args, { mediaIds, status });

  process.stdout.write(
    [
      `Published Mastodon post for ${post.slot}`,
      `- source: ${type}`,
      `- container: ${summaryLabel}`,
      `- planned date: ${post.planned_date}`,
      `- status id: ${status.id || "unknown"}`,
      `- status url: ${status.url || status.uri || "unknown"}`,
      "",
    ].join("\n"),
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = {
    idempotencyKey,
    isRetryableMastodonRequestError,
    normalizeInstanceUrl,
    withMastodonRequestRetry,
  };
}
