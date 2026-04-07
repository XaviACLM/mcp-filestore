# mcp-filestore — Project Specification

## Overview

An MCP server deployed as a Cloudflare Worker that exposes GitHub repositories as editable filesystems of text files. The intent is to give an LLM roughly the same ability to interact with a directory of text files that Claude Code has when running locally — reading, searching, and surgically editing files without needing to transmit entire file contents on every operation.

A single worker deployment can serve multiple repos and multiple agents. Each agent authenticates with a secret token, is associated with a named identity (`agent_id`), and has access to exactly one repo. Within that repo, a per-repo config file (`.agent_config`) controls what each agent can see and modify.

This is not a "notes app". It is a remote text-file filesystem interface backed by GitHub. Files may be `.md`, `.txt`, `.py`, or any other plaintext format.

### Differences from Claude Code's native filesystem tools

- No `write` (destructive overwrite). File creation and deletion are explicit separate operations.
- Protected files: write operations on protected files are not applied directly. Instead, a GitHub pull request is opened with the proposed change, pending human review.
- Hidden files: files marked hidden for a given agent are fully invisible — excluded from listings, unsearchable, and return "file not found" on read.
- `list_files` returns protection status for each file.

---

## Architecture

```
MCP Client (Claude Desktop / Claude Code / Claude Projects)
        |
        | Streamable HTTP (MCP 2025-03-26 transport)
        v
Cloudflare Worker  (stateless)
        |
        | GitHub REST API (Contents API + Git Data API)
        v
Private GitHub Repository/ies
```

**Transport**: Streamable HTTP, stateless. No session IDs. No Durable Objects. No KV store.

**Auth**: Secret token passed as `?token=<value>` query parameter. The worker maps tokens to repo credentials and agent identities via the `REPO_CONFIG` secret.

**Config**: A single Cloudflare Worker secret (`REPO_CONFIG`) contains all repo credentials and agent token mappings. See the Configuration section below.

---

## Configuration

All configuration lives in a single Cloudflare Worker secret: `REPO_CONFIG`. It is a JSON object mapping repo aliases to repo configs:

```json
{
  "my-repo": {
    "github_token": "github_pat_...",
    "owner": "github-username",
    "repo": "github-repo-name",
    "branch": "main",
    "agents": {
      "secret-token-alice": "alice",
      "secret-token-bob": "bob"
    }
  },
  "another-repo": {
    "github_token": "github_pat_...",
    "owner": "github-username",
    "repo": "another-repo-name",
    "agents": {
      "secret-token-carol": "carol"
    }
  }
}
```

- `repos` keys are user-defined aliases (need not match the GitHub repo name).
- Each repo entry holds a fine-grained GitHub PAT scoped to that repo, its owner/name, an optional branch (defaults to `"main"`), and an `agents` map.
- `agents` maps secret tokens to `agent_id` strings. The token is what the MCP client includes in the URL; the `agent_id` is the stable identity used within the repo's `.agent_config`.
- The `agent_id` `"default"` is reserved and will be rejected.
- If the same token appears in multiple repos, the worker returns a 500 error for that token (ambiguous config).
- Adding a new agent or repo requires updating `REPO_CONFIG` in `.dev.vars` and running `node scripts/push-secrets.js` to push to Cloudflare. No redeployment needed.

---

## Repository Structure

No enforced directory layout. The repo is a flat or shallow tree of text files. Subdirectories are allowed and natural. The only reserved filename is `.agent_config` at the repo root.

Directories are implicit — the GitHub Contents API creates intermediate directories automatically when a file is written at a nested path.

---

## Agent Permission System

A file `.agent_config` at the repo root defines per-agent visibility and write permissions. It uses git-config-style syntax with sections of the form `[agent_id "subsection"]`.

### Subsections

- `hidden`: files matching these gitignore-style glob patterns are fully invisible to the agent. They are excluded from `list_files` and `search_files`, return "file not found" on `read_file`, and return "invalid filename" on write attempts.
- `protected`: files matching these patterns are write-protected. Reads proceed normally. Write operations (create, delete, append, edit) are intercepted and redirected to a GitHub pull request for human review instead of committing directly.

### `[default "..."]` section

Patterns in `[default "hidden"]` and `[default "protected"]` are prepended to every agent's effective pattern list. This allows shared baseline rules without repeating them per agent.

### Pattern semantics

Standard gitignore glob syntax with negation support. For each agent and each subsection, the effective pattern list is the `[default]` patterns followed by the agent's own patterns, processed in order. Negation (`!`) overrides earlier matches, enabling whitelist-style configs:

```gitconfig
[default "hidden"]
**
!general_instructions.txt

[default "protected"]
general_instructions.txt

[alice "hidden"]
!alice/**

[alice "protected"]
!alice/**

[bob "hidden"]
!bob/**

[bob "protected"]
!bob/**
```

In this example, alice sees only `alice/**` and `general_instructions.txt`. She can write freely to `alice/**` but `general_instructions.txt` is write-protected (any edit goes to a PR).

### `.agent_config` is a system file — invisible to all agents

`.agent_config` does not exist as far as any agent is concerned. It is excluded from all tool results, cannot be read via `read_file`, will not appear in `search_files`, and write attempts return a generic "invalid filename" error. The agent has no way to discover that this file exists or what it contains.

### `agent_id` must have a section in `.agent_config`

If an agent's `agent_id` (from `REPO_CONFIG`) has no matching section in `.agent_config`, every tool call returns a clear error. This is isolated to that agent — other agents in the same repo are unaffected.

---

## Tools

### `list_files`

List files in the repository visible to the agent.

```
list_files(pattern?: string) -> FileEntry[]
```

- `pattern`: Optional glob filter. If omitted, lists all visible files.
- Returns an array of `{ path: string, protected: boolean }`.
- Hidden files and `.agent_config` are never included in results.

---

### `read_file`

Read the content of a file.

```
read_file(path: string, offset?: number, limit?: number) -> string
```

- `path`: Repo-relative file path.
- `offset`: First line to return (1-indexed). Default: 1.
- `limit`: Number of lines to return. Default: entire file.
- Returns the file content as a string (with line numbers if offset/limit are used).
- Error if file does not exist or is hidden.

---

### `create_file`

Create a new file. Errors if the file already exists.

```
create_file(path: string, content: string) -> void
```

- Error if a file already exists at `path`.
- Error if `path` is hidden or a system file.
- If `path` matches a protected pattern, opens a PR instead of committing directly.

---

### `delete_file`

Delete a file.

```
delete_file(path: string) -> void
```

- Fetches the current file SHA, then deletes.
- Error if file does not exist or is hidden.
- If the file is protected, opens a PR proposing the deletion.

---

### `append_file`

Append text to the end of an existing file.

```
append_file(path: string, content: string) -> void
```

- Fetches current content + SHA, appends `content`, writes back.
- Error if file does not exist or is hidden.
- If the file is protected, opens a PR with the appended version.

---

### `edit_file`

Surgically replace a substring within a file.

```
edit_file(
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean
) -> void
```

- Fetches current content + SHA.
- Error if `old_string` is not found.
- Error if `old_string` appears more than once and `replace_all` is false.
- Error if file is hidden.
- If the file is protected, opens a PR with the edited version.

---

### `search_files`

Search file contents across visible files using a regex pattern.

```
search_files(
  pattern: string,
  glob?: string,
  case_insensitive?: boolean,
  context?: number
) -> SearchResult[]
```

- `pattern`: Regular expression to search for.
- `glob`: Optional file filter. If omitted, searches all visible files.
- `case_insensitive`: Default false.
- `context`: Lines of context around each match. Default 0.
- Hidden files and `.agent_config` are never searched.

---

### `list_proposals`

List open pull requests representing pending proposed edits to protected files, scoped to the current agent.

```
list_proposals() -> Proposal[]
```

- Returns `{ pr_number, title, url, created_at }[]`.
- Only shows proposals created by the current agent (branch prefix `proposal/{agent_id}/`).

---

## Commit Behavior

Every write that applies directly (non-protected files) produces one GitHub commit via the Contents API. No batching — the Worker is stateless.

**Protected file PR flow**: create branch from current main SHA → apply change on branch → open PR. Branch naming: `proposal/{agent_id}/{timestamp}-{sanitized-path}`.

---

## Implementation Notes

- **No MCP SDK dependency.** Streamable HTTP transport implemented directly. Protocol surface: `initialize`, `tools/list`, `tools/call`.
- **Auth via query parameter.** `?token=<value>`. Token is looked up in `REPO_CONFIG` to identify the repo and agent. Simpler than OAuth for personal deployments; token appears in Cloudflare access logs.
- **Every GitHub write is a read-then-write.** The GitHub Contents API requires the current file SHA to update or delete.
- **`getAgentConfig(agentId)`** fetches and parses `.agent_config` on each tool call. Merges `[default]` patterns with `[agent_id]` patterns for `hidden` and `protected` subsections.
- **`resolveAccess(path, agentConfig)`** returns `'direct'`, `'pr'`, or `'system'`. Hidden files are checked before `resolveAccess` and short-circuit with "file not found" (reads/mutations) or "invalid filename" (create).
- **Glob filtering** uses `micromatch` — pure JS, bundles cleanly with wrangler.
- **Text files only.** Binary files out of scope.
- **Error messages are explicit.** Especially for `edit_file`: "string not found", "string matched N times — use replace_all or provide more context".

---

## Out of Scope (v1)

- Execution of any file contents
- Directory creation (implicit via file paths)
- File move / rename
- Viewing or merging pull requests (done via GitHub UI)
- Automatic commit history squashing
- OAuth authentication (planned for a future sprint)
