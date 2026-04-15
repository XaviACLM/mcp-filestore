# mcp-filestore

An MCP server that exposes private GitHub repositories as editable filesystems of text files — deployable as a stateless Cloudflare Worker, free tier compatible. Supports multiple repos and multiple agents from a single deployment.

All the code on this repo was written by Claude, following [this spec](SPEC.md).

## Philosophy

The goal is to give an LLM the same kind of filesystem interaction that Claude Code has when running locally — reading, searching, and surgically editing files without transmitting entire contents on every operation — but over MCP, so you can use it with Claude Projects or any other MCP-capable client. The tool interface is modeled directly on Claude Code's own filesystem tools, with intentional differences: destructive overwrite is replaced by explicit `create_file`/`delete_file`, and a per-repo `.agent_config` file controls what each agent can see and modify. Files marked protected can only be changed via GitHub pull request, requiring human review before the change lands. Files marked hidden are fully invisible to the agent.

See [SPEC.md](SPEC.md) for full details on tools and design decisions.

## Setup

**1. Create a private GitHub repo** for your files. Initialize it with at least one empty commit (`git commit --allow-empty -m "init"`).

**2. Create a fine-grained Personal Access Token** (GitHub → Settings → Developer settings → Fine-grained tokens) scoped to that repo with:
- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read-only (auto-included)

**3. Clone this repo and configure `.dev.vars`:**

```
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars`:

```
JWT_SECRET=a-long-random-string
OAUTH_AUTO_APPROVE=true
REPO_CONFIG={
  "my-repo": {
    "github_token": "github_pat_...",
    "owner": "your-github-username",
    "repo": "your-repo-name",
    "agents": {
      "oauth-client-id-alice": {
        "agent_id": "alice",
        "client_secret": "another-long-random-string"
      }
    }
  }
}
```

- `JWT_SECRET`: a long random string used to sign all OAuth tokens. Rotating it immediately revokes all active sessions.
- `OAUTH_AUTO_APPROVE`: if `true`, the authorization page is skipped and access is granted silently. Fine for personal use; set to `false` if you want an explicit approval step.
- `agents` maps OAuth client IDs to `{ agent_id, client_secret }`. The client ID and secret are what you enter in your MCP client's OAuth fields; the agent ID is the stable identity used in `.agent_config`.

You can serve multiple repos and multiple agents from one deployment — just add more entries.

**4. Install dependencies:**
```
npm install
```

**5. Deploy to Cloudflare Workers:**
```
wrangler deploy
node scripts/push-secrets.js
```

`push-secrets.js` reads `.dev.vars` and bulk-uploads all secrets to Cloudflare via `wrangler secret bulk`. Run it again any time you add a repo or agent — no redeployment needed.

**6. Create `.agent_config` in your GitHub repo** to define what each agent can see and modify. Uses git-config-style section syntax:

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
```

- `hidden`: files matching these gitignore-style glob patterns are fully invisible to the agent — excluded from listings, unsearchable, "file not found" on read.
- `protected`: readable normally, but write operations are redirected to a GitHub pull request for human review.
- `[default "..."]` patterns apply to every agent. Agent-specific patterns are appended, so negation (`!`) can whitelist files back out of a default rule.
- Every agent that connects must have a section in `.agent_config`. Agents with no section get an error on every tool call.
- `.agent_config` itself is a system file — invisible to all agents.

**7. Connect your MCP client.** Point it at the worker URL:
```
https://your-worker.workers.dev
```

In Claude Projects, add a new MCP connector with that URL and enter your `client_id` and `client_secret` in the OAuth fields. Claude will open an authorization window on first use — approve it and you're connected. If `OAUTH_AUTO_APPROVE=true`, the window closes automatically.

**8. Run locally** (optional, for development):
```
wrangler dev
```
