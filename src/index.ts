import { handleMcp } from "./mcp";
import { GitHubClient } from "./github";

interface RepoConfig {
  github_token: string;
  owner: string;
  repo: string;
  branch?: string;
  agents: Record<string, string>; // token -> agent_id
}

export interface Env {
  REPO_CONFIG: string; // JSON: Record<string, RepoConfig>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let config: Record<string, RepoConfig>;
    try {
      config = JSON.parse(env.REPO_CONFIG);
    } catch {
      return new Response("Server misconfiguration: invalid REPO_CONFIG", { status: 500 });
    }

    const token = new URL(request.url).searchParams.get("token");
    if (!token) return new Response("Unauthorized", { status: 401 });

    let matchedRepo: RepoConfig | null = null;
    let matchedAgentId: string | null = null;
    let ambiguous = false;

    for (const repoConfig of Object.values(config)) {
      if (token in repoConfig.agents) {
        if (matchedRepo !== null) { ambiguous = true; break; }
        matchedRepo = repoConfig;
        matchedAgentId = repoConfig.agents[token];
      }
    }

    if (ambiguous) return new Response("Server misconfiguration: token appears in multiple repos", { status: 500 });
    if (!matchedRepo || !matchedAgentId) return new Response("Unauthorized", { status: 401 });
    if (matchedAgentId === "default") return new Response("Server misconfiguration: invalid agent_id", { status: 500 });

    const gh = new GitHubClient(
      matchedRepo.github_token,
      matchedRepo.owner,
      matchedRepo.repo,
      matchedRepo.branch ?? "main"
    );
    return handleMcp(request, gh, matchedAgentId);
  },
};
