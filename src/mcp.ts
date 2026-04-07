import { readFile, createFile, listFiles, deleteFile, appendFile, editFile, searchFiles, listProposals, ToolResult } from "./tools";
import { GitHubClient } from "./github";

// Tool manifest — grows each sprint
const TOOLS = [
  {
    name: "read_file",
    description:
      "Read the content of a file in the repository. Optionally specify a line range with offset and limit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
        offset: { type: "number", description: "First line to return (1-indexed, default: 1)" },
        limit: { type: "number", description: "Number of lines to return (default: entire file)" },
      },
      required: ["path"],
    },
  },
  {
    name: "create_file",
    description:
      "Create a new file. Returns an error if the file already exists - use delete_file first if you want to replace it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative path including filename and extension" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in the repository. Optionally filter by glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob filter, e.g. '**/*.md' or 'journal/2025-*'" },
      },
    },
  },
  {
    name: "delete_file",
    description: "Delete a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "append_file",
    description: "Append text to the end of an existing file. Use create_file for new files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
        content: { type: "string", description: "Text to append" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Surgically replace a string within a file. Errors if old_string is not found or matches multiple times (use replace_all to override the latter). Supplying old_string acts as verification that you know the current state of the file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path" },
        old_string: { type: "string", description: "Exact string to find and replace" },
        new_string: { type: "string", description: "Replacement string" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "search_files",
    description: "Search file contents using a regex pattern. Returns matching lines with optional context.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for" },
        glob: { type: "string", description: "Limit search to files matching this glob, e.g. '*.md'" },
        case_insensitive: { type: "boolean", description: "Case-insensitive matching (default: false)" },
        context: { type: "number", description: "Lines of context to show around each match (default: 0)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_proposals",
    description: "List open pull requests representing pending proposed edits to protected files.",
    inputSchema: { type: "object", properties: {} },
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcOk(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcErr(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export async function handleMcp(req: Request, gh: GitHubClient): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    body = await req.json() as JsonRpcRequest;
  } catch {
    return jsonResponse(rpcErr(null, -32700, "Parse error"));
  }

  const { id, method, params } = body;

  switch (method) {
    case "initialize":
      return jsonResponse(rpcOk(id, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "mcp-filestore", version: "0.1.0" },
        capabilities: { tools: {} },
      }));

    case "notifications/initialized":
      // Client notification, no response needed
      return new Response(null, { status: 204 });

    case "tools/list":
      return jsonResponse(rpcOk(id, { tools: TOOLS }));

    case "tools/call": {
      const p = params as { name: string; arguments?: Record<string, unknown> };
      const args = p.arguments ?? {};
      let result: ToolResult;

      switch (p.name) {
        case "read_file":
          result = await readFile(gh, args);
          break;
        case "create_file":
          result = await createFile(gh, args);
          break;
        case "list_files":
          result = await listFiles(gh, args);
          break;
        case "delete_file":
          result = await deleteFile(gh, args);
          break;
        case "append_file":
          result = await appendFile(gh, args);
          break;
        case "edit_file":
          result = await editFile(gh, args);
          break;
        case "search_files":
          result = await searchFiles(gh, args);
          break;
        case "list_proposals":
          result = await listProposals(gh);
          break;
        default:
          return jsonResponse(rpcErr(id, -32601, `Unknown tool: ${p.name}`));
      }

      return jsonResponse(rpcOk(id, result));
    }

    case "ping":
      return jsonResponse(rpcOk(id, {}));

    default:
      return jsonResponse(rpcErr(id, -32601, `Method not found: ${method}`));
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
