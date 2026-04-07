#!/usr/bin/env node
// push-secrets.js — convert .dev.vars to JSON and bulk-upload to Cloudflare Workers
//
// Usage: node scripts/push-secrets.js
// Supports single-line and multiline values (e.g. pretty-printed JSON).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const varsFile = path.join(__dirname, "..", ".dev.vars");

if (!fs.existsSync(varsFile)) {
  console.error(`Error: ${varsFile} not found`);
  process.exit(1);
}

const lines = fs.readFileSync(varsFile, "utf8").split(/\r?\n/);
const result = {};
let currentKey = null;
let currentLines = [];

for (const line of lines) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)/);
  if (m) {
    if (currentKey) result[currentKey] = currentLines.join("\n").trim();
    currentKey = m[1];
    currentLines = [m[2]];
  } else if (currentKey) {
    currentLines.push(line);
  }
}
if (currentKey) result[currentKey] = currentLines.join("\n").trim();

if (Object.keys(result).length === 0) {
  console.error("No entries found in .dev.vars");
  process.exit(1);
}

const tmpFile = path.join(os.tmpdir(), `wrangler-secrets-${Date.now()}.json`);
fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2));

console.log(`Uploading ${Object.keys(result).length} secret(s) from ${varsFile}...`);
try {
  execSync(`npx wrangler secret bulk "${tmpFile}"`, { stdio: "inherit" });
  console.log("Done.");
} finally {
  fs.unlinkSync(tmpFile);
}
