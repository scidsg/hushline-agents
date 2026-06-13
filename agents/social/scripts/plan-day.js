#!/usr/bin/env node

"use strict";

const path = require("path");
const { planDay, parseArgs } = require("./lib/daily-planner");
const { REPO_ROOT } = require("./lib/social-common");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await planDay(args);

  process.stdout.write(
    [
      `Prepared daily planning context for ${args.date}`,
      `- ${path.relative(REPO_ROOT, result.contextPath)}`,
      `- ${path.relative(REPO_ROOT, result.promptPath)}`,
      `- target plan path: ${path.relative(REPO_ROOT, result.planPath)}`,
      `- shortlisted ${result.context.candidate_screenshots.length} candidate screenshots`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
