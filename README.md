# mcp-filestore

An MCP server that exposes a private GitHub repository as an editable filesystem of text files — deployable as a stateless Cloudflare Worker, free tier compatible.

All the code here was written by Claude in a couple hours.

## Philosophy

The goal is to give an LLM the same kind of filesystem interaction that Claude Code has when running locally — reading, searching, and surgically editing files without transmitting entire contents on every operation — but over MCP, so you can use it with Claude Projects or any other MCP-capable client. The tool interface is modeled directly on Claude Code's own filesystem tools, with two intentional differences: destructive overwrite is replaced by explicit `create_file`/`delete_file`, and files matching patterns in a `.protected` config can only be changed via GitHub pull request, requiring human review before the change lands.

See [SPEC.md](SPEC.md) for full details on tools and design decisions.

## Setup

**1. Create a private GitHub repo** for your files. Initialize it with at least one empty commit (`git commit --allow-empty -m "init"`).

**2. Create a fine-grained Personal Access Token** (GitHub → Settings → Developer settings → Fine-grained tokens) scoped to that repo with:
- Contents: Read and write
- Pull requests: Read and write
- Metadata: Read-only (auto-included)

**3. Clone this repo and configure secrets:**

```
cp .dev.vars.example .dev.vars   # or just create .dev.vars manually
```

Fill in `.dev.vars`:
```
GITHUB_TOKEN=your_pat_here
GITHUB_OWNER=your_github_username
GITHUB_REPO=your_repo_name
MCP_AUTH_TOKEN=your_auth_token
```

Pick any long random string for `MCP_AUTH_TOKEN`. The worker will return 401 to any request that doesn't include `Authorization: Bearer <your-token>`.

**4. Install and run locally:**
```
npm install
wrangler dev
```

**5. Deploy to Cloudflare Workers (free tier):**
```
wrangler deploy
wrangler secret put GITHUB_TOKEN
wrangler secret put GITHUB_OWNER
wrangler secret put GITHUB_REPO
wrangler secret put MCP_AUTH_TOKEN
```

**6. Point your MCP client** at the deployed worker URL. The transport is Streamable HTTP (MCP spec 2025-03-26) — stateless, no session management required. Configure your client to send the header:
```
Authorization: Bearer <your-token>
```
In Claude Projects, this is set under the MCP server's custom headers field.

**7. Optionally create a `.protected` file** in your GitHub repo to mark files as read-only for the LLM. Uses gitignore-style glob patterns with negation support:
```
**
!general_tasks
!notes/**
```
This protects everything except `general_tasks` and anything under `notes/`. Protected file write attempts are redirected to a GitHub pull request for your review.
