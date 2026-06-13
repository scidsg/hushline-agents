"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const AGENT_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(
  process.env.HUSHLINE_SOCIAL_REPO_DIR ||
    process.env.HUSHLINE_SOCIAL_CONTENT_REPO_DIR ||
    AGENT_ROOT,
);
const SCREENSHOTS_REPO_ROOT = path.resolve(
  process.env.HUSHLINE_SCREENSHOTS_REPO_DIR || path.join(REPO_ROOT, "..", "hushline-screenshots"),
);
const CURRENT_SCREENSHOTS_ROOT = path.resolve(
  process.env.HUSHLINE_CURRENT_SCREENSHOTS_DIR ||
    process.env.HUSHLINE_SCREENSHOTS_CURRENT_DIR ||
    path.join(REPO_ROOT, "..", "hushline-website", "src", "assets", "img", "screenshots", "current"),
);
const CURATED_SCREENSHOTS_ROOT = path.join(SCREENSHOTS_REPO_ROOT, "curated");
const LATEST_SCREENSHOTS_ROOT = path.join(SCREENSHOTS_REPO_ROOT, "releases", "latest");
const SCREENSHOTS_ROOT = [
  CURRENT_SCREENSHOTS_ROOT,
  CURATED_SCREENSHOTS_ROOT,
  LATEST_SCREENSHOTS_ROOT,
].find((candidate) => fs.existsSync(candidate)) || LATEST_SCREENSHOTS_ROOT;
const SCREENSHOT_MANIFEST = fs.existsSync(path.join(SCREENSHOTS_ROOT, "manifest.json"))
  ? path.join(SCREENSHOTS_ROOT, "manifest.json")
  : path.join(LATEST_SCREENSHOTS_ROOT, "manifest.json");
const HUSHLINE_ROOT = path.resolve(process.env.HUSHLINE_ROOT || path.join(REPO_ROOT, "..", "hushline"));
const HUSHLINE_DOCS_ROOT = path.resolve(process.env.HUSHLINE_DOCS_ROOT || HUSHLINE_ROOT);
const HUSHLINE_DOCS_DIRS = [...new Set([
  path.join(HUSHLINE_ROOT, "docs"),
  path.join(HUSHLINE_DOCS_ROOT, "docs"),
])];
const LOCAL_LOGO = path.join(AGENT_ROOT, "assets", "logo-tips.png");
const TEMPLATES_DIR = path.join(AGENT_ROOT, "templates");

const LIMITS = {
  linkedin: 3000,
  mastodon: 500,
  bluesky: 300,
};

const USER_APPLICATIONS = process.env.HOME
  ? path.join(process.env.HOME, "Applications")
  : null;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  USER_APPLICATIONS && path.join(USER_APPLICATIONS, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  USER_APPLICATIONS && path.join(USER_APPLICATIONS, "Brave Browser.app", "Contents", "MacOS", "Brave Browser"),
].filter(Boolean);

const STOPWORDS = new Set([
  "about",
  "after",
  "align",
  "also",
  "an",
  "and",
  "are",
  "at",
  "auth",
  "but",
  "can",
  "choose",
  "core",
  "does",
  "for",
  "from",
  "full",
  "gap",
  "gaps",
  "has",
  "have",
  "how",
  "into",
  "its",
  "just",
  "line",
  "month",
  "more",
  "new",
  "now",
  "only",
  "our",
  "out",
  "phase",
  "public",
  "remaining",
  "rollout",
  "screen",
  "settings",
  "social",
  "that",
  "the",
  "their",
  "them",
  "this",
  "through",
  "use",
  "user",
  "using",
  "with",
  "wtforms",
]);

const WEEKDAY_LABELS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ARCHIVE_KEY_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseLocalDate(date) {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${date}`);
  }
  return parsed;
}

function parseArchiveKey(archiveKey) {
  const match = String(archiveKey || "").match(ARCHIVE_KEY_PATTERN);
  if (!match) {
    throw new Error(`Invalid archive key: ${archiveKey}`);
  }

  return {
    date: match[1],
    key: match[0],
    suffix: match[2] === undefined ? 0 : Number(match[2]),
  };
}

function archiveKeyDate(archiveKey) {
  return parseArchiveKey(archiveKey).date;
}

function isValidArchiveKey(archiveKey) {
  return ARCHIVE_KEY_PATTERN.test(String(archiveKey || ""));
}

function compareArchiveKeys(left, right) {
  const leftParsed = parseArchiveKey(left);
  const rightParsed = parseArchiveKey(right);

  if (leftParsed.date < rightParsed.date) {
    return -1;
  }

  if (leftParsed.date > rightParsed.date) {
    return 1;
  }

  return leftParsed.suffix - rightParsed.suffix;
}

function getWeekdayLabel(date) {
  return WEEKDAY_LABELS[parseLocalDate(date).getDay()];
}

function isWeekendDate(date) {
  const day = parseLocalDate(date).getDay();
  return day === 0 || day === 6;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function listFilesRecursive(rootDir, predicate = () => true) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const found = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (predicate(nextPath)) {
        found.push(nextPath);
      }
    }
  }

  return found.sort();
}

function findChrome() {
  const executable = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));

  if (!executable) {
    throw new Error("No Chrome-compatible browser was found in /Applications or ~/Applications.");
  }

  return executable;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function uniqueTokens(value) {
  return [...new Set(tokenize(value))];
}

function sharedTokenCount(left, right) {
  const leftSet = new Set(uniqueTokens(left));
  const rightSet = new Set(uniqueTokens(right));
  let count = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      count += 1;
    }
  }

  return count;
}

function sentenceCase(value) {
  return String(value || "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stripFrontmatter(markdown) {
  return String(markdown || "").replace(/^---\n[\s\S]*?\n---\n/, "");
}

function stripMarkdown(markdown) {
  return stripFrontmatter(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerptText(markdown, maxLength = 1800) {
  const text = stripMarkdown(markdown);
  if (text.length <= maxLength) {
    return text;
  }

  const clipped = text.slice(0, maxLength);
  const lastPeriod = clipped.lastIndexOf(". ");
  if (lastPeriod > Math.floor(maxLength * 0.6)) {
    return clipped.slice(0, lastPeriod + 1);
  }

  return `${clipped.trimEnd()}…`;
}

function ensureLatestFoldScreenshot(screenshotPath) {
  const resolved = path.resolve(screenshotPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Screenshot not found: ${resolved}`);
  }

  if (
    !resolved.startsWith(`${SCREENSHOTS_ROOT}${path.sep}`) ||
    !path.basename(resolved).endsWith("-fold.png")
  ) {
    throw new Error(
      `Screenshot must come from the configured screenshots folder (${SCREENSHOTS_ROOT}) and use an above-the-fold \`-fold\` capture.`,
    );
  }

  return resolved;
}

function resolveScreenshotPath(filePath) {
  const candidate = path.isAbsolute(filePath)
    ? filePath
    : path.join(SCREENSHOTS_ROOT, filePath);

  return ensureLatestFoldScreenshot(candidate);
}

function inferScreenKey(item) {
  const pathValue = String(item.path || "").trim().toLowerCase();
  const pathname = pathValue.split("?")[0];
  const onboardingStep = pathValue.match(/[?&]step=([^&]+)/i)?.[1]?.toLowerCase();
  const text = [
    item.title,
    item.content_key,
    item.contentKey,
    item.screenshot_file,
    item.file,
    pathValue,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (pathname === "/directory" || pathValue.startsWith("/directory?")) {
    return "directory-index";
  }

  if (
    /^\/directory\/public-records\/public-record~[^/]+$/.test(pathname) ||
    /\battorney listing\b/.test(text)
  ) {
    return "directory-public-record";
  }

  if (pathname === "/onboarding" || pathValue.startsWith("/onboarding?")) {
    return `onboarding-${onboardingStep || "unknown"}`;
  }

  if (pathname === "/settings/confirm-disable-2fa") {
    return "/settings/auth";
  }

  if (/^\/to\/[^/]+$/.test(pathname)) {
    return "recipient-profile";
  }

  if (/^\/reply\/[^/]+$/.test(pathname)) {
    return "reply-thread";
  }

  if (pathname) {
    return pathname;
  }

  if (/\bdirectory\b/.test(text)) {
    return "directory-index";
  }

  if (/\bprofile\b/.test(text)) {
    return "recipient-profile";
  }

  if (/\bemail[- ]headers\b|\bemail validation\b/.test(text)) {
    return "/email-headers";
  }

  if (/\bvision\b/.test(text)) {
    return "/vision";
  }

  if (/\bencryption\b|\bpgp\b/.test(text)) {
    return "/settings/encryption";
  }

  if (/\bnotification(s)?\b/.test(text)) {
    return "/settings/notifications";
  }

  if (/\balias(es)?\b/.test(text)) {
    return "/settings/aliases";
  }

  if (/\bauthentication\b|\b2fa\b|\btwo[- ]factor\b/.test(text)) {
    return "/settings/auth";
  }

  return normalizeText(item.content_key || item.contentKey || item.file || item.screenshot_file).replaceAll(" ", "-") || "unknown-screen";
}

function detectTemplate(screenshotPath) {
  const filename = path.basename(screenshotPath);

  if (filename.includes("-mobile-")) {
    return "mobile";
  }

  if (filename.includes("-desktop-")) {
    return "desktop";
  }

  throw new Error(`Could not infer template type from screenshot name: ${filename}`);
}

function compareTemplateNames(left, right) {
  const leftBase = /^hushline-daily-(mobile|desktop)-template\.html$/.test(left);
  const rightBase = /^hushline-daily-(mobile|desktop)-template\.html$/.test(right);

  if (leftBase && !rightBase) {
    return -1;
  }

  if (!leftBase && rightBase) {
    return 1;
  }

  return left.localeCompare(right, undefined, { numeric: true });
}

function listTemplateVariants(templateType, templatesDir = TEMPLATES_DIR) {
  const prefix = `hushline-daily-${templateType}-template`;
  const pattern = new RegExp(`^${prefix}(?:-.+)?\\.html$`);

  return fs.readdirSync(templatesDir)
    .filter((name) => pattern.test(name))
    .sort(compareTemplateNames)
    .map((name) => path.join(templatesDir, name));
}

function resolveTemplateVariant(post, screenshotPath, templatesDir = TEMPLATES_DIR) {
  const templateType = detectTemplate(screenshotPath);
  const variants = listTemplateVariants(templateType, templatesDir);

  if (variants.length === 0) {
    throw new Error(`No template variants found for type: ${templateType}`);
  }

  if (post && post.template_name) {
    const explicitTemplatePath = variants.find(
      (variantPath) => path.basename(variantPath) === post.template_name,
    );

    if (!explicitTemplatePath) {
      throw new Error(
        `Requested template ${post.template_name} is not available for type: ${templateType}`,
      );
    }

    return {
      templateName: path.basename(explicitTemplatePath),
      templatePath: explicitTemplatePath,
      templateType,
    };
  }

  const templatePath = variants[Math.floor(Math.random() * variants.length)];

  return {
    templateName: path.basename(templatePath),
    templatePath,
    templateType,
  };
}

function clampText(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) {
    return value;
  }

  const clipped = value.slice(0, Math.max(0, limit - 1)).trimEnd();
  return `${clipped}…`;
}

function execJson(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    ...options,
  });

  return JSON.parse(output);
}

module.exports = {
  AGENT_ROOT,
  ARCHIVE_KEY_PATTERN,
  CHROME_CANDIDATES,
  CURRENT_SCREENSHOTS_ROOT,
  HUSHLINE_DOCS_DIRS,
  HUSHLINE_DOCS_ROOT,
  HUSHLINE_ROOT,
  LIMITS,
  LOCAL_LOGO,
  REPO_ROOT,
  SCREENSHOT_MANIFEST,
  SCREENSHOTS_ROOT,
  TEMPLATES_DIR,
  archiveKeyDate,
  clampText,
  compareArchiveKeys,
  detectTemplate,
  ensureLatestFoldScreenshot,
  excerptText,
  execJson,
  findChrome,
  getWeekdayLabel,
  inferScreenKey,
  isValidArchiveKey,
  isWeekendDate,
  listFilesRecursive,
  listTemplateVariants,
  parseArchiveKey,
  parseLocalDate,
  readJson,
  resolveTemplateVariant,
  resolveScreenshotPath,
  sentenceCase,
  sharedTokenCount,
  stripMarkdown,
  tokenize,
  uniqueTokens,
  writeJson,
};
