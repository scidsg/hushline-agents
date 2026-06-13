#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function assertIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`Missing expected text in ${label}: ${needle}`);
  }
}

function assertWeekdayArray(plistText, label) {
  for (const weekday of ["1", "2", "3", "4", "5"]) {
    const needle = `<key>Weekday</key>\n      <integer>${weekday}</integer>`;
    assertIncludes(plistText, needle, label);
  }

  const weekdayValues = [...plistText.matchAll(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/g)].map((match) => match[1]);
  if (weekdayValues.some((value) => value === "0" || value === "6" || value === "7")) {
    throw new Error(`${label} unexpectedly includes a weekend weekday value`);
  }
}

function assertDailySchedule(plistText, label, { hour, minute }) {
  assertIncludes(plistText, `<key>Hour</key>\n    <integer>${hour}</integer>`, label);
  assertIncludes(plistText, `<key>Minute</key>\n    <integer>${minute}</integer>`, label);
  if (plistText.includes("<key>Weekday</key>")) {
    throw new Error(`${label} unexpectedly includes a weekday gate`);
  }
}

function main() {
  const readme = read("README.md");
  const agents = read("AGENTS.md");
  const packageJson = JSON.parse(read("package.json"));
  const newsPlist = read("deploy/launchd/com.hushline.social.whistleblower-news-post-agent.plist");
  const featurePlist = read("deploy/launchd/com.hushline.social.hushline-feature-post-agent.plist");
  const verifiedUserPlist = read("deploy/launchd/com.hushline.social.hushline-verified-user-post-agent.plist");
  const daemonNewsPlist = read("deploy/launchd/com.hushline.social.whistleblower-news-post-agent.daemon.plist");
  const daemonFeaturePlist = read("deploy/launchd/com.hushline.social.hushline-feature-post-agent.daemon.plist");
  const daemonVerifiedUserPlist = read("deploy/launchd/com.hushline.social.hushline-verified-user-post-agent.daemon.plist");

  assertIncludes(readme, "Monday through Friday", "README.md");
  assertIncludes(readme, "Whistleblower news post agent", "README.md");
  assertIncludes(readme, "Hush Line feature post agent", "README.md");
  assertIncludes(readme, "sudo ./scripts/install_launch_agent.sh --scope daemon", "README.md");
  assertIncludes(readme, "npm run check:launchd", "README.md");

  assertIncludes(agents, "Whistleblower news post agent", "AGENTS.md");
  assertIncludes(agents, "Hush Line feature post agent", "AGENTS.md");
  assertIncludes(agents, "Hush Line verified-user post agent", "AGENTS.md");
  assertIncludes(agents, "agents/social/scripts/check_launchd_prereqs.sh", "AGENTS.md");

  if (packageJson.scripts["check:docs-drift"] !== "node scripts/check-docs-drift.js") {
    throw new Error("package.json is missing the expected check:docs-drift script");
  }

  if (packageJson.scripts["install:launch-agent"] !== "./scripts/install_launch_agent.sh") {
    throw new Error("package.json install:launch-agent must use local social agent scripts");
  }

  if (packageJson.scripts["install:launch-daemon"] !== "sudo ./scripts/install_launch_agent.sh --scope daemon") {
    throw new Error("package.json install:launch-daemon must use local social agent scripts");
  }

  if (packageJson.scripts["check:launchd"] !== "./scripts/check_launchd_prereqs.sh") {
    throw new Error("package.json check:launchd must use local social agent scripts");
  }

  assertDailySchedule(newsPlist, "deploy/launchd/com.hushline.social.whistleblower-news-post-agent.plist", { hour: "4", minute: "0" });
  assertDailySchedule(featurePlist, "deploy/launchd/com.hushline.social.hushline-feature-post-agent.plist", { hour: "4", minute: "0" });
  assertDailySchedule(daemonNewsPlist, "deploy/launchd/com.hushline.social.whistleblower-news-post-agent.daemon.plist", { hour: "4", minute: "0" });
  assertDailySchedule(daemonFeaturePlist, "deploy/launchd/com.hushline.social.hushline-feature-post-agent.daemon.plist", { hour: "4", minute: "0" });
  assertWeekdayArray(verifiedUserPlist, "deploy/launchd/com.hushline.social.hushline-verified-user-post-agent.plist");
  assertWeekdayArray(daemonVerifiedUserPlist, "deploy/launchd/com.hushline.social.hushline-verified-user-post-agent.daemon.plist");

  process.stdout.write("Docs and launchd schedule are in sync.\n");
}

main();
