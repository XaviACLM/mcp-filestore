import { handleMcp } from "./mcp";
import { GitHubClient } from "./github";

interface RepoConfig {
  github_token: string;
  owner: string;
  repo: string;
  branch?: string;
  agent_id: string;
}

export interface Env {
  REPO_MAP: string; // JSON: { [agentToken: string]: RepoConfig }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let map: Record<string, RepoConfig>;
    try {
      map = JSON.parse(env.REPO_MAP);
    } catch {
      return new Response("Server misconfiguration: invalid REPO_MAP", { status: 500 });
    }

    const token = new URL(request.url).searchParams.get("token");
    const config = token ? map[token] : undefined;
    if (!config) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!config.agent_id || config.agent_id === "default") {
      return new Response("Server misconfiguration: invalid agent_id", { status: 500 });
    }

    const gh = new GitHubClient(
      config.github_token,
      config.owner,
      config.repo,
      config.branch ?? "main"
    );
    return handleMcp(request, gh, config.agent_id);
  },
};
