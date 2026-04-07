#!/usr/bin/env node
// push-secrets.js — convert .dev.vars to JSON and bulk-upload to Cloudflare Workers
//
// Usage: node scripts/push-secrets.js
// Requires: wrangler (npx wrangler or global install), Node.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const varsFile = path.join(__dirname, "..", ".dev.vars");

if (!fs.existsSync(varsFile)) {
  console.error(`Error: ${varsFile} not found`);
  process.exit(1);
}

const result = {};
for (const raw of fs.readFileSync(varsFile, "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  result[key] = value;
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
