export interface GitHubFile {
  content: string; // decoded UTF-8
  sha: string;
}

export interface GitHubTreeEntry {
  path: string;
  type: string; // "blob" | "tree"
}

export interface PullRequest {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
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
      "User-Agent": "mcp-filestore",
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
    const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), c => c.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);
    return { content, sha: data.sha };
  }

  async writeFile(path: string, content: string, sha: string | undefined, message: string, targetBranch?: string): Promise<void> {
    const body: Record<string, unknown> = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: targetBranch ?? this.branch,
    };
    if (sha !== undefined) body.sha = sha;
    await this.request(`/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  async deleteFile(path: string, sha: string, message: string, targetBranch?: string): Promise<void> {
    await this.request(`/contents/${path}`, {
      method: "DELETE",
      body: JSON.stringify({ message, sha, branch: targetBranch ?? this.branch }),
    });
  }

  async getTree(): Promise<GitHubTreeEntry[]> {
    let data: { tree: GitHubTreeEntry[] };
    try {
      data = await this.request(`/git/trees/${this.branch}?recursive=1`) as { tree: GitHubTreeEntry[] };
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("404")) return [];
      throw e;
    }
    return data.tree.filter((e) => e.type === "blob");
  }

  async getBranchSha(): Promise<string> {
    const data = await this.request(`/git/ref/heads/${this.branch}`) as { object: { sha: string } };
    return data.object.sha;
  }

  async createBranch(name: string, fromSha: string): Promise<void> {
    await this.request("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${name}`, sha: fromSha }),
    });
  }

  async createPR(head: string, title: string, body: string): Promise<string> {
    const data = await this.request("/pulls", {
      method: "POST",
      body: JSON.stringify({ title, body, head, base: this.branch }),
    }) as { html_url: string };
    return data.html_url;
  }

  async listOpenPRs(): Promise<PullRequest[]> {
    const data = await this.request(`/pulls?state=open&base=${this.branch}`) as PullRequest[];
    return data;
  }
}
