import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Forge, siteReady, deploymentOutcome, type Resource, type SiteAttrs } from "../src/forge.ts";

type Call = { method: string; url: string };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replaces fetch with a queue of canned responses and records every call.
function stubFetch(responses: { status?: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input) });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  }) as typeof fetch;
  return calls;
}

const site = (name: string, extra: Partial<SiteAttrs> = {}): Resource<SiteAttrs> => ({
  id: "1",
  type: "sites",
  attributes: { name, status: "installed", url: null, created_at: null, repository: { status: "installed" }, ...extra },
});

const forge = () => new Forge("tok", "acme", "5");

test("getSite is org-scoped", async () => {
  const calls = stubFetch([{ body: { data: site("pr-42-nch.on-forge.com") } }]);
  const s = await forge().getSite("7");
  assert.equal(calls[0].url, "https://forge.laravel.com/api/orgs/acme/sites/7");
  assert.equal(s.attributes.name, "pr-42-nch.on-forge.com");
});

test("findDatabase filters by name and requires an exact match", async () => {
  const calls = stubFetch([{ body: { data: [{ id: "9", type: "databases", attributes: { name: "pv_nch_421" } }] } }]);
  assert.equal(await forge().findDatabase("pv_nch_42"), null);
  assert.equal(decodeURIComponent(calls[0].url), "https://forge.laravel.com/api/orgs/acme/servers/5/database/schemas?filter[name]=pv_nch_42");
});

test("findDatabaseUser filters by name", async () => {
  const calls = stubFetch([{ body: { data: [{ id: "3", type: "databaseUsers", attributes: { name: "pv_nch_42" } }] } }]);
  const user = await forge().findDatabaseUser("pv_nch_42");
  assert.equal(user?.id, "3");
  assert.equal(decodeURIComponent(calls[0].url), "https://forge.laravel.com/api/orgs/acme/servers/5/database/users?filter[name]=pv_nch_42");
});

test("findSiteByLabel matches the label or a hostname built from it", async () => {
  stubFetch([{ body: { data: [site("pr-421-nch.on-forge.com"), site("pr-42-nch.on-forge.com")] } }]);
  const found = await forge().findSiteByLabel("pr-42-nch");
  assert.equal(found?.attributes.name, "pr-42-nch.on-forge.com");
  stubFetch([{ body: { data: [site("pr-421-nch")] } }]);
  assert.equal(await forge().findSiteByLabel("pr-42-nch"), null);
});

test("siteReady", () => {
  assert.throws(() => siteReady(site("x", { status: "failed" })), /x failed to install/);
  assert.equal(siteReady(site("x", { status: "installing" })), false);
  assert.equal(siteReady(site("x", { status: "installed", repository: { status: "installing" } })), false);
  assert.equal(siteReady(site("x")), true);
});

test("deploymentOutcome", () => {
  assert.equal(deploymentOutcome("queued"), "running");
  assert.equal(deploymentOutcome("deploying"), "running");
  assert.equal(deploymentOutcome("finished"), "finished");
  assert.equal(deploymentOutcome("failed-build"), "failed");
  assert.equal(deploymentOutcome("cancelled"), "failed");
});

test("a 429 is retried after retry-after", async () => {
  const calls = stubFetch([
    { status: 429, headers: { "retry-after": "0" }, body: { message: "slow down" } },
    { body: { data: site("pr-42-nch.on-forge.com") } },
  ]);
  const s = await forge().getSite("7");
  assert.equal(calls.length, 2);
  assert.equal(s.attributes.name, "pr-42-nch.on-forge.com");
});

test("siteReady throws when the repository install failed", () => {
  assert.throws(() => siteReady(site("x", { status: "installed", repository: { status: "failed" } })), /x.*repository/);
});

test("ensureSecurityRule creates the rule only when none exists", async () => {
  let calls = stubFetch([{ body: { data: [] } }, { body: { data: { id: "1", type: "securityRules", attributes: { name: "Preview" } } } }]);
  await forge().ensureSecurityRule("7", "Preview", "preview", "pw");
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  assert.equal(calls[1].url, "https://forge.laravel.com/api/orgs/acme/servers/5/sites/7/security-rules");
  calls = stubFetch([{ body: { data: [{ id: "1", type: "securityRules", attributes: { name: "Preview" } }] } }]);
  await forge().ensureSecurityRule("7", "Preview", "preview", "pw");
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});

test("ensureCertificate clones only when the domain has no certificate", async () => {
  let calls = stubFetch([{ body: { data: [] } }, { body: { data: { id: "9", type: "certificates", attributes: {} } } }]);
  await forge().ensureCertificate("7", "3", 12);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
  assert.equal(calls[1].url, "https://forge.laravel.com/api/orgs/acme/servers/5/sites/7/domains/3/certificates");
  calls = stubFetch([{ body: { data: [{ id: "9", type: "certificates", attributes: {} }] } }]);
  await forge().ensureCertificate("7", "3", 12);
  assert.deepEqual(calls.map((c) => c.method), ["GET"]);
});
