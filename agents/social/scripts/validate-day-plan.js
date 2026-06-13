#!/usr/bin/env node

"use strict";

const path = require("path");
const {
  buildDailyContext,
  loadSavedDailyContext,
  parseArgs,
  renderDailyPlan,
  validatePlan,
} = require("./lib/daily-planner");
const { REPO_ROOT, readJson, writeJson } = require("./lib/social-common");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = loadSavedDailyContext(args.archiveKey) || buildDailyContext(args);
  const archiveRoot = path.join(REPO_ROOT, "previous-posts", args.archiveKey);
  const planPath = path.join(archiveRoot, "plan.json");
  const criticPath = path.join(archiveRoot, "critic.json");
  const rawPlan = readJson(planPath);
  let validatedPlan = null;

  try {
    validatedPlan = validatePlan(rawPlan, context);
  } catch (error) {
    if (error.critic) {
      writeJson(criticPath, error.critic);
    }
    throw error;
  }

  writeJson(planPath, validatedPlan);
  if (validatedPlan.critic) {
    writeJson(criticPath, validatedPlan.critic);
  }

  let rendered = null;
  if (!args.noRender) {
    rendered = await renderDailyPlan(validatedPlan, args.archiveKey);
  }

  process.stdout.write(
    [
      `Validated daily plan for ${validatedPlan.date}`,
      `- ${path.relative(REPO_ROOT, planPath)}`,
      args.noRender
        ? "- rendering skipped"
        : `- rendered into ${path.relative(REPO_ROOT, rendered.outputDir)}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
