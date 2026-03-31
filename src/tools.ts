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
