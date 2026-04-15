import { handleMcp } from "./mcp";
import { GitHubClient } from "./github";
import { handleWellKnown, handleAuthorize, handleToken, verifyAccessToken } from "./oauth";

export interface AgentEntry {
  agent_id: string;
  client_secret: string;
}

export interface RepoConfig {
  github_token: string;
  owner: string;
  repo: string;
  branch?: string;
  agents: Record<string, AgentEntry>; // client_id -> { agent_id, client_secret }
}

export interface Env {
  REPO_CONFIG: string;
  JWT_SECRET: string;
  OAUTH_AUTO_APPROVE?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    let config: Record<string, RepoConfig>;
    try {
      config = JSON.parse(env.REPO_CONFIG);
    } catch {
      return new Response("Server misconfiguration: invalid REPO_CONFIG", { status: 500 });
    }

    if (pathname.startsWith("/.well-known/")) return handleWellKnown(request);
    if (pathname === "/authorize") return handleAuthorize(request, env, config);
    if (pathname === "/token") return handleToken(request, env, config);

    const auth = await verifyAccessToken(request, env, config);
    if (!auth) return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource"` },
    });

    const { repoConfig, agentId } = auth;
    const gh = new GitHubClient(
      repoConfig.github_token,
      repoConfig.owner,
      repoConfig.repo,
      repoConfig.branch ?? "main"
    );
    return handleMcp(request, gh, agentId);
  },
};
