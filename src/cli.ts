import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { composeEnv, parseDotenv, previewVars, readExampleEnv, renderDotenv } from "./env.ts";
import { Forge, deploymentOutcome, siteReady, waitUntil } from "./forge.ts";
import { GitHub } from "./github.ts";
import { databaseName, derive, originFor, prFromDatabaseName, prFromSiteName, previewLabel } from "./names.ts";
import { readEvent, resolveCommand, type Command } from "./trigger.ts";

// ---- Inputs -----------------------------------------------------------------

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}
const optional = (key: string) => process.env[key] || undefined;

const LABEL = "preview";

// Decided before anything else is read: a skipped run (fork, other label) has no secrets to read.
const event = readEvent(required("GITHUB_EVENT_NAME"), required("GITHUB_EVENT_PATH"));
const command: Command = (process.argv[2] as Command | undefined) || resolveCommand(event, LABEL);
if (command === "skip") {
  console.log(`Nothing to do for ${event.event_name}/${event.action ?? ""} without the ${LABEL} label`);
  process.exit(0);
}

const cfg = loadConfig(required("CONFIG_PATH"));
const repo = required("GITHUB_REPOSITORY");
const secret = required("PREVIEW_SECRET");
const forge = new Forge(required("FORGE_TOKEN"), required("FORGE_ORG"), required("FORGE_SERVER_ID"));
const gh = new GitHub(required("GITHUB_TOKEN"), repo);

function output(key: string, value: string) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

function pullRequest(): { number: number; branch: string; sha: string } {
  const pr = event.pull_request;
  if (!pr) throw new Error("This command must run on a pull_request event");
  return { number: pr.number, branch: pr.head.ref, sha: pr.head.sha.slice(0, 7) };
}

function names(pr: number) {
  const label = previewLabel(cfg.slug, pr);
  const db = databaseName(cfg.slug, pr);
  // In custom mode the hostname is ours to choose; in on-forge mode Forge assigns it.
  const siteName = cfg.domain.mode === "custom" ? `${label}.${cfg.domain.baseDomain}` : label;
  return { label, db, dbUser: db, siteName };
}

// ---- Commands ---------------------------------------------------------------

async function createSite(n: ReturnType<typeof names>, branch: string) {
  const created = await forge.createSite({
    type: "php",
    name: n.siteName,
    domain_mode: cfg.domain.mode === "custom" ? "custom" : "on-forge",
    ...(cfg.domain.mode === "custom" ? { www_redirect_type: "none", allow_wildcard_subdomains: false } : {}),
    web_directory: cfg.webDirectory,
    php_version: cfg.phpVersion,
    // In-place deploys: simpler script, and the seed marker in storage/ persists between pushes.
    zero_downtime_deployments: false,
    // Non-isolated sites share the server's PHP-FPM pool, which fits many more previews per server.
    is_isolated: false,
    source_control_provider: "github",
    repository: repo,
    branch,
    install_composer_dependencies: false,
    push_to_deploy: false,
    tags: ["craft-preview", cfg.slug],
  });
  return waitUntil(`site ${n.siteName}`, () => forge.getSite(created.id), siteReady);
}

async function up() {
  const pr = pullRequest();
  const n = names(pr.number);
  await gh.upsertComment(pr.number, `⏳ Building preview for \`${pr.sha}\`…`);

  let site = await forge.findSiteByLabel(n.label);

  // Every run converges: a run that failed between site creation and the security rule must not
  // leave a public preview behind, so readiness, certificate and basic auth are ensured each time.
  if (!site) {
    // A leftover database from an earlier failed run is reused rather than recreated.
    if (!(await forge.findDatabase(n.db))) {
      console.log(`Creating database ${n.db}`);
      const db = await forge.createDatabase(n.db, n.dbUser, derive(secret, "db-password", n.label));
      await waitUntil(
        `database ${n.db}`,
        () => forge.getDatabase(db.id),
        (d) => d.attributes.status !== "installing",
      );
    }

    console.log(`Creating site ${n.siteName}`);
    site = await createSite(n, pr.branch);
  } else if (!siteReady(site)) {
    site = await waitUntil(`site ${n.siteName}`, () => forge.getSite(site!.id), siteReady);
  }

  const siteId = site.id;
  if (cfg.domain.mode === "custom") {
    // The certificate goes on before basic auth so nothing blocks the domain's first request.
    const record = await forge.findDomain(siteId, n.siteName);
    if (!record) throw new Error(`No domain record found for ${n.siteName}`);
    await forge.ensureCertificate(siteId, record.id, cfg.domain.certificateId);
  }
  await forge.ensureSecurityRule(siteId, "Preview", required("BASIC_AUTH_USER"), required("BASIC_AUTH_PASSWORD"));

  const origin = originFor(site.attributes);
  const adminEmail = required("ADMIN_EMAIL");

  // Rewritten on every run, so config changes reach existing previews and the snapshot URL stays fresh.
  const env = composeEnv([
    readExampleEnv(optional("WORKSPACE") ?? process.cwd()),
    previewVars({ cfg, pr: pr.number, origin, secret, adminEmail, snapshotUrl: optional("SNAPSHOT_URL") }),
    cfg.env,
    parseDotenv(optional("EXTRA_ENV") ?? ""),
  ]);
  await forge.updateEnvironment(siteId, renderDotenv(env));
  await forge.updateDeployScript(siteId, readFileSync(join(import.meta.dirname, "..", "deploy-script.sh"), "utf8"));

  console.log(`Deploying ${pr.branch} (${pr.sha}) to ${origin}`);
  const deployment = await forge.deploy(siteId);
  const result = await waitUntil(
    "deployment",
    () => forge.getDeployment(siteId, deployment.id),
    (d) => deploymentOutcome(d.attributes.status) !== "running",
    { timeoutMs: 20 * 60_000 },
  );

  if (deploymentOutcome(result.attributes.status) !== "finished") {
    await gh.upsertComment(
      pr.number,
      `❌ Preview deploy **${result.attributes.status}** for \`${pr.sha}\`. ` +
        `See the deployment log for site \`${site.attributes.name}\` in Forge.`,
    );
    throw new Error(`Deployment ${result.attributes.status}`);
  }

  output("url", origin);
  await gh.upsertComment(
    pr.number,
    [
      `🚀 **Preview ready:** ${origin}`,
      "",
      `| | |`,
      `|---|---|`,
      `| Commit | \`${pr.sha}\` |`,
      `| Basic auth user | \`${required("BASIC_AUTH_USER")}\` |`,
      `| Control panel | ${origin}/admin |`,
      `| Admin login | \`preview\` / \`${env.PREVIEW_ADMIN_PASSWORD}\` |`,
      "",
      `<sub>Rebuilt on every push. Removed when the \`${LABEL}\` label is removed, the PR closes, ` +
        `or after ${cfg.maxAgeDays} days. Uploads are not supported in previews.</sub>`,
    ].join("\n"),
  );
}

async function down(pr: number, reason: string): Promise<boolean> {
  const n = names(pr);
  const site = await forge.findSiteByLabel(n.label);
  if (site) await forge.deleteSite(site.id);
  const db = await forge.findDatabase(n.db);
  if (db) await forge.deleteDatabase(db.id);
  const user = await forge.findDatabaseUser(n.dbUser);
  if (user) await forge.deleteDatabaseUser(user.id);
  const removed = Boolean(site || db || user);
  if (removed) {
    console.log(`Removed preview for PR #${pr} (${reason})`);
    await gh.upsertComment(pr, `🧹 Preview removed: ${reason}.`);
  }
  return removed;
}

// Catches everything the PR events missed: failed teardowns, orphaned databases, lost labels, stale previews.
async function sweep(): Promise<number[]> {
  // Collect first so we never delete while paginating.
  const sites = new Map<number, string | null>(); // PR number → site created_at
  for await (const site of forge.listSites()) {
    const pr = prFromSiteName(cfg.slug, site.attributes.name);
    if (pr !== null) sites.set(pr, site.attributes.created_at);
  }
  // Databases left behind by a failed provision have no site. They are removed only once the
  // PR is closed, never by age, since an open PR's next push will reuse them.
  const orphans = new Set<number>();
  for await (const db of forge.listDatabases()) {
    const pr = prFromDatabaseName(cfg.slug, db.attributes.name);
    if (pr !== null && !sites.has(pr)) orphans.add(pr);
  }

  const removed: number[] = [];
  const maxAgeMs = cfg.maxAgeDays * 86_400_000;
  for (const pr of [...sites.keys(), ...orphans]) {
    let info: Awaited<ReturnType<typeof gh.prInfo>>;
    try {
      info = await gh.prInfo(pr);
    } catch (error) {
      console.warn(`Skipping PR #${pr}: ${(error as Error).message}`);
      continue;
    }
    const createdAt = sites.get(pr) ?? null;
    const age = createdAt ? Date.now() - Date.parse(createdAt) : 0;
    let reason: string | null = null;
    if (info.state === "closed") reason = "the PR is closed";
    else if (sites.has(pr) && !info.labels.includes(LABEL)) reason = `the \`${LABEL}\` label was removed`;
    else if (age > maxAgeMs) reason = `it was older than ${cfg.maxAgeDays} days. Re-add the label to recreate it`;
    if (reason && (await down(pr, reason))) removed.push(pr);
  }
  return removed;
}

// ---- Main -------------------------------------------------------------------

try {
  switch (command) {
    case "up":
      await up();
      break;
    case "down": {
      const pr = pullRequest().number;
      if (await down(pr, "the PR was closed or the label removed")) output("removed", String(pr));
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
