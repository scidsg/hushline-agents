const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { REPO_ROOT } = require("../scripts/lib/social-common");
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

function writePostCopy(rootDir, archiveKey, linkedinCopy) {
  const archiveDir = path.join(rootDir, archiveKey);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, "post-copy.txt"),
    [
      "Social post copy",
      "",
      `LinkedIn (${linkedinCopy.length}/3000)`,
      linkedinCopy,
      "",
      "Mastodon (12/500)",
      "Mastodon copy.",
    ].join("\n"),
  );
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

test("publication safety allows repeated source-only headlines for text-only article shares", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const articleRoot = path.join(tempRoot, "previous-article-posts");

  try {
    writePost(articleRoot, "2026-06-19", {
      headline: "Whistleblower-related reporting from The Guardian",
      publish_mode: "text",
      social: {
        linkedin: "A Guardian story about one whistleblower case.\n\nRead it: https://example.test/one",
      },
    });

    assert.doesNotThrow(() => assertPublicationIsOriginal({
      archiveKey: "2026-06-26",
      dateRoot: articleRoot,
      post: {
        headline: "Whistleblower-related reporting from The Guardian",
        publish_mode: "text",
        social: {
          linkedin: "A fresh Guardian story with a different URL and different copy.\n\nRead it: https://example.test/two",
        },
      },
    }));
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publication safety includes post-copy fallback archives in LinkedIn duplicate history", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");
  const linkedinCopy = "Legacy archive body copy.\n\nSign up at https://hushline.app.";

  try {
    writePostCopy(dailyRoot, "2026-06-19", linkedinCopy);

    assert.throws(
      () => assertPublicationIsOriginal({
        archiveKey: "2026-06-26",
        dateRoot: dailyRoot,
        post: {
          headline: "Fresh headline",
          social: {
            linkedin: linkedinCopy,
          },
        },
      }),
      /LinkedIn copy duplicates previous-posts\/2026-06-19/,
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publication safety includes verified-user copy.json fallback archives", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publication-safety-"));
  const dailyRoot = path.join(tempRoot, "previous-posts");
  const verifiedRoot = path.join(tempRoot, "previous-verified-user-posts");
  const linkedinCopy = "Verified member fallback copy.\n\nTo send Pat a tip, go to https://tips.hushline.app/to/pat.";

  try {
    writeJson(path.join(verifiedRoot, "2026-06-19", "copy.json"), {
      linkedin: linkedinCopy,
    });

    assert.throws(
      () => assertPublicationIsOriginal({
        archiveKey: "2026-06-26",
        dateRoot: dailyRoot,
        post: {
          headline: "Fresh headline",
          social: {
            linkedin: linkedinCopy,
          },
        },
      }),
      /LinkedIn copy duplicates previous-verified-user-posts\/2026-06-19/,
    );
  } finally {
    fs.rmSync(tempRoot, { force: true, recursive: true });
  }
});

test("publication safety reads duplicate history from the fetched remote ref", () => {
  const dateRoot = path.join(REPO_ROOT, "previous-posts");
  const calls = [];
  const remoteCopy = "Remote archive body copy.\n\nSign up at https://hushline.app.";

  function execFileSyncImpl(command, args) {
    calls.push([command, args]);

    if (args[0] === "fetch") {
      return "";
    }

    if (args[0] === "ls-tree" && args[3].endsWith(":previous-posts")) {
      return "2026-06-19\n";
    }

    if (args[0] === "ls-tree") {
      return "";
    }

    if (args[0] === "show" && args[1].endsWith(":previous-posts/2026-06-19/post.json")) {
      return JSON.stringify({
        headline: "Remote headline",
        social: {
          linkedin: remoteCopy,
        },
      });
    }

    throw new Error(`Unexpected git call: ${command} ${args.join(" ")}`);
  }

  assert.throws(
    () => assertPublicationIsOriginal({
      archiveKey: "2026-06-26",
      dateRoot,
      execFileSyncImpl,
      post: {
        headline: "Fresh headline",
        social: {
          linkedin: remoteCopy,
        },
      },
    }),
    /LinkedIn copy duplicates previous-posts\/2026-06-19/,
  );
  assert.ok(calls.some(([_command, args]) => args[0] === "fetch"));
  assert.ok(calls.some(([_command, args]) => args[0] === "ls-tree"));
  assert.ok(calls.some(([_command, args]) => args[0] === "show"));
});

test("publication safety fails closed when repo archive history cannot be refreshed", () => {
  assert.throws(
    () => assertPublicationIsOriginal({
      archiveKey: "2026-06-26",
      dateRoot: path.join(REPO_ROOT, "previous-posts"),
      execFileSyncImpl(command, args) {
        if (command === "git" && args[0] === "fetch") {
          throw new Error("fetch failed");
        }
        return "";
      },
      post: {
        headline: "Fresh headline",
        social: {
          linkedin: "Fresh copy.",
        },
      },
    }),
    /Failed to refresh origin\/main before checking LinkedIn duplicate history/,
  );
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
