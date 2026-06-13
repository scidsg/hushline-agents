"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  HUSHLINE_DOCS_ROOT,
  HUSHLINE_ROOT,
  LIMITS,
  REPO_ROOT,
  SCREENSHOT_MANIFEST,
  SCREENSHOTS_ROOT,
  excerptText,
  inferScreenKey,
  listFilesRecursive,
  readJson,
  resolveScreenshotPath,
  sharedTokenCount,
  writeJson,
} = require("./social-common");

const DOC_DISCOVERY_TERMS = [
  "journalist",
  "journalists",
  "lawyer",
  "lawyers",
  "attorney",
  "attorneys",
  "whistleblower",
  "whistleblowers",
  "source",
  "sources",
  "newsroom",
  "newsrooms",
  "recipient",
  "recipients",
  "tip line",
  "anonymous",
];

const EXCLUDED_SCREEN_PATTERNS = [
  /\blogin\b/i,
  /\bregister\b/i,
  /\b2fa\b/i,
  /\binbox\b/i,
  /\bmessage submitted\b/i,
  /\bmessage status\b/i,
  /\bjs disabled\b/i,
  /\bdefault state\b/i,
  /\breset\b/i,
  /\bsearch '.*'\b/i,
  /\bsearch\b/i,
];

const PREFERRED_SCREEN_PATTERNS = [
  { pattern: /\bdirectory - verified\b/i, weight: 14 },
  { pattern: /\bencryption\b/i, weight: 12 },
  { pattern: /\bnotifications\b/i, weight: 8 },
  { pattern: /\bmessage statuses\b/i, weight: 8 },
  { pattern: /\bvision assistant\b/i, weight: 10 },
  { pattern: /\buser guidance\b/i, weight: 6 },
  { pattern: /\bauthentication\b/i, weight: 6 },
  { pattern: /\bdirectory\b/i, weight: 4 },
  { pattern: /\bonboarding\b/i, weight: 5 },
];

const ADMIN_ONLY_ROUTE_PATTERNS = [
  /^\/settings\/admin\b/i,
  /^\/settings\/registration\b/i,
];

const ADMIN_ONLY_TEXT_PATTERNS = [
  /\badmin search buster\b/i,
  /\bbranding\b/i,
];

const PUBLIC_ROUTE_PATTERNS = [
  /^\/directory\b/i,
];

const RECIPIENT_SHARED_ROUTE_PATTERNS = [
  /^\/email-headers\b/i,
  /^\/vision\b/i,
  /^\/settings\/aliases\b/i,
  /^\/settings\/auth\b/i,
  /^\/settings\/encryption\b/i,
  /^\/settings\/notifications\b/i,
  /^\/settings\/profile\b/i,
  /^\/settings\/replies\b/i,
  /^\/settings\/advanced\b/i,
];
const PLAIN_LANGUAGE_COPY_GUIDANCE = [
  "Use words a Hush Line user would say out loud: tips, messages, email, inbox, notifications, settings, profile, directory, source, recipient, team, admin.",
  "Name the visible choice or task in the screenshot before explaining why it matters.",
  "Prefer direct headings such as `Choose the notifications that work for you` over abstract slogans.",
  "Write complete sentences with a clear subject and verb. If a sentence needs product insider knowledge to understand, rewrite it.",
  "Do not invent internal concepts or labels that are absent from Hush Line materials.",
  "Avoid jargon and abstract business language such as pings, outside signal, surface, frictionless, case file, operationalize, leverage, unlock, or streamline.",
];
const TOPIC_COPY_GUIDANCE = [
  "For notification screens, say directly that recipients can choose email notifications, Hush Line inbox notifications, and whether encrypted tip contents are included in email.",
  "Do not describe notifications as pings, outside signals, or staff-return mechanisms.",
];

function parseIsoWeek(week) {
  const match = String(week).match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ISO week: ${week}`);
  }

  return {
    weekNumber: Number(match[2]),
    year: Number(match[1]),
  };
}

function getIsoWeekStart(week) {
  const { year, weekNumber } = parseIsoWeek(week);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + ((weekNumber - 1) * 7));
  return monday;
}

function loadScreenshotInventory() {
  if (!SCREENSHOT_MANIFEST.startsWith(`${SCREENSHOTS_ROOT}${path.sep}`)) {
    return loadScreenshotInventoryFromFiles();
  }

  const manifest = readJson(SCREENSHOT_MANIFEST);

  return {
    captured_at: manifest.capturedAt,
    inventory: manifest.scenes
      .map((scene) => {
        const fold = scene.files.find((file) => file.mode === "fold");
        if (!fold) {
          return null;
        }

        let absolutePath = null;
        try {
          absolutePath = resolveScreenshotPath(fold.file);
        } catch (_error) {
          return null;
        }
        return {
          absolute_path: absolutePath,
          ...inferCandidateContext({
            content_key: scene.slug,
            path: scene.path,
            session: scene.session,
            title: scene.title,
          }),
          content_key: scene.slug,
          file: fold.file,
          path: scene.path,
          session: scene.session,
          theme: scene.theme,
          title: scene.title,
          viewport: scene.viewport,
        };
      })
      .filter(Boolean),
    release: manifest.release,
  };
}

function screenshotContentKey(relativeFile) {
  return path.basename(relativeFile, ".png")
    .replace(/-(desktop|mobile)-(light|dark)-fold$/i, "");
}

function screenshotTitle(contentKey) {
  return contentKey
    .replace(/^(auth|guest)-(admin|artvandelay|newman)-/i, "")
    .replace(/^guest-/i, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function screenshotRoute(contentKey) {
  const key = String(contentKey || "");

  if (/\bdirectory\b/i.test(key)) {
    return "/directory";
  }
  if (/\bregister\b/i.test(key)) {
    return "/register";
  }
  if (/\bmessage-status\b/i.test(key)) {
    return "/status";
  }
  if (/\binbox\b/i.test(key)) {
    return "/inbox";
  }
  if (/\bsettings-auth\b/i.test(key)) {
    return "/settings/auth";
  }
  if (/\bsettings-encryption\b/i.test(key)) {
    return "/settings/encryption";
  }
  if (/\bsettings-notifications\b/i.test(key)) {
    return "/settings/notifications";
  }
  if (/\bsettings-profile\b/i.test(key)) {
    return "/settings/profile";
  }
  if (/\bsettings-advanced\b/i.test(key)) {
    return "/settings/advanced";
  }
  if (/\btools\b/i.test(key)) {
    return "/tools";
  }
  if (/\bonboarding\b/i.test(key)) {
    return "/settings";
  }
  if (/\bprofile\b/i.test(key)) {
    return "/to/example";
  }

  return "";
}

function loadScreenshotInventoryFromFiles() {
  const files = listFilesRecursive(SCREENSHOTS_ROOT)
    .filter((filePath) => path.basename(filePath).endsWith("-fold.png"))
    .sort();
  const capturedAt = files.reduce((latest, filePath) => {
    const mtime = fs.statSync(filePath).mtime;
    return !latest || mtime > latest ? mtime : latest;
  }, null);

  return {
    captured_at: capturedAt ? capturedAt.toISOString() : null,
    inventory: files
      .map((filePath) => {
        const relativeFile = path.relative(SCREENSHOTS_ROOT, filePath).split(path.sep).join("/");
        const contentKey = screenshotContentKey(relativeFile);
        const session = relativeFile.split("/")[0] || "";
        const title = screenshotTitle(contentKey);
        const route = screenshotRoute(contentKey);
        const item = {
          content_key: contentKey,
          path: route,
          session,
          title,
        };

        let absolutePath = null;
        try {
          absolutePath = resolveScreenshotPath(relativeFile);
        } catch (_error) {
          return null;
        }

        return {
          absolute_path: absolutePath,
          ...inferCandidateContext(item),
          content_key: contentKey,
          file: relativeFile,
          path: route,
          session,
          theme: /-dark-fold\.png$/i.test(relativeFile) ? "dark" : "light",
          title,
          viewport: /-mobile-(light|dark)-fold\.png$/i.test(relativeFile) ? "mobile" : "desktop",
        };
      })
      .filter(Boolean),
    release: "current",
  };
}

function normalizeConceptKey(contentKey) {
  return String(contentKey || "")
    .replace(/^(auth-(admin|artvandelay|newman)|guest)-/, "")
    .replace(/^-+/, "");
}

function inferCandidateContext(item) {
  const pathValue = String(item.path || "");
  const text = `${item.title} ${item.content_key} ${item.path} ${item.session}`.toLowerCase();

  if (PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(pathValue)) || item.session === "guest") {
    return {
      audience_scope: "public",
      concept_key: normalizeConceptKey(item.content_key),
      copy_brief: "Write for sources and public users evaluating or using Hush Line.",
    };
  }

  if (
    ADMIN_ONLY_ROUTE_PATTERNS.some((pattern) => pattern.test(pathValue)) ||
    ADMIN_ONLY_TEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return {
      audience_scope: "admin-only",
      concept_key: normalizeConceptKey(item.content_key),
      copy_brief: "Write for admins or teams running a Hush Line deployment. Make the admin audience explicit.",
    };
  }

  if (
    RECIPIENT_SHARED_ROUTE_PATTERNS.some((pattern) => pattern.test(pathValue)) ||
    item.session === "newman" ||
    item.session === "artvandelay"
  ) {
    return {
      audience_scope: "recipient-shared",
      concept_key: normalizeConceptKey(item.content_key),
      copy_brief: "Write for recipients and staff using Hush Line day to day, not for platform admins.",
    };
  }

  if (item.session === "admin") {
    return {
      audience_scope: "admin-only",
      concept_key: normalizeConceptKey(item.content_key),
      copy_brief: "Write for admins or teams running a Hush Line deployment. Make the admin audience explicit.",
    };
  }

  return {
    audience_scope: "recipient-shared",
    concept_key: normalizeConceptKey(item.content_key),
    copy_brief: "Write for recipients and staff using Hush Line day to day, not for platform admins.",
  };
}

function discoverAudienceDocs() {
  const readmePath = path.join(HUSHLINE_ROOT, "README.md");
  const candidateFiles = [readmePath];

  try {
    const rgPattern = DOC_DISCOVERY_TERMS
      .map((term) => term.replaceAll(" ", "\\s+"))
      .join("|");
    const discovered = execFileSync(
      "rg",
      [
        "-l",
        "--glob",
        "*.md",
        rgPattern,
        path.join(HUSHLINE_ROOT, "docs"),
        path.join(HUSHLINE_DOCS_ROOT, "docs"),
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 4,
      },
    )
      .split("\n")
      .filter(Boolean)
      .slice(0, 60);

    candidateFiles.push(...discovered);
  } catch (error) {
    candidateFiles.push(
      ...listFilesRecursive(
        path.join(HUSHLINE_ROOT, "docs"),
        (filePath) => filePath.endsWith(".md"),
      ).slice(0, 40),
      ...listFilesRecursive(
        path.join(HUSHLINE_DOCS_ROOT, "docs"),
        (filePath) => filePath.endsWith(".md"),
      ).slice(0, 40),
    );
  }

  const scored = candidateFiles
    .map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const lower = content.toLowerCase();
      const score = DOC_DISCOVERY_TERMS.reduce((total, term) => {
        return total + (lower.includes(term) ? 1 : 0);
      }, 0);

      return {
        excerpt: excerptText(content),
        file: filePath,
        score,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));

  const selected = [];
  const seen = new Set();
  for (const entry of scored) {
    if (seen.has(entry.file)) {
      continue;
    }

    selected.push({
      excerpt: entry.excerpt,
      file: path.relative(REPO_ROOT, entry.file),
    });
    seen.add(entry.file);

    if (selected.length === 6) {
      break;
    }
  }

  return selected;
}

function fetchRecentPullRequests(limit = 20) {
  try {
    return JSON.parse(
      execFileSync(
        "gh",
        [
          "pr",
          "list",
          "--state",
          "merged",
          "--limit",
          String(limit),
          "--json",
          "number,title,mergedAt,url",
          "--repo",
          "scidsg/hushline",
        ],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 4,
          timeout: 5000,
        },
      ),
    );
  } catch (error) {
    const raw = execFileSync(
      "git",
      [
        "-C",
        HUSHLINE_ROOT,
        "log",
        "--pretty=format:%cI|%s",
        `-n${limit}`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 4,
      },
    );

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        const [mergedAt, title] = line.split("|");
        return {
          mergedAt,
          number: null,
          title,
          url: null,
          fallback_index: index,
        };
      })
      .filter((entry) => !/^merge\s+(pull request|branch)\b/i.test(entry.title));
  }
}

function scoreCandidates(inventory, recentPullRequests, audienceDocs) {
  const audienceText = audienceDocs.map((doc) => doc.excerpt).join(" ");

  return inventory
    .map((item) => {
      const candidateText = [item.title, item.content_key, item.path, item.session].join(" ");
      let score = sharedTokenCount(candidateText, audienceText) * 2.5;
      const matchedPullRequests = [];
      const quality = evaluateScreenshotQuality(item);

      recentPullRequests.forEach((pr, index) => {
        const overlap = sharedTokenCount(candidateText, pr.title);
        if (overlap > 0) {
          const recencyWeight = recentPullRequests.length - index;
          score += overlap * recencyWeight;
          matchedPullRequests.push({
            merged_at: pr.mergedAt,
            number: pr.number,
            title: pr.title,
          });
        }
      });

      score += quality.weight;

      return {
        ...item,
        exclusion_reason: quality.exclusionReason,
        matched_pull_requests: matchedPullRequests.slice(0, 4),
        score,
      };
    })
    .sort((left, right) => {
      return right.score - left.score || left.file.localeCompare(right.file);
    });
}

function evaluateScreenshotQuality(item) {
  const text = `${item.title} ${item.content_key} ${item.path}`.toLowerCase();

  for (const pattern of EXCLUDED_SCREEN_PATTERNS) {
    if (pattern.test(text)) {
      return {
        exclusionReason: `filtered by quality rule: ${pattern}`,
        weight: -1000,
      };
    }
  }

  if (item.path.startsWith("/to/") || /\bprofile\b/i.test(item.title)) {
    return {
      exclusionReason: "profile-based screenshots are excluded unless we can positively verify trust signals like a visible PGP key",
      weight: -1000,
    };
  }

  if (item.session !== "guest" && PUBLIC_ROUTE_PATTERNS.some((pattern) => pattern.test(item.path))) {
    return {
      exclusionReason: "public-facing routes should use guest captures, not authenticated sessions",
      weight: -1000,
    };
  }

  if (item.session === "admin" && RECIPIENT_SHARED_ROUTE_PATTERNS.some((pattern) => pattern.test(item.path))) {
    return {
      exclusionReason: "shared recipient routes should not use admin-session captures",
      weight: -1000,
    };
  }

  let weight = 0;
  for (const rule of PREFERRED_SCREEN_PATTERNS) {
    if (rule.pattern.test(text)) {
      weight += rule.weight;
    }
  }

  if (item.theme === "light") {
    weight += 0.5;
  }

  return {
    exclusionReason: null,
    weight,
  };
}

function loadRecentHistory(currentWeek) {
  const archiveRoot = path.join(REPO_ROOT, "previous-posts");
  if (!fs.existsSync(archiveRoot)) {
    return [];
  }

  const currentWeekStart = getIsoWeekStart(currentWeek).toISOString().slice(0, 10);

  return fs
    .readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name) && entry.name < currentWeekStart)
    .map((entry) => {
      const postPath = path.join(archiveRoot, entry.name, "post.json");
      if (!fs.existsSync(postPath)) {
        return null;
      }

      const post = readJson(postPath);
      return {
        date: entry.name,
        posts: [{
          concept_key: post.concept_key || normalizeConceptKey(post.content_key),
        content_key: post.content_key,
        screenshot_file: post.screenshot_file,
        slot: post.slot,
        }],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-30);
}

function chooseSessionScopedCandidates(scored) {
  const grouped = new Map();

  for (const item of scored) {
    if (!grouped.has(item.concept_key)) {
      grouped.set(item.concept_key, []);
    }
    grouped.get(item.concept_key).push(item);
  }

  return [...grouped.values()].flatMap((variants) => {
    const sessions = new Set(variants.map((variant) => variant.session));
    const publicVariants = variants.filter((variant) => variant.audience_scope === "public");
    const recipientVariants = variants.filter((variant) => variant.audience_scope === "recipient-shared");
    const adminVariants = variants.filter((variant) => variant.audience_scope === "admin-only");

    if (publicVariants.length > 0 && sessions.has("guest")) {
      return publicVariants.filter((variant) => variant.session === "guest");
    }

    if (recipientVariants.length > 0) {
      const nonAdmin = recipientVariants.filter((variant) => variant.session !== "admin");
      if (nonAdmin.length > 0) {
        return nonAdmin;
      }
      return recipientVariants;
    }

    if (adminVariants.length > 0) {
      return adminVariants.filter((variant) => variant.session === "admin");
    }

    return variants;
  });
}

function shuffle(items) {
  const shuffled = items.slice();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function buildCandidateShortlist(options) {
  const {
    candidateCount,
    darkRatio,
    week,
    requestedPosts,
  } = options;
  const audienceDocs = discoverAudienceDocs();
  const recentPullRequests = fetchRecentPullRequests(20);
  const screenshots = loadScreenshotInventory();
  const recentHistory = loadRecentHistory(week);
  const eligible = screenshots.inventory
    .map((item) => {
      const quality = evaluateScreenshotQuality(item);

      return {
        ...item,
        exclusion_reason: quality.exclusionReason,
        matched_pull_requests: [],
        screen_key: inferScreenKey(item),
      };
    })
    .filter((item) => !item.exclusion_reason);
  const scored = scoreCandidates(eligible, recentPullRequests, audienceDocs);
  const sessionScoped = chooseSessionScopedCandidates(scored);

  const targetCount = Math.max(candidateCount, Math.max(8, requestedPosts * 2));
  const grouped = new Map();

  for (const item of sessionScoped) {
    if (!grouped.has(item.screen_key)) {
      grouped.set(item.screen_key, []);
    }
    grouped.get(item.screen_key).push(item);
  }

  const selectedConcepts = [...grouped.values()]
    .map((variants) => ({
      variants: variants.slice().sort((left, right) => {
        return right.score - left.score || left.file.localeCompare(right.file);
      }),
    }))
    .sort((left, right) => {
      return (
        right.variants[0].score - left.variants[0].score ||
        left.variants[0].file.localeCompare(right.variants[0].file)
      );
    })
    .slice(0, targetCount * 3);

  const shortlist = assignVariantsToConcepts(selectedConcepts, targetCount, darkRatio);

  return {
    audienceDocs,
    recentHistory,
    screenshotCapturedAt: screenshots.captured_at,
    screenshotRelease: screenshots.release,
    shortlist: shortlist.slice(0, targetCount),
  };
}

function countConceptsWithTheme(concepts, theme) {
  return concepts.filter((concept) => {
    return concept.variants.some((variant) => variant.theme === theme);
  }).length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function assignVariantsToConcepts(selectedConcepts, targetCount, darkRatio) {
  const concepts = selectedConcepts.slice(0, targetCount);
  const assignmentCount = concepts.length;
  const targetMobile = Math.floor(assignmentCount / 2);
  const targetDesktop = assignmentCount - targetMobile;
  const desiredDark = darkRatio <= 0 ? 0 : Math.round(assignmentCount * darkRatio);
  const availableDark = countConceptsWithTheme(concepts, "dark");
  const availableLight = countConceptsWithTheme(concepts, "light");
  const minimumDark = Math.max(0, assignmentCount - availableLight);
  const targetDark = clamp(desiredDark, minimumDark, availableDark);
  let mobileCount = 0;
  let desktopCount = 0;
  let darkCount = 0;

  return concepts.map((concept, index) => {
    const remainingConcepts = concepts.slice(index + 1);
    const needMobile = targetMobile - mobileCount;
    const needDesktop = targetDesktop - desktopCount;
    const lightCount = index - darkCount;
    const targetLight = assignmentCount - targetDark;
    const needLight = targetLight - lightCount;
    const needDark = targetDark - darkCount;

    const hasDark = concept.variants.some((variant) => variant.theme === "dark");
    const hasLight = concept.variants.some((variant) => variant.theme === "light");
    const remainingDarkCapacity = countConceptsWithTheme(remainingConcepts, "dark");
    const remainingLightCapacity = countConceptsWithTheme(remainingConcepts, "light");

    const preferredViewport = needMobile > needDesktop ? "mobile" : "desktop";
    let preferredTheme = "light";

    if (!hasLight && hasDark) {
      preferredTheme = "dark";
    } else if (!hasDark && hasLight) {
      preferredTheme = "light";
    } else if (needDark <= 0) {
      preferredTheme = "light";
    } else if (needLight <= 0) {
      preferredTheme = "dark";
    } else if (remainingDarkCapacity < needDark) {
      preferredTheme = "dark";
    } else if (remainingLightCapacity < needLight) {
      preferredTheme = "light";
    }

    const chosen = concept.variants
      .slice()
      .sort((left, right) => {
        return (
          variantPriority(right, preferredViewport, preferredTheme, needDark) -
            variantPriority(left, preferredViewport, preferredTheme, needDark) ||
          right.score - left.score ||
          left.file.localeCompare(right.file)
        );
      })[0];

    if (chosen.viewport === "mobile") {
      mobileCount += 1;
    } else {
      desktopCount += 1;
    }

    if (chosen.theme === "dark") {
      darkCount += 1;
    }

    return chosen;
  });
}

function variantPriority(variant, preferredViewport, preferredTheme, needDark) {
  let priority = 0;

  if (variant.viewport === preferredViewport) {
    priority += 6;
  }

  if (variant.theme === preferredTheme) {
    priority += 4;
  }

  if (variant.theme === "light" && needDark <= 0) {
    priority += 2;
  }

  if (variant.theme === "dark" && needDark > 0) {
    priority += 1;
  }

  return priority;
}

function buildPromptPayload(context) {
  const slots = context.slots
    .map((slot) => `${slot.slot}: ${slot.planned_date}`)
    .join("\n");
  const pullRequests = context.recent_pull_requests
    .map((pr) => {
      const number = pr.number ? `#${pr.number}` : "local";
      return `${number} | ${pr.mergedAt} | ${pr.title}`;
    })
    .join("\n");
  const docs = context.audience_docs
    .map((doc) => `${doc.file}\n${doc.excerpt}`)
    .join("\n\n");
  const history = context.recent_history.length === 0
    ? "No prior plan history was found."
    : context.recent_history
        .map((plan) => {
          const posts = plan.posts
            .map((post) => `${post.slot}: ${post.content_key} (${post.screenshot_file})`)
            .join("; ");
          return `${plan.week}: ${posts}`;
        })
        .join("\n");
  const plainLanguageGuidance = PLAIN_LANGUAGE_COPY_GUIDANCE
    .map((line) => `- ${line}`)
    .join("\n");
  const topicGuidance = TOPIC_COPY_GUIDANCE
    .map((line) => `- ${line}`)
    .join("\n");

  return {
    system: [
      "You are planning a set of weekday social posts for Hush Line.",
      "Choose screenshots that reflect Hush Line's documented user needs and vary the underlying screen from prior posts.",
      "Write in plain language. No marketing-speak, no hype, no filler.",
      "Social copy must be end-user-facing. Do not confuse post copy with alt text.",
      "Use the visible feature's real words instead of abstract metaphors or internal shorthand.",
      "Avoid empty-state screens, duplicate content themes, and repeated scenes across mobile/desktop variants.",
      "Avoid profile screenshots unless the image visibly shows strong trust/authenticity signals such as a visible PGP key or clear verification cues.",
      "If a screenshot is admin-only, the copy must explicitly say that it is for admins or teams running Hush Line.",
      "LinkedIn is the first automated publishing target, so LinkedIn copy should be especially ready for production use.",
    ].join(" "),
    user: [
      `Plan week: ${context.week}`,
      "",
      "Weekday slots:",
      slots,
      "",
      "Character limits:",
      `LinkedIn ${LIMITS.linkedin}`,
      `Mastodon ${LIMITS.mastodon}`,
      `Bluesky ${LIMITS.bluesky}`,
      "",
      `Target dark-mode share for this week: ${context.dark_ratio}`,
      `Screenshot release from local latest folder: ${context.screenshot_release}`,
      `Screenshots captured at: ${context.screenshot_captured_at}`,
      "",
      "Recently merged Hush Line PRs:",
      pullRequests,
      "",
      "Audience and user-base context from docs:",
      docs,
      "",
      "Plain-language copy standard:",
      plainLanguageGuidance,
      "",
      "Topic-specific copy guidance:",
      topicGuidance,
      "",
      "Recent plan history to avoid repeating:",
      history,
      "",
      "Instructions:",
      "- Pick exactly one screenshot per slot from the provided candidates only.",
      "- Treat same-screen tab or filter variations as repeats even when the exact content_key changed.",
      "- Favor screenshots that matter to journalists, lawyers, whistleblowers, sources, and other trusted recipients.",
      "- Produce exactly five posts, one for each weekday Monday through Friday.",
      "- Avoid repeating the same content theme or route within the week.",
      "- Match the copy to the candidate audience scope. Public screens should read public-facing. Recipient-shared screens should read like recipient workflows. Admin-only screens must clearly say admin or team context.",
      "- Headline and subtext should be concise and straightforward.",
      "- Do not use terms like pings, outside signal, minimum outside signal, case file, surface, frictionless, operationalize, leverage, unlock, or streamline.",
      "- If you choose a notification screenshot, explain the user choice plainly: simple notifications, Hush Line inbox, email notifications, and/or encrypted tip contents in email.",
      "- Each network copy should say the same core thing in a native way, not copy-paste the same sentence three times.",
      "- The alt text should describe the final image asset, not just the raw UI screenshot.",
      "",
      "Return strict JSON matching the schema.",
    ].join("\n"),
  };
}

function buildResponseSchema(context) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["week", "summary", "posts"],
    properties: {
      week: {
        type: "string",
        pattern: "^\\d{4}-W\\d{2}$",
      },
      summary: {
        type: "string",
      },
      posts: {
        type: "array",
        minItems: context.slots.length,
        maxItems: context.slots.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "slot",
            "planned_date",
            "screenshot_file",
            "content_key",
            "headline",
            "subtext",
            "image_alt_text",
            "social",
            "rationale",
            "source_pr_numbers",
          ],
          properties: {
            slot: {
              type: "string",
            },
            planned_date: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            screenshot_file: {
              type: "string",
            },
            content_key: {
              type: "string",
            },
            headline: {
              type: "string",
            },
            subtext: {
              type: "string",
            },
            image_alt_text: {
              type: "string",
            },
            social: {
              type: "object",
              additionalProperties: false,
              required: ["linkedin", "mastodon", "bluesky"],
              properties: {
                linkedin: { type: "string" },
                mastodon: { type: "string" },
                bluesky: { type: "string" },
              },
            },
            rationale: {
              type: "string",
            },
            source_pr_numbers: {
              type: "array",
              items: {
                type: "integer",
              },
            },
          },
        },
      },
    },
  };
}

function buildPlanningContext(args) {
  const shortlistData = buildCandidateShortlist({
    candidateCount: args.candidateCount,
    darkRatio: args.darkRatio,
    week: args.week,
    requestedPosts: 5,
  });

  return {
    audience_docs: shortlistData.audienceDocs,
    candidate_screenshots: shortlistData.shortlist,
    dark_ratio: args.darkRatio,
    week: args.week,
    recent_history: shortlistData.recentHistory,
    screenshot_captured_at: shortlistData.screenshotCapturedAt,
    screenshot_release: shortlistData.screenshotRelease,
  };
}

module.exports = {
  assignVariantsToConcepts,
  buildPlanningContext,
};
