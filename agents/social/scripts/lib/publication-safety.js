"use strict";

const fs = require("fs");
const path = require("path");
const {
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

function readArchiveEntry(rootDir, archiveKey) {
  const archiveDir = path.join(rootDir, archiveKey);
  const post = safeReadJson(path.join(archiveDir, "post.json"));
  const plan = safeReadJson(path.join(archiveDir, "plan.json"));
  const sourcePost = post || (plan && plan.post) || null;

  if (!sourcePost) {
    return null;
  }

  const social = flattenPostSocial(sourcePost);

  return {
    archive_key: archiveKey,
    archive_root: rootDir,
    date: archiveKeyDate(archiveKey),
    headline: sourcePost.headline || sourcePost.display_name || "",
    linkedin_copy: social.linkedin || "",
    path: path.join(archiveDir, "post.json"),
  };
}

function loadPublicationHistory({ dateRoot }) {
  return archiveRootCandidates(dateRoot)
    .flatMap((rootDir) => listArchiveKeys(rootDir).map((archiveKey) => readArchiveEntry(rootDir, archiveKey)))
    .filter(Boolean);
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
  };
}

function findPublicationSafetyViolations({ archiveKey, dateRoot, post }) {
  const candidate = buildCandidateEntry({ archiveKey, dateRoot, post });
  const current = currentEntryIdentity({ archiveKey, dateRoot });
  const candidateHeadline = normalizePublicationText(candidate.headline);
  const candidateLinkedInCopy = normalizePublicationText(candidate.linkedin_copy);
  const violations = [];

  for (const entry of loadPublicationHistory({ dateRoot })) {
    if (isCurrentArchive(entry, current)) {
      continue;
    }

    if (
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

function assertPublicationIsOriginal({ archiveKey, dateRoot, post }) {
  const violations = findPublicationSafetyViolations({ archiveKey, dateRoot, post });

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
  normalizePublicationText,
};
