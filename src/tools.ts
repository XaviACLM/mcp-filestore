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

// --- read_file ---

export async function readFile(
  gh: GitHubClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path;
  if (typeof path !== "string" || path === "") return err("path is required");

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

  // Include line numbers when a partial read is requested
  const numbered = (typeof args.offset === "number" || typeof args.limit === "number");
  const text = numbered
    ? slice.map((l, i) => `${offset + i}\t${l}`).join("\n")
    : slice.join("\n");

  return ok(text);
}

// --- create_file ---

export async function createFile(
  gh: GitHubClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof content !== "string") return err("content is required");

  if (path === ".protected") return err("invalid filename");

  // Check file does not already exist
  try {
    await gh.getFile(path);
    return err(`File already exists: ${path}. Delete it first if you intend to replace it.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("404")) return err(`Failed to check file existence: ${msg}`);
    // 404 = does not exist, proceed
  }

  try {
    await gh.writeFile(path, content, undefined, `create ${path}`);
  } catch (e: unknown) {
    return err(`Failed to create file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Created ${path}`);
}

// --- list_files ---

export async function listFiles(
  gh: GitHubClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const pattern = typeof args.pattern === "string" ? args.pattern : undefined;

  let entries;
  try {
    entries = await gh.getTree();
  } catch (e: unknown) {
    return err(`Failed to list files: ${e instanceof Error ? e.message : String(e)}`);
  }

  let paths = entries.map((e) => e.path).filter((p) => p !== ".protected");

  if (pattern !== undefined) {
    paths = micromatch(paths, pattern);
  }

  if (paths.length === 0) return ok("(no files)");
  return ok(paths.join("\n"));
}

// --- delete_file ---

export async function deleteFile(
  gh: GitHubClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (path === ".protected") return err("invalid filename");

  let sha: string;
  try {
    ({ sha } = await gh.getFile(path));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}`);
    return err(`Failed to read file: ${msg}`);
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
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path;
  const content = args.content;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof content !== "string") return err("content is required");
  if (path === ".protected") return err("invalid filename");

  let existing: string;
  let sha: string;
  try {
    ({ content: existing, sha } = await gh.getFile(path));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) return err(`File not found: ${path}. Use create_file for new files.`);
    return err(`Failed to read file: ${msg}`);
  }

  try {
    await gh.writeFile(path, existing + content, sha, `append to ${path}`);
  } catch (e: unknown) {
    return err(`Failed to append to file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Appended to ${path}`);
}

// --- edit_file ---

export async function editFile(
  gh: GitHubClient,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const path = args.path;
  const oldString = args.old_string;
  const newString = args.new_string;
  const replaceAll = args.replace_all === true;
  if (typeof path !== "string" || path === "") return err("path is required");
  if (typeof oldString !== "string") return err("old_string is required");
  if (typeof newString !== "string") return err("new_string is required");
  if (path === ".protected") return err("invalid filename");

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

  // When count===1, split/join replaces exactly once; when replace_all, replaces all.
  // Both cases are correct with a plain split/join since count>1 without replace_all is already rejected above.
  const result = content.split(oldString).join(newString);

  try {
    await gh.writeFile(path, result, sha, `edit ${path}`);
  } catch (e: unknown) {
    return err(`Failed to write file: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok(`Edited ${path}`);
}

// --- search_files ---

export async function searchFiles(
  gh: GitHubClient,
  args: Record<string, unknown>
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
  try {
    entries = await gh.getTree();
  } catch (e: unknown) {
    return err(`Failed to list files: ${e instanceof Error ? e.message : String(e)}`);
  }

  let paths = entries.map((e) => e.path).filter((p) => p !== ".protected");
  if (glob !== undefined) paths = micromatch(paths, glob);

  // Fetch all files in parallel
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

    // Expand with context, merging overlapping ranges
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
