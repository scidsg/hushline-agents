const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildPost,
  buildVerifiedUserSocialParagraphs,
  chooseVerifiedUserFormat,
  normalizeVerifiedUsers,
  parseArgs,
  prepareVerifiedUserRun,
  renderHtml,
  selectVerifiedUser,
  validateVerifiedUserSocialParagraphs,
} = require("../scripts/lib/verified-user-post");

const SAMPLE_USERS = [
  {
    bio: "Public-interest reporter covering procurement and labor issues.",
    display_name: "Verified User A",
    entry_type: "user",
    is_verified: true,
    primary_username: "verified-user-a",
    profile_url: "/to/verified-user-a",
  },
  {
    bio: "Investigative editor focused on energy and utilities.",
    display_name: "Verified User B",
    entry_type: "user",
    is_verified: true,
    primary_username: "verified-user-b",
    profile_url: "/to/verified-user-b",
  },
  {
    bio: "Ignored because not verified.",
    display_name: "Unverified Placeholder",
    entry_type: "user",
    is_verified: false,
    primary_username: "unverified-placeholder",
    profile_url: "/to/unverified-placeholder",
  },
  {
    bio: "Ignored because admin accounts should never be selected.",
    display_name: "Verified Admin Placeholder",
    entry_type: "user",
    is_admin: true,
    is_verified: true,
    primary_username: "verified-admin-placeholder",
    profile_url: "/to/verified-admin-placeholder",
  },
];

test("parseArgs rejects malformed dates", () => {
  assert.throws(
    () => parseArgs(["--date", "2026/03/30"]),
    /`--date` must use YYYY-MM-DD format/,
  );
});

test("normalizeVerifiedUsers keeps verified user rows and resolves /to URLs", () => {
  const users = normalizeVerifiedUsers(SAMPLE_USERS, "https://tips.hushline.app");

  assert.equal(users.length, 2);
  assert.equal(users[0].display_name, "Verified User A");
  assert.equal(users[0].user_url, "https://tips.hushline.app/to/verified-user-a");
  assert.equal(users[1].user_url, "https://tips.hushline.app/to/verified-user-b");
});

test("normalizeVerifiedUsers excludes verified admin accounts from the weekly spotlight pool", () => {
  const users = normalizeVerifiedUsers(SAMPLE_USERS, "https://tips.hushline.app");

  assert.equal(
    users.some((user) => user.primary_username === "verified-admin-placeholder"),
    false,
  );
});

test("selectVerifiedUser rotates away from recent archive entries", () => {
  const users = normalizeVerifiedUsers(SAMPLE_USERS, "https://tips.hushline.app");
  const selected = selectVerifiedUser(users, [
    {
      date: "2026-03-23",
      primary_username: "verified-user-a",
    },
  ]);

  assert.equal(selected.primary_username, "verified-user-b");
});

test("selectVerifiedUser rejects duplicate picks once every verified user has already been posted", () => {
  const users = normalizeVerifiedUsers(SAMPLE_USERS, "https://tips.hushline.app");

  assert.throws(
    () => selectVerifiedUser(users, [
      {
        date: "2026-03-16",
        primary_username: "verified-user-a",
      },
      {
        date: "2026-03-23",
        primary_username: "verified-user-b",
      },
    ]),
    /No unposted verified users remain/,
  );
});

test("prepareVerifiedUserRun allows manual non-Monday dates", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verified-user-post-"));
  const sourcePath = path.join(tempRoot, "users.json");
  fs.writeFileSync(sourcePath, `${JSON.stringify(SAMPLE_USERS, null, 2)}\n`);

  const run = await prepareVerifiedUserRun({
      baseUrl: "https://tips.hushline.app",
      date: "2026-03-31",
      noRender: true,
      source: sourcePath,
    });

  assert.equal(run.date, "2026-03-31");
  assert.equal(run.selectedUser.primary_username, "verified-user-b");
});

test("prepareVerifiedUserRun selects the next user after archive history", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verified-user-post-"));
  const sourcePath = path.join(tempRoot, "users.json");
  const archiveRoot = path.join(tempRoot, "archive");
  fs.mkdirSync(path.join(archiveRoot, "2026-03-23"), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(SAMPLE_USERS, null, 2)}\n`);
  fs.writeFileSync(
    path.join(archiveRoot, "2026-03-23", "post.json"),
    `${JSON.stringify({
      date: "2026-03-23",
      display_name: "Verified User A",
      primary_username: "verified-user-a",
      user_url: "https://tips.hushline.app/to/verified-user-a",
    }, null, 2)}\n`,
  );

  const run = await prepareVerifiedUserRun(
    {
      baseUrl: "https://tips.hushline.app",
      date: "2026-03-30",
      noRender: true,
      source: sourcePath,
    },
    { archiveRoot },
  );

  assert.equal(run.selectedUser.primary_username, "verified-user-b");
  assert.equal(run.post.user_link, "https://tips.hushline.app/to/verified-user-b");
  assert.equal(run.post.verified_user_format, "source_safe_first_contact");
  assert.equal(run.post.opening_line, "First contact should be source-safe.");
});

test("chooseVerifiedUserFormat rotates away from recent formats", () => {
  const format = chooseVerifiedUserFormat([
    { date: "2026-02-16", verified_user_format: "why_follow_tip_line" },
    { date: "2026-02-23", verified_user_format: "what_this_recipient_covers" },
    { date: "2026-03-02", verified_user_format: "before_you_contact_them" },
    { date: "2026-03-09", verified_user_format: "how_to_verify_the_link" },
    { date: "2026-03-16", verified_user_format: "source_safe_first_contact" },
  ], "2026-03-30");

  assert.equal(format.id, "from_the_directory");
});

test("renderHtml injects the selected user text and QR filename", () => {
  const post = buildPost({
    date: "2026-03-30",
    format: "why_follow_tip_line",
    selectedUser: {
      bio: "Investigative editor focused on energy and utilities.",
      display_name: "Verified User B",
      primary_username: "verified-user-b",
      user_url: "https://tips.hushline.app/to/verified-user-b",
    },
    source: "fixture",
  });
  const html = renderHtml(post, "verified-user-qr.png", "logo-tips.png");

  assert.match(html, /Verified User B/);
  assert.match(html, /Investigative editor focused on energy and utilities\./);
  assert.match(html, /https:\/\/tips\.hushline\.app\/to\/verified-user-b/);
  assert.match(html, /\.\/verified-user-qr\.png/);
  assert.equal(post.verified_user_format, "why_follow_tip_line");
  assert.match(post.social.linkedin, /^Why follow Verified's Hush Line\?/);
  assert.doesNotMatch(post.social.linkedin, /🤩 Verified Member Highlight!/);
});

test("verified-user renderHtml embeds local fonts and strips remote Google Fonts links", () => {
  const post = buildPost({
    date: "2026-03-30",
    selectedUser: {
      bio: "Investigative editor focused on energy and utilities.",
      display_name: "Verified User B",
      primary_username: "verified-user-b",
      user_url: "https://tips.hushline.app/to/verified-user-b",
    },
    source: "fixture",
  });
  const html = renderHtml(post, "verified-user-qr.png", "logo-tips.png");

  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
  assert.match(html, /Atkinson Hyperlegible Embedded/);
  assert.match(html, /data:font\/ttf;base64,/);
});

test("validateVerifiedUserSocialParagraphs rejects capitalized first-person copy", () => {
  assert.throws(
    () => validateVerifiedUserSocialParagraphs({
      bluesky: "Verified User B is an investigative editor.",
      linkedin: "We report on labor issues.",
      mastodon: "Verified User B is an investigative editor.",
    }, {
      display_name: "Verified User B",
      primary_username: "verified-user-b",
      user_url: "https://tips.hushline.app/to/verified-user-b",
    }),
    /must not use first-person language/,
  );
});

test("validateVerifiedUserSocialParagraphs rejects malformed punctuation before cleanup", () => {
  assert.throws(
    () => validateVerifiedUserSocialParagraphs({
      bluesky: "Verified User B is an investigative editor..",
      linkedin: "Verified User B is an investigative editor.",
      mastodon: "Verified User B is an investigative editor.",
    }, {
      display_name: "Verified User B",
      primary_username: "verified-user-b",
      user_url: "https://tips.hushline.app/to/verified-user-b",
    }),
    /malformed punctuation/,
  );
});

test("buildVerifiedUserSocialParagraphs falls back for empty bios", () => {
  const paragraphs = buildVerifiedUserSocialParagraphs({
    bio: "",
    display_name: "Verified User B",
    primary_username: "verified-user-b",
    user_url: "https://tips.hushline.app/to/verified-user-b",
  }, "from_the_directory");

  assert.equal(paragraphs.linkedin, "Verified User B has a verified Hush Line profile.");
});

test("buildVerifiedUserSocialParagraphs cleans malformed terminal punctuation in bios", () => {
  const paragraphs = buildVerifiedUserSocialParagraphs({
    bio: "Investigative editor focused on energy and utilities..",
    display_name: "Verified User B",
    primary_username: "verified-user-b",
    user_url: "https://tips.hushline.app/to/verified-user-b",
  }, "from_the_directory");

  assert.equal(paragraphs.linkedin, "Verified is an investigative editor focused on energy and utilities.");
});

test("buildVerifiedUserSocialParagraphs rewrites first-person bios into direct third-person copy", () => {
  const selectedUser = {
    bio: "LGBTQ+ rights reporter at HuffPost. Covering Trump admin, legal attacks on trans rights, and organized resistance. Writing at the speed of trust. Signal @levikalish.01",
    display_name: "Levi Kalish",
    primary_username: "LKalish",
    user_url: "https://tips.hushline.app/to/LKalish",
  };

  const paragraphs = buildVerifiedUserSocialParagraphs(selectedUser);

  assert.equal(typeof paragraphs.linkedin, "string");
  assert.equal(typeof paragraphs.mastodon, "string");
  assert.equal(typeof paragraphs.bluesky, "string");
  assert.doesNotMatch(paragraphs.linkedin, /\b(I|I'm|I’m|my|me|we|we're|we’re|our|us)\b/i);
  assert.match(paragraphs.linkedin, /LGBTQ\+ rights reporter at HuffPost\./);
  assert.match(paragraphs.linkedin, /Trump admin/);
});
