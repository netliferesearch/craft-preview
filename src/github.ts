const API = "https://api.github.com";
const MARKER = "<!-- craft-preview -->";

type Comment = { id: number; body?: string };

export class GitHub {
  #token: string;
  #repo: string;

  constructor(token: string, repo: string) {
    this.#token = token;
    this.#repo = repo;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}/repos/${this.#repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  // Keeps a single, continually updated preview comment per PR.
  async upsertComment(pr: number, body: string) {
    const text = `${MARKER}\n${body}`;
    for (let page = 1; ; page++) {
      const comments = await this.#request<Comment[]>(
        "GET",
        `/issues/${pr}/comments?per_page=100&page=${page}`,
      );
      const existing = comments.find((c) => c.body?.startsWith(MARKER));
      if (existing) {
        await this.#request("PATCH", `/issues/comments/${existing.id}`, { body: text });
        return;
      }
      if (comments.length < 100) break;
    }
    await this.#request("POST", `/issues/${pr}/comments`, { body: text });
  }

  async prInfo(pr: number): Promise<{ state: "open" | "closed"; labels: string[] }> {
    const data = await this.#request<{ state: "open" | "closed"; labels: { name: string }[] }>(
      "GET",
      `/pulls/${pr}`,
    );
    return { state: data.state, labels: data.labels.map((l) => l.name) };
  }
}
