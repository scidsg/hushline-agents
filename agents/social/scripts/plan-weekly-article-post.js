#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const {
  LIMITS,
  REPO_ROOT,
  clampText,
  getWeekdayLabel,
  writeJson,
} = require("./lib/social-common");

const ARTICLE_ARCHIVE_ROOT = path.join(REPO_ROOT, "previous-article-posts");
const HUSHLINE_URL = "https://hushline.app";
const DEFAULT_MAX_AGE_DAYS = 14;
const MIN_RELEVANCE_SCORE = 8;

const ALLOWED_FEEDS = [
  { source: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml" },
  { source: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml" },
  { source: "The Atlantic", url: "https://www.theatlantic.com/feed/all/" },
  { source: "The Guardian", url: "https://www.theguardian.com/world/rss" },
  { source: "The Guardian", url: "https://www.theguardian.com/us-news/rss" },
  { source: "BBC News", url: "https://feeds.bbci.co.uk/news/rss.xml" },
  { source: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { source: "ABC News", url: "https://abcnews.go.com/abcnews/topstories" },
  { source: "NBC News", url: "https://feeds.nbcnews.com/nbcnews/public/news" },
  { source: "CBS News", url: "https://www.cbsnews.com/latest/rss/main" },
  { source: "CNN", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { source: "CNN", url: "http://rss.cnn.com/rss/cnn_us.rss" },
];

const BLOCKED_SOURCE_PATTERN = /\b(fox|breitbart|gateway pundit|newsmax|oann|infowars|daily wire)\b/i;
const ALLOWED_SOURCE_NAMES = new Set(ALLOWED_FEEDS.map((feed) => feed.source));
const EXCLUDED_URL_PATH_PATTERN = /\/(ideas|opinion|opinions|editorial|commentisfree|commentary)\b/i;

const RELEVANCE_TERMS = [
  { pattern: /\bwhistle[-\s]?blow(?:er|ers|ing)?\b/i, weight: 14 },
  { pattern: /\bwhistleblower protection(s)?\b/i, weight: 16 },
  { pattern: /\bwhistleblower law(s)?\b/i, weight: 13 },
  { pattern: /\bwhistleblower program(s)?\b/i, weight: 12 },
  { pattern: /\bqui tam\b/i, weight: 12 },
  { pattern: /\bfalse claims act\b/i, weight: 12 },
  { pattern: /\bsource protection(s)?\b/i, weight: 10 },
  { pattern: /\bshield law(s)?\b/i, weight: 9 },
  { pattern: /\bprotected disclosure(s)?\b/i, weight: 12 },
  { pattern: /\bretaliat(?:e|ed|ion|ory)\b/i, weight: 9 },
  { pattern: /\bsettlement(s)?\b/i, weight: 7 },
  { pattern: /\blawsuit(s)?\b/i, weight: 7 },
  { pattern: /\breward(s)?\b/i, weight: 6 },
  { pattern: /\baward(s|ed)?\b/i, weight: 5 },
  { pattern: /\bSEC\b/i, weight: 6 },
  { pattern: /\bCFTC\b/i, weight: 6 },
  { pattern: /\bOSHA\b/i, weight: 6 },
  { pattern: /\b(leak|leaked|leaks|leaker)\b/i, weight: 8 },
  { pattern: /\bconfidential source(s)?\b/i, weight: 8 },
  { pattern: /\banonymous source(s)?\b/i, weight: 7 },
  { pattern: /\btip line(s)?\b/i, weight: 7 },
  { pattern: /\breport(?:ed|ing)? wrongdoing\b/i, weight: 7 },
  { pattern: /\bmisconduct\b/i, weight: 5 },
  { pattern: /\bfraud\b/i, weight: 5 },
  { pattern: /\bcorruption\b/i, weight: 5 },
  { pattern: /\babuse of power\b/i, weight: 5 },
  { pattern: /\bethics complaint(s)?\b/i, weight: 5 },
  { pattern: /\binspector general\b/i, weight: 5 },
  { pattern: /\bwatchdog\b/i, weight: 4 },
  { pattern: /\boversight\b/i, weight: 4 },
  { pattern: /\btransparency\b/i, weight: 3 },
  { pattern: /\binvestigat(?:e|ed|ion|ions|ive)\b/i, weight: 3 },
  { pattern: /\baccountability\b/i, weight: 3 },
];

const EXCLUSION_TERMS = [
  /\bsports\b/i,
  /\bcelebrity\b/i,
  /\bmovie(s)?\b/i,
  /\btv show\b/i,
  /\bweather\b/i,
  /\brecipe(s)?\b/i,
  /\btravel\b/i,
];

const ARTICLE_ANGLES = [
  {
    key: "policy",
    pattern: /\b(whistleblower protection|whistleblower law|shield law|source protection|policy|legislation|bill|rule|rules|regulation)\b/i,
    value: "Policy changes decide whether people can report harm before the stakes become personal.",
    shortValue: "Policy changes decide whether people can report harm safely.",
  },
  {
    key: "enforcement",
    pattern: /\b(SEC|CFTC|OSHA|false claims act|qui tam|inspector general|watchdog|oversight|audit|investigation)\b/i,
    value: "Oversight depends on people being able to bring evidence forward without losing control of their safety.",
    shortValue: "Oversight depends on people being able to bring evidence forward safely.",
  },
  {
    key: "retaliation",
    pattern: /\bretaliat(?:e|ed|ion|ory)\b/i,
    value: "Retaliation is exactly why people need a safer path before the first disclosure.",
    shortValue: "Retaliation is why safer first contact matters.",
  },
  {
    key: "win",
    pattern: /\b(win|wins|won|victory|settlement|settles|award|awarded|reward|reinstated|protected)\b/i,
    value: "Wins matter because they show reporting can lead to protection, accountability, or repair.",
    shortValue: "Wins matter when reporting leads to protection or repair.",
  },
  {
    key: "source-protection",
    pattern: /\b(leak|leaked|leaks|leaker|confidential source|anonymous source|source protection)\b/i,
    value: "Source protection starts before publication, when someone decides whether contact is safe enough.",
    shortValue: "Source protection starts before publication.",
  },
  {
    key: "accountability",
    pattern: /\b(corruption|fraud|misconduct|abuse of power|ethics complaint|accountability)\b/i,
    value: "Accountability reporting often begins with a person, a record, and a safe enough way to make contact.",
    shortValue: "Accountability reporting needs a safe enough way to make contact.",
  },
];

const BANNED_COPY_PATTERNS = [
  {
    pattern: /\bhas a new\b/i,
    reason: "source-plus-announcement template",
  },
  {
    pattern: /\bworth reading\b/i,
    reason: "generic recommendation filler",
  },
  {
    pattern: /^.+:\s/m,
    reason: "source-colon or label-colon structure",
  },
  {
    pattern: /\b(news|story|reporting|accountability work|retaliation cases|fraud reporting|whistleblower stories)\s+(is|are|depends|often)\b/i,
    reason: "generic lead-in instead of story-specific news",
  },
];

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const args = {
    archiveKey: null,
    date: todayString(),
    dryRun: false,
    feedFile: "",
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--date") {
      args.date = argv[index + 1];
      index += 1;
    } else if (value === "--archive-key") {
      args.archiveKey = argv[index + 1];
      index += 1;
    } else if (value === "--feed-file") {
      args.feedFile = argv[index + 1];
      index += 1;
    } else if (value === "--max-age-days") {
      args.maxAgeDays = Number(argv[index + 1]);
      index += 1;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error("`--date` must use YYYY-MM-DD format.");
  }

  if (!Number.isFinite(args.maxAgeDays) || args.maxAgeDays < 1) {
    throw new Error("`--max-age-days` must be a positive number.");
  }

  args.archiveKey = args.archiveKey || args.date;
  if (!/^\d{4}-\d{2}-\d{2}(-[0-9]+)?$/.test(args.archiveKey)) {
    throw new Error("`--archive-key` must use YYYY-MM-DD or YYYY-MM-DD-N format.");
  }

  if (args.archiveKey !== args.date && !args.archiveKey.startsWith(`${args.date}-`)) {
    throw new Error("`--archive-key` must start with the requested `--date`.");
  }

  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/plan-weekly-article-post.js",
      "  node scripts/plan-weekly-article-post.js --date 2026-06-03",
      "  node scripts/plan-weekly-article-post.js --feed-file ./feeds.json --dry-run",
      "",
      "Behavior:",
      "  - Fetches current RSS/Atom items from an approved mainstream source allowlist",
      "  - Selects one whistleblower-related article",
      "  - Archives a text-only article-share post under previous-article-posts/YYYY-MM-DD",
      "",
    ].join("\n"),
  );
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll(/<!\[CDATA\[([\s\S]*?)]]>/g, "$1")
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/&quot;/g, "\"")
    .replaceAll(/&#39;/g, "'")
    .replaceAll(/&#x27;/g, "'")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function stripHtml(value) {
  return decodeXml(String(value || "").replaceAll(/<[^>]+>/g, " "));
}

function firstTag(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1]) : "";
}

function firstAttribute(block, tagName, attributeName) {
  const tagMatch = String(block || "").match(new RegExp(`<${tagName}\\b([^>]*)>`, "i"));
  if (!tagMatch) {
    return "";
  }

  const attrMatch = tagMatch[1].match(new RegExp(`${attributeName}=["']([^"']+)["']`, "i"));
  return attrMatch ? decodeXml(attrMatch[1]) : "";
}

function parseFeedItems(xml, source) {
  const items = [];
  const itemBlocks = [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const entryBlocks = [...String(xml || "").matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);

  for (const block of itemBlocks) {
    const title = firstTag(block, "title");
    const link = firstTag(block, "link") || firstAttribute(block, "link", "href");
    const description = stripHtml(firstTag(block, "description") || firstTag(block, "content:encoded"));
    const publishedAt = parseArticleDate(firstTag(block, "pubDate") || firstTag(block, "dc:date") || firstTag(block, "published"));

    if (title && link) {
      items.push({ description, link, publishedAt, source, title });
    }
  }

  for (const block of entryBlocks) {
    const title = firstTag(block, "title");
    const link = firstAttribute(block, "link", "href") || firstTag(block, "link");
    const description = stripHtml(firstTag(block, "summary") || firstTag(block, "content"));
    const publishedAt = parseArticleDate(firstTag(block, "published") || firstTag(block, "updated"));

    if (title && link) {
      items.push({ description, link, publishedAt, source, title });
    }
  }

  return items;
}

function parseArticleDate(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

function plannedDateBoundary(date, { endOfDay = false } = {}) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ));
}

function scoreArticle(article) {
  const text = `${article.title} ${article.description}`;
  if (EXCLUSION_TERMS.some((pattern) => pattern.test(text))) {
    return 0;
  }

  return RELEVANCE_TERMS.reduce(
    (score, term) => score + (term.pattern.test(text) ? term.weight : 0),
    0,
  );
}

function isAllowedSource(source) {
  const value = String(source || "");
  return ALLOWED_SOURCE_NAMES.has(value) && !BLOCKED_SOURCE_PATTERN.test(value);
}

function isStraightNewsArticle(article) {
  return !EXCLUDED_URL_PATH_PATTERN.test(String(article.link || ""));
}

function existingArticleUrls({ archiveRoot = ARTICLE_ARCHIVE_ROOT } = {}) {
  if (!fs.existsSync(archiveRoot)) {
    return new Set();
  }

  const urls = new Set();
  for (const entry of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const postPath = path.join(archiveRoot, entry.name, "post.json");
    if (!fs.existsSync(postPath)) {
      continue;
    }

    try {
      const post = JSON.parse(fs.readFileSync(postPath, "utf8"));
      if (post.article_url) {
        urls.add(String(post.article_url));
      }
    } catch {
      // Ignore malformed historical archives; validation will cover new archives.
    }
  }

  return urls;
}

function selectArticle(articles, { date, maxAgeDays = DEFAULT_MAX_AGE_DAYS, usedUrls = existingArticleUrls() } = {}) {
  const cutoff = plannedDateBoundary(date);
  cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
  const plannedEnd = plannedDateBoundary(date, { endOfDay: true });

  const candidates = articles
    .filter((article) => isAllowedSource(article.source))
    .filter((article) => isStraightNewsArticle(article))
    .filter((article) => !usedUrls.has(article.link))
    .map((article) => ({ ...article, relevanceScore: scoreArticle(article) }))
    .filter((article) => article.relevanceScore >= MIN_RELEVANCE_SCORE)
    .filter((article) => !article.publishedAt || (article.publishedAt >= cutoff && article.publishedAt <= plannedEnd))
    .sort((left, right) => {
      if (right.relevanceScore !== left.relevanceScore) {
        return right.relevanceScore - left.relevanceScore;
      }

      return Number(right.publishedAt || 0) - Number(left.publishedAt || 0);
    });

  return candidates[0] || null;
}

function contentKey(article) {
  return `weekly-news-${article.source}-${article.title}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 96);
}

function articleCopyText(article) {
  return `${article.title} ${article.description}`;
}

function cleanSentence(value) {
  const cleaned = String(value || "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/\s+([,.;?!])/g, "$1")
    .trim();

  if (!cleaned) {
    return "";
  }

  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function titleAsNewsLead(title) {
  const cleaned = cleanSentence(title)
    .replace(/^breaking news[,:\s-]+/i, "")
    .replace(/^exclusive[,:\s-]+/i, "")
    .replace(/^analysis[,:\s-]+/i, "")
    .replace(/^watch[,:\s-]+/i, "")
    .trim();

  if (!cleaned) {
    return "";
  }

  if (/^(whistleblower|source|official|watchdog|inspector general|auditor|judge|court|lawmakers|agency|company|workers|employees)\b/i.test(cleaned)) {
    return cleaned.replace(/^whistleblower\b/i, "A whistleblower");
  }

  if (/^(new|proposed|federal|state|local)\b/i.test(cleaned)) {
    return cleaned.replace(/^new\b/i, "A new");
  }

  return cleaned;
}

function articleDetailSentence(article) {
  const description = cleanSentence(article.description);
  if (!description || description.length < 40) {
    return "";
  }

  if (description.toLowerCase().includes(article.title.toLowerCase().slice(0, 40))) {
    return "";
  }

  return description.length <= 220
    ? description
    : `${description.slice(0, 217).replace(/\s+\S*$/, "")}...`;
}

function classifyArticleAngle(article) {
  const text = articleCopyText(article);
  return ARTICLE_ANGLES.find((angle) => angle.pattern.test(text)) || ARTICLE_ANGLES[ARTICLE_ANGLES.length - 1];
}

function articleReadLine(article) {
  return `Read the article from ${article.source}\n${article.link}`;
}

function ctaLine({ short = false } = {}) {
  return short
    ? `Sign up for Hush Line at ${HUSHLINE_URL}.`
    : `Give sources a safer way to make first contact. Sign up for Hush Line at ${HUSHLINE_URL}.`;
}

function validateArticleCopy(copyByNetwork) {
  for (const [network, copy] of Object.entries(copyByNetwork)) {
    if (!copy || typeof copy !== "string") {
      throw new Error(`Missing ${network} article copy.`);
    }

    for (const { pattern, reason } of BANNED_COPY_PATTERNS) {
      if (pattern.test(copy)) {
        throw new Error(`${network} article copy failed quality gate for ${reason}.`);
      }
    }
  }
}

function composeCopy(article) {
  const angle = classifyArticleAngle(article);
  const lead = titleAsNewsLead(article.title);
  const detail = articleDetailSentence(article);
  const linkedin = [
    lead,
    detail || angle.value,
    articleReadLine(article),
    ctaLine(),
  ].join("\n\n");
  const mastodon = [
    lead,
    angle.shortValue,
    articleReadLine(article),
    ctaLine({ short: true }),
  ].join("\n\n");
  const bluesky = [
    lead,
    articleReadLine(article),
    ctaLine({ short: true }),
  ].join("\n\n");
  const social = {
    bluesky: clampText(bluesky, LIMITS.bluesky),
    linkedin: clampText(linkedin, LIMITS.linkedin),
    mastodon: clampText(mastodon, LIMITS.mastodon),
  };

  validateArticleCopy(social);
  return social;
}

function buildPost(article, args) {
  const social = composeCopy(article);
  return {
    slot: "weekly-news-article",
    planned_date: args.date,
    weekday: getWeekdayLabel(args.date),
    publish_mode: "text",
    source: article.source,
    title: article.title,
    article_url: article.link,
    article_published_at: article.publishedAt ? article.publishedAt.toISOString() : null,
    relevance_score: article.relevanceScore,
    content_key: contentKey(article),
    headline: `Whistleblower-related reporting from ${article.source}`,
    subtext: `${article.source} reports: ${article.title}`,
    social,
    rationale: "Share one current, credible whistleblower-related news article and bring the call to action back to signing up for Hush Line.",
    audience_scope: "whistleblower-news",
    concept_key: "weekly-whistleblower-news-article",
    copy_brief: "Specific, story-led article-share copy with article link and Hush Line signup CTA.",
  };
}

function writePostCopy(outputDir, post) {
  const lines = [
    `Slot: ${post.slot}`,
    `Planned date: ${post.planned_date}`,
    `Publish mode: ${post.publish_mode}`,
    `Source: ${post.source}`,
    `Article URL: ${post.article_url}`,
    `Content key: ${post.content_key}`,
    `Headline: ${post.headline}`,
    `Subtext: ${post.subtext}`,
    "",
    "Social post copy",
    "",
    `LinkedIn (${post.social.linkedin.length}/${LIMITS.linkedin})`,
    post.social.linkedin,
    "",
    `Mastodon (${post.social.mastodon.length}/${LIMITS.mastodon})`,
    post.social.mastodon,
    "",
    `Bluesky (${post.social.bluesky.length}/${LIMITS.bluesky})`,
    post.social.bluesky,
    "",
  ];

  fs.writeFileSync(path.join(outputDir, "post-copy.txt"), lines.join("\n"));
}

async function readFeed(feed) {
  if (feed.url.startsWith("file://")) {
    return fs.readFileSync(new URL(feed.url), "utf8");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.HUSHLINE_SOCIAL_ARTICLE_FEED_TIMEOUT_MS || 12000));

  try {
    const response = await fetch(feed.url, {
      headers: {
        "User-Agent": "HushLineSocialAgent/1.0 (+https://hushline.app)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function loadFeeds(feedFile) {
  if (!feedFile) {
    return ALLOWED_FEEDS;
  }

  const loaded = JSON.parse(fs.readFileSync(feedFile, "utf8"));
  if (!Array.isArray(loaded)) {
    throw new Error("`--feed-file` must contain a JSON array of { source, url } entries.");
  }

  return loaded;
}

async function collectArticles(feeds) {
  const articles = [];
  const errors = [];

  for (const feed of feeds) {
    if (!feed.source || !feed.url) {
      errors.push(`Skipping malformed feed entry: ${JSON.stringify(feed)}`);
      continue;
    }

    if (!isAllowedSource(feed.source)) {
      errors.push(`Skipping blocked or untrusted source: ${feed.source}`);
      continue;
    }

    try {
      const xml = await readFeed(feed);
      articles.push(...parseFeedItems(xml, feed.source));
    } catch (error) {
      errors.push(`Failed to read ${feed.source} feed ${feed.url}: ${error.message}`);
    }
  }

  return { articles, errors };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const feeds = loadFeeds(args.feedFile);
  const { articles, errors } = await collectArticles(feeds);
  const selected = selectArticle(articles, { date: args.date, maxAgeDays: args.maxAgeDays });

  if (!selected) {
    for (const error of errors) {
      process.stderr.write(`${error}\n`);
    }
    throw new Error("No current whistleblower-related article found from the approved source allowlist.");
  }

  const post = buildPost(selected, args);
  const outputDir = path.join(ARTICLE_ARCHIVE_ROOT, args.archiveKey);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(post, null, 2)}\n`);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, "post.json"), post);
  writePostCopy(outputDir, post);
  process.stdout.write(`Archived weekly article post: ${path.relative(REPO_ROOT, outputDir)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = {
    ALLOWED_FEEDS,
    BLOCKED_SOURCE_PATTERN,
    MIN_RELEVANCE_SCORE,
    buildPost,
    classifyArticleAngle,
    collectArticles,
    composeCopy,
    parseFeedItems,
    scoreArticle,
    titleAsNewsLead,
    validateArticleCopy,
    selectArticle,
    isStraightNewsArticle,
  };
}
