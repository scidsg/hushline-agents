#!/usr/bin/env node

"use strict";

const {
  analyzePostHistory,
  formatPostHistoryReport,
} = require("./lib/post-history-analyzer");

function printHelp() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/analyze-post-history.js",
      "  node scripts/analyze-post-history.js --format json",
      "  node scripts/analyze-post-history.js --as-of 2026-05-22 --window 30 --window 90",
      "",
      "Options:",
      "  --as-of YYYY-MM-DD              Analyze windows ending on this date",
      "  --window DAYS                   Include a custom lookback window; repeatable",
      "  --daily-root PATH               Override previous-posts root",
      "  --verified-user-root PATH       Override previous-verified-user-posts root",
      "  --format human|json|both        Output format; default: both",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    asOfDate: null,
    dailyPostsRoot: null,
    format: "both",
    verifiedUserPostsRoot: null,
    windows: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--as-of") {
      args.asOfDate = argv[index + 1];
      index += 1;
    } else if (value === "--window") {
      args.windows.push(Number(argv[index + 1]));
      index += 1;
    } else if (value === "--daily-root") {
      args.dailyPostsRoot = argv[index + 1];
      index += 1;
    } else if (value === "--verified-user-root") {
      args.verifiedUserPostsRoot = argv[index + 1];
      index += 1;
    } else if (value === "--format") {
      args.format = argv[index + 1];
      index += 1;
    } else if (value === "--json") {
      args.format = "json";
    } else if (value === "--human") {
      args.format = "human";
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (args.asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.asOfDate)) {
    throw new Error("`--as-of` must use YYYY-MM-DD format.");
  }

  if (!["both", "human", "json"].includes(args.format)) {
    throw new Error("`--format` must be one of: human, json, both.");
  }

  if (args.windows.some((windowDays) => !Number.isInteger(windowDays) || windowDays <= 0)) {
    throw new Error("`--window` must be a positive integer.");
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = analyzePostHistory({
    asOfDate: args.asOfDate,
    dailyPostsRoot: args.dailyPostsRoot,
    verifiedUserPostsRoot: args.verifiedUserPostsRoot,
    windows: args.windows.length > 0 ? args.windows : undefined,
  });

  if (args.format === "human" || args.format === "both") {
    process.stdout.write(`${formatPostHistoryReport(report)}\n`);
  }

  if (args.format === "both") {
    process.stdout.write("\nJSON:\n");
  }

  if (args.format === "json" || args.format === "both") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main();
