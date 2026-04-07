# Design Notes — Agent Permissions & Filesystem Scoping

Notes from design discussion, kept for reference if we revisit these ideas later.

---

## Where config lives: worker vs repo

Two kinds of config exist in this system:

- **Worker config (`REPO_MAP`)** — routing infrastructure. Maps agent tokens to GitHub credentials, repo, and root directory. The worker needs this before it can talk to the repo at all. Lives as a Cloudflare secret.
- **Repo config (`.protected`, potentially others)** — content policy. Describes the repo's own access rules. Lives in the repo as system files (invisible and uneditable via the MCP interface, managed by the human via normal GitHub flow).

This split is intentional. The principle is: repos are autonomous agent workspaces, and a repo can be its own source of truth for its own access rules. `.protected` already establishes this. Extending it (e.g. `.hidden`) is consistent with the existing design. Putting routing config (which repo, which subtree) in the repo doesn't make sense because the worker needs it before it can read the repo.

---

## What's implemented

- **`.protected`** (repo, global): gitignore-style glob patterns. Matched files are write-protected — writes are redirected to a GitHub PR instead of committed directly. Reads are unrestricted. Invisible to agents.
- **`root_dir`** (worker, per-agent): optional path prefix. Agent sees the subtree at `root_dir` as their filesystem root. Paths are translated transparently before hitting the GitHub API. If absent, agent has full repo access.

---

## What was discussed but not implemented

### `.hidden` file (repo, global)

A system file (same treatment as `.protected`) with gitignore-style patterns. Files matching any pattern are excluded from `list_files` and `search_files`, and return "file not found" on `read_file`. A pure blacklist.

**Why not implemented:** not needed for current use cases. Would be straightforward to add — same pattern as `.protected`, different enforcement point (`resolveAccess` returns a new `'hidden'` value, tools treat it as nonexistent).

### Per-agent `.protected` / `.hidden` (repo, per-agent)

The idea: repo config files that contain per-agent sections, keyed by agent identifier, so different agents get different access rules.

**Why not implemented:** requires agent identity to flow all the way from the worker into the file-resolution layer. Currently tools are completely identity-blind — they only receive a `GitHubClient`. Adding per-agent repo config would mean passing an agent ID through the whole stack and teaching `resolveAccess()` about identities. Meaningful architectural change for a marginal gain given that `root_dir` already handles the main isolation use case.

**If revisited:** agent identity could be the `root_dir` path itself (i.e. the repo config keys on the root dir name, not on an opaque token). This avoids introducing a new identity concept. The worker would need to pass `root_dir` to the file-resolution layer (it currently doesn't).

### `.base_dir` in the repo (repo, per-agent)

Alternative to `root_dir` in the worker: put root directory config inside the repo itself, so the repo is fully self-contained for all access rules.

**Why not implemented:** the worker needs to know where to point requests before reading the repo. You can't read the repo to find out where to read the repo from. A bootstrapping problem. `root_dir` belongs in the worker.

### Virtual file inclusion / filesystem remapping

The use case: agent is rooted at `/agents/alice/`, but also needs read access to `/general_instructions.txt` which lives outside their root.

**Why not implemented:** introduces aliasing — the same underlying file appears at two paths. Write operations on the virtual path become ambiguous (does it write to the real location? what if the real location is protected?). The purely subtractive access controls (hide this, protect this) are much simpler to reason about. Virtual remapping crosses into additive territory.

**Practical alternative:** copy shared files into each agent's subdir during setup. Acceptable overhead for small numbers of shared files. If this becomes burdensome (many shared files, many agents, frequent updates), virtual includes become worth revisiting.

**If revisited:** a `virtual_includes` field in `REPO_MAP` listing real paths to expose at the agent's virtual root is the natural shape. Write behavior on virtual paths would need a defined policy (probably: writes to virtual includes are forbidden, they're read-only by definition).

---

## Summary: where the line was drawn

Purely subtractive, globally-scoped repo config (`.protected`, `.hidden`) + per-agent routing config in the worker (`root_dir`) is the right balance. Per-agent repo config and additive remapping are shelved — not because they're wrong in principle, but because the complexity cost exceeds the current use case benefit.
