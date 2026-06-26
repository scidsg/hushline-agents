const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertPublicationIsOriginal,
  archiveRootCandidates,
  findPublicationSafetyViolations,
  normalizePublicationText,
} = require("../scripts/lib/publication-safety");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePost(rootDir, archiveKey, overrides = {}) {
  writeJson(path.join(rootDir, archiveKey, "post.json"), {
    headline: "Keep follow-up in the conversation thread",
    social: {
      linkedin: "Follow-up should stay in the same review thread.\n\nSign up at https://hushline.app.",
    },
    ...overrides,
  });
}

test("normalizePublicationText makes exact duplicate checks stable across punctuation and case", () => {
  assert.equal(
    normalizePublicationText("Keep follow-up in the conversation thread!"),
    normalizePublicationText("keep follow up in the conversation thread"),
  );
});

test("archiveRootCandidates scans sibling social archive lanes for runtime archives", () => {
  const root = path.join(os.tmpdir(), "hushline-social", "previous-posts");

  assert.deepEqual(
    archiveRootCandidates(root).map((candidate) => path.basename(candidate)),
    [
      "previous-posts",
      "previous-article-posts",
      "previous-verified-user-posts",
    ],
  );
});

test("publication safety blocks an exact duplicate headline from history", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");

  try {
    writePost(dailyRoot, "2026-06-19");

    const violations = findPublicationSafetyViolations({
      archiveKey: "2026-06-26",
      dateRoot: dailyRoot,
      post: {
        headline: "Keep follow-up in the conversation thread",
        social: {
          linkedin: "New body copy that should still be blocked by the headline.",
        },
      },
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0].field, "headline");
    assert.match(violations[0].message, /previous-posts\/2026-06-19/);
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publication safety blocks exact LinkedIn body reuse from sibling archive lanes", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");
  const articleRoot = path.join(tempRoot, "previous-article-posts");

  try {
    writePost(articleRoot, "2026-06-19", {
      headline: "A different headline",
      social: {
        linkedin: "Same body copy.\n\nRead more at https://hushline.app/library/blog/example.",
      },
    });

    assert.throws(
      () => assertPublicationIsOriginal({
        archiveKey: "2026-06-26",
        dateRoot: dailyRoot,
        post: {
          headline: "Fresh headline",
          social: {
            linkedin: "Same body copy.\n\nRead more at https://hushline.app/library/blog/example.",
          },
        },
      }),
      /LinkedIn copy duplicates previous-article-posts\/2026-06-19/,
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publication safety ignores the current archive container", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");

  try {
    writePost(dailyRoot, "2026-06-26");

    assert.doesNotThrow(() => assertPublicationIsOriginal({
      archiveKey: "2026-06-26",
      dateRoot: dailyRoot,
      post: {
        headline: "Keep follow-up in the conversation thread",
        social: {
          linkedin: "Follow-up should stay in the same review thread.\n\nSign up at https://hushline.app.",
        },
      },
    }));
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});
