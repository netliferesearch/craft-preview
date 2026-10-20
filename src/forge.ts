// Thin client for the Laravel Forge API v2, scoped to one organization and one server.
//
// Endpoints marked VERIFY follow v2's REST conventions but weren't confirmed against
// the published docs when this was written. Check them on the first real run.

const BASE = "https://forge.laravel.com/api";

export type Resource<A> = { id: string; type: string; attributes: A };

export type SiteAttrs = {
  name: string;
  status: string;
  created_at: string | null;
  repository: { status: string | null } | null;
};
export type NamedAttrs = { name: string; status?: string };
export type DeploymentAttrs = { status: string };

type One<A> = { data: Resource<A> };
type Page<A> = { data: Resource<A>[]; meta?: { next_cursor?: string | null } };

export class ForgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil<T>(
  label: string,
  poll: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 10 * 60_000, intervalMs = 5_000 } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await poll();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

export class Forge {
  #token: string;
  #base: string;

  constructor(token: string, org: string, serverId: string) {
    this.#token = token;
    this.#base = `${BASE}/orgs/${encodeURIComponent(org)}/servers/${serverId}`;
  }

  async #request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await fetch(this.#base + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 429 && attempt < 5) {
      await sleep(Number(res.headers.get("retry-after") ?? 10) * 1000);
      return this.#request<T>(method, path, body, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ForgeError(res.status, `${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async *#list<A>(path: string): AsyncGenerator<Resource<A>> {
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?page[cursor]=${encodeURIComponent(cursor)}` : "";
      const page: Page<A> = await this.#request<Page<A>>("GET", path + query);
      yield* page.data;
      cursor = page.meta?.next_cursor ?? null;
    } while (cursor);
  }

  async #findByName<A extends { name: string }>(path: string, name: string) {
    for await (const item of this.#list<A>(path)) {
      if (item.attributes.name === name) return item;
    }
    return null;
  }

  // ---- Sites ---------------------------------------------------------------

  listSites() {
    return this.#list<SiteAttrs>("/sites");
  }

  findSite(name: string) {
    return this.#findByName<SiteAttrs>("/sites", name);
  }

  async getSite(siteId: string) {
    // VERIFY: GET /sites/{site}
    return (await this.#request<One<SiteAttrs>>("GET", `/sites/${siteId}`)).data;
  }

  async createSite(body: Record<string, unknown>) {
    return (await this.#request<One<SiteAttrs>>("POST", "/sites", body)).data;
  }

  async deleteSite(siteId: string) {
    // VERIFY: DELETE /sites/{site}
    await this.#request<void>("DELETE", `/sites/${siteId}`);
  }

  async updateEnvironment(siteId: string, environment: string) {
    await this.#request<void>("PUT", `/sites/${siteId}/environment`, { environment });
  }

  async updateDeployScript(siteId: string, content: string) {
    // auto_source makes the site's .env available as variables inside the deploy script.
    await this.#request<void>("PUT", `/sites/${siteId}/deployments/script`, {
      content,
      auto_source: true,
    });
  }

  async deploy(siteId: string) {
    return (await this.#request<One<DeploymentAttrs>>("POST", `/sites/${siteId}/deployments`)).data;
  }

  async getDeployment(siteId: string, deploymentId: string) {
    return (
      await this.#request<One<DeploymentAttrs>>("GET", `/sites/${siteId}/deployments/${deploymentId}`)
    ).data;
  }

  async createSecurityRule(siteId: string, name: string, username: string, password: string) {
    // No path: the rule protects the whole site.
    await this.#request<void>("POST", `/sites/${siteId}/security-rules`, {
      name,
      credentials: [{ username, password }],
    });
  }

  findDomain(siteId: string, name: string) {
    // VERIFY: GET /sites/{site}/domains, and that each record's attributes include `name`
    return this.#findByName<NamedAttrs>(`/sites/${siteId}/domains`, name);
  }

  async createCertificate(siteId: string, domainId: string, body: Record<string, unknown>) {
    await this.#request<void>("POST", `/sites/${siteId}/domains/${domainId}/certificates`, body);
  }

  // ---- Databases -----------------------------------------------------------

  listDatabases() {
    // VERIFY: GET /database/schemas
    return this.#list<NamedAttrs>("/database/schemas");
  }

  findDatabase(name: string) {
    return this.#findByName<NamedAttrs>("/database/schemas", name);
  }

  async createDatabase(name: string, user: string, password: string) {
    // Creates the schema plus a user with access to it.
    return (
      await this.#request<One<NamedAttrs>>("POST", "/database/schemas", { name, user, password })
    ).data;
  }

  async getDatabase(databaseId: string) {
    // VERIFY: GET /database/schemas/{id}
    return (await this.#request<One<NamedAttrs>>("GET", `/database/schemas/${databaseId}`)).data;
  }

  async deleteDatabase(databaseId: string) {
    // VERIFY: DELETE /database/schemas/{id}
    await this.#request<void>("DELETE", `/database/schemas/${databaseId}`);
  }

  findDatabaseUser(name: string) {
    // VERIFY: GET /database/users
    return this.#findByName<NamedAttrs>("/database/users", name);
  }

  async deleteDatabaseUser(userId: string) {
    // VERIFY: DELETE /database/users/{id}
    await this.#request<void>("DELETE", `/database/users/${userId}`);
  }
}
