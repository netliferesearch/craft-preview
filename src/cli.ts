import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { Forge, waitUntil } from "./forge.ts";
import { GitHub } from "./github.ts";

// ---- Inputs -----------------------------------------------------------------

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}
const optional = (key: string) => process.env[key] || undefined;

const cfg = loadConfig(required("CONFIG_PATH"));
const repo = required("GITHUB_REPOSITORY");
const domain = required("PREVIEW_DOMAIN");
const secret = required("PREVIEW_SECRET");
const forge = new Forge(required("FORGE_TOKEN"), required("FORGE_ORG"), required("FORGE_SERVER_ID"));
const gh = new GitHub(required("GITHUB_TOKEN"), repo);

function output(key: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

function pullRequest(): { number: number; branch: string; sha: string } {
  const event = JSON.parse(readFileSync(required("GITHUB_EVENT_PATH"), "utf8"));
  const pr = event.pull_request;
  if (!pr) throw new Error("This command must run on a pull_request event");
  return { number: pr.number, branch: pr.head.ref, sha: String(pr.head.sha).slice(0, 7) };
}

// ---- Naming and derived values -------------------------------------------------

// Every per-preview secret is derived from (PREVIEW_SECRET, host). Any run can therefore
// regenerate the complete .env without storing state anywhere.
function derive(purpose: string, host: string, length = 32): string {
  return createHmac("sha256", secret).update(`${purpose}:${host}`).digest("hex").slice(0, length);
}

function names(pr: number) {
  const host = `pr-${pr}-${cfg.slug}.${domain}`;
  const db = `pv_${cfg.slug}_${pr}`;
  const scheme = "https";
  return { host, db, dbUser: db, origin: `${scheme}://${host}` };
}
type Names = ReturnType<typeof names>;

function parseExtraEnv(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) throw new Error(`Invalid extra-env line: ${trimmed.split("=")[0]}`);
    vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return vars;
}

function dotenv(pr: number, n: Names): string {
  const driver = optional("DB_DRIVER") ?? "mysql";
  const vars: Record<string, string> = {
    CRAFT_APP_ID: `preview-${cfg.slug}-${pr}`,
    CRAFT_ENVIRONMENT: "preview",
    CRAFT_SECURITY_KEY: optional("CRAFT_SECURITY_KEY") ?? derive("security-key", n.host, 64),
    CRAFT_DEV_MODE: "false",
    CRAFT_ALLOW_ADMIN_CHANGES: "false",
    CRAFT_DISALLOW_ROBOTS: "true",
    CRAFT_RUN_QUEUE_AUTOMATICALLY: "true",
    CRAFT_DB_DRIVER: driver,
    CRAFT_DB_SERVER: "127.0.0.1",
    CRAFT_DB_PORT: driver === "pgsql" ? "5432" : "3306",
    CRAFT_DB_DATABASE: n.db,
    CRAFT_DB_USER: n.dbUser,
    CRAFT_DB_PASSWORD: derive("db-password", n.host),
    ASSETS_SUBPATH: `previews/${cfg.slug}/pr-${pr}`,
    PREVIEW_ADMIN_EMAIL: optional("TEST_EMAIL") ?? `preview+${cfg.slug}@example.com`,
    PREVIEW_ADMIN_PASSWORD: derive("admin-password", n.host, 20),
    PREVIEW_LANGUAGE: cfg.language,
  };
  const testEmail = optional("TEST_EMAIL");
  if (testEmail) vars.CRAFT_TEST_TO_EMAIL_ADDRESS = testEmail;
  if (cfg.buildCommand) vars.PREVIEW_BUILD_COMMAND = cfg.buildCommand;
  const snapshotUrl = optional("SNAPSHOT_URL");
  if (snapshotUrl) vars.PREVIEW_SNAPSHOT_URL = snapshotUrl;
  for (const [key, path] of Object.entries(cfg.siteUrls)) {
    vars[key] = new URL(path, `${n.origin}/`).toString();
  }
  Object.assign(vars, cfg.env, parseExtraEnv(optional("EXTRA_ENV") ?? ""));

  // Single quotes are literal in both bash (the deploy script sources this file) and
  // phpdotenv, so no escaping is needed. The one character they can't hold is a single quote.
  return (
    Object.entries(vars)
      .map(([key, value]) => {
        if (value.includes("'")) throw new Error(`Env var ${key} contains a single quote`);
        return `${key}='${value}'`;
      })
      .join("\n") + "\n"
  );
}

// ---- Commands ---------------------------------------------------------------

async function setupSsl(siteId: string, host: string) {
  if (cfg.domain.mode !== "custom") return;
  const record = await forge.findDomain(siteId, host);
  if (!record) throw new Error(`No domain record found for ${host}`);
  await forge.createCertificate(siteId, record.id, {
    type: "clone",
    enable: true,
    clone: { certificate_id: cfg.domain.certificateId },
  });
}

async function up() {
  const pr = pullRequest();
  const n = names(pr.number);
  await gh.upsertComment(pr.number, `⏳ Building preview for \`${pr.sha}\`…`);

  let site = await forge.findSite(n.host);

  if (!site) {
    // A leftover database from an earlier failed run is reused rather than recreated.
    if (!(await forge.findDatabase(n.db))) {
      console.log(`Creating database ${n.db}`);
      const db = await forge.createDatabase(n.db, n.dbUser, derive("db-password", n.host));
      await waitUntil(
        `database ${n.db}`,
        () => forge.getDatabase(db.id),
        (d) => d.attributes.status !== "installing",
      );
    }

    console.log(`Creating site ${n.host}`);
    const created = await forge.createSite({
      type: "php",
      domain_mode: "custom",
      name: n.host,
      web_directory: cfg.webDirectory,
      php_version: cfg.phpVersion,
      // In-place deploys: simpler script, and the seed marker in storage/ persists between pushes.
      zero_downtime_deployments: false,
      // Non-isolated sites share the server's PHP-FPM pool, which fits many more previews per droplet.
      is_isolated: false,
      source_control_provider: "github",
      repository: repo,
      branch: pr.branch,
      install_composer_dependencies: false,
      push_to_deploy: false,
      tags: ["craft-preview", cfg.slug],
    });

    site = await waitUntil(
      `site ${n.host}`,
      () => forge.getSite(created.id),
      (s) => {
        if (s.attributes.status === "failed") throw new Error(`Site ${n.host} failed to install`);
        return (
          !["creating", "installing"].includes(s.attributes.status) &&
          s.attributes.repository?.status === "installed"
        );
      },
    );

    // The certificate goes on before basic auth so the HTTP-01 challenge isn't blocked.
    await setupSsl(site.id, n.host);
    await forge.createSecurityRule(
      site.id,
      "Preview",
      required("BASIC_AUTH_USER"),
      required("BASIC_AUTH_PASSWORD"),
    );
  }

  const siteId = site.id;

  // Rewritten on every run, so config changes reach existing previews and the snapshot URL stays fresh.
  await forge.updateEnvironment(siteId, dotenv(pr.number, n));
  await forge.updateDeployScript(
    siteId,
    readFileSync(join(import.meta.dirname, "..", "deploy-script.sh"), "utf8"),
  );

  console.log(`Deploying ${pr.branch} (${pr.sha}) to ${n.host}`);
  const deployment = await forge.deploy(siteId);
  const result = await waitUntil(
    "deployment",
    () => forge.getDeployment(siteId, deployment.id),
    (d) => !["pending", "queued", "deploying"].includes(d.attributes.status),
    { timeoutMs: 20 * 60_000 },
  );

  if (result.attributes.status !== "finished") {
    await gh.upsertComment(
      pr.number,
      `❌ Preview deploy **${result.attributes.status}** for \`${pr.sha}\`. ` +
        `See the deployment log for site \`${n.host}\` in Forge.`,
    );
    throw new Error(`Deployment ${result.attributes.status}`);
  }

  output("url", n.origin);
  await gh.upsertComment(
    pr.number,
    [
      `🚀 **Preview ready:** ${n.origin}`,
      "",
      `| | |`,
      `|---|---|`,
      `| Commit | \`${pr.sha}\` |`,
      `| Basic auth user | \`${required("BASIC_AUTH_USER")}\` |`,
      `| Control panel | ${n.origin}/admin |`,
      "",
      `<sub>Rebuilt on every push. Removed when the PR closes, or after ${cfg.maxAgeDays} days.</sub>`,
    ].join("\n"),
  );
}

async function down(pr: number, reason: string) {
  const n = names(pr);
  const site = await forge.findSite(n.host);
  if (site) await forge.deleteSite(site.id);
  const db = await forge.findDatabase(n.db);
  if (db) await forge.deleteDatabase(db.id);
  const user = await forge.findDatabaseUser(n.dbUser);
  if (user) await forge.deleteDatabaseUser(user.id);
  console.log(`Removed preview for PR #${pr} (${reason})`);
  await gh.upsertComment(pr, `🧹 Preview removed: ${reason}.`);
}

// Catches everything the close event missed: failed teardowns, orphaned databases, stale previews.
async function sweep(): Promise<number[]> {
  const escapedDomain = domain.replaceAll(".", "\\.");
  const sitePattern = new RegExp(`^pr-(\\d+)-${cfg.slug}\\.${escapedDomain}$`);
  const dbPattern = new RegExp(`^pv_${cfg.slug}_(\\d+)$`);

  // Collect first so we never delete while paginating.
  const found = new Map<number, string | null>(); // PR number → site created_at
  for await (const site of forge.listSites()) {
    const match = sitePattern.exec(site.attributes.name);
    if (match) found.set(Number(match[1]), site.attributes.created_at);
  }
  // Databases left behind by a failed provision have no site. They're removed only once the
  // PR is closed, never by age, since an open PR's next push will reuse them.
  for await (const db of forge.listDatabases()) {
    const match = dbPattern.exec(db.attributes.name);
    if (match && !found.has(Number(match[1]))) found.set(Number(match[1]), null);
  }

  const removed: number[] = [];
  const maxAgeMs = cfg.maxAgeDays * 86_400_000;
  for (const [pr, createdAt] of found) {
    let state: "open" | "closed";
    try {
      state = await gh.prState(pr);
    } catch (error) {
      console.warn(`Skipping PR #${pr}: ${(error as Error).message}`);
      continue;
    }
    const age = createdAt ? Date.now() - Date.parse(createdAt) : 0;
    if (state === "closed") {
      await down(pr, "the PR is closed");
      removed.push(pr);
    } else if (age > maxAgeMs) {
      await down(pr, `it was older than ${cfg.maxAgeDays} days. Push a commit to recreate it`);
      removed.push(pr);
    }
  }
  return removed;
}

// ---- Main -------------------------------------------------------------------

const command = process.argv[2];
try {
  switch (command) {
    case "up":
      await up();
      break;
    case "down": {
      const pr = pullRequest().number;
      await down(pr, "the PR was closed");
      output("removed", String(pr));
      break;
    }
    case "sweep":
      output("removed", (await sweep()).join(" "));
      break;
    default:
      throw new Error(`Unknown command "${command}". Use up, down or sweep.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
