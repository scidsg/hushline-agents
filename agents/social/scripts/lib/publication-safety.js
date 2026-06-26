"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  REPO_ROOT,
  archiveKeyDate,
  compareArchiveKeys,
  isValidArchiveKey,
  readJson,
} = require("./social-common");

const ARCHIVE_ROOT_NAMES = [
  "previous-posts",
  "previous-article-posts",
  "previous-verified-user-posts",
];

function normalizePublicationText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function safeReadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return readJson(filePath);
  } catch (_error) {
    return null;
  }
}

function readTextIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function extractLinkedInCopyFromPostCopy(value) {
  const copy = String(value || "").trim();
  if (!copy) {
    return "";
  }

  const match = copy.match(/(?:^|\n)LinkedIn \([^)]*\)\n([\s\S]*?)(?:\n\n(?:Mastodon|Bluesky) \(|$)/);
  return (match ? match[1] : copy).trim();
}

function archiveRootCandidates(dateRoot) {
  const resolvedDateRoot = path.resolve(dateRoot);
  const rootName = path.basename(resolvedDateRoot);
  const parent = path.dirname(resolvedDateRoot);
  const roots = [resolvedDateRoot];

  if (ARCHIVE_ROOT_NAMES.includes(rootName)) {
    for (const candidateName of ARCHIVE_ROOT_NAMES) {
      roots.push(path.join(parent, candidateName));
    }
  }

  return [...new Set(roots)];
}

function listArchiveKeys(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidArchiveKey(entry.name))
    .map((entry) => entry.name)
    .sort(compareArchiveKeys);
}

function flattenPostSocial(post) {
  const social = post && post.social && typeof post.social === "object" ? post.social : {};

  return {
    linkedin: social.linkedin || post?.linkedin || "",
  };
}

function readArchiveEntryFromSources({
  archiveKey,
  archiveRoot,
  copy = null,
  plan = null,
  post = null,
  postCopy = "",
  sourcePath = "",
}) {
  const sourcePost = post || (plan && plan.post) || copy || null;
  const fallbackLinkedInCopy = copy?.linkedin || extractLinkedInCopyFromPostCopy(postCopy);

  if (!sourcePost && !fallbackLinkedInCopy) {
    return null;
  }

  const social = flattenPostSocial(sourcePost);

  return {
    archive_key: archiveKey,
    archive_root: archiveRoot,
    date: archiveKeyDate(archiveKey),
    headline: sourcePost?.headline || sourcePost?.display_name || "",
    linkedin_copy: social.linkedin || fallbackLinkedInCopy || "",
    path: sourcePath,
    publish_mode: sourcePost?.publish_mode || "",
  };
}

function readLocalArchiveEntry(rootDir, archiveKey) {
  const archiveDir = path.join(rootDir, archiveKey);

  return readArchiveEntryFromSources({
    archiveKey,
    archiveRoot: rootDir,
    copy: safeReadJson(path.join(archiveDir, "copy.json")),
    plan: safeReadJson(path.join(archiveDir, "plan.json")),
    post: safeReadJson(path.join(archiveDir, "post.json")),
    postCopy: readTextIfExists(path.join(archiveDir, "post-copy.txt")),
    sourcePath: path.join(archiveDir, "post.json"),
  });
}

function repoRelativeArchiveRoot(rootDir) {
  const relativeRoot = path.relative(REPO_ROOT, path.resolve(rootDir));

  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    return null;
  }

  return relativeRoot;
}

function gitOutput(execFileSyncImpl, args) {
  return execFileSyncImpl("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function safeGitOutput(execFileSyncImpl, args) {
  try {
    return gitOutput(execFileSyncImpl, args);
  } catch (_error) {
    return "";
  }
}

function readRemoteFile(execFileSyncImpl, ref, filePath) {
  return safeGitOutput(execFileSyncImpl, ["show", `${ref}:${filePath}`]);
}

function safeParseJson(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function refreshRemoteRef({ execFileSyncImpl = execFileSync } = {}) {
  const remote = process.env.HUSHLINE_SOCIAL_ARCHIVE_REMOTE || "origin";
  const branch = process.env.HUSHLINE_SOCIAL_ARCHIVE_BRANCH || "main";
  const remoteRef = `refs/remotes/${remote}/${branch}`;

  try {
    execFileSyncImpl("git", ["fetch", "--quiet", remote, `${branch}:${remoteRef}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
  } catch (_error) {
    return { branch, refreshed: false, remote, ref: null };
  }

  return { branch, refreshed: true, remote, ref: `${remote}/${branch}` };
}

function readRemoteArchiveEntry(rootDir, archiveKey, { execFileSyncImpl = execFileSync, ref }) {
  const relativeRoot = repoRelativeArchiveRoot(rootDir);
  if (!relativeRoot) {
    return null;
  }

  const archivePath = `${relativeRoot}/${archiveKey}`;

  return readArchiveEntryFromSources({
    archiveKey,
    archiveRoot: rootDir,
    copy: safeParseJson(readRemoteFile(execFileSyncImpl, ref, `${archivePath}/copy.json`)),
    plan: safeParseJson(readRemoteFile(execFileSyncImpl, ref, `${archivePath}/plan.json`)),
    post: safeParseJson(readRemoteFile(execFileSyncImpl, ref, `${archivePath}/post.json`)),
    postCopy: readRemoteFile(execFileSyncImpl, ref, `${archivePath}/post-copy.txt`),
    sourcePath: `${ref}:${archivePath}/post.json`,
  });
}

function listRemoteArchiveKeys(rootDir, { execFileSyncImpl = execFileSync, ref }) {
  const relativeRoot = repoRelativeArchiveRoot(rootDir);
  if (!relativeRoot) {
    return [];
  }

  return safeGitOutput(execFileSyncImpl, ["ls-tree", "-d", "--name-only", `${ref}:${relativeRoot}`])
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => isValidArchiveKey(value))
    .sort(compareArchiveKeys);
}

function loadLocalPublicationHistory(dateRoot) {
  return archiveRootCandidates(dateRoot)
    .flatMap((rootDir) => listArchiveKeys(rootDir).map((archiveKey) => readLocalArchiveEntry(rootDir, archiveKey)))
    .filter(Boolean);
}

function loadRemotePublicationHistory(dateRoot, { execFileSyncImpl = execFileSync } = {}) {
  const hasRepoRelativeArchiveRoot = archiveRootCandidates(dateRoot).some((rootDir) => (
    repoRelativeArchiveRoot(rootDir)
  ));

  if (!hasRepoRelativeArchiveRoot) {
    return [];
  }

  const remoteRef = refreshRemoteRef({ execFileSyncImpl });
  if (!remoteRef.ref) {
    throw new Error(
      `Failed to refresh ${remoteRef.remote}/${remoteRef.branch} before checking LinkedIn duplicate history.`,
    );
  }

  return archiveRootCandidates(dateRoot)
    .flatMap((rootDir) => (
      listRemoteArchiveKeys(rootDir, { execFileSyncImpl, ref: remoteRef.ref })
        .map((archiveKey) => readRemoteArchiveEntry(rootDir, archiveKey, {
          execFileSyncImpl,
          ref: remoteRef.ref,
        }))
    ))
    .filter(Boolean);
}

function loadPublicationHistory({ dateRoot, execFileSyncImpl = execFileSync }) {
  const entriesByArchive = new Map();

  for (const entry of [
    ...loadLocalPublicationHistory(dateRoot),
    ...loadRemotePublicationHistory(dateRoot, { execFileSyncImpl }),
  ]) {
    entriesByArchive.set(`${path.resolve(entry.archive_root)}\0${entry.archive_key}`, entry);
  }

  return [...entriesByArchive.values()];
}

function currentEntryIdentity({ archiveKey, dateRoot }) {
  return {
    archive_key: archiveKey,
    archive_root: path.resolve(dateRoot),
  };
}

function isCurrentArchive(entry, current) {
  return (
    entry.archive_key === current.archive_key &&
    path.resolve(entry.archive_root) === current.archive_root
  );
}

function buildCandidateEntry({ archiveKey, dateRoot, post }) {
  const social = flattenPostSocial(post);

  return {
    archive_key: archiveKey,
    archive_root: path.resolve(dateRoot),
    date: archiveKeyDate(archiveKey),
    headline: post.headline || post.display_name || "",
    linkedin_copy: social.linkedin || "",
    publish_mode: post.publish_mode || "",
  };
}

function shouldCompareHeadline(left, right) {
  return left.publish_mode !== "text" && right.publish_mode !== "text";
}

function findPublicationSafetyViolations({
  archiveKey,
  dateRoot,
  execFileSyncImpl = execFileSync,
  post,
}) {
  const candidate = buildCandidateEntry({ archiveKey, dateRoot, post });
  const current = currentEntryIdentity({ archiveKey, dateRoot });
  const candidateHeadline = normalizePublicationText(candidate.headline);
  const candidateLinkedInCopy = normalizePublicationText(candidate.linkedin_copy);
  const violations = [];

  for (const entry of loadPublicationHistory({ dateRoot, execFileSyncImpl })) {
    if (isCurrentArchive(entry, current)) {
      continue;
    }

    if (
      shouldCompareHeadline(candidate, entry) &&
      candidateHeadline &&
      candidateHeadline === normalizePublicationText(entry.headline)
    ) {
      violations.push({
        archive_key: entry.archive_key,
        archive_root: path.basename(entry.archive_root),
        field: "headline",
        message: `LinkedIn publication blocked: headline duplicates ${path.basename(entry.archive_root)}/${entry.archive_key}.`,
      });
    }

    if (
      candidateLinkedInCopy &&
      candidateLinkedInCopy === normalizePublicationText(entry.linkedin_copy)
    ) {
      violations.push({
        archive_key: entry.archive_key,
        archive_root: path.basename(entry.archive_root),
        field: "linkedin_copy",
        message: `LinkedIn publication blocked: LinkedIn copy duplicates ${path.basename(entry.archive_root)}/${entry.archive_key}.`,
      });
    }
  }

  return violations;
}

function assertPublicationIsOriginal({
  archiveKey,
  dateRoot,
  execFileSyncImpl = execFileSync,
  post,
}) {
  const violations = findPublicationSafetyViolations({
    archiveKey,
    dateRoot,
    execFileSyncImpl,
    post,
  });

  if (violations.length > 0) {
    const details = violations.map((violation) => `- ${violation.message}`).join("\n");
    throw new Error(`Publication safety check failed for ${archiveKey}:\n${details}`);
  }
}

module.exports = {
  assertPublicationIsOriginal,
  archiveRootCandidates,
  findPublicationSafetyViolations,
  loadPublicationHistory,
  loadRemotePublicationHistory,
  normalizePublicationText,
};
