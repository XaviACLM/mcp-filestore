import { readFile, createFile, ToolResult } from "./tools";
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
        serverInfo: { name: "mcp-stash", version: "0.1.0" },
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
