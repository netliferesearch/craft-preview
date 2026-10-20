# craft-preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the untested craft-preview draft into a working composite action that builds, redeploys and removes per-PR Craft preview sites on a Laravel Forge server, gated by the `preview` label, using Forge-provided `on-forge.com` hostnames.

**Architecture:** A composite GitHub Action runs `src/cli.ts` on Node 24 with built-in type stripping. Pure decision logic (manifest, naming, `.env` composition, trigger resolution, Forge status predicates) lives in small modules with `node:test` unit tests. `src/forge.ts` stays a thin fetch client for Forge API v2. The deploy script runs on the server and seeds the database once. The example client workflow passes the PR event through; the action decides what to do.

**Tech Stack:** TypeScript 5.9 (erasable syntax only, no build step), Node 24, zod 4, `node:test`, bash for the deploy script and its test, actionlint and shellcheck locally.

**Spec:** `docs/superpowers/specs/2026-10-19-craft-preview-design.md`

## Global Constraints

- Node `>=24` (`engines` in package.json). Local: `nvm use 24`. Add `.nvmrc` with `24`.
- Only erasable TypeScript: no enums, namespaces or parameter properties (`erasableSyntaxOnly` is on).
- Dependencies stay at `zod` only. No Forge SDK.
- Forge API v2 base `https://forge.laravel.com/api`; server-scoped paths under `/orgs/{org}/servers/{server}`, site show under `/orgs/{org}/sites/{site}`. 60 requests per minute: polling interval 5 s, retry on 429 honouring `retry-after`.
- Names: site label `pr-<n>-<slug>`, database and user `pv_<slug>_<n>`, label `preview`, basic auth user `preview`, admin user `preview`.
- Per-preview secrets are HMAC-SHA256 of `PREVIEW_SECRET` keyed by `<purpose>:<label>` (the label, not the hostname: the hostname is unknown before the site exists). Lengths: db password 32, security key 64, admin password 20.
- Preview `.env` fixed values: `CRAFT_ENVIRONMENT=preview`, `CRAFT_DEV_MODE=false`, `CRAFT_ALLOW_ADMIN_CHANGES=true`, `CRAFT_DISALLOW_ROBOTS=true`, `CRAFT_RUN_QUEUE_AUTOMATICALLY=true`, `CRAFT_DB_DRIVER=mysql`, `CRAFT_DB_SERVER=127.0.0.1`, `CRAFT_DB_PORT=3306`.
- Snapshot bucket `netlife-craft-snapshots`, region `fra1`, presign 7 days. Secrets `SNAPSHOT_READ_KEY`, `SNAPSHOT_READ_SECRET`.
- Secrets never printed: mask the presigned URL; never log `.env` contents.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A client repo without `.env.example` or `.env.example.dev`: the preview still builds from generated values alone (Task 4).
2. `.env.example` lines with quoted values, `export` prefixes, blank lines and comments: parsed, quotes stripped, no crash (Task 4).
3. An `unlabeled` event for a label other than `preview` on a PR that still carries `preview`: no teardown (Task 5).
4. Forge reports the site as `failed`: `up` stops with a clear error instead of polling until the timeout (Task 6).
5. A second deploy after a failed first seed (no marker written): the script seeds again rather than running `craft up` against an empty database (Task 8).

---

### Task 1: Baseline commit and test harness

**Files:**
- Create: `.nvmrc`, `tests/smoke.test.ts`
- Modify: `package.json`, `.gitignore`
- Commit everything already in the working tree (draft, spec, this plan).

**Interfaces:**
- Produces: `npm test` runs `node --test tests/*.test.ts`; `npm run typecheck` as today.

- [ ] **Step 1: Make the baseline commit of the existing draft**

```bash
git add -A && git commit -m "Draft of craft-preview with design and plan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 2: Add `.nvmrc` containing `24` and the test script**

In `package.json` `scripts`: `"test": "node --test tests/*.test.ts"`, keep `typecheck`. Add `"check": "npm run typecheck && npm test"`.

- [ ] **Step 3: Write `tests/smoke.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewConfig } from "../src/config.ts";
test("manifest schema loads", () => {
  assert.equal(PreviewConfig.parse({ slug: "nch" }).slug, "nch");
});
```

- [ ] **Step 4: Run and confirm it passes**

Run: `nvm use 24 && npm test`
Expected: `# pass 1`, no ExperimentalWarning about type stripping.

- [ ] **Step 5: Commit**

```bash
git add .nvmrc package.json tests/smoke.test.ts
git commit -m "Add node:test harness and pin Node 24

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Manifest: `domain` replaces `ssl`

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `PreviewConfig` zod schema and type with `domain: { mode: "on-forge" } | { mode: "custom"; baseDomain: string; certificateId: number }` defaulting to `{ mode: "on-forge" }`; `loadConfig(path: string): PreviewConfig` unchanged. The `ssl` field is gone; an `ssl` key in a manifest is a validation error (use `z.strictObject`).

- [ ] **Step 1: Write the failing tests**

```ts
test("domain defaults to on-forge", () =>
  assert.deepEqual(PreviewConfig.parse({ slug: "nch" }).domain, { mode: "on-forge" }));
test("custom domain needs baseDomain and certificateId", () =>
  assert.equal(PreviewConfig.safeParse({ slug: "nch", domain: { mode: "custom", baseDomain: "preview.netlife.no" } }).success, false));
test("custom domain parses", () =>
  assert.equal(PreviewConfig.parse({ slug: "nch", domain: { mode: "custom", baseDomain: "preview.netlife.no", certificateId: 12 } }).domain.mode, "custom"));
test("ssl key is rejected", () =>
  assert.equal(PreviewConfig.safeParse({ slug: "nch", ssl: { mode: "letsencrypt" } }).success, false));
test("slug rules", () => {
  assert.equal(PreviewConfig.safeParse({ slug: "1ab" }).success, false);
  assert.equal(PreviewConfig.safeParse({ slug: "abcdefghijklm" }).success, false);
});
```

- [ ] **Step 2: Run to verify they fail** — `npm test`, expected: failures on `domain` and `ssl` assertions.

- [ ] **Step 3: Implement** — replace the `Ssl` union with `Domain` as in Interfaces, switch to `z.strictObject`, keep every other field and default from the draft.

- [ ] **Step 4: Run** — `npm run check`, expected: all pass, typecheck may now fail in `cli.ts` on `cfg.ssl`; that is fixed in Task 7. If it blocks, leave `cli.ts` compiling by replacing `cfg.ssl.mode === "none"` with `false` for now.

- [ ] **Step 5: Commit** — `git commit -m "Manifest: domain block replaces ssl"` with trailer.

---

### Task 3: Naming and derived secrets

**Files:**
- Create: `src/names.ts`
- Test: `tests/names.test.ts`

**Interfaces:**
- Produces:
  - `previewLabel(slug: string, pr: number): string` → `pr-42-nch`
  - `databaseName(slug: string, pr: number): string` → `pv_nch_42`
  - `prFromSiteName(slug: string, name: string): number | null` — matches `^pr-(\d+)-<slug>(\.|$)` so both `pr-42-nch` and `pr-42-nch.on-forge.com` resolve to 42; `pr-42-other.on-forge.com` → null.
  - `prFromDatabaseName(slug: string, name: string): number | null` — `^pv_<slug>_(\d+)$`.
  - `derive(secret: string, purpose: string, label: string, length?: number): string` — hex HMAC-SHA256 of `${purpose}:${label}`, default length 32.
  - `originFor(site: { name: string; url?: string | null }): string` — `https://` plus the site's `url` host when `url` is set, otherwise `https://` plus `name`.

- [ ] **Step 1: Write the failing tests** — one `test` per function above with the example values in Interfaces, plus `derive` being deterministic and different per purpose, and `originFor({ name: "pr-42-nch", url: "http://pr-42-nch.on-forge.com" })` → `https://pr-42-nch.on-forge.com`.

- [ ] **Step 2: Run to verify they fail** — module not found.

- [ ] **Step 3: Implement `src/names.ts`** — move `derive` and the naming out of `cli.ts`; `originFor` always upgrades to https.

- [ ] **Step 4: Run** — `npm test`, all pass.

- [ ] **Step 5: Commit** — `git commit -m "Extract naming and derived secrets"` with trailer.

---

### Task 4: `.env` composition

**Files:**
- Create: `src/env.ts`
- Test: `tests/env.test.ts`

**Interfaces:**
- Consumes: `PreviewConfig` (Task 2), `derive`, `previewLabel`, `databaseName` (Task 3).
- Produces:
  - `parseDotenv(text: string): Record<string, string>` — ignores blank lines and `#` comments, accepts `export KEY=`, strips matching single or double quotes, keeps `=` inside values.
  - `previewVars(input: { cfg: PreviewConfig; pr: number; origin: string; secret: string; snapshotUrl?: string; adminEmail: string }): Record<string, string>` — the generated layer: the fixed values from Global Constraints, `CRAFT_APP_ID=preview-<slug>-<pr>`, `CRAFT_SECURITY_KEY=derive(secret,"security-key",label,64)`, DB name/user/password, `PREVIEW_ADMIN_EMAIL`, `PREVIEW_ADMIN_PASSWORD=derive(secret,"admin-password",label,20)`, `PREVIEW_LANGUAGE`, `PREVIEW_BUILD_COMMAND` when set, `PREVIEW_SNAPSHOT_URL` when set, and every `siteUrls` entry resolved against `origin`.
  - `composeEnv(layers: Record<string, string>[]): Record<string, string>` — later layers win.
  - `renderDotenv(vars: Record<string, string>): string` — `KEY='value'` lines; throws naming the key when a value contains a single quote.
  - `readExampleEnv(dir: string): Record<string, string>` — reads `.env.example.dev` if present, else `.env.example`, else `{}`.

- [ ] **Step 1: Write the failing tests**

```ts
test("parseDotenv handles quotes, export, comments", () => {
  const vars = parseDotenv(`# c\nexport A="x=y"\nB='q'\nC=plain\n\nD=`);
  assert.deepEqual(vars, { A: "x=y", B: "q", C: "plain", D: "" });
});
test("previewVars sets fixed preview values and site urls", () => {
  const cfg = PreviewConfig.parse({ slug: "nch", siteUrls: { PRIMARY_SITE_URL: "/", EN_URL: "/en" } });
  const v = previewVars({ cfg, pr: 42, origin: "https://pr-42-nch.on-forge.com", secret: "s", adminEmail: "p@x.no" });
  assert.equal(v.CRAFT_ALLOW_ADMIN_CHANGES, "true");
  assert.equal(v.CRAFT_DB_DATABASE, "pv_nch_42");
  assert.equal(v.EN_URL, "https://pr-42-nch.on-forge.com/en");
  assert.equal(v.PREVIEW_ADMIN_PASSWORD.length, 20);
  assert.equal("CRAFT_TEST_TO_EMAIL_ADDRESS" in v, false);
});
test("composeEnv: generated values override the example file", () =>
  assert.deepEqual(composeEnv([{ A: "1", B: "2" }, { B: "3" }]), { A: "1", B: "3" }));
test("renderDotenv rejects single quotes", () =>
  assert.throws(() => renderDotenv({ K: "it's" }), /K/));
test("readExampleEnv returns {} when no file", () =>
  assert.deepEqual(readExampleEnv(mkdtempSync(join(tmpdir(), "pv-"))), {}));
test("readExampleEnv prefers .env.example.dev", /* write both files, expect the dev one's value */);
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `src/env.ts`** — move `dotenv`, `parseExtraEnv` (now `parseDotenv`) and the quoting out of `cli.ts`.

- [ ] **Step 4: Run** — `npm test`, all pass.

- [ ] **Step 5: Commit** — `git commit -m "Compose preview .env from example file and generated values"` with trailer.

---

### Task 5: Trigger resolution

**Files:**
- Create: `src/trigger.ts`
- Test: `tests/trigger.test.ts`

**Interfaces:**
- Produces:
  - `type Command = "up" | "down" | "sweep" | "skip"`
  - `type TriggerEvent = { event_name: string; action?: string; label?: { name: string }; pull_request?: { number: number; labels: { name: string }[]; head: { ref: string; sha: string; repo: { full_name: string } | null } }; repository: { full_name: string } }`
  - `resolveCommand(event: TriggerEvent, labelName = "preview"): Command` per the spec's trigger table: `schedule`/`workflow_dispatch` → `sweep`; `pull_request` from a fork → `skip`; `labeled` with the label → `up`; `synchronize`/`reopened` with the label present → `up`, else `skip`; `unlabeled` of the label → `down`; `closed` → `down` (regardless of label; `down` is idempotent); anything else → `skip`.
  - `readEvent(eventName: string, eventPath: string): TriggerEvent` — reads `GITHUB_EVENT_PATH` JSON and attaches `event_name`.

- [ ] **Step 1: Write the failing tests** — one per row of the table, plus `unlabeled` of `wip` on a PR still labelled `preview` → `skip`, and a fork PR (`head.repo.full_name !== repository.full_name`) → `skip`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement `src/trigger.ts`.**

- [ ] **Step 4: Run** — all pass.

- [ ] **Step 5: Commit** — `git commit -m "Resolve the preview command from the PR event and label"` with trailer.

---

### Task 6: Forge client fixes

**Files:**
- Modify: `src/forge.ts`
- Test: `tests/forge.test.ts` (stub `globalThis.fetch`)

**Interfaces:**
- Produces, on `class Forge` (constructor unchanged: `(token, org, serverId)`):
  - `getSite(siteId: string): Promise<Resource<SiteAttrs>>` → `GET /orgs/{org}/sites/{siteId}` (org-scoped, not server-scoped). `SiteAttrs` gains `url: string | null`.
  - `findSiteByLabel(label: string): Promise<Resource<SiteAttrs> | null>` → lists `/sites` and returns the first whose `name === label || name.startsWith(label + ".")`.
  - `findDatabase(name)`, `findDatabaseUser(name)` → `GET .../database/schemas?filter[name]=<name>` (resp. users), returning the entry whose `attributes.name === name` or null.
  - `siteReady(site: Resource<SiteAttrs>): boolean` — exported pure function: throws `Error("Site <name> failed to install")` on status `failed`; true when status is neither `creating` nor `installing` and `repository?.status === "installed"`.
  - `deploymentOutcome(status: string): "running" | "finished" | "failed"` — `pending|queued|deploying` → running, `finished` → finished, else failed.
  - Remove every `VERIFY` comment. Everything else (create site, env, script, deploy, security rule, domains, certificates, delete) stays.

- [ ] **Step 1: Write the failing tests** — a `fetch` stub that records `(method, url)` and returns canned JSON:
  - `getSite("7")` requests `https://forge.laravel.com/api/orgs/acme/sites/7`.
  - `findDatabase("pv_nch_42")` requests `.../servers/5/database/schemas?filter%5Bname%5D=pv_nch_42` (or the unencoded form; assert with `decodeURIComponent`) and returns null when the only result is `pv_nch_421`.
  - `findSiteByLabel("pr-42-nch")` returns the site named `pr-42-nch.on-forge.com` and not `pr-421-nch.on-forge.com`.
  - `siteReady` throws on `failed`, false on `installing`, true on `installed` + repository installed.
  - `deploymentOutcome("failed-build")` → `failed`.
  - A 429 with `retry-after: 0` is retried once and the second response is returned.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement** — keep `#base` for server-scoped paths and add `#orgBase` for `/orgs/{org}`.

- [ ] **Step 4: Run** — `npm run check`, all pass.

- [ ] **Step 5: Commit** — `git commit -m "Forge client: org-scoped site show, filtered lookups, status predicates"` with trailer.

---

### Task 7: GitHub client and CLI orchestration

**Files:**
- Modify: `src/github.ts`, `src/cli.ts`, `action.yml` (only the `command` input becomes optional, default empty)
- Test: `tests/github.test.ts`; `npm run typecheck` for `cli.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6.
- Produces:
  - `GitHub.prInfo(pr: number): Promise<{ state: "open" | "closed"; labels: string[] }>` replaces `prState` (one `GET /pulls/{n}`).
  - `src/cli.ts` command flow:
    - command = `process.argv[2]` if given, else `resolveCommand(readEvent(...))`. `skip` prints why and exits 0.
    - `up`: label and database names from Task 3; comment "building"; `findSiteByLabel`; if absent, create database (reuse existing), create site with `domain_mode: "on-forge"` and `name: label` when `cfg.domain.mode === "on-forge"`, or `domain_mode: "custom"`, `name: <label>.<baseDomain>`, `www_redirect_type: "none"`, `allow_wildcard_subdomains: false` in custom mode; poll `getSite` with `siteReady`; in custom mode clone the certificate onto the domain record named `<label>.<baseDomain>`; add the security rule. Every run: `origin = originFor(site.attributes)`, `.env` = `renderDotenv(composeEnv([readExampleEnv(workspace), previewVars(...), cfg.env, parseDotenv(EXTRA_ENV)]))`, deploy script, deploy, poll with `deploymentOutcome`, comment with origin, `/admin`, basic auth user, admin user `preview` and the derived admin password, commit sha, and the line "Uploads are not supported in previews."
    - `down(pr, reason)`: as the draft, using `findSiteByLabel`.
    - `sweep`: collect PR numbers from `listSites` via `prFromSiteName` and from `listDatabases` via `prFromDatabaseName`; for each, `prInfo`; remove when closed, when older than `maxAgeDays`, or when open without the `preview` label and a site exists. Databases without a site: only when closed.
    - Env vars read: `CONFIG_PATH`, `WORKSPACE` (checkout dir for `.env.example`), `FORGE_TOKEN`, `FORGE_ORG`, `FORGE_SERVER_ID`, `PREVIEW_SECRET`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD`, `ADMIN_EMAIL`, `EXTRA_ENV`, `SNAPSHOT_URL`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`. Removed: `DB_DRIVER`, `TEST_EMAIL`, `PREVIEW_DOMAIN`, `CRAFT_SECURITY_KEY`.
    - Outputs: `url`, `removed` as today.

- [ ] **Step 1: Write the failing test for `prInfo`** — fetch stub returns `{ state: "open", labels: [{ name: "preview" }] }`; assert `{ state: "open", labels: ["preview"] }`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `prInfo`, delete `prState`.**

- [ ] **Step 4: Rewrite `src/cli.ts`** against the flow above, deleting the code that moved to Tasks 3 to 5.

- [ ] **Step 5: Verify** — `npm run check` passes; `node src/cli.ts bogus` prints `Unknown command "bogus"` and exits 1; with `GITHUB_EVENT_NAME=schedule` and an event file `{}` plus the required env vars set to dummies and `FORGE_TOKEN=x`, `node src/cli.ts` reaches the sweep and fails on the first Forge call with a 401 message, proving the dispatch path.

- [ ] **Step 6: Commit** — `git commit -m "CLI: label-gated up/down/sweep on on-forge hostnames"` with trailer.

---

### Task 8: Deploy script

**Files:**
- Modify: `deploy-script.sh`
- Test: `tests/deploy-script.test.sh` (bash, craft-ci's `lib.sh` style: PATH shims for `git`, `composer`, `php`, `curl`, `gunzip` that log their arguments to `$T/calls`)

**Interfaces:**
- Consumes `.env` variables from Task 4 (sourced by Forge via `auto_source`): `PREVIEW_SNAPSHOT_URL`, `PREVIEW_ADMIN_EMAIL`, `PREVIEW_ADMIN_PASSWORD`, `PREVIEW_LANGUAGE`, `PREVIEW_BUILD_COMMAND`, `PRIMARY_SITE_URL`, plus Forge's `FORGE_SITE_PATH`, `FORGE_SITE_BRANCH`, `FORGE_COMPOSER`, `FORGE_PHP`.
- Produces the script behaviour:
  1. `git fetch origin "$FORGE_SITE_BRANCH"` then `git reset --hard "origin/$FORGE_SITE_BRANCH"`.
  2. `composer install` as the draft; build command when set.
  3. If `storage/.preview-seeded` is absent: restore the snapshot (`craft db/restore`) or `craft install/craft` as the draft; after a restore, `craft users/create --admin=1 --username=preview --email="$PREVIEW_ADMIN_EMAIL" --password="$PREVIEW_ADMIN_PASSWORD" --interactive=0 || craft users/set-password preview --password="$PREVIEW_ADMIN_PASSWORD" --interactive=0`; write the marker only after the seed succeeded (`set -e` already guarantees this; the marker line stays last in the block).
  4. `craft up --interactive=0`.

- [ ] **Step 1: Write the failing shell test**

Tests: `test_first_run_restores_and_creates_admin` (calls log contains `db/restore`, then `users/create`, then `up`; marker exists), `test_second_run_skips_seed` (marker present: no `db/restore`, `up` present), `test_fresh_install_without_snapshot` (no `PREVIEW_SNAPSHOT_URL`: `install/craft` present, no `users/create`), `test_uses_fetch_and_reset` (calls contain `fetch origin feature` and `reset --hard origin/feature`, no `pull`), `test_failed_seed_leaves_no_marker` (php shim exits 1 on `db/restore`: script exits non-zero, marker absent).

- [ ] **Step 2: Run** — `bash tests/deploy-script.test.sh`, expected: `pull` and admin assertions fail.

- [ ] **Step 3: Edit `deploy-script.sh`** as in Interfaces. Keep the header comment.

- [ ] **Step 4: Run** — the test passes; `shellcheck deploy-script.sh` clean (source-time variables excused with `# shellcheck disable=SC2154` at the top).

- [ ] **Step 5: Commit** — `git commit -m "Deploy script: hard reset, admin user after restore"` with trailer.

---

### Task 9: Action, example workflow, README

**Files:**
- Modify: `action.yml`, `examples/client-repo/.github/workflows/preview.yml`, `examples/client-repo/.craft-preview.json`, `README.md`
- Test: `tests/action-yml.test.sh` (ruby structural check as craft-ci's), `actionlint examples/client-repo/.github/workflows/preview.yml`

**Interfaces:**
- `action.yml` inputs: `command` (optional), `config-path`, `forge-token`, `forge-org`, `forge-server-id`, `preview-secret`, `basic-auth-user` (default `preview`), `basic-auth-password`, `admin-email` (default `previews@netlife.no`), `extra-env`, `snapshot-key`, `snapshot-secret`, `snapshot-bucket` (default `netlife-craft-snapshots`), `snapshot-region` (default `fra1`), `github-token`, `workspace` (default `${{ github.workspace }}`). Removed: `preview-domain`, `db-driver`, `test-email`, `security-key`, `spaces-*`.
- Steps: setup-node 24, `npm ci`, presign (uses `snapshot-*`, masks the URL, runs whenever the manifest has a `snapshotKey` and `snapshot-key` is set; the CLI ignores it for `down` and `sweep`), run. The "Remove preview uploads" step is deleted.
- Example workflow: triggers `pull_request: [labeled, unlabeled, synchronize, reopened, closed]`, `schedule` 03:00 UTC, `workflow_dispatch`; no `command` input; sparse checkout of `.craft-preview.json`, `.env.example` and `.env.example.dev` (closed PRs check out the default branch as today); concurrency per PR; secrets `FORGE_API_TOKEN`, `PREVIEW_SECRET`, `PREVIEW_BASIC_AUTH_PASSWORD`, `SNAPSHOT_READ_KEY`, `SNAPSHOT_READ_SECRET`; variables `FORGE_ORG`, `FORGE_PREVIEW_SERVER_ID`.
- Example manifest: `slug nch`, `phpVersion php82`, `buildCommand "npm ci && npm run build"`, `snapshotKey snapshots/nch/latest.sql.gz`, no `ssl`, no `domain` (default).
- README: rewrite from the spec: how a preview works, label gating, on-forge hostnames and the Craft banner, one-time setup (Laravel VPS, Redis check, token scopes, secrets), onboarding, first-run checklist, the custom-domain option as future.

- [ ] **Step 1: Write `tests/action-yml.test.sh`** asserting the input set above, that no input named `spaces-key` or `preview-domain` exists, every `run` step has `shell: bash` and passes `bash -n`, and the "Remove preview uploads" step is gone.

- [ ] **Step 2: Run** — fails on the old inputs.

- [ ] **Step 3: Edit `action.yml`, the example workflow and manifest, then the README.**

- [ ] **Step 4: Verify** — `bash tests/action-yml.test.sh` passes; `actionlint examples/client-repo/.github/workflows/preview.yml` clean; `npm run check` passes.

- [ ] **Step 5: Commit** — `git commit -m "Action inputs, example workflow and README for label-gated on-forge previews"` with trailer.

---

### Task 10: Publish and first live run

Manual. Each step has a checkable result. Needs a Forge API token with the scopes in the spec, and a developer watching the pilot (Feedsystem/nch).

- [ ] **Step 1: Push** — create `netliferesearch/craft-preview` (public), push `main`, tag `v1`. Check: `gh repo view netliferesearch/craft-preview` shows the tag.

- [ ] **Step 2: Server** — in Forge, create a Laravel VPS app server named `craft-preview` (Ubuntu 24.04, MySQL, PHP 8.2 and 8.4, Medium or Large, an EU region). Check: server `is_ready`, `redis-cli ping` over the Forge terminal returns `PONG`, GitHub connection lists `Feedsystem/nch`.

- [ ] **Step 3: Secrets** — on nch add `FORGE_API_TOKEN`, `PREVIEW_SECRET`, `PREVIEW_BASIC_AUTH_PASSWORD` (repo secrets until org secrets exist) and variables `FORGE_ORG`, `FORGE_PREVIEW_SERVER_ID`. Create the `preview` label on nch. Copy the example manifest and workflow into nch on a branch, open the PR.

- [ ] **Step 4: On-forge naming** — label the PR `preview`. Check in the run log and Forge: what `name` produced, the hostname in the site resource, HTTPS answering before the security rule, basic auth after it. If `name` must be the full host, change `cli.ts` accordingly (one line) and `findSiteByLabel` still matches.

- [ ] **Step 5: Site and deploy** — check `/web` is the web directory, the deployment log shows `db/restore`, `users/create`, `up`; the site renders with images; the control panel logs in with `preview` and the comment's password and shows the license banner only.

- [ ] **Step 6: Lifecycle** — push a commit (redeploy, comment updated), remove the label (site, database, user gone in Forge, security rule gone with the site), relabel (rebuilt), close the PR (removed). Next morning: the sweep run is green and removes nothing.

- [ ] **Step 7: Record** — add a Pilot log row in the fleet design doc and update the Obsidian note's preview status; move "Renovate adds the `preview` label to the minor group" to the renovate repo's TODO.
