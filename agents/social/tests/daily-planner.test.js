const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  CONTENT_FORMATS,
  DAILY_POSTS_ROOT,
  EDITORIAL_AUDIENCES,
  buildCooldownPolicy,
  buildPromptPayload,
  chooseSupportedEditorialIntent,
  chooseContentFormat,
  chooseTemplateName,
  contentFormatIds,
  filterCandidatesForEditorialIntent,
  filterCandidatesForArchiveHistory,
  filterCandidatesForCooldowns,
  filterCandidatesForWeeklyCaps,
  filterCandidatesForTemplateName,
  inferTopicFamily,
  loadSavedDailyContext,
  parseArgs,
  planDay,
  rankEditorialIntents,
  scoreEditorialCritic,
  selectCandidateShortlist,
  summarizeScreenshotRotation,
  validatePlan,
} = require("../scripts/lib/daily-planner");
const { assignVariantsToConcepts } = require("../scripts/lib/planning-context");

function buildContext(overrides = {}) {
  return {
    candidate_screenshots: [
      {
        audience_scope: "public",
        concept_key: "directory-verified",
        content_key: "guest-directory-verified",
        copy_brief: "Write for sources and public users evaluating or using Hush Line.",
        file: "guest/guest-directory-verified-desktop-light-fold.png",
        matched_pull_requests: [{ number: 1765, title: "Fix guest screenshot" }],
        topic_family: "directory",
        theme: "light",
        title: "Directory - Verified",
        viewport: "desktop",
      },
    ],
    date: "2026-03-20",
    editorial_intent: {
      audience_scope: "public",
      content_format: "feature_benefit",
      content_format_label: "Feature benefit",
      label: "Public sources and visitors",
      reader_need: "Help someone decide whether Hush Line is the right place to make safe first contact or find a trusted recipient.",
      visual_role: "supporting_screenshot",
    },
    visual_selection_reason: "Selected screenshots only after choosing the Public sources and visitors editorial intent.",
    content_format_selection: {
      available_formats: CONTENT_FORMATS,
      selected_format: CONTENT_FORMATS.find((format) => format.id === "feature_benefit"),
      weekly_cap: 1,
      weekly_usage: {
        counts: {},
        week: "2026-W12",
      },
    },
    cooldown_policy: buildCooldownPolicy({
      cta_posts: 0,
      hook_posts: 0,
    }),
    slot: {
      planned_date: "2026-03-20",
      slot: "friday",
    },
    template_selection: {
      available_templates: [
        "hushline-daily-desktop-template.html",
        "hushline-daily-mobile-template.html",
        "hushline-daily-mobile-template-2.html",
      ],
      desired_template_name: "hushline-daily-desktop-template.html",
      desired_template_type: "desktop",
    },
    ...overrides,
  };
}

function buildModelPlan(overrides = {}) {
  return {
    date: "2026-03-20",
    summary: "Public directory trust signals",
    post: {
      content_key: "guest-directory-verified",
      content_format: "feature_benefit",
      headline: "Let sources verify a recipient before they send a tip",
      image_alt_text: "A social graphic showing the verified directory view.",
      planned_date: "2026-03-20",
      rationale: "It reflects recent public-facing shipped work.",
      screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
      slot: "friday",
      social: {
        bluesky: "  Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.  ",
        linkedin: "  Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.  ",
        mastodon: "  Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.  ",
      },
      source_pr_numbers: [1765],
      subtext: "The public directory highlights verified accounts before a message is sent.",
    },
    ...overrides,
  };
}

test("parseArgs rejects malformed dates", () => {
  assert.throws(
    () => parseArgs(["--date", "2026/03/20"]),
    /`--date` must use YYYY-MM-DD format/,
  );
});

test("parseArgs accepts suffixed archive keys for the same planned date", () => {
  const args = parseArgs(["--date", "2026-03-20", "--archive-key", "2026-03-20-1"]);
  assert.equal(args.archiveKey, "2026-03-20-1");
});

test("parseArgs collects unique excluded screenshots", () => {
  const args = parseArgs([
    "--date",
    "2026-03-20",
    "--exclude-screenshot",
    "artvandelay/auth-artvandelay-settings-notifications-mobile-light-fold.png",
    "--exclude-screenshot",
    "artvandelay/auth-artvandelay-settings-notifications-mobile-light-fold.png",
    "--exclude-screenshot",
    "artvandelay/auth-artvandelay-tools-vision-mobile-light-fold.png",
  ]);

  assert.deepEqual(args.excludeScreenshots, [
    "artvandelay/auth-artvandelay-settings-notifications-mobile-light-fold.png",
    "artvandelay/auth-artvandelay-tools-vision-mobile-light-fold.png",
  ]);
});

test("parseArgs accepts explicit cooldown windows and override", () => {
  const args = parseArgs([
    "--date",
    "2026-03-20",
    "--topic-family-cooldown-posts",
    "7",
    "--concept-key-cooldown-posts",
    "30",
    "--hook-cooldown-posts",
    "14",
    "--cta-cooldown-posts",
    "2",
    "--allow-cooldown-override",
  ]);

  assert.deepEqual(args.cooldownPolicy, {
    allow_override: true,
    concept_key_posts: 30,
    cta_posts: 2,
    hook_posts: 14,
    topic_family_posts: 7,
  });
});

test("parseArgs rejects archive keys outside the requested planned date", () => {
  assert.throws(
    () => parseArgs(["--date", "2026-03-20", "--archive-key", "2026-03-21-1"]),
    /`--archive-key` must start with the requested `--date`\./,
  );
});

test("planDay rejects weekend dates before planning context is built", async () => {
  await assert.rejects(
    () => planDay({
      candidateCount: 12,
      darkRatio: 0.2,
      date: "2026-03-21",
      noRender: false,
    }),
    /Weekend dates are excluded from the daily planner: 2026-03-21 \(saturday\)\./,
  );
});

test("loadSavedDailyContext returns the archived context for validation reruns", () => {
  const archiveKey = "2099-03-20-99";
  const archiveDir = path.join(DAILY_POSTS_ROOT, archiveKey);
  const contextPath = path.join(archiveDir, "context.json");
  const savedContext = buildContext({
    date: "2099-03-20",
    candidate_screenshots: [
      {
        audience_scope: "recipient-shared",
        concept_key: "vision-tool",
        content_key: "auth-artvandelay-tools-vision",
        copy_brief: "Write for recipients and staff using Hush Line day to day.",
        file: "artvandelay/auth-artvandelay-tools-vision-mobile-light-fold.png",
        matched_pull_requests: [],
        topic_family: "vision",
        viewport: "mobile",
      },
    ],
  });

  fs.mkdirSync(archiveDir, { recursive: true });

  try {
    fs.writeFileSync(contextPath, JSON.stringify(savedContext, null, 2));
    assert.deepEqual(loadSavedDailyContext(archiveKey), savedContext);
  } finally {
    fs.rmSync(archiveDir, { force: true, recursive: true });
  }
});

test("validatePlan trims social copy and enriches the selected candidate metadata", () => {
  const validated = validatePlan(buildModelPlan(), buildContext());

  assert.equal(validated.post.social.linkedin, "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.");
  assert.equal(validated.post.content_format, "feature_benefit");
  assert.equal(validated.post.screenshot_file, "guest/guest-directory-verified-desktop-light-fold.png");
  assert.equal(validated.post.audience_scope, "public");
  assert.equal(validated.post.concept_key, "directory-verified");
  assert.equal(validated.post.template_name, "hushline-daily-desktop-template.html");
  assert.equal(validated.post.topic_family, "directory");
  assert.equal(
    validated.post.visual_selection_reason,
    "Selected screenshots only after choosing the Public sources and visitors editorial intent.",
  );
  assert.equal(validated.critic.passed, true);
  assert.equal(validated.critic.threshold, 12);
  assert.deepEqual(validated.post.matched_pull_requests, [{ number: 1765, title: "Fix guest screenshot" }]);
});

test("scoreEditorialCritic passes fresh, specific drafts", () => {
  const validated = validatePlan(buildModelPlan(), buildContext());
  const critic = scoreEditorialCritic(validated, buildContext());

  assert.equal(critic.passed, true);
  assert.equal(critic.score >= critic.threshold, true);
  assert.equal(critic.criteria.length, 8);
});

test("scoreEditorialCritic respects disabled hook and CTA cooldowns", () => {
  const context = buildContext({
    cooldown_policy: buildCooldownPolicy({
      cta_posts: 0,
      hook_posts: 0,
    }),
    recent_archive_history: [
      {
        archive_key: "2026-03-19",
        cta_pattern: "learn_more",
        hook_pattern: "sources can verify trust signals before sending a tip",
        linkedin_copy: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
      },
    ],
  });
  const validated = validatePlan(buildModelPlan(), context);
  const critic = scoreEditorialCritic(validated, context);
  const hookCriterion = critic.criteria.find((criterion) => criterion.id === "hook_freshness");
  const ctaCriterion = critic.criteria.find((criterion) => criterion.id === "cta_freshness");

  assert.equal(hookCriterion.score, 2);
  assert.match(hookCriterion.rationale, /disabled by cooldown policy/);
  assert.equal(ctaCriterion.score, 2);
  assert.match(ctaCriterion.rationale, /disabled by cooldown policy/);
});

test("validatePlan blocks drafts that still fail the editorial critic threshold", () => {
  const staleContext = buildContext({
    cooldown_policy: buildCooldownPolicy({
      allow_override: true,
      cta_posts: 0,
      hook_posts: 0,
    }),
    recent_archive_history: [
      {
        archive_key: "2026-03-13",
        content_format: "feature_benefit",
        cta_pattern: "learn_more",
        date: "2026-03-13",
        hook_pattern: "different archived hook",
        linkedin_copy: "Different archived hook. Learn more at https://hushline.app/.",
        topic_family: "directory",
      },
    ],
  });
  const lowValuePlan = buildModelPlan({
    post: {
      ...buildModelPlan().post,
      headline: "Better tools for better work",
      image_alt_text: "A social graphic showing a product screen.",
      social: {
        bluesky: "Better tools make things easier. Learn more at https://hushline.app/.",
        linkedin: "Better tools make things easier. Learn more at https://hushline.app/.",
        mastodon: "Better tools make things easier. Learn more at https://hushline.app/.",
      },
      subtext: "A product screen shows a useful feature.",
    },
  });

  assert.throws(
    () => validatePlan(lowValuePlan, staleContext),
    (error) => {
      assert.match(error.message, /Editorial critic score .* is below threshold/);
      assert.equal(error.critic.passed, false);
      assert.equal(error.critic.rationale.includes("Topic freshness"), true);
      return true;
    },
  );
});

test("contentFormatIds includes the required editorial format taxonomy", () => {
  assert.deepEqual(contentFormatIds(), [
    "source_safety_checklist",
    "recipient_playbook",
    "iso_37002_principle",
    "mistake_to_avoid",
    "myth_vs_reality",
    "workflow_teardown",
    "design_principle",
    "feature_benefit",
  ]);
});

test("rankEditorialIntents rotates toward less-used audiences before visual selection", () => {
  assert.deepEqual(
    EDITORIAL_AUDIENCES.map((audience) => audience.audience_scope),
    ["public", "recipient-shared", "admin-only"],
  );

  const ranked = rankEditorialIntents(
    [
      { archive_key: "2026-05-18", audience_scope: "public", date: "2026-05-18" },
      { archive_key: "2026-05-19", audience_scope: "public", date: "2026-05-19" },
      { archive_key: "2026-05-20", audience_scope: "recipient-shared", date: "2026-05-20" },
    ],
    "2026-05-21",
    {
      selected_format: CONTENT_FORMATS.find((format) => format.id === "workflow_teardown"),
    },
  );

  assert.equal(ranked[0].audience_scope, "admin-only");
  assert.equal(ranked[0].content_format, "workflow_teardown");
});

test("filterCandidatesForEditorialIntent keeps only screenshots that support the planned audience", () => {
  const filtered = filterCandidatesForEditorialIntent(
    [
      {
        audience_scope: "public",
        content_key: "guest-directory-verified",
      },
      {
        audience_scope: "recipient-shared",
        content_key: "auth-artvandelay-settings-notifications",
      },
    ],
    {
      audience_scope: "recipient-shared",
    },
  );

  assert.deepEqual(
    filtered.map((candidate) => candidate.content_key),
    ["auth-artvandelay-settings-notifications"],
  );
});

test("chooseSupportedEditorialIntent skips unsupported intents before selecting screenshots", () => {
  const selection = chooseSupportedEditorialIntent(
    [],
    "2026-05-21",
    {
      selected_format: CONTENT_FORMATS.find((format) => format.id === "feature_benefit"),
    },
    [
      {
        audience_scope: "recipient-shared",
        content_key: "auth-artvandelay-settings-notifications",
      },
    ],
  );

  assert.equal(selection.intent.audience_scope, "recipient-shared");
  assert.equal(selection.supporting_candidates[0].content_key, "auth-artvandelay-settings-notifications");
  assert.ok(selection.rejected_intents.some((intent) => intent.audience_scope === "admin-only"));
});

test("chooseSupportedEditorialIntent can fall through after excluded screenshots are removed", () => {
  const excludedScreenshots = new Set(["admin-settings-branding-mobile-light-fold.png"]);
  const candidates = [
    {
      audience_scope: "admin-only",
      content_key: "auth-admin-settings-branding",
      file: "admin-settings-branding-mobile-light-fold.png",
    },
    {
      audience_scope: "recipient-shared",
      content_key: "auth-artvandelay-settings-notifications",
      file: "settings-notifications-mobile-light-fold.png",
    },
  ].filter((candidate) => !excludedScreenshots.has(candidate.file));
  const selection = chooseSupportedEditorialIntent(
    [],
    "2026-05-21",
    {
      selected_format: CONTENT_FORMATS.find((format) => format.id === "feature_benefit"),
    },
    candidates,
  );

  assert.equal(selection.intent.audience_scope, "recipient-shared");
  assert.ok(selection.rejected_intents.some((intent) => intent.audience_scope === "admin-only"));
  assert.ok(selection.rejected_intents.some((intent) => intent.audience_scope === "public"));
});

test("selectCandidateShortlist preserves selected audience during cooldown fallback", () => {
  const archiveHistory = [
    { archive_key: "2026-05-18", audience_scope: "public", date: "2026-05-18" },
    { archive_key: "2026-05-19", audience_scope: "public", date: "2026-05-19" },
  ];
  const fallbackCandidates = [
    {
      audience_scope: "public",
      content_key: "guest-directory-verified",
      cooldown_exhaustion_fallback: true,
      cooldown_violations: [{ field: "concept_key" }],
      file: "public-lowest-violation.png",
      history_stats: { novelty_penalty: 0 },
      rotation_sort_key: 0,
      score: 100,
      viewport: "desktop",
    },
    {
      audience_scope: "recipient-shared",
      content_key: "auth-inbox-detail",
      cooldown_exhaustion_fallback: true,
      cooldown_violations: [{ field: "topic_family" }, { field: "concept_key" }],
      file: "recipient-supported-a.png",
      history_stats: { novelty_penalty: 0 },
      rotation_sort_key: 1,
      score: 80,
      viewport: "desktop",
    },
    {
      audience_scope: "recipient-shared",
      content_key: "auth-settings-notifications",
      cooldown_exhaustion_fallback: true,
      cooldown_violations: [{ field: "topic_family" }, { field: "concept_key" }],
      file: "recipient-supported-b.png",
      history_stats: { novelty_penalty: 0 },
      rotation_sort_key: 2,
      score: 70,
      viewport: "desktop",
    },
  ];
  const selection = chooseSupportedEditorialIntent(
    archiveHistory,
    "2026-05-21",
    {
      selected_format: CONTENT_FORMATS.find((format) => format.id === "feature_benefit"),
    },
    fallbackCandidates,
  );

  const shortlist = selectCandidateShortlist(
    selection,
    archiveHistory,
    ["hushline-daily-desktop-template.html"],
  );

  assert.equal(selection.intent.audience_scope, "recipient-shared");
  assert.deepEqual(
    shortlist.map((candidate) => candidate.file),
    ["recipient-supported-a.png", "recipient-supported-b.png"],
  );
  assert.ok(shortlist.every((candidate) => candidate.audience_scope === selection.intent.audience_scope));
});

test("chooseContentFormat rotates away from formats already used this week", () => {
  const selection = chooseContentFormat(
    [
      {
        archive_key: "2026-05-18",
        content_format: "source_safety_checklist",
        date: "2026-05-18",
      },
      {
        archive_key: "2026-05-19",
        content_format: "recipient_playbook",
        date: "2026-05-19",
      },
    ],
    "2026-05-20",
  );

  assert.equal(selection.weekly_usage.week, "2026-W21");
  assert.notEqual(selection.selected_format.id, "source_safety_checklist");
  assert.notEqual(selection.selected_format.id, "recipient_playbook");
  assert.equal(selection.weekly_cap, 1);
});

test("chooseContentFormat fails when the weekly format rotation is exhausted", () => {
  assert.throws(
    () => chooseContentFormat(
      CONTENT_FORMATS.map((format, index) => ({
        archive_key: `2026-05-${18 + index}`,
        content_format: format.id,
        date: "2026-05-18",
      })),
      "2026-05-20",
    ),
    /No eligible content formats remain/,
  );
});

test("buildPromptPayload includes selected editorial format guidance", () => {
  const context = buildContext({
    audience_docs: [],
    content_format_selection: {
      available_formats: CONTENT_FORMATS,
      selected_format: CONTENT_FORMATS.find((format) => format.id === "mistake_to_avoid"),
      weekly_cap: 1,
      weekly_usage: {
        counts: {},
        week: "2026-W12",
      },
    },
    hushline_agent_context: "",
    hushline_app_voice_guidance: [],
    recent_archive_history: [],
    screenshot_captured_at: "2026-03-20T00:00:00Z",
    screenshot_release: "test-release",
    week: "2026-W12",
  });
  const payload = buildPromptPayload(context);

  assert.match(payload.user, /Required content format: mistake_to_avoid/);
  assert.match(payload.user, /Editorial intent:/);
  assert.match(payload.user, /Treat screenshots as visual support/);
  assert.match(payload.user, /Mistake to avoid \(mistake_to_avoid\)/);
  assert.match(payload.user, /Use exactly the required content format/);
});

test("validatePlan rejects a missing or mismatched content format", () => {
  assert.throws(
    () => validatePlan(
      buildModelPlan({
        post: {
          ...buildModelPlan().post,
          content_format: "workflow_teardown",
        },
      }),
      buildContext(),
    ),
    /expected feature_benefit/,
  );

  assert.throws(
    () => validatePlan(
      buildModelPlan({
        post: {
          ...buildModelPlan().post,
          content_format: "unknown_format",
        },
      }),
      buildContext({
        content_format_selection: null,
      }),
    ),
    /Unknown content format/,
  );
});

test("validatePlan rejects a content format that already reached the weekly cap", () => {
  const context = buildContext({
    recent_archive_history: [
      {
        archive_key: "2026-03-19",
        content_format: "feature_benefit",
        date: "2026-03-19",
      },
    ],
  });

  assert.throws(
    () => validatePlan(buildModelPlan(), context),
    /already reached the weekly cap/,
  );
});

test("validatePlan rejects a screenshot that does not support the editorial intent audience", () => {
  const context = buildContext({
    editorial_intent: {
      audience_scope: "recipient-shared",
      content_format: "feature_benefit",
      content_format_label: "Feature benefit",
      label: "Recipients and staff",
      reader_need: "Help a recipient or staff member improve a repeatable sensitive-intake workflow.",
      visual_role: "supporting_screenshot",
    },
  });

  assert.throws(
    () => validatePlan(buildModelPlan(), context),
    /does not support editorial intent audience recipient-shared/,
  );
});

test("chooseTemplateName prefers the least-used daily template from the prior month", () => {
  const selected = chooseTemplateName(
    [
      { archive_key: "2026-03-03", template_name: "hushline-daily-desktop-template.html" },
      { archive_key: "2026-03-04", template_name: "hushline-daily-desktop-template.html" },
      { archive_key: "2026-03-05", template_name: "hushline-daily-mobile-template.html" },
    ],
    [
      "hushline-daily-desktop-template.html",
      "hushline-daily-mobile-template.html",
      "hushline-daily-mobile-template-2.html",
    ],
  );

  assert.equal(selected, "hushline-daily-mobile-template-2.html");
});

test("filterCandidatesForTemplateName narrows the shortlist to the chosen template type", () => {
  const filtered = filterCandidatesForTemplateName(
    [
      {
        content_key: "guest-directory-verified",
        file: "guest/guest-directory-verified-desktop-light-fold.png",
        viewport: "desktop",
      },
      {
        content_key: "auth-artvandelay-settings-authentication",
        file: "auth/auth-artvandelay-settings-authentication-mobile-light-fold.png",
        viewport: "mobile",
      },
    ],
    "hushline-daily-mobile-template-2.html",
  );

  assert.deepEqual(
    filtered.map((candidate) => candidate.content_key),
    ["auth-artvandelay-settings-authentication"],
  );
});

test("validatePlan rejects admin-only screenshots when the copy never says admin or team", () => {
  const context = buildContext({
    editorial_intent: {
      audience_scope: "admin-only",
      content_format: "feature_benefit",
      content_format_label: "Feature benefit",
      label: "Admins and deployment teams",
      reader_need: "Help an admin or deployment team run Hush Line responsibly without weakening safety or trust.",
      visual_role: "supporting_screenshot",
    },
    candidate_screenshots: [
      {
        audience_scope: "admin-only",
        concept_key: "admin-inbox",
        content_key: "auth-admin-inbox",
        copy_brief: "Write for admins.",
        file: "admin/admin-inbox-desktop-light-fold.png",
        matched_pull_requests: [],
        topic_family: "admin-inbox",
        theme: "light",
        title: "Admin Inbox",
        viewport: "desktop",
      },
    ],
  });
  const plan = buildModelPlan({
    post: {
      ...buildModelPlan().post,
      content_key: "auth-admin-inbox",
      screenshot_file: "admin/admin-inbox-desktop-light-fold.png",
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /needs copy that explicitly signals admin\/team context/,
  );
});

test("inferTopicFamily groups onboarding directory screenshots under the directory family", () => {
  assert.equal(
    inferTopicFamily({
      content_key: "auth-newman-onboarding-directory",
      path: "/onboarding?step=directory",
      title: "Onboarding - Step 4 Directory (newman)",
    }),
    "directory",
  );
});

test("filterCandidatesForArchiveHistory keeps unused screenshots in the current rotation", () => {
  const archiveHistory = [
    {
      archive_key: "2026-03-20",
      content_key: "guest-directory-verified",
      date: "2026-03-20",
      screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
  ];

  const candidates = [
    {
      content_key: "guest-directory-verified",
      file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
    {
      content_key: "auth-artvandelay-settings-encryption",
      file: "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
    },
    {
      content_key: "auth-artvandelay-settings-notifications",
      file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
    },
  ];

  const filtered = filterCandidatesForArchiveHistory(candidates, archiveHistory, {
    currentArchiveKey: "2026-03-21",
  });

  assert.equal(filtered.length, 2);
  assert.deepEqual(
    new Set(filtered.map((candidate) => candidate.file)),
    new Set([
      "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
      "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
    ]),
  );
});

test("filterCandidatesForArchiveHistory starts a new shuffled cycle after all screenshots are used", () => {
  const archiveHistory = [
    {
      archive_key: "2026-03-20",
      content_key: "guest-directory-verified",
      date: "2026-03-20",
      screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
    {
      archive_key: "2026-03-21",
      content_key: "auth-artvandelay-settings-encryption",
      date: "2026-03-21",
      screenshot_file: "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
    },
  ];

  const candidates = [
    {
      concept_key: "directory-verified",
      content_key: "guest-directory-verified",
      file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
    {
      concept_key: "encryption-settings",
      content_key: "auth-artvandelay-settings-encryption",
      file: "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
    },
  ];

  const rotation = summarizeScreenshotRotation(candidates, archiveHistory, "2026-03-22");
  const filtered = filterCandidatesForArchiveHistory(candidates, archiveHistory, {
    currentArchiveKey: "2026-03-22",
  });

  assert.equal(rotation.cycle_complete, true);
  assert.equal(filtered.length, 2);
  assert.deepEqual(
    new Set(filtered.map((candidate) => candidate.content_key)),
    new Set(["guest-directory-verified", "auth-artvandelay-settings-encryption"]),
  );
});

test("filterCandidatesForArchiveHistory treats repeats before the current cycle as available later", () => {
  const archiveHistory = [
    {
      archive_key: "2026-03-20",
      content_key: "guest-directory-verified",
      date: "2026-03-20",
      screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
    {
      archive_key: "2026-03-21",
      content_key: "auth-artvandelay-settings-encryption",
      date: "2026-03-21",
      screenshot_file: "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
    },
    {
      archive_key: "2026-03-22",
      content_key: "guest-directory-verified",
      date: "2026-03-22",
      screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
  ];

  const candidates = [
    {
      content_key: "guest-directory-verified",
      file: "guest/guest-directory-verified-desktop-light-fold.png",
    },
    {
      content_key: "auth-artvandelay-settings-encryption",
      file: "artvandelay/auth-artvandelay-settings-encryption-desktop-light-fold.png",
    },
  ];

  const filtered = filterCandidatesForArchiveHistory(candidates, archiveHistory, {
    currentArchiveKey: "2026-03-23",
  });

  assert.deepEqual(
    filtered.map((candidate) => candidate.content_key),
    ["auth-artvandelay-settings-encryption"],
  );
});

test("filterCandidatesForWeeklyCaps blocks a second admin or dark post in the same ISO week", () => {
  const archiveHistory = [
    {
      archive_key: "2026-04-06",
      audience_scope: "admin-only",
      date: "2026-04-06",
      screenshot_file: "admin/auth-admin-settings-guidance-mobile-light-fold.png",
      theme: "light",
    },
    {
      archive_key: "2026-04-07",
      audience_scope: "recipient-shared",
      date: "2026-04-07",
      screenshot_file: "artvandelay/auth-artvandelay-settings-notifications-mobile-dark-fold.png",
      theme: "dark",
    },
  ];

  const filtered = filterCandidatesForWeeklyCaps(
    [
      {
        audience_scope: "admin-only",
        content_key: "auth-admin-settings-registration",
        file: "admin/auth-admin-settings-registration-mobile-light-fold.png",
        theme: "light",
      },
      {
        audience_scope: "recipient-shared",
        content_key: "auth-artvandelay-tools-vision",
        file: "artvandelay/auth-artvandelay-tools-vision-mobile-dark-fold.png",
        theme: "dark",
      },
      {
        audience_scope: "recipient-shared",
        content_key: "auth-artvandelay-settings-encryption",
        file: "artvandelay/auth-artvandelay-settings-encryption-mobile-light-fold.png",
        theme: "light",
      },
    ],
    archiveHistory,
    "2026-04-10",
  );

  assert.deepEqual(
    filtered.map((candidate) => candidate.content_key),
    ["auth-artvandelay-settings-encryption"],
  );
});

test("filterCandidatesForCooldowns blocks recent topic and concept repeats", () => {
  const archiveHistory = [
    {
      archive_key: "2026-04-01",
      concept_key: "settings-notifications",
      topic_family: "notifications",
    },
    {
      archive_key: "2026-04-02",
      concept_key: "directory-verified",
      topic_family: "directory",
    },
  ];
  const candidates = [
    {
      concept_key: "directory-verified",
      content_key: "guest-directory-verified",
      file: "guest-directory-verified-desktop-light-fold.png",
      topic_family: "directory",
    },
    {
      concept_key: "settings-encryption",
      content_key: "auth-artvandelay-settings-encryption",
      file: "settings-encryption-desktop-light-fold.png",
      topic_family: "encryption",
    },
  ];

  const filtered = filterCandidatesForCooldowns(
    candidates,
    archiveHistory,
    buildCooldownPolicy({
      concept_key_posts: 20,
      topic_family_posts: 5,
    }),
  );

  assert.deepEqual(
    filtered.map((candidate) => candidate.content_key),
    ["auth-artvandelay-settings-encryption"],
  );
});

test("filterCandidatesForCooldowns returns fallback candidates when every candidate violates cooldowns", () => {
  const filtered = filterCandidatesForCooldowns(
    [
      {
        concept_key: "directory-verified",
        content_key: "guest-directory-verified",
        file: "guest-directory-verified-desktop-light-fold.png",
        topic_family: "directory",
      },
    ],
    [
      {
        archive_key: "2026-04-02",
        concept_key: "directory-verified",
        topic_family: "directory",
      },
    ],
    buildCooldownPolicy({
      concept_key_posts: 20,
      topic_family_posts: 5,
    }),
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].cooldown_exhaustion_fallback, true);
  assert.match(filtered[0].cooldown_exhaustion_reason, /All eligible screenshots violate cooldowns/);
  assert.deepEqual(
    filtered[0].cooldown_violations.map((violation) => violation.field),
    ["topic_family", "concept_key"],
  );
});

test("filterCandidatesForCooldowns preserves blocked candidates with an explicit override", () => {
  const filtered = filterCandidatesForCooldowns(
    [
      {
        concept_key: "directory-verified",
        content_key: "guest-directory-verified",
        file: "guest-directory-verified-desktop-light-fold.png",
        topic_family: "directory",
      },
    ],
    [
      {
        archive_key: "2026-04-02",
        concept_key: "directory-verified",
        topic_family: "directory",
      },
    ],
    buildCooldownPolicy({
      allow_override: true,
      concept_key_posts: 20,
      topic_family_posts: 5,
    }),
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].cooldown_violations.length, 2);
  assert.equal(filtered[0].cooldown_exhaustion_fallback, undefined);
});

test("validatePlan allows screenshot cooldown fallback candidates", () => {
  const context = buildContext({
    candidate_screenshots: [
      {
        audience_scope: "public",
        concept_key: "directory-verified",
        content_key: "guest-directory-verified",
        copy_brief: "Write for sources and public users evaluating or using Hush Line.",
        cooldown_exhaustion_fallback: true,
        cooldown_violations: [
          {
            archive_key: "2026-03-19",
            field: "topic_family",
            value: "directory",
            window_posts: 5,
          },
          {
            archive_key: "2026-03-19",
            field: "concept_key",
            value: "directory-verified",
            window_posts: 20,
          },
        ],
        file: "guest/guest-directory-verified-desktop-light-fold.png",
        matched_pull_requests: [],
        topic_family: "directory",
        theme: "light",
        title: "Directory - Verified",
        viewport: "desktop",
      },
    ],
    recent_archive_history: [
      {
        archive_key: "2026-03-19",
        concept_key: "directory-verified",
        linkedin_copy: "People can find verified recipients before sending a tip. Learn more at https://hushline.app/.",
        topic_family: "directory",
      },
    ],
  });

  const validated = validatePlan(
    buildModelPlan({
      post: {
        ...buildModelPlan().post,
        social: {
          bluesky: "A verified directory gives sources one more check before first contact. Learn more at https://hushline.app/.",
          linkedin: "A verified directory gives sources one more check before first contact.\n\nHush Line shows verified recipients before someone sends a sensitive message.\n\nLearn more at https://hushline.app/.",
          mastodon: "A verified directory gives sources one more check before first contact. Learn more at https://hushline.app/.",
        },
      },
    }),
    context,
  );

  assert.equal(validated.post.screenshot_file, "guest/guest-directory-verified-desktop-light-fold.png");
  assert.equal(validated.critic.passed, true);
});

test("validatePlan rejects repeated hooks and CTA patterns inside cooldown windows", () => {
  const context = buildContext({
    cooldown_policy: buildCooldownPolicy({
      concept_key_posts: 0,
      cta_posts: 2,
      hook_posts: 5,
      topic_family_posts: 0,
    }),
    recent_archive_history: [
      {
        archive_key: "2026-03-18",
        cta_pattern: "learn_more",
        hook_pattern: "sources can verify trust signals before sending a tip",
        linkedin_copy: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
      },
    ],
  });

  assert.throws(
    () => validatePlan(buildModelPlan(), context),
    /repeats 2026-03-18 within the 5-post hook cooldown/,
  );
});

test("validatePlan rejects a repeated CTA when the hook is fresh", () => {
  const context = buildContext({
    cooldown_policy: buildCooldownPolicy({
      concept_key_posts: 0,
      cta_posts: 2,
      hook_posts: 5,
      topic_family_posts: 0,
    }),
    recent_archive_history: [
      {
        archive_key: "2026-03-18",
        cta_pattern: "learn_more",
        hook_pattern: "different opening line",
        linkedin_copy: "Different opening line. Learn more at https://hushline.app/.",
      },
    ],
  });
  const plan = buildModelPlan({
    post: {
      ...buildModelPlan().post,
      social: {
        bluesky: "Fresh public copy. Learn more at https://hushline.app/.",
        linkedin: "Fresh public copy.\n\nLearn more at https://hushline.app/.",
        mastodon: "Fresh public copy. Learn more at https://hushline.app/.",
      },
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /repeats 2026-03-18 within the 2-post CTA cooldown/,
  );
});

test("validatePlan rejects messaging that duplicates a recent archive angle", () => {
  const context = buildContext({
    cooldown_policy: buildCooldownPolicy({
      concept_key_posts: 0,
      cta_posts: 0,
      hook_posts: 0,
      topic_family_posts: 0,
    }),
    recent_archive_history: [
      {
        archive_key: "2026-03-19",
        headline: "Let sources verify a recipient before they send a tip",
        linkedin_copy: "Sources can verify trust signals before sending a tip. Learn more at https://hushline.app/.",
        screen_key: "directory-index",
        subtext: "The public directory highlights verified accounts before a message is sent.",
        topic_family: "directory",
      },
    ],
  });

  assert.throws(
    () => validatePlan(buildModelPlan(), context),
    /duplicates recent archive headline/,
  );
});

test("validatePlan allows an older same-topic archive outside the recent-feature window", () => {
  const context = buildContext({
    recent_archive_history: [
      {
        archive_key: "2026-03-10",
        headline: "Verify a recipient before you send a tip",
        linkedin_copy: "Trust signals help people verify a recipient before they send a tip. Learn more at https://hushline.app/.",
        screen_key: "directory-index",
        subtext: "The public directory highlights trust signals before someone sends a message.",
        topic_family: "directory",
      },
      {
        archive_key: "2026-03-11",
        headline: "Archive one",
        linkedin_copy: "Distinct copy one.",
        screen_key: "/settings/encryption",
        subtext: "Distinct one.",
        topic_family: "encryption",
      },
      {
        archive_key: "2026-03-12",
        headline: "Archive two",
        linkedin_copy: "Distinct copy two.",
        screen_key: "/settings/profile",
        subtext: "Distinct two.",
        topic_family: "profile",
      },
      {
        archive_key: "2026-03-13",
        headline: "Archive three",
        linkedin_copy: "Distinct copy three.",
        screen_key: "/settings/replies",
        subtext: "Distinct three.",
        topic_family: "message-statuses",
      },
      {
        archive_key: "2026-03-14",
        headline: "Archive four",
        linkedin_copy: "Distinct copy four.",
        screen_key: "/vision",
        subtext: "Distinct four.",
        topic_family: "vision",
      },
      {
        archive_key: "2026-03-17",
        headline: "Archive five",
        linkedin_copy: "Distinct copy five.",
        screen_key: "/settings/auth",
        subtext: "Distinct five.",
        topic_family: "authentication",
      },
      {
        archive_key: "2026-03-18",
        headline: "Archive six",
        linkedin_copy: "Distinct copy six.",
        screen_key: "/settings/guidance",
        subtext: "Distinct six.",
        topic_family: "guidance",
      },
    ],
  });

  assert.doesNotThrow(() => validatePlan(buildModelPlan(), context));
});

test("validatePlan allows a distinct directory message that only shares generic public-directory wording", () => {
  const context = buildContext({
    cooldown_policy: buildCooldownPolicy({
      allow_override: true,
    }),
    candidate_screenshots: [
      {
        absolute_path: "/tmp/guest-directory-attorney-adam-j-levitt-mobile-light-fold.png",
        audience_scope: "public",
        concept_key: "directory-attorney-adam-j-levitt",
        content_key: "guest-directory-attorney-adam-j-levitt",
        copy_brief: "Write for sources and public users evaluating or using Hush Line.",
        file: "guest/guest-directory-attorney-adam-j-levitt-mobile-light-fold.png",
        matched_pull_requests: [],
        path: "/directory/public-records/public-record~adam-j-levitt",
        screen_key: "directory-public-record",
        theme: "light",
        title: "Directory - Attorney listing (Adam J. Levitt)",
        topic_family: "directory",
        viewport: "mobile",
      },
    ],
    date: "2026-04-14",
    recent_archive_history: [
      {
        archive_key: "2026-03-20",
        audience_scope: "public",
        bluesky_copy: "Need to verify who you're contacting before you send a tip? Hush Line's public directory shows verified profiles so you can compare recipients first. Learn more at https://hushline.app/.",
        date: "2026-03-20",
        headline: "Check verified tip lines before you reach out",
        linkedin_copy: "When you need to contact a journalist, lawyer, or other trusted recipient, the first question is whether you found the right person. Hush Line's public directory lets you browse verified profiles before you send anything, so you can check who runs the tip line and choose a better match for your situation. Learn more at https://hushline.app/.",
        mastodon_copy: "If you're deciding where to send a tip, Hush Line's public directory helps you start with verified profiles. You can compare recipients and check who runs the tip line before you reach out. Learn more at https://hushline.app/.",
        screen_key: "directory-index",
        subtext: "The public directory helps sources compare verified profiles and choose a tip line that matches the person they need.",
        theme: "light",
        topic_family: "directory",
      },
    ],
    slot: {
      planned_date: "2026-04-14",
      slot: "tuesday",
    },
    template_selection: {
      available_templates: ["hushline-daily-mobile-template.html"],
      desired_template_name: "hushline-daily-mobile-template.html",
      desired_template_type: "mobile",
    },
  });

  const plan = {
    date: "2026-04-14",
    summary: "Public-facing attorney listing post.",
    post: {
      slot: "tuesday",
      planned_date: "2026-04-14",
      screenshot_file: "guest/guest-directory-attorney-adam-j-levitt-mobile-light-fold.png",
      content_key: "guest-directory-attorney-adam-j-levitt",
      content_format: "feature_benefit",
      headline: "Review a whistleblower law listing before you reach out",
      subtext: "This public attorney listing shows bar-registration details, location, and firm links so a source can judge whether a law office fits the disclosure they need to make.",
      image_alt_text: "A portrait Hush Line social graphic built from a light-mode mobile public directory screen. It shows an attorney listing with a law firm name, location, practice description, and links to the lawyer's site and source record.",
      social: {
        linkedin: "Sometimes the hardest part of asking for legal help is figuring out which office actually handles the kind of disclosure you need to make.\n\nHush Line's public attorney listings can point people to bar-record details, locations, and firm links before first contact, so they can compare legal options with more context instead of guessing.\n\nLearn more at https://hushline.app.",
        mastodon: "Legal intake starts before the first message.\n\nHush Line's public attorney listings show record details, locations, and firm links so people can compare law offices with more context before they reach out.\n\nLearn more at https://hushline.app.",
        bluesky: "Finding the right law office can be part of the hard part.\n\nHush Line's public attorney listings show record details, location, and firm links before first contact.\n\nLearn more at https://hushline.app.",
      },
      rationale: "This uses the attorney listing screen and stays focused on legal-fit context instead of general directory browsing.",
      source_pr_numbers: [],
    },
  };

  assert.doesNotThrow(() => validatePlan(plan, context));
});

test("validatePlan rejects a second admin-only post in the same ISO week", () => {
  const context = buildContext({
    candidate_screenshots: [
      {
        audience_scope: "admin-only",
        concept_key: "settings-guidance",
        content_key: "auth-admin-settings-guidance",
        copy_brief: "Write for admins.",
        file: "admin/auth-admin-settings-guidance-mobile-light-fold.png",
        matched_pull_requests: [],
        topic_family: "guidance",
        theme: "light",
        title: "Settings - User Guidance (admin)",
        viewport: "mobile",
      },
    ],
    date: "2026-04-10",
    recent_archive_history: [
      {
        archive_key: "2026-04-06",
        audience_scope: "admin-only",
        date: "2026-04-06",
        screenshot_file: "admin/auth-admin-settings-branding-mobile-light-fold.png",
        theme: "light",
      },
    ],
    slot: {
      planned_date: "2026-04-10",
      slot: "friday",
    },
    template_selection: {
      available_templates: ["hushline-daily-mobile-template.html"],
      desired_template_name: "hushline-daily-mobile-template.html",
      desired_template_type: "mobile",
    },
  });

  const plan = buildModelPlan({
    date: "2026-04-10",
    post: {
      ...buildModelPlan().post,
      planned_date: "2026-04-10",
      screenshot_file: "admin/auth-admin-settings-guidance-mobile-light-fold.png",
      content_key: "auth-admin-settings-guidance",
      slot: "friday",
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /Weekly admin-only cap already reached/,
  );
});

test("validatePlan rejects a second dark-mode post in the same ISO week", () => {
  const context = buildContext({
    candidate_screenshots: [
      {
        audience_scope: "recipient-shared",
        concept_key: "settings-notifications",
        content_key: "auth-artvandelay-settings-notifications",
        copy_brief: "Write for recipients.",
        file: "artvandelay/auth-artvandelay-settings-notifications-mobile-dark-fold.png",
        matched_pull_requests: [],
        topic_family: "notifications",
        theme: "dark",
        title: "Settings - Notifications",
        viewport: "mobile",
      },
    ],
    date: "2026-04-10",
    recent_archive_history: [
      {
        archive_key: "2026-04-07",
        audience_scope: "recipient-shared",
        date: "2026-04-07",
        screenshot_file: "artvandelay/auth-artvandelay-settings-encryption-mobile-dark-fold.png",
        theme: "dark",
      },
    ],
    slot: {
      planned_date: "2026-04-10",
      slot: "friday",
    },
    template_selection: {
      available_templates: ["hushline-daily-mobile-template.html"],
      desired_template_name: "hushline-daily-mobile-template.html",
      desired_template_type: "mobile",
    },
  });

  const plan = buildModelPlan({
    date: "2026-04-10",
    post: {
      ...buildModelPlan().post,
      planned_date: "2026-04-10",
      screenshot_file: "artvandelay/auth-artvandelay-settings-notifications-mobile-dark-fold.png",
      content_key: "auth-artvandelay-settings-notifications",
      slot: "friday",
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /Weekly dark-mode cap already reached/,
  );
});

test("validatePlan rejects jargon that is not Hush Line user-facing language", () => {
  const context = buildContext({
    candidate_screenshots: [
      {
        audience_scope: "recipient-shared",
        concept_key: "settings-notifications",
        content_key: "auth-artvandelay-settings-notifications",
        copy_brief: "Write for recipients.",
        file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
        matched_pull_requests: [],
        topic_family: "notifications",
        theme: "light",
        title: "Settings - Notifications",
        viewport: "desktop",
      },
    ],
    editorial_intent: {
      audience_scope: "recipient-shared",
      content_format: "feature_benefit",
      content_format_label: "Feature benefit",
      label: "Recipients and staff",
      reader_need: "Help a recipient or staff member improve a repeatable sensitive-intake workflow.",
      visual_role: "supporting_screenshot",
    },
  });
  const plan = buildModelPlan({
    post: {
      ...buildModelPlan().post,
      content_key: "auth-artvandelay-settings-notifications",
      headline: "Keep pings separate from the case file",
      screenshot_file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
      social: {
        bluesky: "Recipients can choose the minimum outside signal needed to bring staff back to Hush Line inbox. Learn more at https://hushline.app.",
        linkedin: "Recipients can choose the minimum outside signal needed to bring staff back to Hush Line inbox. Learn more at https://hushline.app.",
        mastodon: "Recipients can choose the minimum outside signal needed to bring staff back to Hush Line inbox. Learn more at https://hushline.app.",
      },
      subtext: "Recipients can choose the minimum outside signal needed to bring staff back to Hush Line inbox.",
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /uses banned jargon/,
  );
});

test("validatePlan requires notification copy to name the notification choice", () => {
  const context = buildContext({
    candidate_screenshots: [
      {
        audience_scope: "recipient-shared",
        concept_key: "settings-notifications",
        content_key: "auth-artvandelay-settings-notifications",
        copy_brief: "Write for recipients.",
        file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
        matched_pull_requests: [],
        topic_family: "notifications",
        theme: "light",
        title: "Settings - Notifications",
        viewport: "desktop",
      },
    ],
    editorial_intent: {
      audience_scope: "recipient-shared",
      content_format: "feature_benefit",
      content_format_label: "Feature benefit",
      label: "Recipients and staff",
      reader_need: "Help a recipient or staff member improve a repeatable sensitive-intake workflow.",
      visual_role: "supporting_screenshot",
    },
  });
  const plan = buildModelPlan({
    post: {
      ...buildModelPlan().post,
      content_key: "auth-artvandelay-settings-notifications",
      headline: "Choose what works for your day",
      screenshot_file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
      social: {
        bluesky: "Recipients can decide how much detail to receive away from Hush Line. Learn more at https://hushline.app.",
        linkedin: "Recipients can decide how much detail to receive away from Hush Line. Learn more at https://hushline.app.",
        mastodon: "Recipients can decide how much detail to receive away from Hush Line. Learn more at https://hushline.app.",
      },
      subtext: "Recipients can decide how much detail to receive away from Hush Line.",
    },
  });

  assert.throws(
    () => validatePlan(plan, context),
    /must directly describe notification, email, inbox, or encrypted-message choices/,
  );
});

test("assignVariantsToConcepts preserves light candidates when the concept set is smaller than the target count", () => {
  const selectedConcepts = Array.from({ length: 17 }, (_, index) => ({
    variants: [
      {
        file: `guest/example-${index + 1}-desktop-light-fold.png`,
        score: 10,
        theme: "light",
        viewport: "desktop",
      },
      {
        file: `guest/example-${index + 1}-desktop-dark-fold.png`,
        score: 11,
        theme: "dark",
        viewport: "desktop",
      },
    ],
  }));

  const shortlist = assignVariantsToConcepts(selectedConcepts, 200, 0.25);
  const darkCount = shortlist.filter((candidate) => candidate.theme === "dark").length;
  const lightCount = shortlist.filter((candidate) => candidate.theme === "light").length;

  assert.equal(shortlist.length, 17);
  assert.equal(darkCount, 4);
  assert.equal(lightCount, 13);
});
