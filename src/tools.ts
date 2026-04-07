import micromatch from "micromatch";
import { GitHubClient } from "./github";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

// --- .agent_config system ---

interface AgentConfig {
  hidden: string[];
  protected: string[];
}

function parseAgentConfig(content: string): Record<string, Record<string, string[]>> {
  const result: Record<string, Record<string, string[]>> = {};
  let currentAgent: string | null = null;
  let currentSub: string | null = null;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const m = line.match(/^\[([^\s\]"]+)(?:\s+"([^"]+)")?\]$/);
    if (m) {
      currentAgent = m[1];
      currentSub = m[2] ?? null;
      if (!result[currentAgent]) result[currentAgent] = {};
      if (currentSub && !result[currentAgent][currentSub]) {
        result[currentAgent][currentSub] = [];
      }
      continue;
    }

    if (currentAgent && currentSub) {
      if (!result[currentAgent][currentSub]) result[currentAgent][currentSub] = [];
      result[currentAgent][currentSub].push(line);
    }
  }

  return result;
}

async function getAgentConfig(gh: GitHubClient, agentId: string): Promise<AgentConfig> {
  let content: string;
  try {
    ({ content } = await gh.getFile(".agent_config"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) throw new Error("No .agent_config file found in repo");
    throw e;
  }

  const sections = parseAgentConfig(content);
  const def = sections["default"] ?? {};
  const agent = sections[agentId];

  if (!agent) throw new Error(`Agent "${agentId}" not found in .agent_config`);

  return {
    hidden: [...(def["hidden"] ?? []), ...(agent["hidden"] ?? [])],
    protected: [...(def["protected"] ?? []), ...(agent["protected"] ?? [])],
  };
}

function isSystemPath(path: string): boolean {
  return path === ".agent_config";
}

function isHidden(path: string, config: AgentConfig): boolean {
  return config.hidden.length > 0 && micromatch([path], config.hidden).length > 0;
}

type Access = "direct" | "pr" | "system";

function resolveAccess(path: string, config: AgentConfig): Access {
  if (isSystemPath(path)) return "system";
  if (config.protected.length > 0 && micromatch([path], config.protected).length > 0) return "pr";
  return "direct";
}

// --- Proposals ---

async function createProposal(
  gh: GitHubClient,
  agentId: string,
  path: string,
  commitMessage: string,
  applyChange: (branch: string) => Promise<void>
): Promise<ToolResult> {
  const sanitized = path.replace(/[^a-zA-Z0-9-]/g, "-");
  const branchName = `proposal/${agentId}/${Date.now()}-${sanitized}`;
  try {
    const headSha = await gh.getBranchSha();
    await gh.createBranch(branchName, headSha);
    await applyChange(branchName);
    const prUrl = await gh.createPR(
      branchName,
      commitMessage,
      `Proposed change to \`${path}\` by agent \`${agentId}\` — pending review.`
    );
    return ok(`File is protected. Proposed change submitted for review: ${prUrl}`);
  } catch (e: unknown) {
    return err(`Failed to create proposal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- read_file ---

export async function readFile(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const path = args.path;
  if (typeof path !== "string" || path === "") return err("path is required");

  let config: AgentConfig;
  try {
    config = await getAgentConfig(gh, agentId);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (isSystemPath(path) || isHidden(path, config)) return err(`File not found: ${path}`);

  let file;
  try {
    file = await gh.getFile(path);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}`);
    return err(`Failed to read file: ${msg}`);
  }

  const lines = file.content.split("\n");
  const offset = typeof args.offset === "number" ? args.offset : 1;
  const limit = typeof args.limit === "number" ? args.limit : lines.length;

  if (offset < 1 || offset > lines.length) {
    return err(`offset ${offset} is out of range (file has ${lines.length} lines)`);
  }

  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const numbered = typeof args.offset === "number" || typeof args.limit === "number";
  const text = numbered
    ? slice.map((l, i) => `${offset + i}\t${l}`).join("\n")
    : slice.join("\n");

  return ok(text);
}

// --- list_files ---

export async function listFiles(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern : undefined;

  let entries;
  let config: AgentConfig;
  try {
    [entries, config] = await Promise.all([gh.getTree(), getAgentConfig(gh, agentId)]);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  let paths = entries
    .map((e) => e.path)
    .filter((p) => !isSystemPath(p) && !isHidden(p, config));

  if (pattern !== undefined) paths = micromatch(paths, pattern);
  if (paths.length === 0) return ok("(no files)");

  const lines = paths.map((p) => {
    const isProtected = resolveAccess(p, config) === "pr";
    return isProtected ? `${p} [protected]` : p;
  });

  return ok(lines.join("\n"));
}

// --- create_file ---

export async function createFile(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof content !== "string") return err("content is required");

  let config: AgentConfig;
  try {
    config = await getAgentConfig(gh, agentId);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (isSystemPath(path) || isHidden(path, config)) return err("invalid filename");

  const access = resolveAccess(path, config);

  try {
    await gh.getFile(path);
    return err(`File already exists: ${path}. Delete it first if you intend to replace it.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("404")) return err(`Failed to check file existence: ${msg}`);
  }

  if (access === "pr") {
    return createProposal(gh, agentId, path, `create ${path}`, (branch) =>
      gh.writeFile(path, content, undefined, `create ${path}`, branch)
    );
  }

  try {
    await gh.writeFile(path, content, undefined, `create ${path}`);
  } catch (e: unknown) {
    return err(`Failed to create file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Created ${path}`);
}

// --- delete_file ---

export async function deleteFile(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const path = args.path;
  if (typeof path !== "string" || path === "") return err("path is required");

  let config: AgentConfig;
  try {
    config = await getAgentConfig(gh, agentId);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (isSystemPath(path) || isHidden(path, config)) return err(`File not found: ${path}`);

  const access = resolveAccess(path, config);

  let sha: string;
  try {
    ({ sha } = await gh.getFile(path));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}`);
    return err(`Failed to read file: ${msg}`);
  }

  if (access === "pr") {
    return createProposal(gh, agentId, path, `delete ${path}`, (branch) =>
      gh.deleteFile(path, sha, `delete ${path}`, branch)
    );
  }

  try {
    await gh.deleteFile(path, sha, `delete ${path}`);
  } catch (e: unknown) {
    return err(`Failed to delete file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Deleted ${path}`);
}

// --- append_file ---

export async function appendFile(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof content !== "string") return err("content is required");

  let config: AgentConfig;
  try {
    config = await getAgentConfig(gh, agentId);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (isSystemPath(path) || isHidden(path, config)) return err(`File not found: ${path}`);

  const access = resolveAccess(path, config);

  let existing: string;
  let sha: string;
  try {
    ({ content: existing, sha } = await gh.getFile(path));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}. Use create_file for new files.`);
    return err(`Failed to read file: ${msg}`);
  }

  const appended = existing + content;

  if (access === "pr") {
    return createProposal(gh, agentId, path, `append to ${path}`, (branch) =>
      gh.writeFile(path, appended, sha, `append to ${path}`, branch)
    );
  }

  try {
    await gh.writeFile(path, appended, sha, `append to ${path}`);
  } catch (e: unknown) {
    return err(`Failed to append to file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Appended to ${path}`);
}

// --- edit_file ---

export async function editFile(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const path = args.path;
  const oldString = args.old_string;
  const newString = args.new_string;
  const replaceAll = args.replace_all === true;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof oldString !== "string") return err("old_string is required");
  if (typeof newString !== "string") return err("new_string is required");

  let config: AgentConfig;
  try {
    config = await getAgentConfig(gh, agentId);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  if (isSystemPath(path) || isHidden(path, config)) return err(`File not found: ${path}`);

  const access = resolveAccess(path, config);

  let content: string;
  let sha: string;
  try {
    ({ content, sha } = await gh.getFile(path));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}`);
    return err(`Failed to read file: ${msg}`);
  }

  const count = content.split(oldString).length - 1;
  if (count === 0) return err(`String not found in ${path}`);
  if (count > 1 && !replaceAll) {
    return err(
      `String matched ${count} times in ${path} - provide more context to make the match unique, or pass replace_all:true to replace all occurrences`
    );
  }

  const updated = content.split(oldString).join(newString);

  if (access === "pr") {
    return createProposal(gh, agentId, path, `edit ${path}`, (branch) =>
      gh.writeFile(path, updated, sha, `edit ${path}`, branch)
    );
  }

  try {
    await gh.writeFile(path, updated, sha, `edit ${path}`);
  } catch (e: unknown) {
    return err(`Failed to write file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Edited ${path}`);
}

// --- search_files ---

export async function searchFiles(
  gh: GitHubClient,
  args: Record<string, unknown>,
  agentId: string
): Promise<ToolResult> {
  const pattern = args.pattern;
  const glob = typeof args.glob === "string" ? args.glob : undefined;
  const caseInsensitive = args.case_insensitive === true;
  const context = typeof args.context === "number" ? Math.max(0, Math.floor(args.context)) : 0;
  if (typeof pattern !== "string" || pattern === "") return err("pattern is required");

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? "i" : "");
  } catch {
    return err(`Invalid regex pattern: ${pattern}`);
  }

  let entries;
  let config: AgentConfig;
  try {
    [entries, config] = await Promise.all([gh.getTree(), getAgentConfig(gh, agentId)]);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e));
  }

  let paths = entries
    .map((e) => e.path)
    .filter((p) => !isSystemPath(p) && !isHidden(p, config));

  if (glob !== undefined) paths = micromatch(paths, glob);

  const fileResults = await Promise.all(
    paths.map(async (p) => {
      try {
        const { content } = await gh.getFile(p);
        return { path: p, content };
      } catch {
        return null;
      }
    })
  );

  const output: string[] = [];

  for (const file of fileResults) {
    if (file === null) continue;
    const lines = file.content.split("\n");
    const matchingLines: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) matchingLines.push(i);
    }

    if (matchingLines.length === 0) continue;

    output.push(file.path);

    const shown = new Set<number>();
    for (const idx of matchingLines) {
      for (let i = Math.max(0, idx - context); i <= Math.min(lines.length - 1, idx + context); i++) {
        shown.add(i);
      }
    }

    const sortedLines = Array.from(shown).sort((a, b) => a - b);
    let prev = -2;
    for (const i of sortedLines) {
      if (i > prev + 1 && prev !== -2) output.push("  ...");
      const marker = matchingLines.includes(i) ? ">" : " ";
      output.push(`  ${marker} ${i + 1}\t${lines[i]}`);
      prev = i;
    }

    output.push("");
  }

  if (output.length === 0) return ok("No matches found");
  return ok(output.join("\n").trimEnd());
}

// --- list_proposals ---

export async function listProposals(gh: GitHubClient, agentId: string): Promise<ToolResult> {
  let prs;
  try {
    prs = await gh.listOpenPRs();
  } catch (e: unknown) {
    return err(`Failed to list proposals: ${e instanceof Error ? e.message : String(e)}`);
  }

  const prefix = `proposal/${agentId}/`;
  const filtered = prs.filter((pr) => pr.head.ref.startsWith(prefix));

  if (filtered.length === 0) return ok("No pending proposals");

  const lines = filtered.map(
    (pr) => `#${pr.number} ${pr.title}\n  ${pr.html_url}\n  opened: ${pr.created_at}`
  );
  return ok(lines.join("\n\n"));
}
