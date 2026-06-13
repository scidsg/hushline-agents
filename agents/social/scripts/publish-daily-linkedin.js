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

function defaultLinkedInVersion() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function previousLinkedInVersion(now = new Date()) {
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${previousMonth.getFullYear()}${String(previousMonth.getMonth() + 1).padStart(2, "0")}`;
}

function resolveLinkedInVersionCandidates(requestedVersion, now = new Date()) {
  const explicitVersion = String(requestedVersion || "").trim();

  if (explicitVersion) {
    if (!/^\d{6}$/.test(explicitVersion)) {
      throw new Error("LINKEDIN_API_VERSION must use YYYYMM format.");
    }
    return [explicitVersion];
  }

  const currentVersion = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const fallbackVersion = previousLinkedInVersion(now);
  return currentVersion === fallbackVersion ? [currentVersion] : [currentVersion, fallbackVersion];
}

function isInactiveLinkedInVersionError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /NONEXISTENT_VERSION/.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableLinkedInRequestError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)\b/.test(message);
}

async function withLinkedInRequestRetry({
  attempts = Number(process.env.HUSHLINE_SOCIAL_LINKEDIN_REQUEST_RETRY_ATTEMPTS || 4),
  baseDelayMs = Number(process.env.HUSHLINE_SOCIAL_LINKEDIN_REQUEST_RETRY_DELAY_MS || 1500),
  onRetry = () => {},
  run,
}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableLinkedInRequestError(error)) {
        throw error;
      }

      const delayMs = baseDelayMs * attempt;
      onRetry({ attempt, delayMs, error, nextAttempt: attempt + 1 });
      await sleep(delayMs);
    }
  }

  throw lastError || new Error("LinkedIn request retry exhausted without an error.");
}

async function withLinkedInVersionFallback({ requestedVersion, now = new Date(), onRetry = () => {}, run }) {
  const versionCandidates = resolveLinkedInVersionCandidates(requestedVersion, now);

  for (let index = 0; index < versionCandidates.length; index += 1) {
    const version = versionCandidates[index];

    try {
      return await run(version);
    } catch (error) {
      const nextVersion = versionCandidates[index + 1];
      if (!nextVersion || !isInactiveLinkedInVersionError(error)) {
        throw error;
      }

      onRetry({ currentVersion: version, error, nextVersion });
    }
  }

  throw new Error("No LinkedIn API version candidates were available.");
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
      "  node scripts/publish-daily-linkedin.js",
      "  node scripts/publish-daily-linkedin.js --date 2026-03-18",
      "  node scripts/publish-daily-linkedin.js --date 2026-03-18 --archive-key 2026-03-18-1",
      "  node scripts/publish-daily-linkedin.js --date 2026-03-30 --date-root previous-verified-user-posts",
      "  node scripts/publish-daily-linkedin.js --date 2026-03-29 --date-root previous-verified-user-posts --allow-weekend",
      "  node scripts/publish-daily-linkedin.js --dry-run",
      "",
      "Behavior:",
      "  - Publishes from previous-posts/YYYY-MM-DD by default",
      "  - Can also publish verified-user archives via --date-root previous-verified-user-posts",
      "",
      "Environment:",
      "  LINKEDIN_ACCESS_TOKEN    OAuth access token with LinkedIn posting permissions",
      "  LINKEDIN_AUTHOR_URN      urn:li:person:... or urn:li:organization:...",
      "  LINKEDIN_API_VERSION     Optional, uses current YYYYMM and retries previous month if inactive",
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

function remoteArchivePublished(args) {
  const archiveRootName = getRepoArchiveRootName(args);

  if (!archiveRootName) {
    return { published: false };
  }

  const remote = process.env.HUSHLINE_SOCIAL_ARCHIVE_REMOTE || "origin";
  const branch = process.env.HUSHLINE_SOCIAL_ARCHIVE_BRANCH || "main";
  const publicationRecordPath = `${archiveRootName}/${args.archiveKey}/linkedin-publication.json`;
  const legacyArchivePath = `${archiveRootName}/${args.archiveKey}/post.json`;
  const remoteRef = `refs/remotes/${remote}/${branch}`;

  try {
    execFileSync("git", ["fetch", "--quiet", remote, `${branch}:${remoteRef}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    execFileSync("git", ["cat-file", "-e", `${remote}/${branch}:${publicationRecordPath}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return { archiveRootName, branch, published: true, remote };
  } catch {
    try {
      execFileSync("git", ["cat-file", "-e", `${remote}/${branch}:${legacyArchivePath}`], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
      return { archiveRootName, branch, published: true, remote };
    } catch {
      return { archiveRootName, branch, published: false, remote };
    }
  }
}

function publicationRecordPath(args) {
  return path.join(getDailyPostDir(args), "linkedin-publication.json");
}

function localPublicationRecordExists(args) {
  return fs.existsSync(publicationRecordPath(args));
}

function writePublicationRecord(args, { post, publication }) {
  writeJson(publicationRecordPath(args), {
    archive_key: args.archiveKey,
    platform: "linkedin",
    planned_date: args.date,
    post_id: publication.postId || "",
    published_at: new Date().toISOString(),
    slot: post.slot || "",
    status: publication.status || null,
  });
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

async function linkedinRequest({ method, pathOrUrl, token, version, body, headers = {} }) {
  const isAbsolute = /^https?:\/\//.test(pathOrUrl);
  const url = isAbsolute ? pathOrUrl : `https://api.linkedin.com/rest${pathOrUrl}`;
  const response = await withLinkedInRequestRetry({
    onRetry: ({ attempt, delayMs, nextAttempt, error }) => {
      process.stderr.write(
        `LinkedIn request attempt ${attempt} failed for ${method} ${url}: ${error.message}. Retrying attempt ${nextAttempt} in ${delayMs}ms.\n`,
      );
    },
    async run() {
      try {
        return await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Linkedin-Version": version,
            "X-Restli-Protocol-Version": "2.0.0",
            ...headers,
          },
          body,
        });
      } catch (error) {
        const causeMessage =
          error && error.cause && error.cause.message
            ? error.cause.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`LinkedIn API ${method} ${url} request failed: ${causeMessage}`);
      }
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LinkedIn API ${method} ${url} failed with ${response.status}: ${errorText}`);
  }

  return response;
}

async function initializeImageUpload(authorUrn, token, version) {
  const response = await linkedinRequest({
    body: JSON.stringify({
      initializeUploadRequest: {
        owner: authorUrn,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    pathOrUrl: "/images?action=initializeUpload",
    token,
    version,
  });

  return response.json();
}

async function uploadImage(uploadUrl, imagePath, token, version) {
  const imageBuffer = fs.readFileSync(imagePath);
  const response = await linkedinRequest({
    body: imageBuffer,
    headers: {
      "Content-Type": "image/png",
    },
    method: "POST",
    pathOrUrl: uploadUrl,
    token,
    version,
  });

  return response.status;
}

async function waitForImageAvailable(imageUrn, token, version) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await linkedinRequest({
      method: "GET",
      pathOrUrl: `/images/${encodeURIComponent(imageUrn)}`,
      token,
      version,
    });
    const image = await response.json();
    if (image.status === "AVAILABLE") {
      return image;
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for LinkedIn image to become AVAILABLE: ${imageUrn}`);
}

async function createLinkedInPost({ authorUrn, commentary, imageUrn, altText, token, version }) {
  const requestBody = {
    author: authorUrn,
    commentary,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    requestBody.content = {
      media: {
        altText,
        id: imageUrn,
      },
    };
  }

  const response = await linkedinRequest({
    body: JSON.stringify(requestBody),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    pathOrUrl: "/posts",
    token,
    version,
  });

  return {
    postId: response.headers.get("x-restli-id") || "",
    status: response.status,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (isWeekendDate(args.date) && !args.allowWeekend) {
    process.stdout.write(`Skipping LinkedIn publication for weekend date ${args.date} (${getWeekdayLabel(args.date)}).\n`);
    return;
  }

  const resolved = resolveArchivedDailyPost(args);

  if (!resolved) {
    process.stdout.write(`No archived daily LinkedIn post content found for ${args.archiveKey}.\n`);
    return;
  }
  const {
    imagePath,
    post,
    summaryLabel,
    type,
  } = resolved;
  const remotePublished = remoteArchivePublished(args);
  const publishMode = String(post.publish_mode || "image");
  const imageRequired = publishMode !== "text";

  if (imageRequired && !fs.existsSync(imagePath)) {
    throw new Error(`Rendered image not found for ${post.slot}: ${imagePath}`);
  }

  if (!args.force && localPublicationRecordExists(args)) {
    const archiveLabel = archiveKindLabel(args);
    process.stdout.write(
      `${archiveLabel} container ${args.archiveKey} already has a local LinkedIn publication record; skipping publish.\n`,
    );
    return;
  }

  if (remotePublished.published && !args.force) {
    const archiveLabel = archiveKindLabel(args);
    process.stdout.write(
      `${archiveLabel} container ${args.archiveKey} is already present on ${remotePublished.remote}/${remotePublished.branch}; assuming LinkedIn post already published.\n`,
    );
    return;
  }

  if (args.dryRun) {
    process.stdout.write(
      [
        `Dry run: LinkedIn publication prepared for ${args.date}`,
        `- source: ${type}`,
        `- container: ${summaryLabel}`,
        `- slot: ${post.slot}`,
        `- publish mode: ${publishMode}`,
        ...(imageRequired ? [`- image: ${path.relative(REPO_ROOT, imagePath)}`] : []),
        `- commentary length: ${post.social.linkedin.length}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const token = requireEnv("LINKEDIN_ACCESS_TOKEN");
  const authorUrn = requireEnv("LINKEDIN_AUTHOR_URN");
  const requestedVersion = process.env.LINKEDIN_API_VERSION || "";
  const created = await withLinkedInVersionFallback({
    onRetry: ({ currentVersion, nextVersion }) => {
      process.stdout.write(
        `LinkedIn API version ${currentVersion} is not active; retrying with ${nextVersion}.\n`,
      );
    },
    requestedVersion,
    async run(version) {
      let imageUrn = "";

      if (imageRequired) {
        const initialized = await initializeImageUpload(authorUrn, token, version);
        imageUrn = initialized?.value?.image || "";
        const uploadUrl = initialized?.value?.uploadUrl;

        if (!imageUrn || !uploadUrl) {
          throw new Error("LinkedIn image initializeUpload response did not include image URN and upload URL.");
        }

        await uploadImage(uploadUrl, imagePath, token, version);
        await waitForImageAvailable(imageUrn, token, version);
      }

      return createLinkedInPost({
        altText: String(post.image_alt_text || ""),
        authorUrn,
        commentary: post.social.linkedin,
        imageUrn,
        token,
        version,
      });
    },
  });
  writePublicationRecord(args, { post, publication: created });

  process.stdout.write(
    [
      `Published LinkedIn post for ${post.slot}`,
      `- source: ${type}`,
      `- container: ${summaryLabel}`,
      `- planned date: ${post.planned_date}`,
      `- post id: ${created.postId || "unknown"}`,
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
    defaultLinkedInVersion,
    isInactiveLinkedInVersionError,
    isRetryableLinkedInRequestError,
    previousLinkedInVersion,
    resolveLinkedInVersionCandidates,
    withLinkedInRequestRetry,
    withLinkedInVersionFallback,
  };
}
