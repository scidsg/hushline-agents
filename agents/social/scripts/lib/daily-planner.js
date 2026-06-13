"use strict";

const fs = require("fs");
const path = require("path");
const { renderPost } = require("./render-social-post");
const { buildPlanningContext } = require("./planning-context");
const {
  HUSHLINE_ROOT,
  LIMITS,
  REPO_ROOT,
  TEMPLATES_DIR,
  archiveKeyDate,
  compareArchiveKeys,
  detectTemplate,
  excerptText,
  getWeekdayLabel,
  inferScreenKey,
  isValidArchiveKey,
  isWeekendDate,
  parseLocalDate,
  readJson,
  uniqueTokens,
  writeJson,
} = require("./social-common");

const DAILY_POSTS_ROOT = path.join(REPO_ROOT, "previous-posts");
const ARCHIVE_LOOKBACK_DAYS = 90;
const FEATURE_REPEAT_HARD_LOOKBACK_POSTS = 5;
const EDITORIAL_CRITIC_THRESHOLD = 12;
const DEFAULT_COOLDOWN_POLICY = {
  allow_override: false,
  concept_key_posts: 20,
  cta_posts: 1,
  hook_posts: 30,
  topic_family_posts: 5,
};
const ADMIN_COPY_PATTERNS = [
  /\badmin\b/i,
  /\badmins\b/i,
  /\badministrator\b/i,
  /\badministrators\b/i,
  /\boperator\b/i,
  /\boperators\b/i,
  /\bmoderation\b/i,
  /\bmoderators\b/i,
  /\bteam\b/i,
  /\bteams\b/i,
];
const GENERIC_MESSAGE_TOKENS = new Set([
  "a",
  "account",
  "accounts",
  "admin",
  "admins",
  "an",
  "and",
  "anonymous",
  "app",
  "at",
  "attorney",
  "attorneys",
  "before",
  "browser",
  "by",
  "can",
  "compare",
  "deployment",
  "deployments",
  "contact",
  "decide",
  "directory",
  "download",
  "downloads",
  "encrypted",
  "first",
  "for",
  "form",
  "forms",
  "from",
  "hard",
  "help",
  "hush",
  "hushline",
  "if",
  "in",
  "includes",
  "into",
  "is",
  "it",
  "its",
  "law",
  "lawyer",
  "lawyers",
  "learn",
  "legal",
  "line",
  "listing",
  "listings",
  "lets",
  "location",
  "more",
  "message",
  "messages",
  "need",
  "not",
  "of",
  "on",
  "one",
  "or",
  "out",
  "people",
  "profile",
  "profiles",
  "public",
  "reach",
  "recipient",
  "recipients",
  "right",
  "s",
  "secure",
  "securely",
  "set",
  "sign",
  "so",
  "source",
  "sources",
  "start",
  "starts",
  "submission",
  "submissions",
  "team",
  "teams",
  "that",
  "the",
  "their",
  "there",
  "they",
  "this",
  "to",
  "tips",
  "up",
  "visitor",
  "visitors",
  "visit",
  "want",
  "way",
  "whether",
  "with",
  "you",
  "your",
]);
const HUSHLINE_APP_VOICE_GUIDANCE = [
  "Use practical language from hushline.app: Hush Line is for anonymous, end-to-end encrypted contact and secure first contact, not broad marketing claims.",
  "Keep the message grounded in the people Hush Line serves, such as sources, journalists, lawyers, educators, developers, organizers, and trusted recipients when the screenshot supports that audience.",
  "Prefer concrete platform framing from hushline.app like no app download or account required for sources, a public directory that helps people find the right recipient, and browser-based tools that support real review workflows.",
];
const PLAIN_LANGUAGE_COPY_GUIDANCE = [
  "Use words a Hush Line user would say out loud: tips, messages, email, inbox, notifications, settings, profile, directory, source, recipient, team, admin.",
  "Name the visible choice or task in the screenshot before explaining why it matters.",
  "Prefer direct headings such as `Choose the notifications that work for you` over abstract slogans.",
  "Write complete sentences with a clear subject and verb. If a sentence needs product insider knowledge to understand, rewrite it.",
  "Do not invent internal concepts or labels that are absent from Hush Line materials.",
  "Avoid jargon and abstract business language such as pings, outside signal, surface, frictionless, case file, operationalize, leverage, unlock, or streamline.",
];
const TOPIC_COPY_GUIDANCE = {
  notifications: [
    "For notification screens, say directly that recipients can choose email notifications, Hush Line inbox notifications, and whether encrypted tip contents are included in email.",
    "Do not describe notifications as pings, outside signals, or staff-return mechanisms.",
  ],
};
const BANNED_COPY_PATTERNS = [
  { pattern: /\bping(s|ed|ing)?\b/i, reason: "uses `ping`, which is business jargon" },
  { pattern: /\bcase files?\b/i, reason: "uses `case file`, which is not Hush Line language" },
  { pattern: /\bcase review\b/i, reason: "uses `case review`, which is not Hush Line language" },
  { pattern: /\boutside signals?\b/i, reason: "uses `outside signal`, which is unclear jargon" },
  { pattern: /\bminimum outside\b/i, reason: "uses `minimum outside`, which is unclear jargon" },
  { pattern: /\bstaff back to\b/i, reason: "uses an indirect staff-return framing instead of naming the feature" },
  { pattern: /\bsurface(s|d|ing)?\b/i, reason: "uses `surface` as product jargon" },
  { pattern: /\bfrictionless\b/i, reason: "uses generic marketing jargon" },
  { pattern: /\boperationalize(s|d|ing)?\b/i, reason: "uses abstract business jargon" },
  { pattern: /\bleverage(s|d|ing)?\b/i, reason: "uses abstract business jargon" },
  { pattern: /\bunlock(s|ed|ing)?\b/i, reason: "uses generic marketing jargon" },
  { pattern: /\bstreamline(s|d|ing)?\b/i, reason: "uses generic business jargon" },
];
const NOTIFICATION_COPY_PATTERNS = [
  /\bnotification(s)?\b/i,
  /\bemail\b/i,
  /\binbox\b/i,
  /\bencrypted\b/i,
];
const AUDIENCE_SPECIFICITY_PATTERNS = {
  "admin-only": [
    /\badmin(s|istrator|istrators)?\b/i,
    /\bdeployment(s)?\b/i,
    /\boperator(s)?\b/i,
    /\bteam(s)?\b/i,
  ],
  public: [
    /\bsource(s)?\b/i,
    /\bvisitor(s)?\b/i,
    /\bpublic\b/i,
    /\btip(s)?\b/i,
    /\bfind\b/i,
    /\brecipient(s)?\b/i,
  ],
  "recipient-shared": [
    /\brecipient(s)?\b/i,
    /\bstaff\b/i,
    /\binbox\b/i,
    /\bmessage(s)?\b/i,
    /\breview\b/i,
    /\bintake\b/i,
  ],
};
const CONCRETE_VALUE_PATTERNS = [
  /\bbefore\b/i,
  /\bcheck\b/i,
  /\bchoose\b/i,
  /\bcompare\b/i,
  /\bdecide\b/i,
  /\bdownload\b/i,
  /\bfind\b/i,
  /\bmanage\b/i,
  /\breview\b/i,
  /\bsend\b/i,
  /\bset up\b/i,
  /\bverify\b/i,
];
const HUSHLINE_RELEVANCE_PATTERNS = [
  /\bHush Line\b/i,
  /https:\/\/hushline\.app\b/i,
  /\banonymous\b/i,
  /\bdirectory\b/i,
  /\bencrypted\b/i,
  /\binbox\b/i,
  /\bmessage(s)?\b/i,
  /\bprofile(s)?\b/i,
  /\btip line\b/i,
];
const SAFETY_RISK_PATTERNS = [
  /\bguarantee(s|d)? anonymity\b/i,
  /\bcompletely anonymous\b/i,
  /\bunbreakable\b/i,
  /\bmilitary[- ]grade\b/i,
  /\bzero risk\b/i,
  /\bnewly released\b/i,
  /\bjust shipped\b/i,
  /\brecently launched\b/i,
];
const CONTENT_FORMAT_WEEKLY_CAP = 1;
const CONTENT_FORMATS = Object.freeze([
  {
    cta_guidance: "Close with a next step that matches the checklist, not a generic product slogan.",
    id: "source_safety_checklist",
    label: "Source safety checklist",
    copy_guidance: "Write as a short practical checklist for a person deciding whether and how to make first contact safely.",
    alt_text_guidance: "Describe the UI and the checklist context the asset is illustrating.",
  },
  {
    cta_guidance: "Close with a recipient-oriented action, such as setting up or reviewing the relevant workflow.",
    id: "recipient_playbook",
    label: "Recipient playbook",
    copy_guidance: "Write like an operational playbook for recipients or staff who need to manage sensitive intake repeatedly.",
    alt_text_guidance: "Describe the screen as part of a recipient workflow, including the visible controls or state.",
  },
  {
    cta_guidance: "Close by connecting the principle to a concrete Hush Line action or learning path.",
    id: "iso_37002_principle",
    label: "ISO 37002 principle",
    copy_guidance: "Tie the screenshot to one plain-English whistleblowing-system principle without sounding academic.",
    alt_text_guidance: "Describe the asset and the principle it is demonstrating in accessible language.",
  },
  {
    cta_guidance: "Close with how to avoid the mistake or where to learn the safer path.",
    id: "mistake_to_avoid",
    label: "Mistake to avoid",
    copy_guidance: "Open with a realistic mistake a source, recipient, or admin could make, then explain the safer workflow.",
    alt_text_guidance: "Describe the visual as an example of the safer workflow that avoids the mistake.",
  },
  {
    cta_guidance: "Close by inviting the reader to use the corrected understanding in Hush Line.",
    id: "myth_vs_reality",
    label: "Myth versus reality",
    copy_guidance: "Contrast one common misconception with a concrete reality shown or supported by the screenshot.",
    alt_text_guidance: "Describe the UI and the misconception/reality comparison the graphic supports.",
  },
  {
    cta_guidance: "Close with a workflow-specific next step instead of a broad sign-up line when possible.",
    id: "workflow_teardown",
    label: "Workflow teardown",
    copy_guidance: "Walk through one workflow moment: what the user is trying to decide, what the UI shows, and what happens next.",
    alt_text_guidance: "Describe the relevant UI elements in the order a user would encounter them.",
  },
  {
    cta_guidance: "Close by linking the design choice to a concrete reader benefit.",
    id: "design_principle",
    label: "Design principle",
    copy_guidance: "Explain one product design choice and why it matters for privacy, trust, accessibility, or operational safety.",
    alt_text_guidance: "Describe the visible design choice and the user-facing context.",
  },
  {
    cta_guidance: "Close with the most relevant product action for the audience and screen.",
    id: "feature_benefit",
    label: "Feature benefit",
    copy_guidance: "Explain the feature through the specific user benefit it creates, avoiding release-note language.",
    alt_text_guidance: "Describe the final social asset and the feature being shown.",
  },
]);
const EDITORIAL_AUDIENCES = Object.freeze([
  {
    audience_scope: "public",
    label: "Public sources and visitors",
    reader_need: "Help someone decide whether Hush Line is the right place to make safe first contact or find a trusted recipient.",
  },
  {
    audience_scope: "recipient-shared",
    label: "Recipients and staff",
    reader_need: "Help a recipient or staff member improve a repeatable sensitive-intake workflow.",
  },
  {
    audience_scope: "admin-only",
    label: "Admins and deployment teams",
    reader_need: "Help an admin or deployment team run Hush Line responsibly without weakening safety or trust.",
  },
]);

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatIsoWeek(date) {
  const cursor = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil((((cursor - yearStart) / 86400000) + 1) / 7);
  return `${cursor.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`;
}

function inferAudienceScopeFromEntry(entry) {
  if (entry.audience_scope) {
    return entry.audience_scope;
  }

  const screenshotFile = String(entry.screenshot_file || entry.file || "");
  if (screenshotFile.startsWith("admin/")) {
    return "admin-only";
  }

  return null;
}

function inferThemeFromEntry(entry) {
  if (entry.theme === "light" || entry.theme === "dark") {
    return entry.theme;
  }

  const screenshotFile = String(entry.screenshot_file || entry.file || "");
  if (/-dark-fold\.png$/i.test(screenshotFile)) {
    return "dark";
  }

  if (/-light-fold\.png$/i.test(screenshotFile)) {
    return "light";
  }

  return null;
}

function getContentFormat(formatId) {
  return CONTENT_FORMATS.find((format) => format.id === formatId) || null;
}

function contentFormatIds() {
  return CONTENT_FORMATS.map((format) => format.id);
}

function getEditorialAudience(audienceScope) {
  return EDITORIAL_AUDIENCES.find((audience) => audience.audience_scope === audienceScope) || null;
}

function normalizeConceptKey(contentKey) {
  return String(contentKey || "")
    .replace(/^(auth-(admin|artvandelay|newman)|guest)-/, "")
    .replace(/^-+/, "");
}

function inferTopicFamily(item) {
  const pathValue = String(item.path || "");
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

  if (/\bdirectory\b/.test(text) || /^\/directory\b/.test(pathValue)) {
    return "directory";
  }

  if (/\bencryption\b|\bpgp\b/.test(text) || /^\/settings\/encryption\b/.test(pathValue)) {
    return "encryption";
  }

  if (/\bnotification(s)?\b/.test(text) || /^\/settings\/notifications\b/.test(pathValue)) {
    return "notifications";
  }

  if (
    /\bauthentication\b|\b2fa\b|\btwo[- ]factor\b|\bsettings[- ]auth\b/.test(text) ||
    /^\/settings\/auth\b/.test(pathValue)
  ) {
    return "authentication";
  }

  if (/\balias(es)?\b/.test(text) || /^\/settings\/aliases\b/.test(pathValue)) {
    return "aliases";
  }

  if (/\bguidance\b/.test(text) || /^\/settings\/guidance\b/.test(pathValue)) {
    return "guidance";
  }

  if (/\bregistration\b/.test(text) || /^\/settings\/registration\b/.test(pathValue)) {
    return "registration";
  }

  if (/\bbranding\b/.test(text) || /^\/settings\/branding\b/.test(pathValue)) {
    return "branding";
  }

  if (/\bmessage statuses\b|\breplies\b/.test(text) || /^\/settings\/replies\b/.test(pathValue)) {
    return "message-statuses";
  }

  if (/\bvision\b/.test(text) || /^\/vision\b/.test(pathValue)) {
    return "vision";
  }

  if (/\bemail[- ]headers\b/.test(text) || /^\/email-headers\b/.test(pathValue)) {
    return "email-headers";
  }

  if (/\bprofile\b/.test(text) || /^\/to\//.test(pathValue) || /^\/settings\/profile\b/.test(pathValue)) {
    return "profile";
  }

  if (/\bonboarding\b/.test(text) || /^\/onboarding\b/.test(pathValue)) {
    return "onboarding";
  }

  return normalizeConceptKey(item.content_key || item.contentKey);
}

function parseCooldownCount(value, name) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > ARCHIVE_LOOKBACK_DAYS) {
    throw new Error(`\`${name}\` must be an integer from 0 to ${ARCHIVE_LOOKBACK_DAYS}.`);
  }

  return parsed;
}

function envFlag(name) {
  return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function buildCooldownPolicy(overrides = {}) {
  return {
    allow_override: Boolean(overrides.allow_override || envFlag("HUSHLINE_SOCIAL_ALLOW_COOLDOWN_OVERRIDE")),
    concept_key_posts: overrides.concept_key_posts ?? (
      process.env.HUSHLINE_SOCIAL_CONCEPT_KEY_COOLDOWN_POSTS
        ? parseCooldownCount(process.env.HUSHLINE_SOCIAL_CONCEPT_KEY_COOLDOWN_POSTS, "HUSHLINE_SOCIAL_CONCEPT_KEY_COOLDOWN_POSTS")
        : DEFAULT_COOLDOWN_POLICY.concept_key_posts
    ),
    cta_posts: overrides.cta_posts ?? (
      process.env.HUSHLINE_SOCIAL_CTA_COOLDOWN_POSTS
        ? parseCooldownCount(process.env.HUSHLINE_SOCIAL_CTA_COOLDOWN_POSTS, "HUSHLINE_SOCIAL_CTA_COOLDOWN_POSTS")
        : DEFAULT_COOLDOWN_POLICY.cta_posts
    ),
    hook_posts: overrides.hook_posts ?? (
      process.env.HUSHLINE_SOCIAL_HOOK_COOLDOWN_POSTS
        ? parseCooldownCount(process.env.HUSHLINE_SOCIAL_HOOK_COOLDOWN_POSTS, "HUSHLINE_SOCIAL_HOOK_COOLDOWN_POSTS")
        : DEFAULT_COOLDOWN_POLICY.hook_posts
    ),
    topic_family_posts: overrides.topic_family_posts ?? (
      process.env.HUSHLINE_SOCIAL_TOPIC_FAMILY_COOLDOWN_POSTS
        ? parseCooldownCount(process.env.HUSHLINE_SOCIAL_TOPIC_FAMILY_COOLDOWN_POSTS, "HUSHLINE_SOCIAL_TOPIC_FAMILY_COOLDOWN_POSTS")
        : DEFAULT_COOLDOWN_POLICY.topic_family_posts
    ),
  };
}

function parseArgs(argv) {
  const args = {
    allowCooldownOverride: false,
    archiveKey: null,
    candidateCount: 12,
    conceptKeyCooldownPosts: null,
    ctaCooldownPosts: null,
    darkRatio: 0.2,
    date: todayString(),
    excludeScreenshots: [],
    hookCooldownPosts: null,
    noRender: false,
    topicFamilyCooldownPosts: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--date") {
      args.date = argv[index + 1];
      index += 1;
    } else if (value === "--archive-key") {
      args.archiveKey = argv[index + 1];
      index += 1;
    } else if (value === "--candidate-count") {
      args.candidateCount = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--dark-ratio") {
      args.darkRatio = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--exclude-screenshot") {
      args.excludeScreenshots.push(String(argv[index + 1] || ""));
      index += 1;
    } else if (value === "--topic-family-cooldown-posts") {
      args.topicFamilyCooldownPosts = parseCooldownCount(argv[index + 1], "--topic-family-cooldown-posts");
      index += 1;
    } else if (value === "--concept-key-cooldown-posts") {
      args.conceptKeyCooldownPosts = parseCooldownCount(argv[index + 1], "--concept-key-cooldown-posts");
      index += 1;
    } else if (value === "--hook-cooldown-posts") {
      args.hookCooldownPosts = parseCooldownCount(argv[index + 1], "--hook-cooldown-posts");
      index += 1;
    } else if (value === "--cta-cooldown-posts") {
      args.ctaCooldownPosts = parseCooldownCount(argv[index + 1], "--cta-cooldown-posts");
      index += 1;
    } else if (value === "--allow-cooldown-override") {
      args.allowCooldownOverride = true;
    } else if (value === "--no-render") {
      args.noRender = true;
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

  if (!Number.isInteger(args.candidateCount) || args.candidateCount < 4 || args.candidateCount > 20) {
    throw new Error("`--candidate-count` must be an integer from 4 to 20.");
  }

  if (Number.isNaN(args.darkRatio) || args.darkRatio < 0 || args.darkRatio > 1) {
    throw new Error("`--dark-ratio` must be a number from 0 to 1.");
  }

  args.excludeScreenshots = Array.from(
    new Set(args.excludeScreenshots.filter((value) => value.length > 0)),
  );
  args.cooldownPolicy = buildCooldownPolicy({
    allow_override: args.allowCooldownOverride,
    concept_key_posts: args.conceptKeyCooldownPosts,
    cta_posts: args.ctaCooldownPosts,
    hook_posts: args.hookCooldownPosts,
    topic_family_posts: args.topicFamilyCooldownPosts,
  });

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/plan-day.js --date 2026-03-19",
      "  node scripts/plan-day.js --date 2026-03-19 --candidate-count 12",
      "  node scripts/plan-day.js --date 2026-03-19 --archive-key 2026-03-19-1",
      "  node scripts/plan-day.js --date 2026-03-19 --topic-family-cooldown-posts 5",
      "",
      "Behavior:",
      "  - Reads audience context from Hush Line docs and ../hushline/AGENTS.md",
      "  - Builds an eligible screenshot pool from the local curated hushline-screenshots set when available",
      "  - Randomly preselects one screenshot after excluding recent repeats of the same screen",
      "  - Enforces hard cooldowns for repeated topic families, concepts, hooks, and CTA patterns",
      "  - Writes daily planning context and a Codex prompt to previous-posts/<archive-key>",
      "  - Expects one high-value post for the requested day",
      "",
    ].join("\n"),
  );
}

function withinArchiveWindow(archiveDate, currentDate) {
  const diffDays = Math.floor((currentDate.getTime() - archiveDate.getTime()) / 86400000);
  return diffDays > 0 && diffDays <= ARCHIVE_LOOKBACK_DAYS;
}

function buildMessageText(entry) {
  return [
    entry.headline,
    entry.subtext,
    entry.linkedin_copy,
    entry.mastodon_copy,
    entry.bluesky_copy,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPostCopyText(post) {
  const social = post.social || {};

  return [
    post.headline,
    post.subtext,
    social.linkedin,
    social.mastodon,
    social.bluesky,
  ]
    .filter(Boolean)
    .join(" ");
}

function validatePlainLanguageCopy(post, candidate, context) {
  const copyText = buildPostCopyText(post);
  const bannedMatch = BANNED_COPY_PATTERNS.find(({ pattern }) => pattern.test(copyText));

  if (bannedMatch) {
    throw new Error(
      `Post copy for ${context.date} uses banned jargon: ${bannedMatch.reason}.`,
    );
  }

  if (
    (candidate.topic_family || inferTopicFamily(candidate)) === "notifications" &&
    !NOTIFICATION_COPY_PATTERNS.some((pattern) => pattern.test(copyText))
  ) {
    throw new Error(
      `Notification post copy for ${context.date} must directly describe notification, email, inbox, or encrypted-message choices.`,
    );
  }
}

function messageTokens(value) {
  return uniqueTokens(value).filter((token) => !GENERIC_MESSAGE_TOKENS.has(token));
}

function sharedMessageTokenCount(left, right) {
  const leftSet = new Set(messageTokens(left));
  const rightSet = new Set(messageTokens(right));
  let count = 0;

  for (const token of leftSet) {
    if (rightSet.has(token)) {
      count += 1;
    }
  }

  return count;
}

function normalizeMessageLine(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .trim();
}

function splitParagraphs(value) {
  return String(value || "")
    .split(/\n\s*\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function firstSentence(value) {
  const paragraph = splitParagraphs(value)[0] || String(value || "").replace(/\s+/g, " ").trim();
  const match = paragraph.match(/^(.+?[.!?])(?:\s|$)/);
  return (match ? match[1] : paragraph).trim();
}

function lastParagraph(value) {
  const paragraphs = splitParagraphs(value);
  return paragraphs[paragraphs.length - 1] || "";
}

function normalizePhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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

function buildPlanText(post) {
  return [
    post.headline,
    post.subtext,
    post.image_alt_text,
    post.rationale,
    post.social?.linkedin,
    post.social?.mastodon,
    post.social?.bluesky,
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreCriterion(id, label, score, max_score, rationale) {
  return {
    id,
    label,
    max_score,
    rationale,
    score: Math.max(0, Math.min(max_score, score)),
  };
}

function countPatternMatches(value, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(value) ? 1 : 0), 0);
}

function hasRecentMatch(entries, count, predicate) {
  return recentArchiveEntries(entries, count).some(predicate);
}

function cooldownWindow(value, fallback) {
  const resolved = value ?? fallback;
  return Number.isInteger(resolved) && resolved > 0 ? resolved : 0;
}

function scoreEditorialCritic(validatedPlan, context) {
  const post = validatedPlan.post || {};
  const archiveHistory = context.recent_archive_history || [];
  const text = buildPlanText(post);
  const linkedinText = post.social?.linkedin || text;
  const currentHookPattern = normalizePhrase(firstSentence(linkedinText || text));
  const currentCtaPattern = classifyCta(linkedinText || text);
  const currentTopicFamily = post.topic_family || inferTopicFamily(post);
  const currentAudience = post.audience_scope || context.editorial_intent?.audience_scope || "";
  const currentFormat = post.content_format || "";
  const criteria = [];

  const recentTopicMatch5 = hasRecentMatch(
    archiveHistory,
    5,
    (entry) => entry.topic_family && entry.topic_family === currentTopicFamily,
  );
  const recentTopicMatch2 = hasRecentMatch(
    archiveHistory,
    2,
    (entry) => entry.topic_family && entry.topic_family === currentTopicFamily,
  );
  criteria.push(scoreCriterion(
    "topic_freshness",
    "Topic freshness",
    recentTopicMatch2 ? 0 : recentTopicMatch5 ? 1 : 2,
    2,
    recentTopicMatch2
      ? `Topic family ${currentTopicFamily || "unknown"} appeared in the last two posts.`
      : recentTopicMatch5
        ? `Topic family ${currentTopicFamily || "unknown"} appeared recently but not in the last two posts.`
        : `Topic family ${currentTopicFamily || "unknown"} is fresh against the recent archive.`,
  ));

  const hookWindow = cooldownWindow(context.cooldown_policy?.hook_posts, DEFAULT_COOLDOWN_POLICY.hook_posts);
  const repeatedHook = hookWindow > 0 && currentHookPattern && hasRecentMatch(
    archiveHistory,
    hookWindow,
    (entry) => archiveEntryHookPattern(entry) === currentHookPattern,
  );
  criteria.push(scoreCriterion(
    "hook_freshness",
    "Hook freshness",
    repeatedHook ? 0 : 2,
    2,
    hookWindow === 0
      ? "Opening hook freshness check is disabled by cooldown policy."
      : repeatedHook ? "Opening hook repeats recent archive language." : "Opening hook is distinct from recent archive hooks.",
  ));

  const recentFormatMatch3 = hasRecentMatch(
    archiveHistory,
    3,
    (entry) => entry.content_format && entry.content_format === currentFormat,
  );
  const lastFormatMatch = hasRecentMatch(
    archiveHistory,
    1,
    (entry) => entry.content_format && entry.content_format === currentFormat,
  );
  criteria.push(scoreCriterion(
    "format_novelty",
    "Format novelty",
    lastFormatMatch ? 0 : recentFormatMatch3 ? 1 : 2,
    2,
    lastFormatMatch
      ? `Format ${currentFormat || "unknown"} was used in the last post.`
      : recentFormatMatch3
        ? `Format ${currentFormat || "unknown"} appeared in the last three posts.`
        : `Format ${currentFormat || "unknown"} is not overused in the recent archive.`,
  ));

  const audiencePatterns = AUDIENCE_SPECIFICITY_PATTERNS[currentAudience] || [];
  const audienceMatches = countPatternMatches(text, audiencePatterns);
  criteria.push(scoreCriterion(
    "audience_specificity",
    "Audience specificity",
    audienceMatches >= 2 ? 2 : audienceMatches === 1 ? 1 : 0,
    2,
    audienceMatches > 0
      ? `Copy contains ${audienceMatches} signal(s) for ${currentAudience || "the selected audience"}.`
      : `Copy does not clearly name or signal ${currentAudience || "the selected audience"}.`,
  ));

  const concreteValueMatches = countPatternMatches(text, CONCRETE_VALUE_PATTERNS);
  const textTokenCount = messageTokens(text).length;
  criteria.push(scoreCriterion(
    "concrete_reader_value",
    "Concrete reader value",
    concreteValueMatches >= 2 && textTokenCount >= 10 ? 2 : concreteValueMatches >= 1 ? 1 : 0,
    2,
    concreteValueMatches > 0
      ? `Copy gives ${concreteValueMatches} concrete action/value signal(s).`
      : "Copy does not give the reader a concrete action or decision point.",
  ));

  const hushlineMatches = countPatternMatches(text, HUSHLINE_RELEVANCE_PATTERNS);
  criteria.push(scoreCriterion(
    "hushline_relevance",
    "Hush Line relevance",
    /\bHush Line\b/i.test(text) || /https:\/\/hushline\.app\b/i.test(text) ? 2 : hushlineMatches > 0 ? 1 : 0,
    2,
    hushlineMatches > 0 ? "Copy is tied to Hush Line or a concrete Hush Line surface." : "Copy could apply to a generic product.",
  ));

  const ctaWindow = cooldownWindow(context.cooldown_policy?.cta_posts, DEFAULT_COOLDOWN_POLICY.cta_posts);
  const repeatedCta = ctaWindow > 0 && currentCtaPattern !== "none" && hasRecentMatch(
    archiveHistory,
    ctaWindow,
    (entry) => archiveEntryCtaPattern(entry) === currentCtaPattern,
  );
  criteria.push(scoreCriterion(
    "cta_freshness",
    "CTA freshness",
    repeatedCta ? 0 : 2,
    2,
    ctaWindow === 0
      ? "CTA freshness check is disabled by cooldown policy."
      : repeatedCta ? "CTA pattern repeats a recent archive CTA." : "CTA pattern is fresh against the configured CTA cooldown.",
  ));

  const safetyRisks = SAFETY_RISK_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
  criteria.push(scoreCriterion(
    "safety_compliance",
    "Safety and compliance",
    safetyRisks.length > 0 ? 0 : 2,
    2,
    safetyRisks.length > 0
      ? "Copy includes unsupported safety, anonymity, or recency claims."
      : "Copy avoids unsupported safety, anonymity, and recency claims.",
  ));

  const totalScore = criteria.reduce((sum, criterion) => sum + criterion.score, 0);
  const maxScore = criteria.reduce((sum, criterion) => sum + criterion.max_score, 0);
  const failedCriteria = criteria.filter((criterion) => criterion.score === 0);

  return {
    blocked: totalScore < EDITORIAL_CRITIC_THRESHOLD,
    criteria,
    failed_criteria: failedCriteria.map((criterion) => criterion.id),
    max_score: maxScore,
    passed: totalScore >= EDITORIAL_CRITIC_THRESHOLD,
    rationale: criteria.map((criterion) => `${criterion.label}: ${criterion.rationale}`).join(" "),
    score: totalScore,
    threshold: EDITORIAL_CRITIC_THRESHOLD,
  };
}

function assertEditorialCriticPass(validatedPlan, context) {
  const critic = scoreEditorialCritic(validatedPlan, context);
  if (!critic.passed) {
    const failed = critic.failed_criteria.length > 0
      ? ` Failed criteria: ${critic.failed_criteria.join(", ")}.`
      : "";
    const error = new Error(
      `Editorial critic score ${critic.score}/${critic.max_score} is below threshold ${critic.threshold}.${failed} ${critic.rationale}`,
    );
    error.critic = critic;
    throw error;
  }

  return critic;
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || "");

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function candidateRotationIdentity(candidate) {
  return String(candidate.file || candidate.screenshot_file || candidate.content_key || "");
}

function archiveRotationIdentity(entry) {
  return String(entry.screenshot_file || entry.content_key || "");
}

function lastTemplateUseOffset(archiveHistory, templateName) {
  for (let index = archiveHistory.length - 1; index >= 0; index -= 1) {
    if (archiveHistory[index].template_name === templateName) {
      return archiveHistory.length - index;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function averageTemplateUsageForType(archiveHistory, templateNames, templateType) {
  const matching = templateNames.filter((name) => templateTypeForName(name) === templateType);
  if (matching.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const total = matching.reduce((sum, templateName) => {
    return sum + archiveHistory.filter((entry) => entry.template_name === templateName).length;
  }, 0);

  return total / matching.length;
}

function summarizeCandidateHistory(candidate, archiveHistory) {
  const normalized = {
    ...candidate,
    screen_key: candidate.screen_key || inferScreenKey(candidate),
    topic_family: candidate.topic_family || inferTopicFamily(candidate),
  };
  const stats = {
    candidate: normalized,
    content_matches: 0,
    exact_screenshot_matches: 0,
    novelty_penalty: 0,
    screen_matches: 0,
    topic_matches: 0,
  };

  archiveHistory.forEach((entry, index) => {
    const recencyWeight = archiveHistory.length - index;

    if (entry.screenshot_file && entry.screenshot_file === normalized.file) {
      stats.exact_screenshot_matches += 1;
      stats.novelty_penalty += 12000 * recencyWeight;
    }

    if (entry.content_key && entry.content_key === normalized.content_key) {
      stats.content_matches += 1;
      stats.novelty_penalty += 6000 * recencyWeight;
    }

    if (entry.screen_key && entry.screen_key === normalized.screen_key) {
      stats.screen_matches += 1;
      stats.novelty_penalty += 4000 * recencyWeight;
    }

    if (entry.topic_family && entry.topic_family === normalized.topic_family) {
      stats.topic_matches += 1;
      stats.novelty_penalty += 1500 * recencyWeight;
    }
  });

  return stats;
}

function summarizeWeeklyUsage(archiveHistory, plannedDate) {
  const week = formatIsoWeek(parseLocalDate(plannedDate));

  return archiveHistory.reduce((summary, entry) => {
    if (!entry.date || formatIsoWeek(parseLocalDate(entry.date)) !== week) {
      return summary;
    }

    if (inferAudienceScopeFromEntry(entry) === "admin-only") {
      summary.admin_count += 1;
    }

    if (inferThemeFromEntry(entry) === "dark") {
      summary.dark_count += 1;
    }

    return summary;
  }, {
    admin_count: 0,
    dark_count: 0,
    week,
  });
}

function summarizeWeeklyContentFormatUsage(archiveHistory, plannedDate) {
  const week = formatIsoWeek(parseLocalDate(plannedDate));

  return (archiveHistory || []).reduce((summary, entry) => {
    if (!entry.date || formatIsoWeek(parseLocalDate(entry.date)) !== week || !entry.content_format) {
      return summary;
    }

    summary.counts[entry.content_format] = (summary.counts[entry.content_format] || 0) + 1;
    return summary;
  }, {
    counts: {},
    week,
  });
}

function lastContentFormatUseOffset(archiveHistory, formatId) {
  for (let index = archiveHistory.length - 1; index >= 0; index -= 1) {
    if (archiveHistory[index].content_format === formatId) {
      return archiveHistory.length - index;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function chooseContentFormat(archiveHistory, plannedDate, options = {}) {
  const weeklyCap = options.weeklyCap || CONTENT_FORMAT_WEEKLY_CAP;
  const weeklyUsage = summarizeWeeklyContentFormatUsage(archiveHistory, plannedDate);
  let candidates = CONTENT_FORMATS.filter((format) => {
    return (weeklyUsage.counts[format.id] || 0) < weeklyCap;
  });

  if (candidates.length === 0) {
    throw new Error(
      `No eligible content formats remain for ${weeklyUsage.week}; each format is capped at ${weeklyCap} use per week.`,
    );
  }

  const recentHistory = (archiveHistory || []).slice(-30);
  candidates = candidates
    .map((format) => ({
      ...format,
      last_used_offset: lastContentFormatUseOffset(archiveHistory || [], format.id),
      recent_count: recentHistory.filter((entry) => entry.content_format === format.id).length,
      weekly_count: weeklyUsage.counts[format.id] || 0,
    }))
    .sort((left, right) => {
      return (
        left.weekly_count - right.weekly_count ||
        left.recent_count - right.recent_count ||
        right.last_used_offset - left.last_used_offset ||
        left.id.localeCompare(right.id)
      );
    });

  return {
    available_formats: CONTENT_FORMATS,
    selected_format: getContentFormat(candidates[0].id),
    weekly_cap: weeklyCap,
    weekly_usage: weeklyUsage,
  };
}

function validateContentFormatSelection(contentFormat, context) {
  const selectedFormat = context.content_format_selection?.selected_format;
  const format = getContentFormat(contentFormat);

  if (!format) {
    throw new Error(`Unknown content format: ${contentFormat || "missing"}.`);
  }

  if (selectedFormat && contentFormat !== selectedFormat.id) {
    throw new Error(
      `Model returned content_format ${contentFormat}, expected ${selectedFormat.id}.`,
    );
  }

  const weeklyCap = context.content_format_selection?.weekly_cap || CONTENT_FORMAT_WEEKLY_CAP;
  const weeklyUsage = summarizeWeeklyContentFormatUsage(
    context.recent_archive_history || [],
    context.date,
  );
  const currentCount = weeklyUsage.counts[contentFormat] || 0;

  if (currentCount >= weeklyCap) {
    throw new Error(
      `Content format ${contentFormat} already reached the weekly cap for ${weeklyUsage.week}.`,
    );
  }

  return format;
}

function summarizeAudienceUsage(archiveHistory, plannedDate) {
  const week = formatIsoWeek(parseLocalDate(plannedDate));

  return (archiveHistory || []).reduce((summary, entry) => {
    const audienceScope = inferAudienceScopeFromEntry(entry);
    if (!audienceScope) {
      return summary;
    }

    summary.recent_counts[audienceScope] = (summary.recent_counts[audienceScope] || 0) + 1;

    if (entry.date && formatIsoWeek(parseLocalDate(entry.date)) === week) {
      summary.weekly_counts[audienceScope] = (summary.weekly_counts[audienceScope] || 0) + 1;
    }

    return summary;
  }, {
    recent_counts: {},
    week,
    weekly_counts: {},
  });
}

function lastAudienceUseOffset(archiveHistory, audienceScope) {
  for (let index = archiveHistory.length - 1; index >= 0; index -= 1) {
    if (inferAudienceScopeFromEntry(archiveHistory[index]) === audienceScope) {
      return archiveHistory.length - index;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function rankEditorialIntents(archiveHistory, plannedDate, contentFormatSelection) {
  const weeklyUsage = summarizeWeeklyUsage(archiveHistory, plannedDate);
  const audienceUsage = summarizeAudienceUsage(archiveHistory, plannedDate);
  const contentFormat = contentFormatSelection?.selected_format || getContentFormat("feature_benefit");

  return EDITORIAL_AUDIENCES
    .filter((audience) => {
      return audience.audience_scope !== "admin-only" || weeklyUsage.admin_count < 1;
    })
    .map((audience) => ({
      ...audience,
      content_format: contentFormat.id,
      content_format_label: contentFormat.label,
      last_used_offset: lastAudienceUseOffset(archiveHistory || [], audience.audience_scope),
      recent_count: audienceUsage.recent_counts[audience.audience_scope] || 0,
      visual_role: "supporting_screenshot",
      weekly_count: audienceUsage.weekly_counts[audience.audience_scope] || 0,
    }))
    .sort((left, right) => {
      return (
        left.weekly_count - right.weekly_count ||
        left.recent_count - right.recent_count ||
        right.last_used_offset - left.last_used_offset ||
        left.audience_scope.localeCompare(right.audience_scope)
      );
    });
}

function filterCandidatesForEditorialIntent(candidates, editorialIntent) {
  if (!editorialIntent?.audience_scope) {
    return candidates;
  }

  return candidates.filter((candidate) => candidate.audience_scope === editorialIntent.audience_scope);
}

function chooseSupportedEditorialIntent(archiveHistory, plannedDate, contentFormatSelection, candidates) {
  const rankedIntents = rankEditorialIntents(archiveHistory, plannedDate, contentFormatSelection);
  const rejectedIntents = [];

  for (const intent of rankedIntents) {
    const supportingCandidates = filterCandidatesForEditorialIntent(candidates, intent);

    if (supportingCandidates.length > 0) {
      return {
        intent: {
          audience_scope: intent.audience_scope,
          content_format: intent.content_format,
          content_format_label: intent.content_format_label,
          label: intent.label,
          reader_need: intent.reader_need,
          visual_role: intent.visual_role,
        },
        rejected_intents: rejectedIntents,
        supporting_candidates: supportingCandidates,
        visual_selection_reason: `Selected screenshots only after choosing the ${intent.label} editorial intent.`,
      };
    }

    rejectedIntents.push({
      audience_scope: intent.audience_scope,
      reason: "No cooldown-eligible screenshot supports this editorial intent.",
    });
  }

  throw new Error("No eligible screenshot candidates support any editorial intent.");
}

function recentArchiveEntries(archiveHistory, count) {
  if (!count) {
    return [];
  }

  return (archiveHistory || []).slice(-count);
}

function archiveEntryHookPattern(entry) {
  return entry.hook_pattern || normalizePhrase(firstSentence(entry.linkedin_copy || buildMessageText(entry)));
}

function archiveEntryCtaPattern(entry) {
  return entry.cta_pattern || classifyCta(entry.linkedin_copy || buildMessageText(entry));
}

function loadArchiveHistory(currentArchiveKey) {
  if (!fs.existsSync(DAILY_POSTS_ROOT)) {
    return [];
  }
  const currentDate = parseLocalDate(archiveKeyDate(currentArchiveKey));

  return fs
    .readdirSync(DAILY_POSTS_ROOT, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() &&
        isValidArchiveKey(entry.name) &&
        compareArchiveKeys(entry.name, currentArchiveKey) < 0 &&
        withinArchiveWindow(parseLocalDate(archiveKeyDate(entry.name)), currentDate),
    )
    .map((entry) => entry.name)
    .sort(compareArchiveKeys)
    .map((archiveKey) => {
      const postPath = path.join(DAILY_POSTS_ROOT, archiveKey, "post.json");
      const postCopyPath = path.join(DAILY_POSTS_ROOT, archiveKey, "post-copy.txt");
      let post = null;

      if (fs.existsSync(postPath)) {
        post = readJson(postPath);
      }

      if (!post && !fs.existsSync(postCopyPath)) {
        return null;
      }
      const postCopy = fs.existsSync(postCopyPath)
        ? fs.readFileSync(postCopyPath, "utf8")
        : "";
      const templateMatch = postCopy.match(/^Template:\s+(.+)$/m);
      const social = post && post.social && typeof post.social === "object"
        ? post.social
        : {};

      return {
        audience_scope: (post && post.audience_scope) || "",
        archive_key: archiveKey,
        bluesky_copy: social.bluesky || "",
        concept_key: (post && (post.concept_key || normalizeConceptKey(post.content_key))) || "",
        content_format: (post && post.content_format) || "",
        content_key: (post && post.content_key) || "",
        cta_pattern: classifyCta(social.linkedin || postCopy),
        date: archiveKeyDate(archiveKey),
        headline: (post && post.headline) || "",
        hook_pattern: normalizePhrase(firstSentence(social.linkedin || postCopy)),
        linkedin_copy: social.linkedin || "",
        mastodon_copy: social.mastodon || "",
        screen_key: (post && (post.screen_key || inferScreenKey(post))) || "",
        screenshot_file: (post && post.screenshot_file) || "",
        subtext: (post && post.subtext) || "",
        template_name: (post && post.template_name) || (templateMatch ? templateMatch[1].trim() : ""),
        theme: (post && post.theme) || "",
        topic_family: (post && (post.topic_family || inferTopicFamily(post))) || "",
      };
    })
    .filter(Boolean);
}

function listDailyTemplateNames() {
  return fs.readdirSync(TEMPLATES_DIR)
    .filter((name) => /^hushline-daily-.*\.html$/.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function templateTypeForName(templateName) {
  if (/^hushline-daily-mobile-template(?:-.+)?\.html$/.test(templateName)) {
    return "mobile";
  }

  if (/^hushline-daily-desktop-template(?:-.+)?\.html$/.test(templateName)) {
    return "desktop";
  }

  return null;
}

function detectCandidateTemplateType(candidate) {
  try {
    return detectTemplate(candidate.file || candidate.screenshot_file);
  } catch (_error) {
    if (candidate.viewport === "mobile" || candidate.viewport === "desktop") {
      return candidate.viewport;
    }

    return null;
  }
}

function chooseTemplateName(archiveHistory, templateNames, options = {}) {
  let candidates = options.templateType
    ? templateNames.filter((name) => templateTypeForName(name) === options.templateType)
    : templateNames.slice();

  if (candidates.length === 0) {
    throw new Error(`No daily templates are available for type: ${options.templateType}`);
  }

  const mostRecentTemplate = archiveHistory[archiveHistory.length - 1]?.template_name;
  if (candidates.length > 1 && mostRecentTemplate && candidates.includes(mostRecentTemplate)) {
    candidates = candidates.filter((templateName) => templateName !== mostRecentTemplate);
  }

  const scoredTemplates = candidates.map((templateName) => {
    const usageCount = archiveHistory.filter((entry) => entry.template_name === templateName).length;

    return {
      last_used_offset: lastTemplateUseOffset(archiveHistory, templateName),
      template_name: templateName,
      usage_count: usageCount,
    };
  });

  scoredTemplates.sort((left, right) => {
    return (
      left.usage_count - right.usage_count ||
      right.last_used_offset - left.last_used_offset ||
      left.template_name.localeCompare(right.template_name, undefined, { numeric: true })
    );
  });

  return scoredTemplates[0].template_name;
}

function filterCandidatesForTemplateName(candidates, templateName) {
  const desiredType = templateTypeForName(templateName);

  if (!desiredType) {
    return candidates;
  }

  const matchingCandidates = candidates.filter(
    (candidate) => detectCandidateTemplateType(candidate) === desiredType,
  );

  return matchingCandidates.length > 0 ? matchingCandidates : candidates;
}

function summarizeScreenshotRotation(candidates, archiveHistory, currentArchiveKey) {
  const identities = new Set(candidates.map(candidateRotationIdentity).filter(Boolean));
  const usedIdentities = new Set();
  let cycleStartArchiveKey = "";
  const relevantHistory = archiveHistory.filter((entry) => {
    return identities.has(archiveRotationIdentity(entry));
  });

  for (const entry of relevantHistory) {
    const identity = archiveRotationIdentity(entry);

    if (usedIdentities.has(identity)) {
      usedIdentities.clear();
      cycleStartArchiveKey = "";
    }

    usedIdentities.add(identity);
    cycleStartArchiveKey = entry.archive_key || entry.date || cycleStartArchiveKey;
  }

  const cycleComplete = identities.size > 0 && usedIdentities.size >= identities.size;

  return {
    cycle_complete: cycleComplete,
    rotation_seed: cycleComplete
      ? currentArchiveKey
      : (cycleStartArchiveKey || currentArchiveKey),
    used_identities: cycleComplete ? new Set() : usedIdentities,
  };
}

function filterCandidatesForArchiveHistory(candidates, archiveHistory, options = {}) {
  const normalizedCandidates = candidates.map((candidate) => {
    const historyStats = summarizeCandidateHistory(candidate, archiveHistory);

    return {
      ...historyStats.candidate,
      history_stats: historyStats,
    };
  });
  const rotation = summarizeScreenshotRotation(
    normalizedCandidates,
    archiveHistory,
    options.currentArchiveKey || "",
  );
  const rotationCandidates = normalizedCandidates.filter((candidate) => {
    const identity = candidateRotationIdentity(candidate);
    return !identity || !rotation.used_identities.has(identity);
  });

  return (rotationCandidates.length > 0 ? rotationCandidates : normalizedCandidates)
    .map((candidate) => ({
      ...candidate,
      rotation_sort_key: stableHash(
        `${rotation.rotation_seed}\0${candidateRotationIdentity(candidate)}`,
      ),
      screenshot_rotation: {
        cycle_complete: rotation.cycle_complete,
        seed: rotation.rotation_seed,
      },
    }));
}

function filterCandidatesForWeeklyCaps(candidates, archiveHistory, plannedDate) {
  const weeklyUsage = summarizeWeeklyUsage(archiveHistory, plannedDate);
  let filtered = candidates.slice();

  if (weeklyUsage.admin_count >= 1) {
    filtered = filtered.filter((candidate) => candidate.audience_scope !== "admin-only");
    if (filtered.length === 0) {
      throw new Error(
        `No eligible non-admin screenshot candidates remain for ${plannedDate}; weekly admin-only cap for ${weeklyUsage.week} is already full.`,
      );
    }
  }

  if (weeklyUsage.dark_count >= 1) {
    filtered = filtered.filter((candidate) => candidate.theme !== "dark");
    if (filtered.length === 0) {
      throw new Error(
        `No eligible light-mode screenshot candidates remain for ${plannedDate}; weekly dark-mode cap for ${weeklyUsage.week} is already full.`,
      );
    }
  }

  return filtered;
}

function candidateCooldownViolations(candidate, archiveHistory, cooldownPolicy = DEFAULT_COOLDOWN_POLICY) {
  const normalized = {
    ...candidate,
    concept_key: candidate.concept_key || normalizeConceptKey(candidate.content_key),
    topic_family: candidate.topic_family || inferTopicFamily(candidate),
  };
  const violations = [];

  if (cooldownPolicy.topic_family_posts > 0 && normalized.topic_family) {
    const match = recentArchiveEntries(archiveHistory, cooldownPolicy.topic_family_posts)
      .find((entry) => entry.topic_family === normalized.topic_family);

    if (match) {
      violations.push({
        archive_key: match.archive_key,
        field: "topic_family",
        value: normalized.topic_family,
        window_posts: cooldownPolicy.topic_family_posts,
      });
    }
  }

  if (cooldownPolicy.concept_key_posts > 0 && normalized.concept_key) {
    const match = recentArchiveEntries(archiveHistory, cooldownPolicy.concept_key_posts)
      .find((entry) => entry.concept_key === normalized.concept_key);

    if (match) {
      violations.push({
        archive_key: match.archive_key,
        field: "concept_key",
        value: normalized.concept_key,
        window_posts: cooldownPolicy.concept_key_posts,
      });
    }
  }

  return violations;
}

function filterCandidatesForCooldowns(candidates, archiveHistory, cooldownPolicy = DEFAULT_COOLDOWN_POLICY) {
  const evaluated = candidates.map((candidate) => ({
    ...candidate,
    cooldown_violations: candidateCooldownViolations(candidate, archiveHistory, cooldownPolicy),
  }));

  if (cooldownPolicy.allow_override) {
    return evaluated;
  }

  const allowed = evaluated.filter((candidate) => candidate.cooldown_violations.length === 0);

  if (allowed.length === 0) {
    const blockedFields = Array.from(
      new Set(evaluated.flatMap((candidate) => candidate.cooldown_violations.map((violation) => violation.field))),
    ).join(", ");

    return evaluated
      .map((candidate) => ({
        ...candidate,
        cooldown_exhaustion_fallback: true,
        cooldown_exhaustion_reason: `All eligible screenshots violate cooldowns (${blockedFields || "none"}).`,
      }))
      .sort((left, right) => (
        left.cooldown_violations.length - right.cooldown_violations.length ||
        left.file.localeCompare(right.file)
      ));
  }

  return allowed;
}

function chooseBestCandidate(candidates, archiveHistory, templateNames) {
  const ranked = rankCandidates(candidates, archiveHistory, templateNames);

  return ranked[0] || null;
}

function rankCandidates(candidates, archiveHistory, templateNames) {
  return candidates
    .map((candidate) => {
      const candidateType = detectCandidateTemplateType(candidate);

      return {
        ...candidate,
        template_type: candidateType,
        template_type_average_usage: averageTemplateUsageForType(
          archiveHistory,
          templateNames,
          candidateType,
        ),
      };
    })
    .sort((left, right) => {
      return (
        Number(left.audience_scope === "admin-only") - Number(right.audience_scope === "admin-only") ||
        (left.rotation_sort_key || 0) - (right.rotation_sort_key || 0) ||
        left.template_type_average_usage - right.template_type_average_usage ||
        (right.score || 0) - (left.score || 0) ||
        left.history_stats.novelty_penalty - right.history_stats.novelty_penalty ||
        left.file.localeCompare(right.file)
      );
    });
}

function selectCandidateShortlist(editorialIntentSelection, archiveHistory, templateNames, count = 3) {
  return rankCandidates(
    editorialIntentSelection.supporting_candidates || [],
    archiveHistory,
    templateNames,
  ).slice(0, count);
}

function chooseTemplateNameForCandidate(candidate, context) {
  if (
    !context.template_selection ||
    !Array.isArray(context.template_selection.available_templates) ||
    context.template_selection.available_templates.length === 0
  ) {
    const fallbackType = detectCandidateTemplateType(candidate);
    const fallbackTemplates = listDailyTemplateNames().filter(
      (templateName) => templateTypeForName(templateName) === fallbackType,
    );

    return chooseTemplateName(context.recent_archive_history || [], fallbackTemplates, {
      templateType: fallbackType,
    });
  }

  const candidateType = detectCandidateTemplateType(candidate);
  const matchingTemplateNames = context.template_selection.available_templates.filter(
    (templateName) => templateTypeForName(templateName) === candidateType,
  );

  if (matchingTemplateNames.length > 0) {
    return chooseTemplateName(context.recent_archive_history || [], matchingTemplateNames, {
      templateType: candidateType,
    });
  }

  return chooseTemplateName(
    context.recent_archive_history || [],
    context.template_selection.available_templates,
  );
}

function readHushlineAgentExcerpt() {
  const filePath = path.join(HUSHLINE_ROOT, "AGENTS.md");
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return excerptText(fs.readFileSync(filePath, "utf8"), 2600);
}

function buildDailyContext(args) {
  const parsedDate = new Date(`${args.date}T12:00:00`);
  const week = formatIsoWeek(parsedDate);
  const excludedScreenshots = new Set(args.excludeScreenshots || []);
  const cooldownPolicy = args.cooldownPolicy || buildCooldownPolicy();
  const planningContext = buildPlanningContext({
    candidateCount: Math.max(args.candidateCount * 10, 200),
    darkRatio: args.darkRatio,
    week,
  });
  const archiveHistory = loadArchiveHistory(args.archiveKey);
  const contentFormatSelection = chooseContentFormat(archiveHistory, args.date);
  const templateNames = listDailyTemplateNames();
  const variedCandidates = filterCandidatesForArchiveHistory(
    planningContext.candidate_screenshots,
    archiveHistory,
    { currentArchiveKey: args.archiveKey },
  );
  const weekEligibleCandidates = filterCandidatesForWeeklyCaps(
    variedCandidates,
    archiveHistory,
    args.date,
  );
  const cooldownEligibleCandidates = filterCandidatesForCooldowns(
    weekEligibleCandidates,
    archiveHistory,
    cooldownPolicy,
  );
  const eligibleCandidates = cooldownEligibleCandidates.filter(
    (candidate) => !excludedScreenshots.has(candidate.file),
  );
  const editorialIntentSelection = chooseSupportedEditorialIntent(
    archiveHistory,
    args.date,
    contentFormatSelection,
    eligibleCandidates,
  );
  const selectedCandidates = selectCandidateShortlist(
    editorialIntentSelection,
    archiveHistory,
    templateNames,
  );
  const selectedCandidate = selectedCandidates[0] || null;

  if (!selectedCandidate) {
    throw new Error(`No eligible screenshot candidates remain for ${args.date}.`);
  }
  const desiredTemplateName = chooseTemplateNameForCandidate(
    selectedCandidate,
    {
      recent_archive_history: archiveHistory,
      template_selection: {
        available_templates: templateNames,
      },
    },
  );
  const cooldownFallbackCandidates = selectedCandidates.filter(
    (candidate) => candidate.cooldown_exhaustion_fallback,
  );

  return {
    audience_docs: planningContext.audience_docs,
    candidate_screenshots: selectedCandidates,
    content_format_selection: contentFormatSelection,
    cooldown_policy: cooldownPolicy,
    cooldown_exhaustion_fallback: cooldownFallbackCandidates.length > 0
      ? {
          candidate_count: cooldownFallbackCandidates.length,
          reason: cooldownFallbackCandidates[0].cooldown_exhaustion_reason,
          violated_fields: Array.from(
            new Set(cooldownFallbackCandidates.flatMap(
              (candidate) => candidate.cooldown_violations.map((violation) => violation.field),
            )),
          ).sort(),
        }
      : null,
    daily_posts_root: path.relative(REPO_ROOT, DAILY_POSTS_ROOT),
    date: args.date,
    dark_ratio: args.darkRatio,
    editorial_critic: {
      criteria: [
        "topic_freshness",
        "hook_freshness",
        "format_novelty",
        "audience_specificity",
        "concrete_reader_value",
        "hushline_relevance",
        "cta_freshness",
        "safety_compliance",
      ],
      threshold: EDITORIAL_CRITIC_THRESHOLD,
    },
    editorial_intent: editorialIntentSelection.intent,
    editorial_intent_rejections: editorialIntentSelection.rejected_intents,
    excluded_screenshots: Array.from(excludedScreenshots),
    hushline_agent_context: readHushlineAgentExcerpt(),
    hushline_app_voice_guidance: HUSHLINE_APP_VOICE_GUIDANCE,
    recent_archive_history: archiveHistory,
    screenshot_rotation: selectedCandidate.screenshot_rotation,
    visual_selection_reason: cooldownFallbackCandidates.length > 0
      ? `${editorialIntentSelection.visual_selection_reason} Cooldown fallback was used because no fully fresh screenshot candidates remained.`
      : editorialIntentSelection.visual_selection_reason,
    screenshot_captured_at: planningContext.screenshot_captured_at,
    screenshot_release: planningContext.screenshot_release,
    slot: {
      planned_date: args.date,
      slot: getWeekdayLabel(args.date),
    },
    template_selection: {
      available_templates: templateNames,
      desired_template_name: desiredTemplateName,
      desired_template_type: templateTypeForName(desiredTemplateName),
    },
    week,
  };
}

function buildPromptPayload(context) {
  const docs = context.audience_docs
    .map((doc) => `${doc.file}\n${doc.excerpt}`)
    .join("\n\n");
  const voiceGuidance = (context.hushline_app_voice_guidance || HUSHLINE_APP_VOICE_GUIDANCE)
    .map((line) => `- ${line}`)
    .join("\n");
  const plainLanguageGuidance = PLAIN_LANGUAGE_COPY_GUIDANCE
    .map((line) => `- ${line}`)
    .join("\n");
  const topicGuidance = Object.entries(TOPIC_COPY_GUIDANCE)
    .map(([topic, lines]) => {
      return [`${topic}:`, ...lines.map((line) => `- ${line}`)].join("\n");
    })
    .join("\n\n");
  const archiveHistory = context.recent_archive_history.length === 0
    ? "No prior archived daily posts were found."
    : context.recent_archive_history
        .map((entry) => {
          return [
            `${entry.archive_key}: ${entry.content_key} [${entry.topic_family}] (${entry.screenshot_file})`,
            `  Format: ${entry.content_format || "unknown"}`,
            `  Template: ${entry.template_name || "unknown"}`,
            `  Headline: ${entry.headline || "n/a"}`,
            `  Subtext: ${entry.subtext || "n/a"}`,
          ].join("\n");
        })
        .join("\n");

  return {
    system: [
      "You are writing one daily social post for Hush Line around a small ranked screenshot shortlist.",
      "Write in plain language. No marketing-speak, no hype, no filler.",
      "Social copy must be end-user-facing. Do not confuse post copy with alt text.",
      "Use the visible feature's real words instead of abstract metaphors or internal shorthand.",
      "Avoid empty-state screens, duplicate content themes, and repeated scenes across mobile/desktop variants.",
      "If a screenshot is admin-only, the copy must explicitly say that it is for admins or teams running Hush Line.",
      "LinkedIn is the first automated publishing target, so LinkedIn copy should be especially ready for production use.",
    ].join(" "),
    user: [
      `Plan date: ${context.date}`,
      `Week context: ${context.week}`,
      `Slot label: ${context.slot.slot}`,
      "",
      "Character limits:",
      `LinkedIn ${LIMITS.linkedin}`,
      `Mastodon ${LIMITS.mastodon}`,
      `Bluesky ${LIMITS.bluesky}`,
      "",
      `Target dark-mode share for this run: ${context.dark_ratio}`,
      `Screenshot release from local latest folder: ${context.screenshot_release}`,
      `Screenshots captured at: ${context.screenshot_captured_at}`,
      `Hard cooldown policy: ${JSON.stringify(context.cooldown_policy || DEFAULT_COOLDOWN_POLICY)}`,
      context.cooldown_exhaustion_fallback
        ? `Cooldown exhaustion fallback: ${JSON.stringify(context.cooldown_exhaustion_fallback)}`
        : "Cooldown exhaustion fallback: not used",
      `Editorial critic threshold: ${context.editorial_critic?.threshold || EDITORIAL_CRITIC_THRESHOLD}`,
      `Required content format: ${context.content_format_selection?.selected_format?.id || "feature_benefit"}`,
      `Editorial intent: ${JSON.stringify(context.editorial_intent || {})}`,
      `Visual selection reason: ${context.visual_selection_reason || "Selected screenshot as visual support after editorial planning."}`,
      "",
      "Current hushline.app voice guidance:",
      voiceGuidance,
      "",
      "Plain-language copy standard:",
      plainLanguageGuidance,
      "",
      "Topic-specific copy guidance:",
      topicGuidance,
      "",
      "Audience and user-base context from docs:",
      docs,
      "",
      "Additional Hush Line AGENTS guidance:",
      context.hushline_agent_context || "No additional AGENTS guidance was found.",
      "",
      "Recent archived daily posts to avoid repeating:",
      archiveHistory,
      "",
      "Available editorial formats:",
      JSON.stringify(context.content_format_selection?.available_formats || CONTENT_FORMATS, null, 2),
      "",
      "Selected format guidance:",
      context.content_format_selection?.selected_format
        ? [
            `${context.content_format_selection.selected_format.label} (${context.content_format_selection.selected_format.id})`,
            `Copy: ${context.content_format_selection.selected_format.copy_guidance}`,
            `CTA: ${context.content_format_selection.selected_format.cta_guidance}`,
            `Alt text: ${context.content_format_selection.selected_format.alt_text_guidance}`,
          ].join("\n")
        : "Use feature_benefit guidance.",
      "",
      "Instructions:",
      "- Start from the editorial intent and reader need above. Treat screenshots as visual support, not the source of the idea.",
      "- Choose exactly one supporting screenshot from the provided candidates.",
      "- Use exactly the required content format and set `content_format` to that format id.",
      `- Check the prior ${ARCHIVE_LOOKBACK_DAYS} days of archived daily posts before you decide on the messaging angle.`,
      "- The candidates were preselected from a ranked pool after excluding recent repeats of the same screenshot, screen, feature family, and overused template types wherever possible.",
      "- The candidate shortlist enforces topic-family and concept-key cooldowns when fresh candidates exist.",
      "- If the current screenshot pool is exhausted, the shortlist may include least-bad cooldown fallback candidates; in that case, write a clearly fresh hook, value proposition, and CTA for the selected screenshot.",
      "- Opening hooks and CTA patterns are validated against recent archive cooldowns after drafting; choose a fresh hook and closing line.",
      "- A final editorial critic will score topic freshness, hook freshness, format novelty, audience specificity, concrete reader value, Hush Line relevance, CTA freshness, and safety/compliance before rendering.",
      "- Drafts below the critic threshold are rewritten once and then blocked if they still fail, so avoid generic or low-value copy on the first pass.",
      "- Let the selected editorial format shape the post structure, hook, CTA, and alt text. Do not write another generic screenshot tour.",
      "- Produce exactly one post for the requested date.",
      "- Do not talk about recent releases, recent merges, or product recency unless the prompt explicitly gives you that information.",
      "- Do not repeat a screenshot, feature, or messaging angle that already appeared in the prior month, even if you could retarget it to a different audience.",
      "- Treat screenshots in the same topic family as repeats even when the exact content_key differs. For example, directory-all, directory-verified, and onboarding-directory all count as directory posts for variation purposes.",
      "- Prefer the candidate that gives you the most distinct message from the recent archive, not just the highest-ranked familiar topic.",
      "- Match the copy to the candidate audience scope. Public screens should read public-facing. Recipient-shared screens should read like recipient workflows. Admin-only screens must clearly say admin or team context.",
      "- Tailor the message to real Hush Line users and use cases, not generic product copy.",
      "- Headline and subtext should be concise and straightforward.",
      "- Do not use terms like pings, outside signal, minimum outside signal, case file, surface, frictionless, operationalize, leverage, unlock, or streamline.",
      "- If you choose a notification screenshot, explain the user choice plainly: simple notifications, Hush Line inbox, email notifications, and/or encrypted tip contents in email.",
      "- Each network copy should say the same core thing in a native way, not copy-paste the same sentence three times.",
      "- The alt text should describe the final image asset, not just the raw UI screenshot.",
      "- Set `source_pr_numbers` to an empty array unless the prompt explicitly provides PR numbers to cite.",
      "",
      "Return strict JSON matching the schema.",
    ].join("\n"),
  };
}

function buildResponseSchema(context) {
  return {
    additionalProperties: false,
    properties: {
      date: {
        pattern: "^\\d{4}-\\d{2}-\\d{2}$",
        type: "string",
      },
      post: {
        additionalProperties: false,
        properties: {
          content_key: {
            type: "string",
          },
          content_format: {
            enum: contentFormatIds(),
            type: "string",
          },
          headline: {
            type: "string",
          },
          image_alt_text: {
            type: "string",
          },
          planned_date: {
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            type: "string",
          },
          rationale: {
            type: "string",
          },
          screenshot_file: {
            type: "string",
          },
          slot: {
            type: "string",
          },
          social: {
            additionalProperties: false,
            properties: {
              bluesky: { type: "string" },
              linkedin: { type: "string" },
              mastodon: { type: "string" },
            },
            required: ["linkedin", "mastodon", "bluesky"],
            type: "object",
          },
          source_pr_numbers: {
            items: {
              type: "integer",
            },
            type: "array",
          },
          subtext: {
            type: "string",
          },
        },
        required: [
          "slot",
          "planned_date",
          "screenshot_file",
          "content_key",
          "content_format",
          "headline",
          "subtext",
          "image_alt_text",
          "social",
          "rationale",
          "source_pr_numbers",
        ],
        type: "object",
      },
      summary: {
        type: "string",
      },
    },
    required: ["date", "summary", "post"],
    type: "object",
  };
}

function buildCodexPrompt(context, archiveKey) {
  const prompt = buildPromptPayload(context);
  const candidates = context.candidate_screenshots
    .map((candidate, index) => {
      return [
        `Candidate ${index + 1}`,
        `file: ${candidate.file}`,
        `topic_family: ${candidate.topic_family}`,
        `concept_key: ${candidate.concept_key}`,
        `content_key: ${candidate.content_key}`,
        `title: ${candidate.title}`,
        `route: ${candidate.path}`,
        `session: ${candidate.session}`,
        `audience_scope: ${candidate.audience_scope}`,
        `copy_brief: ${candidate.copy_brief}`,
        `viewport: ${candidate.viewport}`,
        `theme: ${candidate.theme}`,
        `screen_key: ${candidate.screen_key}`,
        `absolute_path: ${candidate.absolute_path}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    prompt.system,
    "",
    prompt.user,
    "",
    "Candidate screenshots:",
    candidates,
    "",
    `Read planning context from: ${path.join("previous-posts", archiveKey, "context.json")}`,
    `Write the finished plan JSON to: ${path.join("previous-posts", archiveKey, "plan.json")}`,
    "",
    "Output requirements:",
    "- Write valid JSON only to the target file.",
    "- Do not write markdown fences.",
    "- Use exactly this JSON schema:",
    JSON.stringify(buildResponseSchema(context), null, 2),
    "",
    "Execution requirements:",
    "- Use exactly one of the provided screenshots.",
    "- Do not render images yourself.",
    "- Do not mention recent release timing, recent PRs, or recency-based product claims unless the prompt explicitly includes that evidence.",
    "- Use `source_pr_numbers: []` unless the prompt explicitly gives you PR numbers to cite.",
    "- If the chosen candidate has audience_scope `admin-only`, make that admin audience explicit in the copy.",
  ].join("\n");
}

function validatePlan(modelPlan, context) {
  const candidateMap = new Map(
    context.candidate_screenshots.map((candidate) => [candidate.file, candidate]),
  );
  const recentFeatureEntries = (context.recent_archive_history || []).slice(
    -FEATURE_REPEAT_HARD_LOOKBACK_POSTS,
  );

  if (modelPlan.date !== context.date) {
    throw new Error(`Model returned date ${modelPlan.date}, expected ${context.date}.`);
  }

  if (!modelPlan.post || typeof modelPlan.post !== "object") {
    throw new Error("Model did not return a `post` object.");
  }

  const post = modelPlan.post;
  if (post.slot !== context.slot.slot) {
    throw new Error(`Model returned slot ${post.slot}, expected ${context.slot.slot}.`);
  }

  if (post.planned_date !== context.slot.planned_date) {
    throw new Error(
      `Post expected planned date ${context.slot.planned_date}, received ${post.planned_date}.`,
    );
  }

  const candidate = candidateMap.get(post.screenshot_file);
  if (!candidate) {
    throw new Error(`Model selected screenshot outside shortlist: ${post.screenshot_file}`);
  }

  const cooldownPolicy = context.cooldown_policy || DEFAULT_COOLDOWN_POLICY;
  if (!cooldownPolicy.allow_override && !candidate.cooldown_exhaustion_fallback) {
    const violations = candidateCooldownViolations(
      candidate,
      context.recent_archive_history || [],
      cooldownPolicy,
    );

    if (violations.length > 0) {
      const violation = violations[0];
      throw new Error(
        `Selected screenshot ${post.screenshot_file} violates ${violation.field} cooldown from ${violation.archive_key}.`,
      );
    }
  }

  const weeklyUsage = summarizeWeeklyUsage(context.recent_archive_history || [], context.date);
  if (candidate.audience_scope === "admin-only" && weeklyUsage.admin_count >= 1) {
    throw new Error(
      `Weekly admin-only cap already reached for ${weeklyUsage.week}; cannot select ${post.screenshot_file} on ${context.date}.`,
    );
  }

  if (candidate.theme === "dark" && weeklyUsage.dark_count >= 1) {
    throw new Error(
      `Weekly dark-mode cap already reached for ${weeklyUsage.week}; cannot select ${post.screenshot_file} on ${context.date}.`,
    );
  }

  if (post.content_key !== candidate.content_key) {
    throw new Error(
      `Model content key mismatch for ${post.screenshot_file}: expected ${candidate.content_key}, received ${post.content_key}.`,
    );
  }

  if (
    context.editorial_intent?.audience_scope &&
    candidate.audience_scope !== context.editorial_intent.audience_scope
  ) {
    throw new Error(
      `Selected screenshot ${post.screenshot_file} does not support editorial intent audience ${context.editorial_intent.audience_scope}.`,
    );
  }

  validateContentFormatSelection(post.content_format, context);

  if (!post.social || typeof post.social !== "object") {
    throw new Error("Post is missing a social copy object.");
  }

  validatePlainLanguageCopy(post, candidate, context);

  for (const network of Object.keys(LIMITS)) {
    if (String(post.social[network] || "").length > LIMITS[network]) {
      throw new Error(`${network} copy exceeds limit for ${context.date}.`);
    }
  }

  if (candidate.audience_scope === "admin-only") {
    const combinedCopy = [
      post.headline,
      post.subtext,
      post.social.linkedin,
      post.social.mastodon,
      post.social.bluesky,
    ].join(" ");

    if (!ADMIN_COPY_PATTERNS.some((pattern) => pattern.test(combinedCopy))) {
      throw new Error(
        `Admin-only screenshot ${post.screenshot_file} needs copy that explicitly signals admin/team context.`,
      );
    }
  }

  const currentMessageText = buildMessageText({
    bluesky_copy: post.social.bluesky,
    headline: post.headline,
    linkedin_copy: post.social.linkedin,
    mastodon_copy: post.social.mastodon,
    subtext: post.subtext,
  });
  const currentHookPattern = normalizePhrase(firstSentence(post.social.linkedin || currentMessageText));
  const currentCtaPattern = classifyCta(post.social.linkedin || currentMessageText);

  if (!cooldownPolicy.allow_override && cooldownPolicy.hook_posts > 0 && currentHookPattern) {
    const matchingHook = recentArchiveEntries(
      context.recent_archive_history || [],
      cooldownPolicy.hook_posts,
    ).find((entry) => archiveEntryHookPattern(entry) === currentHookPattern);

    if (matchingHook) {
      throw new Error(
        `Post opening hook for ${context.date} repeats ${matchingHook.archive_key} within the ${cooldownPolicy.hook_posts}-post hook cooldown.`,
      );
    }
  }

  if (
    !cooldownPolicy.allow_override &&
    cooldownPolicy.cta_posts > 0 &&
    currentCtaPattern !== "none"
  ) {
    const matchingCta = recentArchiveEntries(
      context.recent_archive_history || [],
      cooldownPolicy.cta_posts,
    ).find((entry) => archiveEntryCtaPattern(entry) === currentCtaPattern);

    if (matchingCta) {
      throw new Error(
        `Post CTA pattern for ${context.date} repeats ${matchingCta.archive_key} within the ${cooldownPolicy.cta_posts}-post CTA cooldown.`,
      );
    }
  }

  for (const entry of context.recent_archive_history || []) {
    const archivedMessageText = buildMessageText(entry);
    const sameScreenshot = entry.screenshot_file && entry.screenshot_file === candidate.file;
    const recentFeatureOverlap = sameScreenshot && recentFeatureEntries.includes(entry);
    const matchingHeadline = normalizeMessageLine(entry.headline) === normalizeMessageLine(post.headline);
    const headlineOverlap = sharedMessageTokenCount(
      `${post.headline} ${post.subtext}`,
      `${entry.headline} ${entry.subtext}`,
    );
    const bodyOverlap = sharedMessageTokenCount(currentMessageText, archivedMessageText);

    if (matchingHeadline) {
      throw new Error(
        `Post headline for ${context.date} duplicates recent archive headline from ${entry.archive_key}.`,
      );
    }

    if (recentFeatureOverlap && (headlineOverlap >= 3 || bodyOverlap >= 6)) {
      throw new Error(
        `Post messaging for ${context.date} is too close to recent ${entry.topic_family} archive ${entry.archive_key}.`,
      );
    }

    if (headlineOverlap >= 6 && bodyOverlap >= 10) {
      throw new Error(
        `Post messaging for ${context.date} overlaps too heavily with recent archive ${entry.archive_key}.`,
      );
    }
  }

  const validatedPlan = {
    date: modelPlan.date,
    post: {
      ...post,
      audience_scope: candidate.audience_scope,
      concept_key: candidate.concept_key,
      content_format: post.content_format,
      copy_brief: candidate.copy_brief,
      editorial_intent: context.editorial_intent || null,
      matched_pull_requests: candidate.matched_pull_requests,
      screen_key: candidate.screen_key || inferScreenKey(candidate),
      screenshot_file: candidate.file,
      social: {
        bluesky: post.social.bluesky.trim(),
        linkedin: post.social.linkedin.trim(),
        mastodon: post.social.mastodon.trim(),
      },
      template_name: chooseTemplateNameForCandidate(candidate, context),
      theme: candidate.theme,
      title: candidate.title,
      topic_family: candidate.topic_family || inferTopicFamily(candidate),
      visual_selection_reason: context.visual_selection_reason || "",
      viewport: candidate.viewport,
    },
    summary: modelPlan.summary,
  };
  const critic = assertEditorialCriticPass(validatedPlan, context);

  return {
    ...validatedPlan,
    critic,
  };
}

function writeContextArtifacts(archiveKey, context) {
  const postRoot = path.join(DAILY_POSTS_ROOT, archiveKey);
  fs.mkdirSync(postRoot, { recursive: true });
  const contextPath = path.join(postRoot, "context.json");
  const promptPath = path.join(postRoot, "prompt.txt");
  const planPath = path.join(postRoot, "plan.json");
  writeJson(contextPath, context);
  fs.writeFileSync(promptPath, `${buildCodexPrompt(context, archiveKey)}\n`);
  return {
    contextPath,
    planPath,
    postRoot,
    promptPath,
  };
}

function loadSavedDailyContext(archiveKey) {
  const contextPath = path.join(DAILY_POSTS_ROOT, archiveKey, "context.json");
  if (!fs.existsSync(contextPath)) {
    return null;
  }

  return readJson(contextPath);
}

async function renderDailyPlan(plan, archiveKey = plan.date) {
  const outputDir = path.join(DAILY_POSTS_ROOT, archiveKey);
  return renderPost(plan.post, outputDir);
}

async function planDay(args) {
  if (isWeekendDate(args.date)) {
    throw new Error(`Weekend dates are excluded from the daily planner: ${args.date} (${getWeekdayLabel(args.date)}).`);
  }

  const context = buildDailyContext(args);
  const artifacts = writeContextArtifacts(args.archiveKey, context);

  return {
    context,
    contextPath: artifacts.contextPath,
    plan: null,
    planPath: artifacts.planPath,
    postRoot: artifacts.postRoot,
    promptPath: artifacts.promptPath,
  };
}

module.exports = {
  DAILY_POSTS_ROOT,
  CONTENT_FORMATS,
  CONTENT_FORMAT_WEEKLY_CAP,
  DEFAULT_COOLDOWN_POLICY,
  EDITORIAL_AUDIENCES,
  buildDailyContext,
  buildPromptPayload,
  buildCooldownPolicy,
  candidateRotationIdentity,
  candidateCooldownViolations,
  chooseSupportedEditorialIntent,
  chooseContentFormat,
  chooseTemplateName,
  contentFormatIds,
  filterCandidatesForEditorialIntent,
  filterCandidatesForArchiveHistory,
  filterCandidatesForCooldowns,
  filterCandidatesForWeeklyCaps,
  filterCandidatesForTemplateName,
  getContentFormat,
  getEditorialAudience,
  inferTopicFamily,
  rankEditorialIntents,
  loadSavedDailyContext,
  parseArgs,
  planDay,
  renderDailyPlan,
  scoreEditorialCritic,
  selectCandidateShortlist,
  summarizeScreenshotRotation,
  validatePlan,
};
