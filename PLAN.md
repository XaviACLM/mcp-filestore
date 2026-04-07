# mcp-filestore — Implementation Plan

---

## Sprint 1 — Foundation + first two tools ✓

Goal: a working MCP server, deployed locally, that can create and read files in a real GitHub repo. Every architectural decision is proven by the end of this sprint.

- [x] Wrangler project init (TypeScript, no frameworks)
- [x] MCP Streamable HTTP transport
  - POST handler for JSON-RPC
  - `initialize` response (server name, version, capabilities)
  - `tools/list` response (static tool manifest)
  - `tools/call` dispatch
- [x] GitHub API client module
  - Authenticated fetch wrapper (PAT from Worker secret)
  - `getFile(path)` → content + SHA
  - `writeFile(path, content, sha?)` → commit (create if no SHA, update if SHA provided)
- [x] `read_file` tool
- [x] `create_file` tool (error if file already exists)
- [x] Local smoke test via `wrangler dev` + Claude Code or curl

---

## Sprint 2 — Remaining tools ✓

Goal: feature-complete server (minus protection). All tools implemented and locally tested.

- [x] GitHub API client additions
  - `deleteFile(path, sha)`
  - `getTree()` → flat list of all file paths (returns `[]` on 404 for empty repos)
- [x] `list_files` tool (glob filtering via micromatch)
- [x] `delete_file` tool
- [x] `append_file` tool (getFile → append → writeFile)
- [x] `edit_file` tool (getFile → string replace → writeFile, with match validation)
- [x] `search_files` tool (getTree → fetch each file → regex match with context lines)
- [x] Error message polish across all tools

---

## Sprint 3 — Protection system + deployment ✓

Goal: production-ready, deployed, connected to Claude.

- [x] GitHub API client additions
  - `createBranch(name, fromSha)`
  - `createPR(branch, title, body)`
  - `listOpenPRs()`
- [x] `.protected` parsing (gitignore-style glob matching via micromatch)
- [x] `resolveAccess(path)` → `'direct' | 'pr' | 'system'`
- [x] Wire `resolveAccess` into all write tools
  - `'system'` → generic "invalid filename" error, no further info
  - `'pr'` → create branch, apply change, open PR, return PR URL
- [x] `list_proposals` tool
- [x] Deploy to Cloudflare (`wrangler deploy`, set secrets)
- [x] Connect to Claude Desktop / Claude Code, end-to-end test

**Post-sprint fixes:**
- Auth switched from `Authorization: Bearer` header to `?token=` query param — Claude Projects has no UI for custom headers
- UTF-8 read decoding fixed: `getFile()` now uses `TextDecoder` + `Uint8Array` instead of bare `atob()`, to match the encoding used on write

---

## Sprint 4 — Multi-tenant config

**Goal:** Single deployment serves multiple agents, each with their own auth token, GitHub PAT, and backing repo. No changes to tool behavior.

**Estimate:** ~30 LOC changed. Minimal troubleshooting — the logic is simple JSON lookup and the rest of the codebase is untouched. One pass should be enough.

### Config structure

Replace the four env vars (`GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `MCP_AUTH_TOKEN`) with a single `REPO_MAP` secret containing a JSON blob:

```json
{
  "agent-token-abc": {
    "github_token": "github_pat_...",
    "owner": "XaviACLM",
    "repo": "assistant-files",
    "branch": "main"
  },
  "agent-token-xyz": {
    "github_token": "github_pat_...",
    "owner": "XaviACLM",
    "repo": "other-repo",
    "branch": "main"
  }
}
```

- The key is the agent's auth token (passed as `?token=`)
- Each entry has its own fine-grained GitHub PAT scoped to that specific repo
- `branch` is optional — defaults to `"main"` if absent
- Adding a new repo = updating one secret, no redeployment

For local dev, `.dev.vars`:
```
REPO_MAP={"agent-token-abc":{"github_token":"github_pat_...","owner":"XaviACLM","repo":"assistant-files"}}
```

### Code changes

**`src/index.ts`**
- Update `Env` interface: remove individual vars, add `REPO_MAP: string`
- On each request: parse `REPO_MAP`, extract `?token=` from URL, look up entry
- If token not found → 401 immediately
- If found → construct `GitHubClient` with entry's `github_token`, `owner`, `repo`, `branch ?? "main"`
- Call `handleMcp(req, gh)` with no auth argument

**`src/mcp.ts`**
- Remove `authToken` parameter from `handleMcp` signature
- Remove auth check block (now handled in `index.ts`)

**`wrangler.toml`**
- Remove `GITHUB_BRANCH = "main"` from `[vars]`

**`.dev.vars.example`**
- Update to show `REPO_MAP` format

### Migration steps

1. Update code
2. Locally: rewrite `.dev.vars` to use `REPO_MAP`
3. Deploy: `wrangler deploy`, then `wrangler secret put REPO_MAP`
4. Delete old secrets: `wrangler secret delete GITHUB_TOKEN` etc.
5. Update MCP client config URL if token value changes

### What doesn't change

Tools, protection system, MCP protocol handling, auth mechanism (`?token=`), agent isolation — all untouched.

---

## Sprint 5 — OAuth 2.1 (Authorization Code + PKCE)

**Goal:** Replace `?token=` query param auth with standard OAuth 2.1 so the worker integrates cleanly with Claude Projects' OAuth fields and any other spec-compliant MCP client.

**Estimate:** ~200 LOC new code, ~20 LOC modified. Moderate troubleshooting — the JWT/crypto code itself is straightforward, but the Claude Projects integration is an unknown: we don't know exactly what discovery endpoints it requires or how it handles the browser redirect during setup. Expect 2–4 debugging rounds against a live deployment.

### How statelessness is preserved

No KV or Durable Objects needed. All tokens are signed JWTs (HMAC-SHA256, WebCrypto). Each token carries its own state; the worker only needs to verify signatures.

- **Auth code** (issued at `/authorize`): short-lived JWT (~5 min) containing `{client_id, redirect_uri, code_challenge, code_challenge_method}`
- **Access token** (issued at `/token`): JWT (~1 hr) containing `{client_id}`
- **Refresh token**: JWT (~30 days) containing `{client_id}`

Token revocation requires rotating `JWT_SECRET`, which invalidates all sessions. Acceptable for a personal tool.

### New env vars

- `JWT_SECRET` — signing key for all JWTs (random string, keep long)
- `OAUTH_AUTO_APPROVE` — if `"true"`, `/authorize` silently redirects without showing a UI (personal use); if false or absent, shows a minimal HTML approval page (standard flow)

`REPO_MAP` keys shift role: the key is now the OAuth `client_id`, and the value gains no new fields (the GitHub PAT + repo config stays the same).

### New endpoints

**`GET /.well-known/oauth-protected-resource`**
Discovery metadata pointing to the authorization server (ourselves). Required by MCP spec for clients to find the auth server.

**`GET /.well-known/oauth-authorization-server`**
Authorization server metadata (RFC 8414): lists `/authorize`, `/token` endpoints and supported grant types.

**`GET /authorize`**
- Validate `client_id` (must exist in `REPO_MAP`), `redirect_uri`, `code_challenge`, `code_challenge_method=S256`
- If `OAUTH_AUTO_APPROVE=true`: immediately issue auth code JWT and redirect
- Otherwise: serve minimal HTML approval page with a confirm button (POST back to `/authorize`)

**`POST /authorize`** (only when not auto-approving)
- Accept form submission, issue auth code JWT, redirect to `redirect_uri?code=<jwt>`

**`POST /token`**
- `grant_type=authorization_code`: verify auth code JWT signature + expiry, verify PKCE (`SHA256(code_verifier) == code_challenge`), issue access + refresh tokens
- `grant_type=refresh_token`: verify refresh JWT, issue new access token

### Changes to existing code

**`src/index.ts`**
- Route new endpoints before MCP handler
- MCP handler: extract `Authorization: Bearer <token>` instead of `?token=`, verify JWT, extract `client_id`, look up repo config

**`src/mcp.ts`**
- No auth changes (auth is in `index.ts`); `handleMcp` continues to receive a ready `GitHubClient`

### What doesn't change

Tools, protection system, MCP protocol handling, `REPO_MAP` structure — all untouched.

### Unknowns to resolve during implementation

- Which discovery endpoints Claude Projects actually fetches (`.well-known` may or may not be required)
- Whether Claude Projects handles the browser redirect during initial setup smoothly
- Whether Claude Projects sends `client_secret` to the token endpoint (our REPO_MAP keys serve as client IDs; we may need a separate client secret field, or treat the PAT token as the secret — TBD)
