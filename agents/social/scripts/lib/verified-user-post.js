"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const puppeteer = require("puppeteer-core");
const QRCode = require("qrcode");
const { pathToFileURL } = require("url");
const {
  AGENT_ROOT,
  LIMITS,
  LOCAL_LOGO,
  REPO_ROOT,
  findChrome,
  readJson,
  writeJson,
} = require("./social-common");

const VERIFIED_USER_POSTS_ROOT = path.join(REPO_ROOT, "previous-verified-user-posts");
const VERIFIED_USER_TEMPLATE = path.join(
  AGENT_ROOT,
  "templates",
  "hushline-social-verified-user-template.html",
);
const FONT_REGULAR_PATH = path.join(
  AGENT_ROOT,
  "assets",
  "fonts",
  "AtkinsonHyperlegible-Regular.ttf",
);
const FONT_BOLD_PATH = path.join(AGENT_ROOT, "assets", "fonts", "AtkinsonHyperlegible-Bold.ttf");
const DEFAULT_DIRECTORY_SOURCE = process.env.HUSHLINE_VERIFIED_USERS_SOURCE || "https://tips.hushline.app/directory/users.json";
const DEFAULT_TIPS_BASE_URL = process.env.HUSHLINE_VERIFIED_USERS_BASE_URL || "https://tips.hushline.app";
const QR_FILENAME = "verified-user-qr.png";
const VERIFIED_MEMBER_HIGHLIGHT = "🤩 Verified Member Highlight!";
const RECENT_FORMAT_WINDOW = 6;
const SOCIAL_COPY_CONFIG = {
  bluesky: {
    bioLimit: 165,
    cta: (name, userUrl) => `Send ${name} a tip: ${userUrl}`,
    minBioLimit: 72,
    step: 12,
  },
  linkedin: {
    bioLimit: 260,
    cta: (name, userUrl) => `To send ${name} a tip, go to ${userUrl}.`,
    minBioLimit: 96,
    step: 16,
  },
  mastodon: {
    bioLimit: 210,
    cta: (name, userUrl) => `To send ${name} a tip, visit ${userUrl}.`,
    minBioLimit: 84,
    step: 14,
  },
};
const VERIFIED_USER_FORMATS = [
  {
    id: "why_follow_tip_line",
    label: "Why follow this tip line",
    opening: (_network, selectedUser) => `Why follow ${possessiveName(tipRecipientLabel(selectedUser.display_name))} Hush Line?`,
    cta: (network, selectedUser) => {
      const name = tipRecipientLabel(selectedUser.display_name);
      if (network === "bluesky") {
        return `Review the verified link before sending a tip: ${selectedUser.user_url}`;
      }
      return `Review ${possessiveName(name)} verified Hush Line link before sending a tip: ${selectedUser.user_url}.`;
    },
  },
  {
    id: "what_this_recipient_covers",
    label: "What this recipient covers",
    opening: () => "What this recipient covers:",
    cta: (network, selectedUser) => buildTipCta(network, selectedUser.display_name, selectedUser.user_url),
  },
  {
    id: "before_you_contact_them",
    label: "Before you contact them",
    opening: (_network, selectedUser) => `Before you contact ${tipRecipientLabel(selectedUser.display_name)}:`,
    cta: (network, selectedUser) => {
      if (network === "bluesky") {
        return `Use the verified URL when you are ready to reach out: ${selectedUser.user_url}`;
      }
      return `Use the verified URL when you are ready to reach out: ${selectedUser.user_url}.`;
    },
  },
  {
    id: "how_to_verify_the_link",
    label: "How to verify the link",
    opening: () => "Verify the link before you send anything sensitive.",
    cta: (network, selectedUser) => {
      const name = tipRecipientLabel(selectedUser.display_name);
      if (network === "bluesky") {
        return `${possessiveName(name)} verified Hush Line URL: ${selectedUser.user_url}`;
      }
      return `${possessiveName(name)} verified Hush Line URL: ${selectedUser.user_url}.`;
    },
  },
  {
    id: "source_safe_first_contact",
    label: "Source-safe first contact",
    opening: () => "First contact should be source-safe.",
    cta: (network, selectedUser) => {
      const name = tipRecipientLabel(selectedUser.display_name);
      if (network === "bluesky") {
        return `Start with ${possessiveName(name)} verified Hush Line URL: ${selectedUser.user_url}`;
      }
      return `Start with ${possessiveName(name)} verified Hush Line URL: ${selectedUser.user_url}.`;
    },
  },
  {
    id: "from_the_directory",
    label: "From the directory",
    opening: (_network, selectedUser) => `From the verified Hush Line directory: ${selectedUser.display_name}.`,
    cta: (network, selectedUser) => {
      if (network === "bluesky") {
        return `Open the profile: ${selectedUser.user_url}`;
      }
      return `Open the profile: ${selectedUser.user_url}.`;
    },
  },
];

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/render-verified-user-post.js --date 2026-03-30",
      "  node scripts/render-verified-user-post.js --date 2026-03-30 --source ./verified-users.json",
      "",
      "Behavior:",
      "  - Reads verified directory listings from a JSON file or URL",
      "  - Selects one verified user for the requested date",
      "  - Fills the verified-user social template with display name, bio, URL, and QR code",
      "  - Writes artifacts under previous-verified-user-posts/YYYY-MM-DD",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_TIPS_BASE_URL,
    date: todayString(),
    noRender: false,
    source: DEFAULT_DIRECTORY_SOURCE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--date") {
      args.date = argv[index + 1];
      index += 1;
    } else if (value === "--source") {
      args.source = argv[index + 1];
      index += 1;
    } else if (value === "--base-url") {
      args.baseUrl = argv[index + 1];
      index += 1;
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

  try {
    new URL(args.baseUrl);
  } catch {
    throw new Error("`--base-url` must be an absolute URL.");
  }

  if (!String(args.source || "").trim()) {
    throw new Error("`--source` must not be empty.");
  }

  return args;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function buildEmbeddedFontCss() {
  if (!fs.existsSync(FONT_REGULAR_PATH) || !fs.existsSync(FONT_BOLD_PATH)) {
    throw new Error(`Missing embedded font assets: ${FONT_REGULAR_PATH} and ${FONT_BOLD_PATH}`);
  }

  const regularBase64 = fs.readFileSync(FONT_REGULAR_PATH).toString("base64");
  const boldBase64 = fs.readFileSync(FONT_BOLD_PATH).toString("base64");

  return [
    "  <style>",
    "    @font-face {",
    "      font-family: \"Atkinson Hyperlegible Embedded\";",
    "      font-style: normal;",
    "      font-weight: 400;",
    "      src: url(data:font/ttf;base64," + regularBase64 + ") format(\"truetype\");",
    "    }",
    "",
    "    @font-face {",
    "      font-family: \"Atkinson Hyperlegible Embedded\";",
    "      font-style: normal;",
    "      font-weight: 700;",
    "      src: url(data:font/ttf;base64," + boldBase64 + ") format(\"truetype\");",
    "    }",
    "",
    "    body {",
    "      font-family: \"Atkinson Hyperlegible Embedded\", \"Atkinson Hyperlegible\", Inter, Arial, Helvetica, sans-serif !important;",
    "    }",
    "",
    "    h1, h2, h3, h4, h5, h6, p, span, div, a, button, li {",
    "      font-family: \"Atkinson Hyperlegible Embedded\", \"Atkinson Hyperlegible\", Inter, Arial, Helvetica, sans-serif;",
    "    }",
    "  </style>",
  ].join("\n");
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanMalformedPunctuation(value) {
  return normalizeWhitespace(value)
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([!?])\./g, "$1")
    .replace(/\.([!?])/g, "$1")
    .replace(/([!?]){2,}/g, "$1")
    .replace(/\.{2,}(?!\.)/g, ".")
    .replace(/,([.!?])/g, "$1")
    .trim();
}

function normalizeSortValue(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function ensureTerminalPunctuation(value) {
  const normalized = cleanMalformedPunctuation(value);
  if (!normalized) {
    return "";
  }

  return /(?:[.!?…]|\.{3})$/.test(normalized) ? normalized : `${normalized}.`;
}

function truncateAtWordBoundary(value, limit) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }

  const clipped = normalized.slice(0, Math.max(0, limit - 1)).trimEnd();
  const boundary = clipped.lastIndexOf(" ");
  const safeClip = boundary > Math.floor(limit * 0.6) ? clipped.slice(0, boundary) : clipped;
  const cleanClip = safeClip.replace(/[.!?,;:]+$/g, "").trimEnd();
  return `${cleanClip}…`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstNameFromDisplayName(displayName) {
  const normalized = normalizeWhitespace(displayName);
  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const cleaned = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (cleaned) {
      return cleaned;
    }
  }

  return normalized;
}

function cleanedDisplayTokens(displayName) {
  return normalizeWhitespace(displayName)
    .split(/\s+/)
    .map((part) => part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
    .filter(Boolean);
}

function isLikelyOrganizationName(displayName) {
  const normalized = normalizeWhitespace(displayName);
  if (!normalized) {
    return false;
  }

  const organizationPatterns = [
    /\bboard\b/i,
    /\bteam\b/i,
    /\bproject\b/i,
    /\bregister\b/i,
    /\bline\b/i,
    /\bnews\b/i,
    /\bcorp\b/i,
    /\binc\b/i,
    /\bllc\b/i,
    /\bltd\b/i,
    /\bmedia\b/i,
    /\bnetwork\b/i,
    /\bassociation\b/i,
    /\bcouncil\b/i,
    /\bcommittee\b/i,
    /\bfoundation\b/i,
  ];

  return organizationPatterns.some((pattern) => pattern.test(normalized));
}

function prefersPersonStyle(displayName) {
  const tokens = cleanedDisplayTokens(displayName);
  if (tokens.length === 0 || isLikelyOrganizationName(displayName)) {
    return false;
  }

  if (tokens.length === 1) {
    return true;
  }

  if (tokens.length > 3) {
    return false;
  }

  return tokens.every((token) => /^[A-Za-z0-9.'-]+$/.test(token));
}

function lowerCasePhraseLead(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }

  const words = normalized.split(/\s+/);
  const bridgeWords = new Set(["at", "for", "in", "of", "on", "with", "from", "the", "a", "an", "&"]);
  const transformed = [];
  let preserveTail = false;

  for (const word of words) {
    if (preserveTail) {
      transformed.push(word);
      continue;
    }

    const bare = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    const lowerBare = bare.toLowerCase();
    if (bridgeWords.has(lowerBare)) {
      transformed.push(lowerBare === bare ? word : word.replace(bare, lowerBare));
      preserveTail = true;
      continue;
    }

    if (/^[A-Z][a-z]+$/.test(bare)) {
      transformed.push(word.replace(bare, bare.toLowerCase()));
      continue;
    }

    transformed.push(word);
  }

  return transformed.join(" ");
}

function looksLikeBareRolePhrase(value) {
  const normalized = normalizeWhitespace(value).replace(/[.!?…]+$/, "");
  if (!normalized) {
    return false;
  }

  if (/\b(is|are|was|were|be|been|being|work|works|working|cover|covers|covering|write|writes|writing|go|goes|accept|accepts|focus|focuses)\b/i.test(normalized)) {
    return false;
  }

  return normalized.length <= 120;
}

function possessiveName(name) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function indefiniteArticleForPhrase(value) {
  const normalized = normalizeWhitespace(value).replace(/^[^A-Za-z0-9]+/, "");
  if (!normalized) {
    return "a";
  }

  if (/^(honest|honor|hour|heir|editorial)\b/i.test(normalized)) {
    return "an";
  }

  return /^[aeiou]/i.test(normalized) ? "an" : "a";
}

function fetchRemoteJson(source) {
  const client = source.startsWith("https://") ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.get(source, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        const redirected = new URL(response.headers.location, source).toString();
        resolve(fetchRemoteJson(redirected));
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to fetch verified-user directory JSON: ${source} (${response.statusCode})`));
        return;
      }

      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Verified-user directory source is not valid JSON: ${source}: ${error.message}`));
        }
      });
    });

    request.on("error", (error) => {
      reject(new Error(`Failed to fetch verified-user directory JSON: ${source}: ${error.message}`));
    });
  });
}

async function readDirectoryPayload(source) {
  if (/^https?:\/\//i.test(source)) {
    return fetchRemoteJson(source);
  }

  const resolvedPath = path.isAbsolute(source) ? source : path.resolve(REPO_ROOT, source);
  return readJson(resolvedPath);
}

function extractDirectoryEntries(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object") {
    for (const key of ["users", "entries", "results", "items", "data"]) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }

  throw new Error("Verified-user directory JSON must be an array or an object containing `users`, `entries`, `results`, `items`, or `data`.");
}

function buildUserUrl(entry, baseUrl) {
  const rawUrl = normalizeWhitespace(entry.profile_url || entry.user_url || entry.url);
  const username = normalizeWhitespace(entry.primary_username || entry.username);
  let userUrl = "";

  if (rawUrl) {
    userUrl = new URL(rawUrl, baseUrl).toString();
  } else if (username) {
    userUrl = new URL(`/to/${username}`, baseUrl).toString();
  } else {
    throw new Error("Verified user entry is missing both `profile_url` and `primary_username`.");
  }

  const pathname = new URL(userUrl).pathname;
  if (!pathname.startsWith("/to/")) {
    throw new Error(`Verified user URL must point to /to/...: ${userUrl}`);
  }

  return userUrl;
}

function normalizeVerifiedUsers(payload, baseUrl) {
  const entries = extractDirectoryEntries(payload);
  const users = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    if (entry.entry_type && entry.entry_type !== "user") {
      continue;
    }

    if (!entry.is_verified) {
      continue;
    }

    if (entry.is_admin) {
      continue;
    }

    const displayName = normalizeWhitespace(entry.display_name || entry.name || entry.primary_username || entry.username);
    const bio = normalizeWhitespace(entry.bio || entry.description);
    const username = normalizeWhitespace(entry.primary_username || entry.username);

    if (!displayName || !bio) {
      continue;
    }

    const userUrl = buildUserUrl(entry, baseUrl);
    users.push({
      bio,
      display_name: displayName,
      is_admin: Boolean(entry.is_admin),
      primary_username: username || new URL(userUrl).pathname.replace(/^\/to\//, ""),
      profile_url: normalizeWhitespace(entry.profile_url || ""),
      user_url: userUrl,
    });
  }

  if (users.length === 0) {
    throw new Error("No eligible verified users were found in the directory JSON.");
  }

  return users.sort((left, right) => {
    const leftKey = `${normalizeSortValue(left.display_name)} ${normalizeSortValue(left.primary_username)}`;
    const rightKey = `${normalizeSortValue(right.display_name)} ${normalizeSortValue(right.primary_username)}`;
    return leftKey.localeCompare(rightKey);
  });
}

function loadArchiveHistory(currentDate, archiveRoot = VERIFIED_USER_POSTS_ROOT) {
  if (!fs.existsSync(archiveRoot)) {
    return [];
  }

  return fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < currentDate)
    .map((entry) => entry.name)
    .sort()
    .map((date) => {
      const postPath = path.join(archiveRoot, date, "post.json");
      if (!fs.existsSync(postPath)) {
        return null;
      }

      const post = readJson(postPath);
      return {
        date,
        display_name: post.display_name,
        opening_line: normalizeWhitespace(post.opening_line || firstSocialLine(post.social)),
        primary_username: post.primary_username,
        verified_user_format: normalizeWhitespace(post.verified_user_format || post.social_format || post.format),
        user_url: post.user_url,
      };
    })
    .filter(Boolean);
}

function firstSocialLine(social) {
  if (!social || typeof social !== "object") {
    return "";
  }

  for (const network of ["linkedin", "mastodon", "bluesky"]) {
    const copy = String(social[network] || "");
    const line = copy.split(/\r?\n/).map(normalizeWhitespace).find(Boolean);
    if (line) {
      return line;
    }
  }

  return "";
}

function shuffleKey(user, seed = "") {
  return crypto
    .createHash("sha256")
    .update(`${seed}\n${user.primary_username}\n${user.user_url}`)
    .digest("hex");
}

function selectVerifiedUser(users, archiveHistory, currentDate = "") {
  const postedUsernames = new Set(
    archiveHistory
      .map((entry) => entry.primary_username)
      .filter(Boolean),
  );
  const unseenUsers = users.filter((user) => !postedUsernames.has(user.primary_username));

  if (unseenUsers.length === 0) {
    throw new Error(
      "No unposted verified users remain in the current directory dataset. Refusing to create a duplicate weekly verified-user post.",
    );
  }

  return unseenUsers
    .slice()
    .sort((left, right) => {
      const leftKey = shuffleKey(left, currentDate);
      const rightKey = shuffleKey(right, currentDate);
      if (leftKey === rightKey) {
        return left.primary_username.localeCompare(right.primary_username);
      }
      return leftKey.localeCompare(rightKey);
    })[0];
}

function rewriteBioForCopy(selectedUser, limit) {
  const displayName = normalizeWhitespace(selectedUser.display_name);
  const personStyle = prefersPersonStyle(displayName);
  const firstName = firstNameFromDisplayName(displayName) || displayName;
  const subjectName = personStyle && cleanedDisplayTokens(displayName).length > 1
    ? firstName
    : displayName;
  const bio = normalizeWhitespace(selectedUser.bio);
  if (!bio) {
    return ensureTerminalPunctuation(`${displayName} has a verified Hush Line profile`);
  }

  const shortenedBio = truncateAtWordBoundary(bio, limit);
  const normalized = ensureTerminalPunctuation(shortenedBio);
  const displayPattern = escapeRegExp(displayName);
  const firstPattern = escapeRegExp(firstName);

  if (
    new RegExp(`^${displayPattern}\\b`, "i").test(normalized) ||
    new RegExp(`^${firstPattern}\\b`, "i").test(normalized)
  ) {
    return normalized;
  }

  if (/^messages go to\s+/i.test(normalized)) {
    return ensureTerminalPunctuation(normalized.replace(/^messages go to\s+/i, `Messages to ${displayName} go to `));
  }

  const replacements = [
    {
      pattern: new RegExp(`^i am\\s+`, "i"),
      value: `${subjectName} is `,
    },
    {
      pattern: new RegExp(`^(i'm|i’m)\\s+`, "i"),
      value: `${subjectName} is `,
    },
    {
      pattern: new RegExp(`^i work as\\s+(an?\\s+)`, "i"),
      value: `${subjectName} is $1`,
    },
    {
      pattern: new RegExp(`^i work as\\s+`, "i"),
      value: `${subjectName} is `,
    },
    {
      pattern: new RegExp(`^i work in\\s+`, "i"),
      value: `${subjectName} works in `,
    },
    {
      pattern: new RegExp(`^i cover\\s+`, "i"),
      value: `${subjectName} covers `,
    },
    {
      pattern: new RegExp(`^i investigate\\s+`, "i"),
      value: `${subjectName} investigates `,
    },
    {
      pattern: new RegExp(`^my work focuses on\\s+`, "i"),
      value: `${possessiveName(subjectName)} work focuses on `,
    },
    {
      pattern: new RegExp(`^my reporting focuses on\\s+`, "i"),
      value: `${possessiveName(subjectName)} reporting focuses on `,
    },
    {
      pattern: new RegExp(`^${displayPattern}\\s+is\\s+`, "i"),
      value: `${subjectName} is `,
    },
    {
      pattern: new RegExp(`^${firstPattern}\\s+is\\s+`, "i"),
      value: `${subjectName} is `,
    },
  ];

  for (const replacement of replacements) {
    if (replacement.pattern.test(normalized)) {
      return ensureTerminalPunctuation(normalized.replace(replacement.pattern, replacement.value));
    }
  }

  if (personStyle && looksLikeBareRolePhrase(normalized)) {
    const role = lowerCasePhraseLead(normalized).replace(/^[Aa]n?\s+/i, "");
    return ensureTerminalPunctuation(`${subjectName} is ${indefiniteArticleForPhrase(role)} ${role}`);
  }

  return normalized;
}

function shouldPreferLiteralBioRewrite(selectedUser) {
  const bio = normalizeWhitespace(selectedUser && selectedUser.bio).replace(/[.!?…]+$/, "");
  if (!bio) {
    return false;
  }

  return looksLikeBareRolePhrase(bio) && bio.length <= 80;
}

function tipRecipientLabel(displayName) {
  const normalized = normalizeWhitespace(displayName);
  if (!normalized) {
    return "";
  }

  if (prefersPersonStyle(normalized)) {
    const tokens = cleanedDisplayTokens(normalized);
    return tokens.length > 1 ? firstNameFromDisplayName(normalized) : normalized;
  }

  return normalized;
}

function resolveVerifiedUserFormat(format) {
  if (!format) {
    return VERIFIED_USER_FORMATS[0];
  }

  const id = typeof format === "string" ? format : format.id;
  return VERIFIED_USER_FORMATS.find((candidate) => candidate.id === id) || VERIFIED_USER_FORMATS[0];
}

function chooseVerifiedUserFormat(archiveHistory = [], currentDate = "") {
  const recent = archiveHistory.slice(-RECENT_FORMAT_WINDOW);
  const recentFormatIds = new Set(recent.map((entry) => entry.verified_user_format).filter(Boolean));
  const unusedRecentFormats = VERIFIED_USER_FORMATS.filter((format) => !recentFormatIds.has(format.id));
  const candidates = unusedRecentFormats.length > 0 ? unusedRecentFormats : VERIFIED_USER_FORMATS;

  return candidates
    .slice()
    .sort((left, right) => {
      const leftLastUsed = lastUsedIndex(archiveHistory, left.id);
      const rightLastUsed = lastUsedIndex(archiveHistory, right.id);
      if (leftLastUsed !== rightLastUsed) {
        return rightLastUsed - leftLastUsed;
      }

      const leftKey = formatShuffleKey(left.id, currentDate);
      const rightKey = formatShuffleKey(right.id, currentDate);
      if (leftKey === rightKey) {
        return left.id.localeCompare(right.id);
      }
      return leftKey.localeCompare(rightKey);
    })[0];
}

function lastUsedIndex(archiveHistory, formatId) {
  const index = archiveHistory
    .map((entry) => entry.verified_user_format)
    .lastIndexOf(formatId);

  return index === -1 ? Number.MAX_SAFE_INTEGER : archiveHistory.length - index;
}

function formatShuffleKey(formatId, seed = "") {
  return crypto
    .createHash("sha256")
    .update(`${seed}\n${formatId}`)
    .digest("hex");
}

function buildOpeningLine(network, selectedUser, format) {
  return cleanMalformedPunctuation(resolveVerifiedUserFormat(format).opening(network, selectedUser));
}

function buildFormatCta(network, selectedUser, format) {
  return cleanMalformedPunctuation(resolveVerifiedUserFormat(format).cta(network, selectedUser));
}

function buildTipCta(network, displayName, userUrl) {
  const name = tipRecipientLabel(displayName);
  const personStyle = prefersPersonStyle(displayName);

  if (network === "bluesky") {
    return personStyle
      ? `Send ${name} a tip: ${userUrl}`
      : `Send a tip to ${name}: ${userUrl}`;
  }

  if (network === "mastodon") {
    return personStyle
      ? `To send ${name} a tip, visit ${userUrl}.`
      : `To send a tip to ${name}, visit ${userUrl}.`;
  }

  return personStyle
    ? `To send ${name} a tip, go to ${userUrl}.`
    : `To send a tip to ${name}, go to ${userUrl}.`;
}

function composeVerifiedUserSocialCopy(network, selectedUser, middleParagraph, format = VERIFIED_USER_FORMATS[0]) {
  const selectedFormat = resolveVerifiedUserFormat(format);
  const paragraph = ensureTerminalPunctuation(normalizeWhitespace(middleParagraph));
  if (!paragraph) {
    throw new Error(`Missing generated ${network} paragraph for @${selectedUser.primary_username}.`);
  }

  return [
    buildOpeningLine(network, selectedUser, selectedFormat),
    "",
    paragraph,
    "",
    buildFormatCta(network, selectedUser, selectedFormat),
  ].join("\n");
}

function composeSocialParagraph(network, selectedUser, format = VERIFIED_USER_FORMATS[0]) {
  const config = SOCIAL_COPY_CONFIG[network];
  let bioLimit = config.bioLimit;
  const selectedFormat = resolveVerifiedUserFormat(format);

  while (bioLimit >= config.minBioLimit) {
    const bio = rewriteBioForCopy(selectedUser, bioLimit);
    if (composeVerifiedUserSocialCopy(network, selectedUser, bio, selectedFormat).length <= LIMITS[network]) {
      return bio;
    }

    bioLimit -= config.step;
  }

  throw new Error(`Could not compose ${network} copy within ${LIMITS[network]} characters for @${selectedUser.primary_username}.`);
}

function stabilizeGeneratedParagraph(network, selectedUser, paragraph) {
  const candidate = ensureTerminalPunctuation(normalizeWhitespace(paragraph));
  if (!candidate) {
    return candidate;
  }

  if (shouldPreferLiteralBioRewrite(selectedUser)) {
    const fallbackLimit = Math.max(96, normalizeWhitespace(selectedUser.bio).length + normalizeWhitespace(selectedUser.display_name).length + 32);
    return rewriteBioForCopy(selectedUser, fallbackLimit);
  }

  return candidate;
}

function fitGeneratedParagraphToLimit(network, selectedUser, paragraph, format = VERIFIED_USER_FORMATS[0]) {
  let candidate = ensureTerminalPunctuation(normalizeWhitespace(paragraph));
  if (!candidate) {
    throw new Error(`Missing generated ${network} paragraph for @${selectedUser.primary_username}.`);
  }

  if (composeVerifiedUserSocialCopy(network, selectedUser, candidate, format).length <= LIMITS[network]) {
    return candidate;
  }

  let limit = Math.max(24, candidate.length - 16);
  while (limit >= 24) {
    const shortened = ensureTerminalPunctuation(truncateAtWordBoundary(candidate, limit));
    if (composeVerifiedUserSocialCopy(network, selectedUser, shortened, format).length <= LIMITS[network]) {
      return shortened;
    }
    limit -= 12;
  }

  throw new Error(`Generated ${network} copy exceeds ${LIMITS[network]} characters for @${selectedUser.primary_username}.`);
}

function validateVerifiedUserSocialParagraphs(paragraphs, selectedUser, options = {}) {
  if (!paragraphs || typeof paragraphs !== "object") {
    throw new Error("Generated verified-user copy must be an object.");
  }

  const validated = {};
  for (const network of Object.keys(LIMITS)) {
    const value = normalizeWhitespace(paragraphs[network]);
    if (!value) {
      throw new Error(`Generated verified-user copy is missing ${network}.`);
    }

    if (/\b(I|I'm|I’m|my|me|we|we're|we’re|our|us)\b/i.test(value)) {
      throw new Error(`Generated ${network} copy for @${selectedUser.primary_username} must not use first-person language.`);
    }

    if (/\b(the profile says|the bio says|according to (the )?(profile|bio)|listed as|this profile|this bio|this account|the account says|the page says)\b/i.test(value)) {
      throw new Error(`Generated ${network} copy for @${selectedUser.primary_username} must not use distancing meta-language about the profile.`);
    }

    if (/[.!?]{2,}|[!?]\.|\.([!?])|,\s*[.!?]/.test(value)) {
      throw new Error(`Generated ${network} copy for @${selectedUser.primary_username} has malformed punctuation.`);
    }

    validated[network] = fitGeneratedParagraphToLimit(network, selectedUser, stabilizeGeneratedParagraph(network, selectedUser, value), options.format);
  }

  return validated;
}

function buildVerifiedUserSocialPrompt({ date, format = VERIFIED_USER_FORMATS[0], outputPath, selectedUser, feedback = "" }) {
  const selectedFormat = resolveVerifiedUserFormat(format);
  return [
    "You are writing social post copy for one verified Hush Line profile.",
    "Write plain, factual, human copy.",
    "Do not use marketing language, hype, or filler.",
    "Do not write in first person.",
    "Do not invent facts beyond the profile text provided.",
    "Each output value must be a single middle paragraph only.",
    "Do not include the intro line.",
    "Do not include the closing URL line.",
    "Say what the profile is in clear third-person language.",
    "If the bio is already a short title or role, keep it simple instead of elaborating on it.",
    "Do not pad a short bio with synonyms, restatements, or explanatory fluff.",
    "If the profile looks like an organization, publication, team, or board, write it that way instead of forcing a first name.",
    "Do not talk about the profile as a source or record.",
    "Never say phrases like `the profile says`, `the bio says`, `according to the profile`, `listed as`, `this profile`, or `this account`.",
    "Speak directly about the person, team, publication, or organization.",
    "",
    `Planned date: ${date}`,
    `Display name: ${selectedUser.display_name}`,
    `Username: @${selectedUser.primary_username}`,
    `Profile URL: ${selectedUser.user_url}`,
    `Original profile bio: ${selectedUser.bio}`,
    `Editorial format: ${selectedFormat.label} (${selectedFormat.id})`,
    feedback ? `Revision note: ${feedback}` : "",
    "",
    "Final post structure for each network will be:",
    `1. ${buildOpeningLine("linkedin", selectedUser, selectedFormat)}`,
    "2. blank line",
    "3. your generated middle paragraph",
    "4. blank line",
    `5. ${buildFormatCta("linkedin", selectedUser, selectedFormat)}`,
    "",
    "Write valid JSON only to this file:",
    outputPath,
    "",
    "JSON schema:",
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["linkedin", "mastodon", "bluesky"],
      properties: {
        linkedin: { type: "string" },
        mastodon: { type: "string" },
        bluesky: { type: "string" },
      },
    }, null, 2),
    "",
    "Requirements:",
    "- LinkedIn can be the most complete version.",
    "- Mastodon should stay tighter.",
    "- Bluesky should be the tightest version.",
    "- Preserve specific factual details from the bio when they matter.",
    "- Rewrite first-person profile text into third person or direct descriptive language.",
    "- Keep the meaning of the profile intact.",
    "- Example: if the bio is `3D Character Artist`, write `Yumi is a 3D character artist.` Do not expand it into `working in three-dimensional character art`.",
  ].join("\n");
}

function composeSocialCopy(network, selectedUser, format = VERIFIED_USER_FORMATS[0]) {
  return composeVerifiedUserSocialCopy(network, selectedUser, composeSocialParagraph(network, selectedUser, format), format);
}

function buildVerifiedUserSocialParagraphs(selectedUser, format = VERIFIED_USER_FORMATS[0]) {
  return {
    bluesky: composeSocialParagraph("bluesky", selectedUser, format),
    linkedin: composeSocialParagraph("linkedin", selectedUser, format),
    mastodon: composeSocialParagraph("mastodon", selectedUser, format),
  };
}

function buildSocialCopy(selectedUser, format = VERIFIED_USER_FORMATS[0]) {
  return {
    bluesky: composeSocialCopy("bluesky", selectedUser, format),
    linkedin: composeSocialCopy("linkedin", selectedUser, format),
    mastodon: composeSocialCopy("mastodon", selectedUser, format),
  };
}

function buildPost({ archiveHistory = [], date, format, selectedUser, source }) {
  const selectedFormat = resolveVerifiedUserFormat(format || chooseVerifiedUserFormat(archiveHistory, date));
  return {
    date,
    display_name: selectedUser.display_name,
    editorial_format_label: selectedFormat.label,
    headline: selectedUser.display_name,
    image_alt_text: `A social card featuring verified Hush Line user ${selectedUser.display_name}, their bio, their tip line URL, and a QR code that links to the same URL.`,
    opening_line: buildOpeningLine("linkedin", selectedUser, selectedFormat),
    planned_date: date,
    primary_username: selectedUser.primary_username,
    qr_code_file: QR_FILENAME,
    social: buildSocialCopy(selectedUser, selectedFormat),
    slot: "verified-user-weekly",
    source,
    subtext: selectedUser.bio,
    user_link: selectedUser.user_url,
    user_url: selectedUser.user_url,
    verified_user_format: selectedFormat.id,
  };
}

function buildContext({ date, archiveHistory, selectedFormat, selectedUser, source, verifiedUsers }) {
  return {
    archive_root: path.relative(REPO_ROOT, VERIFIED_USER_POSTS_ROOT),
    date,
    eligible_verified_user_count: verifiedUsers.length,
    recent_archive_history: archiveHistory.slice(-20),
    selected_format: {
      id: selectedFormat.id,
      label: selectedFormat.label,
      opening_line: buildOpeningLine("linkedin", selectedUser, selectedFormat),
    },
    selected_user: selectedUser,
    source,
  };
}

function renderHtml(post, qrFilename, logoFilename) {
  let html = fs.readFileSync(VERIFIED_USER_TEMPLATE, "utf8");

  html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*/g, "");
  html = html.replace(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\s*/g, "");
  html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]+" rel="stylesheet">\s*/g, "");

  html = html.replace(
    /<h1 class="headline">[\s\S]*?<\/h1>/,
    `<h1 class="headline">${escapeHtml(post.headline)}</h1>`,
  );

  html = html.replace(
    /<p class="subtext">[\s\S]*?<\/p>/,
    `<p class="subtext">\n          ${escapeHtml(post.subtext)}\n        </p>`,
  );

  html = html.replace(
    /<p class="user-link">[\s\S]*?<\/p>/,
    `<p class="user-link">${escapeHtml(post.user_link)}</p>`,
  );

  html = html.replace(
    /<img src="assets\/example-qr\.svg" alt="[^"]*" \/>/,
    `<img src="./${escapeAttribute(qrFilename)}" alt="${escapeAttribute(`QR code for ${post.user_link}`)}" />`,
  );

  html = html.replace(
    /<img src="https:\/\/hushline\.app\/assets\/img\/social\/logo-tips\.png" alt="" \/>/,
    `<img src="./${escapeAttribute(logoFilename)}" alt="" />`,
  );

  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtml(post.headline)}</title>`,
  );

  html = html.replace(
    "</head>",
    [
      buildEmbeddedFontCss(),
      "  <style>",
      "    html, body {",
      "      width: 1024px;",
      "      height: 768px;",
      "      overflow: hidden;",
      "      background: white;",
      "    }",
      "",
      "    body {",
      "      display: block;",
      "      min-height: 0;",
      "    }",
      "",
      "    .canvas {",
      "      margin: 0;",
      "    }",
      "  </style>",
      "</head>",
    ].join("\n"),
  );

  return html;
}

function buildTxt(post) {
  return [
    `Slot: ${post.slot}`,
    `Planned date: ${post.planned_date}`,
    `Verified user: @${post.primary_username}`,
    `User link: ${post.user_link}`,
    `Source: ${post.source}`,
    `Editorial format: ${post.editorial_format_label} (${post.verified_user_format})`,
    `Opening line: ${post.opening_line}`,
    `Headline: ${post.headline.replace(/\n/g, " ")}`,
    `Subtext: ${post.subtext}`,
    "",
    "Image alt text",
    post.image_alt_text,
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
  ].join("\n");
}

async function renderPng(htmlPath, outputPath) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    defaultViewport: {
      width: 1024,
      height: 768,
      deviceScaleFactor: 2,
    },
    args: [
      "--allow-file-access-from-files",
      "--disable-background-networking",
      "--disable-gpu",
      "--disable-setuid-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-sandbox",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });

    const canvas = await page.$(".canvas");
    if (!canvas) {
      throw new Error("Could not find `.canvas` in the verified-user HTML.");
    }

    await canvas.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

async function generateQrCode(url, outputPath, size = 720) {
  try {
    await QRCode.toFile(outputPath, url, {
      color: {
        dark: "#ffffffff",
        light: "#00000000",
      },
      errorCorrectionLevel: "M",
      margin: 0,
      type: "png",
      width: size,
    });
  } catch (error) {
    throw new Error(error && error.message ? error.message : `Failed to generate QR code for ${url}.`);
  }
}

async function renderVerifiedUserPost(run, options = {}) {
  const archiveRoot = options.archiveRoot || VERIFIED_USER_POSTS_ROOT;
  const outputDir = path.join(archiveRoot, run.date);
  const htmlPath = path.join(outputDir, "social-card.html");
  const pngPath = path.join(outputDir, "social-card@2x.png");
  const postPath = path.join(outputDir, "post.json");
  const txtPath = path.join(outputDir, "post-copy.txt");
  const contextPath = path.join(outputDir, "context.json");
  const qrPath = path.join(outputDir, QR_FILENAME);
  const logoFilename = path.basename(LOCAL_LOGO);

  if (!fs.existsSync(LOCAL_LOGO)) {
    throw new Error(`Missing local logo asset: ${LOCAL_LOGO}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(contextPath, run.context);
  writeJson(postPath, run.post);
  fs.writeFileSync(txtPath, `${buildTxt(run.post)}\n`);

  if (run.noRender) {
    return {
      contextPath,
      outputDir,
      postPath,
      rendered: false,
      txtPath,
    };
  }

  fs.copyFileSync(LOCAL_LOGO, path.join(outputDir, logoFilename));
  await generateQrCode(run.post.user_url, qrPath);

  const html = renderHtml(run.post, path.basename(qrPath), logoFilename);
  fs.writeFileSync(htmlPath, html);
  await renderPng(htmlPath, pngPath);

  return {
    contextPath,
    htmlPath,
    outputDir,
    pngPath,
    postPath,
    qrPath,
    rendered: true,
    txtPath,
  };
}

async function prepareVerifiedUserRun(args, options = {}) {
  const payload = await readDirectoryPayload(args.source);
  const verifiedUsers = normalizeVerifiedUsers(payload, args.baseUrl);
  const archiveHistory = loadArchiveHistory(args.date, options.archiveRoot);
  const selectedUser = selectVerifiedUser(verifiedUsers, archiveHistory, args.date);
  const selectedFormat = chooseVerifiedUserFormat(archiveHistory, args.date);

  return {
    context: buildContext({
      archiveHistory,
      date: args.date,
      selectedFormat,
      selectedUser,
      source: args.source,
      verifiedUsers,
    }),
    date: args.date,
    noRender: args.noRender,
    post: buildPost({
      archiveHistory,
      date: args.date,
      format: selectedFormat,
      selectedUser,
      source: args.source,
    }),
    selectedUser,
    verifiedUserFormat: selectedFormat,
  };
}

module.exports = {
  DEFAULT_DIRECTORY_SOURCE,
  DEFAULT_TIPS_BASE_URL,
  QR_FILENAME,
  VERIFIED_MEMBER_HIGHLIGHT,
  VERIFIED_USER_POSTS_ROOT,
  buildVerifiedUserSocialPrompt,
  buildPost,
  buildVerifiedUserSocialParagraphs,
  chooseVerifiedUserFormat,
  composeVerifiedUserSocialCopy,
  loadArchiveHistory,
  normalizeVerifiedUsers,
  parseArgs,
  prepareVerifiedUserRun,
  renderHtml,
  renderVerifiedUserPost,
  selectVerifiedUser,
  validateVerifiedUserSocialParagraphs,
};
