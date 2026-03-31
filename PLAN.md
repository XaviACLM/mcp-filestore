# mcp-stash — Implementation Plan

## Sprint 1 — Foundation + first two tools

Goal: a working MCP server, deployed locally, that can create and read files in a real GitHub repo. Every architectural decision is proven by the end of this sprint.

- [ ] Wrangler project init (TypeScript, no frameworks)
- [ ] MCP Streamable HTTP transport
  - POST handler for JSON-RPC
  - `initialize` response (server name, version, capabilities)
  - `tools/list` response (static tool manifest)
  - `tools/call` dispatch
- [ ] GitHub API client module
  - Authenticated fetch wrapper (PAT from Worker secret)
  - `getFile(path)` → content + SHA
  - `writeFile(path, content, sha?)` → commit (create if no SHA, update if SHA provided)
- [ ] `read_file` tool
- [ ] `create_file` tool (error if file already exists)
- [ ] Local smoke test via `wrangler dev` + Claude Code or curl

---

## Sprint 2 — Remaining tools

Goal: feature-complete server (minus protection). All tools implemented and locally tested.

- [ ] GitHub API client additions
  - `deleteFile(path, sha)`
  - `getTree()` → flat list of all file paths
- [ ] `list_files` tool (glob filtering via micromatch)
- [ ] `delete_file` tool
- [ ] `append_file` tool (getFile → append → writeFile)
- [ ] `edit_file` tool (getFile → string replace → writeFile, with match validation)
- [ ] `search_files` tool (getTree → fetch each file → regex match with context lines)
- [ ] Error message polish across all tools

---

## Sprint 3 — Protection system + deployment

Goal: production-ready, deployed, connected to Claude.

- [ ] GitHub API client additions
  - `createBranch(name, fromSha)`
  - `createPR(branch, title, body)`
  - `listOpenPRs()`
- [ ] `.protected` parsing (gitignore-style glob matching via micromatch)
- [ ] `resolveAccess(path)` → `'direct' | 'pr' | 'system'`
- [ ] Wire `resolveAccess` into all write tools
  - `'system'` → generic "invalid filename" error, no further info
  - `'pr'` → create branch, apply change, open PR, return PR URL
- [ ] `list_proposals` tool
- [ ] Deploy to Cloudflare (`wrangler deploy`, set secrets)
- [ ] Connect to Claude Desktop / Claude Code, end-to-end test
