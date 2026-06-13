const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  analyzePostHistory,
  classifyCta,
  daysBetween,
  firstSentence,
  formatPostHistoryReport,
} = require("../scripts/lib/post-history-analyzer");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeDailyPost(rootDir, archiveKey, post) {
  const archiveDir = path.join(rootDir, archiveKey);
  writeJson(path.join(archiveDir, "post.json"), post);
  fs.writeFileSync(
    path.join(archiveDir, "post-copy.txt"),
    `Template: ${post.template_name}\n\n${post.social.linkedin}\n`,
  );
}

function writeVerifiedUserPost(rootDir, archiveKey, post) {
  const archiveDir = path.join(rootDir, archiveKey);
  writeJson(path.join(archiveDir, "post.json"), post);
  fs.writeFileSync(path.join(archiveDir, "post-copy.txt"), `${post.social.linkedin}\n`);
}

function buildDailyPost(overrides = {}) {
  return {
    audience_scope: "public",
    concept_key: "directory-verified",
    content_key: "guest-directory-verified",
    headline: "Find a verified tip line",
    screenshot_file: "guest/guest-directory-verified-desktop-light-fold.png",
    social: {
      bluesky: "A public tip line should be easy to verify.\n\nLearn more at https://hushline.app.",
      linkedin: "A public tip line should be easy to verify.\n\nHush Line helps sources find a verified recipient before they send a tip.\n\nSign up at https://hushline.app.",
      mastodon: "A public tip line should be easy to verify.\n\nLearn more at https://hushline.app.",
    },
    subtext: "Directory verification appears before first contact.",
    template_name: "hushline-daily-desktop-template.html",
    topic_family: "directory",
    ...overrides,
  };
}

function buildVerifiedUserPost(overrides = {}) {
  return {
    display_name: "Example Recipient",
    primary_username: "example",
    social: {
      bluesky: "Verified Member Highlight!\n\nExample receives tips.\n\nSend Example a tip: https://tips.hushline.app/to/example",
      linkedin: "Verified Member Highlight!\n\nExample receives tips.\n\nTo send Example a tip, go to https://tips.hushline.app/to/example.",
      mastodon: "Verified Member Highlight!\n\nExample receives tips.\n\nTo send Example a tip, visit https://tips.hushline.app/to/example.",
    },
    user_link: "https://tips.hushline.app/to/example",
    ...overrides,
  };
}

test("firstSentence extracts the opening hook from paragraph copy", () => {
  assert.equal(
    firstSentence("A public tip line should be easy to verify.\n\nSecond paragraph."),
    "A public tip line should be easy to verify.",
  );
});

test("classifyCta normalizes common Hush Line CTA patterns", () => {
  assert.equal(classifyCta("Body.\n\nSign up at https://hushline.app."), "sign_up");
  assert.equal(classifyCta("Body.\n\nLearn more at https://hushline.app."), "learn_more");
  assert.equal(
    classifyCta("Body.\n\nTo send Alex a tip, go to https://tips.hushline.app/to/alex."),
    "send_tip_go_to",
  );
});

test("daysBetween compares calendar days across DST boundaries", () => {
  assert.equal(daysBetween("2026-03-07", "2026-03-08"), 1);
  assert.equal(daysBetween("2026-11-01", "2026-11-02"), 1);
});

test("analyzePostHistory reports daily topic, hook, CTA, template, and concept repetition", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushline-history-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");
  const verifiedRoot = path.join(tempRoot, "previous-verified-user-posts");

  try {
    writeDailyPost(dailyRoot, "2026-05-20", buildDailyPost());
    writeDailyPost(
      dailyRoot,
      "2026-05-21",
      buildDailyPost({
        concept_key: "onboarding-directory",
        content_key: "auth-newman-onboarding-directory",
        screenshot_file: "newman/auth-newman-onboarding-directory-mobile-light-fold.png",
        template_name: "hushline-daily-mobile-template.html",
      }),
    );
    writeDailyPost(
      dailyRoot,
      "2026-05-22",
      buildDailyPost({
        audience_scope: "recipient-shared",
        concept_key: "settings-notifications",
        content_key: "auth-artvandelay-settings-notifications",
        screenshot_file: "artvandelay/auth-artvandelay-settings-notifications-desktop-light-fold.png",
        social: {
          bluesky: "Notification settings help recipients plan inbox coverage.\n\nLearn more at https://hushline.app.",
          linkedin: "Notification settings help recipients plan inbox coverage.\n\nHush Line lets recipients choose how much message context email notifications include.\n\nLearn more at https://hushline.app.",
          mastodon: "Notification settings help recipients plan inbox coverage.\n\nLearn more at https://hushline.app.",
        },
        topic_family: "notifications",
      }),
    );

    const report = analyzePostHistory({
      asOfDate: "2026-05-22",
      dailyPostsRoot: dailyRoot,
      verifiedUserPostsRoot: verifiedRoot,
      windows: [30],
    });
    const window = report.daily.windows["30"];

    assert.equal(window.total, 3);
    assert.deepEqual(window.topic_family_counts[0], { count: 2, value: "directory" });
    assert.deepEqual(window.audience_scope_counts[0], { count: 2, value: "public" });
    assert.equal(
      window.repeated_hooks[0].sample,
      "A public tip line should be easy to verify.",
    );
    assert.deepEqual(window.repeated_ctas[0], {
      count: 2,
      sample: "sign_up",
      value: "sign_up",
    });
    assert.equal(window.template_usage.length, 2);
    assert.ok(window.concept_key_counts.some((item) => item.value === "onboarding-directory"));
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("analyzePostHistory reports verified-user repetition separately", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hushline-history-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");
  const verifiedRoot = path.join(tempRoot, "previous-verified-user-posts");

  try {
    writeDailyPost(dailyRoot, "2026-05-22", buildDailyPost());
    writeVerifiedUserPost(verifiedRoot, "2026-05-11", buildVerifiedUserPost());
    writeVerifiedUserPost(
      verifiedRoot,
      "2026-05-18",
      buildVerifiedUserPost({
        display_name: "Second Recipient",
        primary_username: "second",
        user_link: "https://tips.hushline.app/to/second",
      }),
    );

    const report = analyzePostHistory({
      asOfDate: "2026-05-22",
      dailyPostsRoot: dailyRoot,
      verifiedUserPostsRoot: verifiedRoot,
      windows: [30],
    });
    const window = report.verified_user.windows["30"];

    assert.equal(window.total, 2);
    assert.deepEqual(window.opening_line_counts[0], {
      count: 2,
      value: "verified member highlight",
    });
    assert.deepEqual(window.repeated_ctas[0], {
      count: 2,
      sample: "send_tip_go_to",
      value: "send_tip_go_to",
    });
    assert.equal(
      window.template_usage[0].value,
      "hushline-social-verified-user-template.html",
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("formatPostHistoryReport includes concise human-readable daily and verified sections", () => {
  const report = {
    as_of_date: "2026-05-22",
    daily: {
      windows: {
        30: {
          audience_scope_counts: [{ count: 1, value: "public" }],
          repeated_ctas: [{ count: 2, value: "sign_up" }],
          repeated_hooks: [{ count: 2, value: "a public tip line should be easy to verify" }],
          template_usage: [{ count: 1, value: "hushline-daily-desktop-template.html" }],
          topic_family_counts: [{ count: 1, value: "directory" }],
          total: 1,
        },
      },
    },
    verified_user: {
      windows: {
        30: {
          opening_line_counts: [{ count: 2, value: "verified member highlight" }],
          repeated_ctas: [{ count: 2, value: "send_tip_go_to" }],
          repeated_hooks: [{ count: 2, value: "verified member highlight" }],
          total: 2,
        },
      },
    },
    windows: [30],
  };

  const output = formatPostHistoryReport(report);

  assert.match(output, /Post history report as of 2026-05-22/);
  assert.match(output, /Daily last 30 days: 1 posts/);
  assert.match(output, /Verified-user last 30 days: 2 posts/);
});
