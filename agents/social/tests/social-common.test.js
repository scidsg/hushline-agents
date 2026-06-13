const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const modulePath = require.resolve("../scripts/lib/social-common");

function withFreshSocialCommon(tempScreenshotsRepoDir) {
  const previousScreenshotsRoot = process.env.HUSHLINE_SCREENSHOTS_REPO_DIR;
  const previousCurrentScreenshotsRoot = process.env.HUSHLINE_CURRENT_SCREENSHOTS_DIR;
  process.env.HUSHLINE_SCREENSHOTS_REPO_DIR = tempScreenshotsRepoDir;
  process.env.HUSHLINE_CURRENT_SCREENSHOTS_DIR = path.join(tempScreenshotsRepoDir, "current");
  delete require.cache[modulePath];
  const socialCommon = require("../scripts/lib/social-common");

  return {
    cleanup() {
      delete require.cache[modulePath];
      if (previousScreenshotsRoot === undefined) {
        delete process.env.HUSHLINE_SCREENSHOTS_REPO_DIR;
      } else {
        process.env.HUSHLINE_SCREENSHOTS_REPO_DIR = previousScreenshotsRoot;
      }
      if (previousCurrentScreenshotsRoot === undefined) {
        delete process.env.HUSHLINE_CURRENT_SCREENSHOTS_DIR;
      } else {
        process.env.HUSHLINE_CURRENT_SCREENSHOTS_DIR = previousCurrentScreenshotsRoot;
      }
    },
    socialCommon,
  };
}

test("getWeekdayLabel and isWeekendDate classify weekdays correctly", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    assert.equal(socialCommon.getWeekdayLabel("2026-03-20"), "friday");
    assert.equal(socialCommon.getWeekdayLabel("2026-03-21"), "saturday");
    assert.equal(socialCommon.isWeekendDate("2026-03-20"), false);
    assert.equal(socialCommon.isWeekendDate("2026-03-22"), true);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("archive key helpers parse base and suffixed containers correctly", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    assert.equal(socialCommon.isValidArchiveKey("2026-03-26"), true);
    assert.equal(socialCommon.isValidArchiveKey("2026-03-26-2"), true);
    assert.equal(socialCommon.isValidArchiveKey("2026-03-26-extra"), false);
    assert.equal(socialCommon.archiveKeyDate("2026-03-26-2"), "2026-03-26");
    assert.deepEqual(socialCommon.parseArchiveKey("2026-03-26-2"), {
      date: "2026-03-26",
      key: "2026-03-26-2",
      suffix: 2,
    });
    assert.equal(socialCommon.compareArchiveKeys("2026-03-26", "2026-03-26-1"), -1);
    assert.equal(socialCommon.compareArchiveKeys("2026-03-26-2", "2026-03-26-1"), 1);
    assert.equal(socialCommon.compareArchiveKeys("2026-03-27", "2026-03-26-9"), 1);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("ensureLatestFoldScreenshot accepts only files under the configured screenshot root ending in -fold.png", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const latestDir = path.join(tempRoot, "releases", "latest", "guest");
  const oldDir = path.join(tempRoot, "releases", "2026-03-01", "guest");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.mkdirSync(oldDir, { recursive: true });

  const validPath = path.join(latestDir, "guest-directory-verified-desktop-light-fold.png");
  const nonFoldPath = path.join(latestDir, "guest-directory-verified-desktop-light.png");
  const stalePath = path.join(oldDir, "guest-directory-verified-desktop-light-fold.png");

  fs.writeFileSync(validPath, "png");
  fs.writeFileSync(nonFoldPath, "png");
  fs.writeFileSync(stalePath, "png");

  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    assert.equal(socialCommon.ensureLatestFoldScreenshot(validPath), validPath);
    assert.throws(() => socialCommon.ensureLatestFoldScreenshot(nonFoldPath), /must come from the configured screenshots folder/);
    assert.throws(() => socialCommon.ensureLatestFoldScreenshot(stalePath), /must come from the configured screenshots folder/);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("current screenshots folder takes precedence over release screenshots", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const currentDir = path.join(tempRoot, "current", "guest");
  const latestDir = path.join(tempRoot, "releases", "latest", "guest");
  fs.mkdirSync(currentDir, { recursive: true });
  fs.mkdirSync(latestDir, { recursive: true });

  const currentPath = path.join(currentDir, "guest-directory-verified-desktop-light-fold.png");
  const latestPath = path.join(latestDir, "guest-directory-verified-desktop-light-fold.png");
  fs.writeFileSync(currentPath, "png");
  fs.writeFileSync(latestPath, "png");

  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    assert.equal(socialCommon.SCREENSHOTS_ROOT, path.join(tempRoot, "current"));
    assert.equal(socialCommon.ensureLatestFoldScreenshot(currentPath), currentPath);
    assert.throws(() => socialCommon.ensureLatestFoldScreenshot(latestPath), /must come from the configured screenshots folder/);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("listTemplateVariants discovers base and suffixed template files for a type", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const templatesDir = path.join(tempRoot, "templates");
  fs.mkdirSync(templatesDir, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template-2.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template-10.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-desktop-template.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-social-verified-user-template.html"), "");

  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    const variants = socialCommon.listTemplateVariants("mobile", templatesDir).map((filePath) => path.basename(filePath));
    assert.deepEqual(variants, [
      "hushline-daily-mobile-template.html",
      "hushline-daily-mobile-template-2.html",
      "hushline-daily-mobile-template-10.html",
    ]);
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("resolveTemplateVariant randomly uses matching daily template variants", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const latestDir = path.join(tempRoot, "releases", "latest", "guest");
  const templatesDir = path.join(tempRoot, "templates");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });
  const screenshotPath = path.join(latestDir, "guest-directory-verified-mobile-light-fold.png");
  fs.writeFileSync(screenshotPath, "png");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template-2.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template-3.html"), "");

  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);
  const originalRandom = Math.random;
  Math.random = () => 0.8;

  try {
    const selection = socialCommon.resolveTemplateVariant({
      planned_date: "2026-03-24",
      content_key: "guest-directory-verified",
    }, screenshotPath, templatesDir);

    assert.equal(selection.templateName, "hushline-daily-mobile-template-3.html");
  } finally {
    Math.random = originalRandom;
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("resolveTemplateVariant honors an explicit template name for the post", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const latestDir = path.join(tempRoot, "releases", "latest", "guest");
  const templatesDir = path.join(tempRoot, "templates");
  fs.mkdirSync(latestDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });
  const screenshotPath = path.join(latestDir, "guest-directory-verified-mobile-light-fold.png");
  fs.writeFileSync(screenshotPath, "png");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template.html"), "");
  fs.writeFileSync(path.join(templatesDir, "hushline-daily-mobile-template-2.html"), "");

  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    const selection = socialCommon.resolveTemplateVariant({
      content_key: "guest-directory-verified",
      planned_date: "2026-04-02",
      template_name: "hushline-daily-mobile-template-2.html",
    }, screenshotPath, templatesDir);

    assert.equal(selection.templateName, "hushline-daily-mobile-template-2.html");
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("inferScreenKey groups same-screen variants while keeping distinct screens separate", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "social-common-"));
  const { socialCommon, cleanup } = withFreshSocialCommon(tempRoot);

  try {
    assert.equal(
      socialCommon.inferScreenKey({
        content_key: "guest-directory-verified",
        path: "/directory",
        title: "Directory - Verified",
      }),
      "directory-index",
    );
    assert.equal(
      socialCommon.inferScreenKey({
        content_key: "guest-directory-all",
        path: "/directory",
        title: "Directory - All",
      }),
      "directory-index",
    );
    assert.equal(
      socialCommon.inferScreenKey({
        content_key: "guest-directory-attorney-adam-j-levitt",
        path: "/directory/public-records/public-record~adam-j-levitt",
        title: "Directory - Attorney listing (Adam J. Levitt)",
      }),
      "directory-public-record",
    );
    assert.equal(
      socialCommon.inferScreenKey({
        content_key: "auth-newman-onboarding-directory",
        path: "/onboarding?step=directory",
        title: "Onboarding - Step 4 Directory (newman)",
      }),
      "onboarding-directory",
    );
  } finally {
    cleanup();
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
