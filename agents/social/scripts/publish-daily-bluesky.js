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

const MAX_BLUESKY_IMAGE_BYTES = 1_000_000;

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

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/publish-daily-bluesky.js",
      "  node scripts/publish-daily-bluesky.js --date 2026-03-18",
      "  node scripts/publish-daily-bluesky.js --date 2026-03-18 --archive-key 2026-03-18-1",
      "  node scripts/publish-daily-bluesky.js --date 2026-03-30 --date-root previous-verified-user-posts --allow-weekend",
      "  node scripts/publish-daily-bluesky.js --dry-run",
      "",
      "Behavior:",
      "  - Publishes from previous-posts/YYYY-MM-DD by default",
      "  - Can also publish article and verified-user archives via --date-root",
      "",
      "Environment:",
      "  BLUESKY_IDENTIFIER      Bluesky handle or DID",
      "  BLUESKY_APP_PASSWORD    Bluesky app password",
      "  BLUESKY_SERVICE_URL     Optional PDS origin, defaults to https://bsky.social",
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

function normalizeServiceUrl(value) {
  const rawValue = String(value || "https://bsky.social").trim();
  if (!rawValue) {
    throw new Error("BLUESKY_SERVICE_URL is required when set.");
  }

  const url = new URL(rawValue);
  if (url.protocol !== "https:") {
    throw new Error("BLUESKY_SERVICE_URL must use https.");
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
  return path.join(getDailyPostDir(args), "bluesky-publication.json");
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
  const recordPath = `${archiveRootName}/${args.archiveKey}/bluesky-publication.json`;
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

function writePublicationRecord(args, { post, publication }) {
  writeJson(publicationRecordPath(args), {
    archive_key: args.archiveKey,
    cid: publication.cid || "",
    platform: "bluesky",
    planned_date: args.date,
    post_url: publication.postUrl || "",
    published_at: new Date().toISOString(),
    slot: post.slot || "",
    uri: publication.uri || "",
  });
}

function isRetryableBlueskyRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|HTTP 429|HTTP 500|HTTP 502|HTTP 503|HTTP 504)\b/.test(message);
}

async function withBlueskyRequestRetry({
  attempts = Number(process.env.HUSHLINE_SOCIAL_BLUESKY_REQUEST_RETRY_ATTEMPTS || 4),
  baseDelayMs = Number(process.env.HUSHLINE_SOCIAL_BLUESKY_REQUEST_RETRY_DELAY_MS || 1500),
  onRetry = () => {},
  run,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableBlueskyRequestError(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * attempt;
      onRetry({ attempt, delayMs, error, nextAttempt: attempt + 1 });
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("Bluesky request retry exhausted without an error.");
}

async function blueskyRequest({ body, headers = {}, method, pathOrUrl, serviceUrl, token }) {
  const isAbsolute = /^https?:\/\//.test(pathOrUrl);
  const url = isAbsolute ? pathOrUrl : `${serviceUrl}${pathOrUrl}`;
  const response = await withBlueskyRequestRetry({
    onRetry: ({ attempt, delayMs, nextAttempt, error }) => {
      process.stderr.write(
        `Bluesky request attempt ${attempt} failed for ${method} ${url}: ${error.message}. Retrying attempt ${nextAttempt} in ${delayMs}ms.\n`,
      );
    },
    async run() {
      try {
        const requestHeaders = { ...headers };
        if (token) {
          requestHeaders.Authorization = `Bearer ${token}`;
        }
        return await fetch(url, {
          body,
          headers: requestHeaders,
          method,
        });
      } catch (error) {
        const causeMessage =
          error && error.cause && error.cause.message
            ? error.cause.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`Bluesky API ${method} ${url} request failed: ${causeMessage}`);
      }
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Bluesky API ${method} ${url} failed with HTTP ${response.status}: ${errorText}`);
  }

  return response;
}

async function createSession({ identifier, password, serviceUrl }) {
  const response = await blueskyRequest({
    body: JSON.stringify({ identifier, password }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    pathOrUrl: "/xrpc/com.atproto.server.createSession",
    serviceUrl,
  });
  const session = await response.json();
  if (!session.accessJwt || !session.did) {
    throw new Error("Bluesky createSession response did not include accessJwt and did.");
  }

  return session;
}

async function uploadBlob({ imagePath, serviceUrl, token }) {
  const imageBuffer = fs.readFileSync(imagePath);
  if (imageBuffer.length > MAX_BLUESKY_IMAGE_BYTES) {
    throw new Error(`Bluesky image exceeds ${MAX_BLUESKY_IMAGE_BYTES} bytes: ${imagePath}`);
  }

  const response = await blueskyRequest({
    body: imageBuffer,
    headers: { "Content-Type": "image/png" },
    method: "POST",
    pathOrUrl: "/xrpc/com.atproto.repo.uploadBlob",
    serviceUrl,
    token,
  });
  const payload = await response.json();
  if (!payload.blob) {
    throw new Error("Bluesky uploadBlob response did not include a blob.");
  }

  return payload.blob;
}

function utcTimestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseUrlFacets(text) {
  const facets = [];
  const urlRegex = /https?:\/\/[^\s<>"'`]+/g;
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const rawUrl = match[0].replace(/[),.!?;:]+$/g, "");
    const byteStart = Buffer.byteLength(text.slice(0, match.index), "utf8");
    const byteEnd = byteStart + Buffer.byteLength(rawUrl, "utf8");
    facets.push({
      features: [
        {
          $type: "app.bsky.richtext.facet#link",
          uri: rawUrl,
        },
      ],
      index: { byteEnd, byteStart },
    });
  }

  return facets;
}

function createPostRecord({ blob, imageAltText, imageRequired, text }) {
  const record = {
    $type: "app.bsky.feed.post",
    createdAt: utcTimestamp(),
    facets: parseUrlFacets(text),
    langs: ["en-US"],
    text,
  };

  if (imageRequired) {
    record.embed = {
      $type: "app.bsky.embed.images",
      images: [
        {
          alt: imageAltText,
          image: blob,
        },
      ],
    };
  }

  return record;
}

async function createBlueskyPost({ blob, imageAltText, imageRequired, serviceUrl, session, text }) {
  const record = createPostRecord({ blob, imageAltText, imageRequired, text });
  const response = await blueskyRequest({
    body: JSON.stringify({
      collection: "app.bsky.feed.post",
      repo: session.did,
      record,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    pathOrUrl: "/xrpc/com.atproto.repo.createRecord",
    serviceUrl,
    token: session.accessJwt,
  });
  const publication = await response.json();
  if (!publication.uri || !publication.cid) {
    throw new Error("Bluesky createRecord response did not include uri and cid.");
  }

  const rkey = publication.uri.split("/").pop() || "";
  const handle = session.handle || session.did;
  return {
    ...publication,
    postUrl: rkey ? `https://bsky.app/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}` : "",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (isWeekendDate(args.date) && !args.allowWeekend) {
    process.stdout.write(`Skipping Bluesky publication for weekend date ${args.date} (${getWeekdayLabel(args.date)}).\n`);
    return;
  }

  const resolved = resolveArchivedDailyPost(args);

  if (!resolved) {
    process.stdout.write(`No archived daily Bluesky post content found for ${args.archiveKey}.\n`);
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
  const statusText = String(post.social?.bluesky || "").trim();

  if (!statusText) {
    throw new Error(`Archived post is missing Bluesky copy: ${summaryLabel}`);
  }

  if (imageRequired && !fs.existsSync(imagePath)) {
    throw new Error(`Rendered image not found for ${post.slot}: ${imagePath}`);
  }

  if (!args.force && localPublicationRecordExists(args)) {
    process.stdout.write(`${archiveKindLabel(args)} container ${args.archiveKey} already has a local Bluesky publication record; skipping publish.\n`);
    return;
  }

  const remotePublished = remotePublicationRecordExists(args);
  if (remotePublished.published && !args.force) {
    process.stdout.write(
      `${archiveKindLabel(args)} container ${args.archiveKey} already has a Bluesky publication record on ${remotePublished.remote}/${remotePublished.branch}; skipping publish.\n`,
    );
    return;
  }

  if (args.dryRun) {
    process.stdout.write(
      [
        `Dry run: Bluesky publication prepared for ${args.date}`,
        `- source: ${type}`,
        `- container: ${summaryLabel}`,
        `- slot: ${post.slot}`,
        `- publish mode: ${publishMode}`,
        ...(imageRequired ? [`- image: ${path.relative(REPO_ROOT, imagePath)}`] : []),
        `- status length: ${statusText.length}`,
        `- facets: ${parseUrlFacets(statusText).length}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const serviceUrl = normalizeServiceUrl(process.env.BLUESKY_SERVICE_URL || "https://bsky.social");
  const session = await createSession({
    identifier: requireEnv("BLUESKY_IDENTIFIER"),
    password: requireEnv("BLUESKY_APP_PASSWORD"),
    serviceUrl,
  });
  const blob = imageRequired
    ? await uploadBlob({
      imagePath,
      serviceUrl,
      token: session.accessJwt,
    })
    : null;
  const publication = await createBlueskyPost({
    blob,
    imageAltText: String(post.image_alt_text || ""),
    imageRequired,
    serviceUrl,
    session,
    text: statusText,
  });
  writePublicationRecord(args, { post, publication });

  process.stdout.write(
    [
      `Published Bluesky post for ${post.slot}`,
      `- source: ${type}`,
      `- container: ${summaryLabel}`,
      `- planned date: ${post.planned_date}`,
      `- uri: ${publication.uri || "unknown"}`,
      `- url: ${publication.postUrl || "unknown"}`,
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
    MAX_BLUESKY_IMAGE_BYTES,
    createPostRecord,
    isRetryableBlueskyRequestError,
    normalizeServiceUrl,
    parseUrlFacets,
    withBlueskyRequestRetry,
  };
}
