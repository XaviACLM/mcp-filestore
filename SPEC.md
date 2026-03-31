# mcp-stash — Project Specification

## Overview

An MCP server deployed as a Cloudflare Worker that exposes a GitHub repository as an editable filesystem of text files. The intent is to give an LLM roughly the same ability to interact with a directory of text files that Claude Code has when running locally — reading, searching, and surgically editing files without needing to transmit entire file contents on every operation.

This is not a "notes app". It is a remote text-file filesystem interface backed by GitHub. Files may be `.md`, `.txt`, `.py`, or any other plaintext format.

### Differences from Claude Code's native filesystem tools

- No `write` (destructive overwrite). File creation and deletion are explicit separate operations.
- Protected files: write operations on protected files are not applied directly. Instead, a GitHub pull request is opened with the proposed change, pending human review.
- `list_files` returns protection status for each file.

---

## Architecture

```
MCP Client (Claude Desktop / Claude Code)
        |
        | Streamable HTTP (MCP 2025-03-26 transport)
        v
Cloudflare Worker  (stateless)
        |
        | GitHub REST API (Contents API + Git Data API)
        v
Private GitHub Repository
```

**Transport**: Streamable HTTP, stateless. No session IDs. No Durable Objects. No KV store. The Worker is a pure function: receive MCP request → call GitHub API → return MCP response.

**Auth**: GitHub Personal Access Token (or bot account PAT) stored as a Cloudflare Worker secret (`GITHUB_TOKEN`). Also secrets for `GITHUB_OWNER` and `GITHUB_REPO`.

**Bot account**: Optionally use a dedicated GitHub account for the PAT to keep LLM-generated commits visually separated from human commits. Not required.

---

## Repository Structure

No enforced directory layout. The repo is a flat or shallow tree of text files. Subdirectories are allowed and natural. The only reserved filename is `.protected` at the repo root.

Directories are implicit — the GitHub Contents API creates intermediate directories automatically when a file is written at a nested path. There is no `create_directory` tool and no need for `.gitkeep` files.

---

## Protection System

A file `.protected` at the repo root contains gitignore-style glob patterns. Any file whose path matches a pattern in `.protected` is considered **protected**.

- For protected files, all write operations (`create_file`, `delete_file`, `append_file`, `edit_file`) are intercepted. Instead of applying the change directly, the Worker creates a new branch and opens a GitHub pull request with the proposed change. The tool response informs the LLM that the change is pending review and includes the PR URL.
- Read operations (`read_file`, `search_files`, `list_files`) on protected files proceed normally.
- `list_files` includes a `protected: true/false` field per file so the LLM knows in advance which files require review.

### `.protected` is a system file — invisible to the LLM

`.protected` does not exist as far as the LLM is concerned. It is excluded from `list_files` results, cannot be read via `read_file`, will not appear in `search_files` results, and cannot be deleted. If the LLM attempts to call `create_file` with the path `.protected`, the Worker returns a generic "invalid filename" error with no indication of why. The LLM has no way to discover that this file exists or what it contains.

This is analogous to reserved filenames in some operating systems: the restriction is enforced silently at the system boundary.

### `.protected` format

Standard gitignore glob syntax. Example:
```
# Config and index files
index.md
config/*.md

# Everything in the archive directory
archive/**
```

---

## Tools

### `list_files`

List files in the repository.

```
list_files(pattern?: string) -> FileEntry[]
```

- `pattern`: Optional glob filter (e.g. `**/*.md`, `journal/2025-*`). If omitted, lists all files.
- Returns an array of `{ path: string, protected: boolean }`.
- `.protected` is never included in results.

---

### `read_file`

Read the content of a file.

```
read_file(path: string, offset?: number, limit?: number) -> string
```

- `path`: Repo-relative file path.
- `offset`: First line to return (1-indexed). Default: 1.
- `limit`: Number of lines to return. Default: entire file.
- Returns the file content as a string (with line numbers if offset/limit are used, to support follow-up `edit_file` calls).
- Error if file does not exist.

---

### `create_file`

Create a new file. Errors if the file already exists.

```
create_file(path: string, content: string) -> void
```

- `path`: Repo-relative path including filename and extension.
- `content`: Full file content.
- Error if a file already exists at `path`. (Use `delete_file` first if intentional overwrite is desired.)
- If `path` matches a protected pattern, opens a PR instead of committing directly.

---

### `delete_file`

Delete a file.

```
delete_file(path: string) -> void
```

- Fetches the current file SHA (required by GitHub API), then deletes.
- If the file is protected, opens a PR proposing the deletion.
- Error if file does not exist.

---

### `append_file`

Append text to the end of an existing file.

```
append_file(path: string, content: string) -> void
```

- Fetches current content + SHA, appends `content`, writes back.
- If the file is protected, opens a PR with the appended version.
- Error if file does not exist. (Use `create_file` for new files.)

---

### `edit_file`

Surgically replace a substring within a file. The primary editing tool.

```
edit_file(
  path: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean
) -> void
```

- Fetches current content + SHA.
- Searches for `old_string` in the content.
- Error if `old_string` is not found.
- Error if `old_string` appears more than once and `replace_all` is false.
- If `replace_all` is true, replaces all occurrences.
- Writes the result back.
- If the file is protected, opens a PR with the edited version instead of committing directly.
- The requirement to supply `old_string` is intentional: it acts as verification that the caller knows the current state of the relevant section.

---

### `search_files`

Search file contents across the repository using a regex pattern.

```
search_files(
  pattern: string,
  glob?: string,
  case_insensitive?: boolean,
  context?: number
) -> SearchResult[]
```

- `pattern`: Regular expression to search for.
- `glob`: Optional file filter (e.g. `*.md`). If omitted, searches all files.
- `case_insensitive`: Default false.
- `context`: Number of lines to include before and after each match. Default 0.
- Returns an array of `{ path: string, line: number, content: string }` (with surrounding context lines if requested).

---

### `list_proposals` *(optional / nice-to-have)*

List open pull requests representing pending proposed edits to protected files.

```
list_proposals() -> Proposal[]
```

- Returns `{ pr_number: number, title: string, url: string, created_at: string }[]`.
- Useful if the LLM needs to reference or reason about pending changes.
- Not essential for core functionality; include if implementation is not burdensome.

---

## Commit Behavior

Every write operation that applies directly (non-protected files) produces one GitHub commit via the Contents API. There is no batching — the Worker is stateless and cannot accumulate changes.

At realistic usage volumes (~50 write operations/day) this is not a technical problem. Git and GitHub handle repositories with hundreds of thousands of commits. The history will be noisy but functional. Since the repo is private and the filesystem state (not the history) is what matters, this is acceptable.

**Automatic history squashing is explicitly out of scope for v1.** Rewriting git history via the GitHub API requires reconstructing every commit in the chain after the squash point, which is complex and has meaningful failure modes. If commit count eventually becomes a concern, a one-time manual squash (replacing full history with a single snapshot commit) is the recommended approach.

---

## Implementation Notes

- **No MCP SDK dependency in the Worker.** Implement the Streamable HTTP transport directly. The protocol surface for a tools-only server is small: `initialize`, `tools/list`, `tools/call`. This avoids Node.js compatibility friction in the Workers runtime and keeps the bundle minimal.
- **Auth via query parameter.** The worker accepts an optional `MCP_AUTH_TOKEN` secret. When set, requests must include `?token=<value>` in the URL or receive a 401. This is intentionally simpler than OAuth — Claude Projects and similar hosted clients don't support arbitrary request headers, and their OAuth fields expect a full authorization server. For a personal single-user deployment, a shared secret in the URL is a reasonable tradeoff. The token appears in Cloudflare access logs but not in any client-visible surface.
- **Every GitHub write is a read-then-write.** The GitHub Contents API requires the current file SHA to update or delete a file. There is no way around this; each mutating operation makes at least two API calls.
- **Protected file PR flow**: create branch from current main SHA → apply change to file on branch → open PR. Branch naming: `proposal/{timestamp}-{sanitized-path}`.
- **Glob filtering** for `list_files` and `search_files` is implemented by fetching the full file tree from GitHub (Git Trees API, one call) and filtering the result in-process using `micromatch` or `picomatch` — both are pure JS with no Node.js dependencies and bundle cleanly with wrangler.
- **`resolveAccess(path)`** is the single internal function responsible for all path-level access decisions. It returns `'direct'`, `'pr'`, or `'system'`. Tool implementations never check protection themselves; the dispatch layer calls `resolveAccess` once and routes accordingly. `'system'` paths (`.protected`) are never surfaced to the LLM — they are silently excluded from read results and produce a generic "invalid filename" error on write attempts.
- **Text files only.** Binary files are out of scope. No enforcement needed — `edit_file` and `search_files` simply won't work correctly on binary content, and there's no intended use case for them.
- **Error messages should be explicit.** Especially for `edit_file`: "string not found", "string matched N times — use replace_all or provide more context to make match unique", etc.

---

## Out of Scope (v1)

- Execution of any file contents
- Directory creation (implicit via file paths)
- File move / rename
- Viewing or merging pull requests (done via GitHub UI)
- Automatic commit history squashing
- Multi-user access or auth beyond a single shared PAT
