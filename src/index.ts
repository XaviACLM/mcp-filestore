import { handleMcp } from "./mcp";
import { GitHubClient } from "./github";

export interface Env {
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  MCP_AUTH_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const gh = new GitHubClient(
      env.GITHUB_TOKEN,
      env.GITHUB_OWNER,
      env.GITHUB_REPO,
      env.GITHUB_BRANCH
    );
    return handleMcp(request, gh, env.MCP_AUTH_TOKEN);
  },
};
