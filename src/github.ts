export interface GitHubFile {
  content: string; // decoded UTF-8
  sha: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: string; // "blob" | "tree"
}

export class GitHubClient {
  private base: string;
  private headers: Record<string, string>;
  public readonly branch: string;

  constructor(token: string, owner: string, repo: string, branch: string) {
    this.base = `https://api.github.com/repos/${owner}/${repo}`;
    this.branch = branch;
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "mcp-stash",
    };
  }

  private async request(path: string, options: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${this.base}${path}`, {
      ...options,
      headers: { ...this.headers, ...(options.headers as Record<string, string> ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${body}`);
    }
    return res.json();
  }

  async getFile(path: string): Promise<GitHubFile> {
    const data = await this.request(`/contents/${path}?ref=${this.branch}`) as {
      content: string;
      sha: string;
    };
    const content = atob(data.content.replace(/\n/g, ""));
    return { content, sha: data.sha };
  }

  async writeFile(path: string, content: string, sha: string | undefined, message: string): Promise<void> {
    const body: Record<string, unknown> = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: this.branch,
    };
    if (sha !== undefined) body.sha = sha;
    await this.request(`/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteFile(path: string, sha: string, message: string): Promise<void> {
    await this.request(`/contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: this.branch }),
    });
  }

  async getTree(): Promise<GitHubTreeEntry[]> {
    const data = await this.request(
      `/git/trees/${this.branch}?recursive=1`
    ) as { tree: GitHubTreeEntry[] };
    return data.tree.filter((e) => e.type === "blob");
  }
}
