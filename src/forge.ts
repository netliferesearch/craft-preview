// Thin client for the Laravel Forge API v2, scoped to one organization and one server.
// Paths checked against the published OpenAPI spec (forge.laravel.com/api/docs.openapi), Oct 2026.

const BASE = "https://forge.laravel.com/api";

export type Resource<A> = { id: string; type: string; attributes: A };

export type SiteAttrs = {
  name: string;
  status: string;
  url: string | null;
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

// Throws on a failed install; true once the site and its repository are installed.
export function siteReady(site: Resource<SiteAttrs>): boolean {
  const { status, repository, name } = site.attributes;
  if (status === "failed") throw new Error(`Site ${name} failed to install`);
  if (repository?.status === "failed") throw new Error(`Site ${name}: repository failed to install`);
  return !["creating", "installing"].includes(status) && repository?.status === "installed";
}

export function deploymentOutcome(status: string): "running" | "finished" | "failed" {
  if (["pending", "queued", "deploying"].includes(status)) return "running";
  return status === "finished" ? "finished" : "failed";
}

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
  #orgBase: string;

  constructor(token: string, org: string, serverId: string) {
    this.#token = token;
    this.#orgBase = `${BASE}/orgs/${encodeURIComponent(org)}`;
    this.#base = `${this.#orgBase}/servers/${serverId}`;
  }

  // Server-scoped unless the path is absolute (starts with the API base).
  async #request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const url = path.startsWith(BASE) ? path : this.#base + path;
    const res = await fetch(url, {
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
      const sep = path.includes("?") ? "&" : "?";
      const query: string = cursor ? `${sep}page[cursor]=${encodeURIComponent(cursor)}` : "";
      const page: Page<A> = await this.#request<Page<A>>("GET", path + query);
      yield* page.data;
      cursor = page.meta?.next_cursor ?? null;
    } while (cursor);
  }

  // Server-side filter, then an exact match: filter[name] may be a partial match.
  async #findByName<A extends { name: string }>(path: string, name: string) {
    for await (const item of this.#list<A>(`${path}?filter[name]=${encodeURIComponent(name)}`)) {
      if (item.attributes.name === name) return item;
    }
    return null;
  }

  // ---- Sites ---------------------------------------------------------------

  listSites() {
    return this.#list<SiteAttrs>("/sites");
  }

  // The site is asked for by label; Forge names it after the hostname it assigns.
  async findSiteByLabel(label: string) {
    for await (const site of this.#list<SiteAttrs>("/sites")) {
      const { name } = site.attributes;
      if (name === label || name.startsWith(`${label}.`)) return site;
    }
    return null;
  }

  async getSite(siteId: string) {
    // Site show lives under the organization, not the server.
    return (await this.#request<One<SiteAttrs>>("GET", `${this.#orgBase}/sites/${siteId}`)).data;
  }

  async createSite(body: Record<string, unknown>) {
    return (await this.#request<One<SiteAttrs>>("POST", "/sites", body)).data;
  }

  async deleteSite(siteId: string) {
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

  // Idempotent: a run that failed between site creation and the rule must still end with basic auth.
  async ensureSecurityRule(siteId: string, name: string, username: string, password: string) {
    if (await this.#findByName<NamedAttrs>(`/sites/${siteId}/security-rules`, name)) return;
    // No path: the rule protects the whole site.
    await this.#request<void>("POST", `/sites/${siteId}/security-rules`, {
      name,
      credentials: [{ username, password }],
    });
  }

  findDomain(siteId: string, name: string) {
    return this.#findByName<NamedAttrs>(`/sites/${siteId}/domains`, name);
  }

  // Idempotent: clones the certificate onto the domain record unless it already has one.
  async ensureCertificate(siteId: string, domainId: string, certificateId: number) {
    const path = `/sites/${siteId}/domains/${domainId}/certificates`;
    const existing = await this.#request<{ data: unknown[] }>("GET", path);
    if (existing.data.length > 0) return;
    await this.#request<void>("POST", path, { type: "clone", enable: true, clone: { certificate_id: certificateId } });
  }

  // ---- Databases -----------------------------------------------------------

  listDatabases() {
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
    return (await this.#request<One<NamedAttrs>>("GET", `/database/schemas/${databaseId}`)).data;
  }

  async deleteDatabase(databaseId: string) {
    await this.#request<void>("DELETE", `/database/schemas/${databaseId}`);
  }

  findDatabaseUser(name: string) {
    return this.#findByName<NamedAttrs>("/database/users", name);
  }

  async deleteDatabaseUser(userId: string) {
    await this.#request<void>("DELETE", `/database/users/${userId}`);
  }
}
