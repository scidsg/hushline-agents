#!/usr/bin/env node

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  VERIFIED_USER_POSTS_ROOT,
  buildVerifiedUserSocialParagraphs,
  buildVerifiedUserSocialPrompt,
  composeVerifiedUserSocialCopy,
  parseArgs,
  prepareVerifiedUserRun,
  renderVerifiedUserPost,
  validateVerifiedUserSocialParagraphs,
} = require("./lib/verified-user-post");
const { REPO_ROOT } = require("./lib/social-common");

const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.5";
const CODEX_REASONING_EFFORT = process.env.CODEX_REASONING_EFFORT || "high";

function requireCommand(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Missing required command: ${command}`);
  }
}

function writeCopyJson(copyPath, paragraphs) {
  fs.writeFileSync(copyPath, `${JSON.stringify(paragraphs, null, 2)}\n`);
}

function buildSocialFromParagraphs(selectedUser, paragraphs, format) {
  return {
    bluesky: composeVerifiedUserSocialCopy("bluesky", selectedUser, paragraphs.bluesky, format),
    linkedin: composeVerifiedUserSocialCopy("linkedin", selectedUser, paragraphs.linkedin, format),
    mastodon: composeVerifiedUserSocialCopy("mastodon", selectedUser, paragraphs.mastodon, format),
  };
}

function loadValidatedExistingCopy(copyPath, selectedUser, format) {
  if (!fs.existsSync(copyPath)) {
    return null;
  }

  const generated = JSON.parse(fs.readFileSync(copyPath, "utf8"));
  const paragraphs = validateVerifiedUserSocialParagraphs(generated, selectedUser, { format });

  return {
    copyPath,
    fallback: false,
    provided: true,
    social: buildSocialFromParagraphs(selectedUser, paragraphs, format),
  };
}

function buildLocalFallbackCopy(run, outputDir, promptPath, lastError) {
  const copyPath = path.join(outputDir, "copy.json");
  const paragraphs = buildVerifiedUserSocialParagraphs(run.selectedUser, run.verifiedUserFormat);
  writeCopyJson(copyPath, paragraphs);

  if (lastError) {
    process.stderr.write(
      `Falling back to local verified-user copy for ${run.date}: ${lastError.message}\n`,
    );
  }

  return {
    copyPath,
    fallback: true,
    promptPath,
    social: buildSocialFromParagraphs(run.selectedUser, paragraphs, run.verifiedUserFormat),
  };
}

function generateVerifiedUserCopy(run, outputDir) {
  const copyPath = path.join(outputDir, "copy.json");
  const promptPath = path.join(outputDir, "copy-prompt.txt");
  fs.mkdirSync(outputDir, { recursive: true });
  let feedback = "";
  let lastError = null;

  try {
    const providedCopy = loadValidatedExistingCopy(copyPath, run.selectedUser, run.verifiedUserFormat);
    if (providedCopy) {
      return providedCopy;
    }
  } catch (error) {
    lastError = new Error(`Existing verified-user copy.json is invalid: ${error.message}`);
  }

  try {
    requireCommand("codex");
  } catch (error) {
    lastError = error;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildVerifiedUserSocialPrompt({
      date: run.date,
      feedback,
      format: run.verifiedUserFormat,
      outputPath: path.relative(REPO_ROOT, copyPath),
      selectedUser: run.selectedUser,
    });
    fs.writeFileSync(promptPath, `${prompt}\n`);

    if (lastError && /Missing required command: codex/.test(lastError.message)) {
      break;
    }

    const codexOutputPath = path.join(os.tmpdir(), `verified-user-codex-output-${process.pid}-${Date.now()}-${attempt}.txt`);
    if (fs.existsSync(copyPath)) {
      fs.unlinkSync(copyPath);
    }

    const result = spawnSync(
      "codex",
      [
        "exec",
        "--model",
        CODEX_MODEL,
        "-c",
        `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
        "--full-auto",
        "--sandbox",
        "workspace-write",
        "-C",
        REPO_ROOT,
        "-o",
        codexOutputPath,
        "-",
      ],
      {
        encoding: "utf8",
        input: prompt,
        maxBuffer: 1024 * 1024 * 8,
      },
    );

    if (result.status !== 0) {
      const stderr = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      lastError = new Error(stderr || `Codex copy generation failed with exit ${result.status}.`);
      continue;
    }

    if (!fs.existsSync(copyPath)) {
      lastError = new Error(`Codex did not write verified-user copy to ${copyPath}.`);
      continue;
    }

    try {
      const generated = JSON.parse(fs.readFileSync(copyPath, "utf8"));
      const paragraphs = validateVerifiedUserSocialParagraphs(generated, run.selectedUser, { format: run.verifiedUserFormat });
      return {
        copyPath,
        promptPath,
        social: buildSocialFromParagraphs(run.selectedUser, paragraphs, run.verifiedUserFormat),
      };
    } catch (error) {
      lastError = error;
      feedback = `The previous draft failed validation: ${error.message} Rewrite it more directly and avoid profile-meta phrasing.`;
    }
  }

  return buildLocalFallbackCopy(run, outputDir, promptPath, lastError);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = await prepareVerifiedUserRun(args);
  const outputDir = path.join(VERIFIED_USER_POSTS_ROOT, args.date);
  const generatedCopy = generateVerifiedUserCopy(run, outputDir);
  run.post.social = generatedCopy.social;
  const rendered = await renderVerifiedUserPost(run);
  const archiveRel = path.relative(REPO_ROOT, path.join(VERIFIED_USER_POSTS_ROOT, args.date));

  process.stdout.write(
    [
      `Prepared verified-user weekly post for ${args.date}`,
      `- selected ${run.selectedUser.display_name} (@${run.selectedUser.primary_username})`,
      `- archive: ${archiveRel}`,
      generatedCopy.provided
        ? "- social copy: existing copy.json"
        : generatedCopy.fallback
          ? "- social copy: local fallback"
          : "- social copy: codex-generated",
      args.noRender ? "- rendering skipped" : `- rendered into ${path.relative(REPO_ROOT, rendered.outputDir)}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
