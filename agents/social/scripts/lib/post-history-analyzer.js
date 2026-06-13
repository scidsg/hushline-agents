"use strict";

const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  archiveKeyDate,
  compareArchiveKeys,
  inferScreenKey,
  isValidArchiveKey,
  readJson,
} = require("./social-common");
const { inferTopicFamily } = require("./daily-planner");

const DEFAULT_WINDOWS = [30, 60, 90];
const DAILY_POSTS_ROOT = path.join(REPO_ROOT, "previous-posts");
const VERIFIED_USER_POSTS_ROOT = path.join(REPO_ROOT, "previous-verified-user-posts");

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

function normalizePhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitParagraphs(value) {
  return String(value || "")
    .split(/\n\s*\n/)
    .map(cleanLine)
    .filter(Boolean);
}

function firstSentence(value) {
  const paragraph = splitParagraphs(value)[0] || cleanLine(value);
  const match = paragraph.match(/^(.+?[.!?])(?:\s|$)/);
  return cleanLine(match ? match[1] : paragraph);
}

function lastParagraph(value) {
  const paragraphs = splitParagraphs(value);
  return paragraphs[paragraphs.length - 1] || "";
}

function classifyCta(value) {
  const cta = normalizePhrase(lastParagraph(value));

  if (!cta) {
    return "none";
  }

  if (/^sign up at url/.test(cta)) {
    return "sign_up";
  }

  if (/^learn more at url/.test(cta)) {
    return "learn_more";
  }

  if (/^to send .+ a tip go to url/.test(cta)) {
    return "send_tip_go_to";
  }

  if (/^to send .+ a tip visit url/.test(cta)) {
    return "send_tip_visit";
  }

  if (/^send .+ a tip url/.test(cta)) {
    return "send_tip_direct";
  }

  if (/\burl\b/.test(cta)) {
    return "other_url";
  }

  return cta;
}

function extractTemplateName(post, postCopy, fallback = "") {
  if (post && post.template_name) {
    return post.template_name;
  }

  const match = String(postCopy || "").match(/^Template:\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function flattenSocial(post) {
  const social = post && post.social && typeof post.social === "object"
    ? post.social
    : {};

  return {
    bluesky: social.bluesky || "",
    linkedin: social.linkedin || "",
    mastodon: social.mastodon || "",
  };
}

function readDailyEntry(rootDir, archiveKey) {
  const archiveDir = path.join(rootDir, archiveKey);
  const post = safeReadJson(path.join(archiveDir, "post.json"));
  const plan = safeReadJson(path.join(archiveDir, "plan.json"));
  const planPost = plan && plan.post ? plan.post : null;
  const sourcePost = post || planPost;
  const postCopy = readTextIfExists(path.join(archiveDir, "post-copy.txt"));

  if (!sourcePost && !postCopy) {
    return null;
  }

  const social = flattenSocial(sourcePost);
  const primaryCopy = social.linkedin || postCopy;
  const topicFamily = sourcePost && (sourcePost.topic_family || inferTopicFamily(sourcePost));

  return {
    archive_key: archiveKey,
    audience_scope: (sourcePost && sourcePost.audience_scope) || "",
    bluesky_copy: social.bluesky,
    concept_key: (sourcePost && sourcePost.concept_key) || "",
    content_key: (sourcePost && sourcePost.content_key) || "",
    cta_pattern: classifyCta(primaryCopy),
    date: archiveKeyDate(archiveKey),
    headline: (sourcePost && sourcePost.headline) || "",
    hook: firstSentence(primaryCopy),
    hook_pattern: normalizePhrase(firstSentence(primaryCopy)),
    linkedin_copy: social.linkedin,
    mastodon_copy: social.mastodon,
    screen_key: (sourcePost && (sourcePost.screen_key || inferScreenKey(sourcePost))) || "",
    screenshot_file: (sourcePost && sourcePost.screenshot_file) || "",
    subtext: (sourcePost && sourcePost.subtext) || "",
    template_name: extractTemplateName(sourcePost, postCopy),
    theme: (sourcePost && sourcePost.theme) || "",
    topic_family: topicFamily || "",
    type: "daily",
    viewport: (sourcePost && sourcePost.viewport) || "",
  };
}

function readVerifiedUserEntry(rootDir, archiveKey) {
  const archiveDir = path.join(rootDir, archiveKey);
  const post = safeReadJson(path.join(archiveDir, "post.json"));
  const copy = safeReadJson(path.join(archiveDir, "copy.json"));
  const postCopy = readTextIfExists(path.join(archiveDir, "post-copy.txt"));

  if (!post && !copy && !postCopy) {
    return null;
  }

  const social = flattenSocial(post || copy || {});
  const primaryCopy = social.linkedin || (copy && copy.linkedin) || postCopy;

  return {
    archive_key: archiveKey,
    cta_pattern: classifyCta(primaryCopy),
    date: archiveKeyDate(archiveKey),
    display_name: (post && post.display_name) || "",
    hook: firstSentence(primaryCopy),
    hook_pattern: normalizePhrase(firstSentence(primaryCopy)),
    linkedin_copy: social.linkedin || (copy && copy.linkedin) || "",
    primary_username: (post && post.primary_username) || "",
    template_name: "hushline-social-verified-user-template.html",
    type: "verified-user",
    user_link: (post && (post.user_link || post.user_url)) || "",
  };
}

function loadEntries(rootDir, reader) {
  return listArchiveKeys(rootDir)
    .map((archiveKey) => reader(rootDir, archiveKey))
    .filter(Boolean);
}

function latestDate(entries) {
  return entries.reduce((latest, entry) => {
    if (!latest || entry.date > latest) {
      return entry.date;
    }

    return latest;
  }, "");
}

function daysBetween(leftDate, rightDate) {
  const left = String(leftDate).split("-").map(Number);
  const right = String(rightDate).split("-").map(Number);
  const leftUtc = Date.UTC(left[0], left[1] - 1, left[2]);
  const rightUtc = Date.UTC(right[0], right[1] - 1, right[2]);

  return Math.floor((rightUtc - leftUtc) / 86400000);
}

function entriesForWindow(entries, asOfDate, days) {
  return entries.filter((entry) => {
    const diff = daysBetween(entry.date, asOfDate);
    return diff >= 0 && diff < days;
  });
}

function countBy(entries, fieldName) {
  const counts = new Map();

  for (const entry of entries) {
    const value = String(entry[fieldName] || "unknown");
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function repeatedBy(entries, fieldName, sampleFieldName = fieldName) {
  return countBy(entries, fieldName)
    .filter((item) => item.count > 1 && item.value !== "unknown" && item.value !== "none")
    .map((item) => {
      const sample = entries.find((entry) => String(entry[fieldName] || "") === item.value);

      return {
        ...item,
        sample: sample ? sample[sampleFieldName] : "",
      };
    });
}

function summarizeWindow(entries, asOfDate, days, fields) {
  const scoped = entriesForWindow(entries, asOfDate, days);
  const summary = {
    date_range: {
      as_of: asOfDate,
      days,
    },
    repeated_ctas: repeatedBy(scoped, "cta_pattern"),
    repeated_hooks: repeatedBy(scoped, "hook_pattern", "hook"),
    total: scoped.length,
  };

  for (const [outputName, fieldName] of Object.entries(fields)) {
    summary[outputName] = countBy(scoped, fieldName);
  }

  return summary;
}

function summarizeCollection(entries, asOfDate, windows, fields) {
  const windowSummaries = {};

  for (const days of windows) {
    windowSummaries[String(days)] = summarizeWindow(entries, asOfDate, days, fields);
  }

  return {
    total_archived: entries.length,
    windows: windowSummaries,
  };
}

function normalizeWindows(windows) {
  return [...new Set((windows || DEFAULT_WINDOWS).map(Number))]
    .filter((value) => Number.isInteger(value) && value > 0)
    .sort((left, right) => left - right);
}

function analyzePostHistory(options = {}) {
  const dailyPostsRoot = options.dailyPostsRoot || DAILY_POSTS_ROOT;
  const verifiedUserPostsRoot = options.verifiedUserPostsRoot || VERIFIED_USER_POSTS_ROOT;
  const dailyEntries = loadEntries(dailyPostsRoot, readDailyEntry);
  const verifiedUserEntries = loadEntries(verifiedUserPostsRoot, readVerifiedUserEntry);
  const inferredAsOfDate = latestDate([...dailyEntries, ...verifiedUserEntries]);
  const asOfDate = options.asOfDate || inferredAsOfDate;

  if (!asOfDate) {
    throw new Error("No archived posts were found to analyze.");
  }

  const windows = normalizeWindows(options.windows);

  return {
    as_of_date: asOfDate,
    daily: summarizeCollection(dailyEntries, asOfDate, windows, {
      audience_scope_counts: "audience_scope",
      concept_key_counts: "concept_key",
      template_usage: "template_name",
      topic_family_counts: "topic_family",
    }),
    generated_at: new Date().toISOString(),
    verified_user: summarizeCollection(verifiedUserEntries, asOfDate, windows, {
      cta_pattern_counts: "cta_pattern",
      opening_line_counts: "hook_pattern",
      template_usage: "template_name",
    }),
    windows,
  };
}

function topValues(items, limit = 5) {
  return (items || [])
    .slice(0, limit)
    .map((item) => `${item.value} (${item.count})`)
    .join(", ") || "none";
}

function formatWindowSummary(label, summary) {
  return [
    `${label}: ${summary.total} posts`,
    `  topics: ${topValues(summary.topic_family_counts)}`,
    `  audiences: ${topValues(summary.audience_scope_counts)}`,
    `  templates: ${topValues(summary.template_usage)}`,
    `  repeated hooks: ${topValues(summary.repeated_hooks, 3)}`,
    `  repeated CTAs: ${topValues(summary.repeated_ctas, 3)}`,
  ].join("\n");
}

function formatVerifiedWindowSummary(label, summary) {
  return [
    `${label}: ${summary.total} posts`,
    `  opening lines: ${topValues(summary.opening_line_counts, 3)}`,
    `  repeated hooks: ${topValues(summary.repeated_hooks, 3)}`,
    `  repeated CTAs: ${topValues(summary.repeated_ctas, 3)}`,
  ].join("\n");
}

function formatPostHistoryReport(report) {
  const dailySections = report.windows.map((days) => {
    return formatWindowSummary(`Daily last ${days} days`, report.daily.windows[String(days)]);
  });
  const verifiedSections = report.windows.map((days) => {
    return formatVerifiedWindowSummary(
      `Verified-user last ${days} days`,
      report.verified_user.windows[String(days)],
    );
  });

  return [
    `Post history report as of ${report.as_of_date}`,
    "",
    ...dailySections,
    "",
    ...verifiedSections,
  ].join("\n");
}

module.exports = {
  DAILY_POSTS_ROOT,
  DEFAULT_WINDOWS,
  VERIFIED_USER_POSTS_ROOT,
  analyzePostHistory,
  classifyCta,
  daysBetween,
  firstSentence,
  formatPostHistoryReport,
  normalizePhrase,
  readDailyEntry,
  readVerifiedUserEntry,
};
