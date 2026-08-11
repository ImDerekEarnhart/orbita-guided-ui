#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const excluded = new Set([".git", "node_modules"]);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && full.endsWith(".js")) files.push(full);
  }
}

walk(root);
for (const filename of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", filename], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
process.stdout.write(`Syntax checked ${files.length} JavaScript files.\n`);
