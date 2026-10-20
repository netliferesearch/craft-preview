# craft-preview

Per-PR preview sites for Craft CMS projects, on a Laravel Forge server (DigitalOcean).

Opening a PR creates `pr-42-acme.preview.netlife.no`: a Forge site on the PR branch, with its own database
seeded from a sanitized staging snapshot, behind basic auth. Every push redeploys it. Closing the PR
removes the site, database, DB user and uploaded files. A nightly sweep catches anything the close event missed.

It's a composite GitHub Action. This repo holds the fixed core; each client repo carries a small
`.craft-preview.json` and a short workflow that calls it (see `examples/client-repo/`).

## How a preview is built

1. **Database**: `pv_<slug>_<pr>` plus a matching user, created via the Forge API.
2. **Site**: a PHP site on the PR branch, web directory `/web`, in-place deploys, sharing the server's PHP-FPM pool.
3. **SSL, then basic auth**: the certificate is issued before basic auth so the HTTP-01 challenge isn't blocked.
4. **`.env`**: generated on every run. All per-preview secrets are derived from `PREVIEW_SECRET` + hostname,
   so there's no state to store and config changes reach existing previews on their next push.
5. **Deploy** (`deploy-script.sh`): composer install and the optional build. On the first deploy it restores
   the snapshot, or does a fresh install from project config if there's no snapshot. Then `craft up`.

Previews run with `allowAdminChanges=false` (schema changes only come from the PR), `disallowRobots`,
the queue running automatically, and all outgoing mail redirected to `test-email`.

## One-time setup

**Preview server.** Provision a dedicated droplet in Forge (4–8 GB RAM) with MySQL or Postgres and the
PHP versions your Craft sites need. Keep it separate from client production and staging servers.
Make sure Forge's GitHub connection can read every client repo that will use previews.

**DNS.** Add a wildcard record `*.preview.netlife.no` pointing at the droplet.

**SSL.** Either:
- `"ssl": { "mode": "clone", "certificateId": … }` *(recommended)*. Create an anchor site on the server,
  issue a wildcard cert for `*.preview.netlife.no` on it with DNS-01 verification, and use that cert's ID.
  Every preview clones it instantly, with no Let's Encrypt rate limits.
- `"ssl": { "mode": "letsencrypt" }`. One HTTP-01 cert per preview. Fine at low volume, but Let's Encrypt
  limits certificates per registered domain per week.

**Snapshots.** A separate nightly job (not included here) should dump each client's staging database,
scrub users, form submissions and other PII, and upload it to `snapshots/<slug>/latest.sql.gz` in the bucket.
The action presigns a 7-day URL, so the preview server never holds bucket credentials.

**Organization secrets and variables** (Settings → Secrets and variables → Actions, at org level):

| Name | Kind | Value |
|---|---|---|
| `FORGE_API_TOKEN` | secret | Forge API token |
| `PREVIEW_SECRET` | secret | Long random string (`openssl rand -hex 32`) |
| `PREVIEW_BASIC_AUTH_PASSWORD` | secret | Shared basic auth password for previews |
| `SPACES_KEY`, `SPACES_SECRET` | secret | DigitalOcean Spaces access key |
| `FORGE_ORG` | variable | Forge organization slug |
| `FORGE_PREVIEW_SERVER_ID` | variable | ID of the preview server |
| `PREVIEW_DOMAIN` | variable | `preview.netlife.no` |

**Repo access.** If this repo is private, allow other repos in the org to use it:
Settings → Actions → General → Access → "Accessible from repositories in the organization".

## Onboarding a client repo

1. Copy `examples/client-repo/.craft-preview.json` and `.github/workflows/preview.yml` into the repo.
2. Set `slug` (2–12 chars) and adjust `siteUrls` for multi-site setups.
3. Point the project's asset volumes at the bucket using env vars, with `$ASSETS_SUBPATH` as the subpath,
   so each preview's uploads land under `previews/<slug>/pr-<n>/` and are deleted on teardown.
4. Open a PR.

## First-run checklist

The Forge API v2 endpoints for creating sites, databases, env, deploy scripts, deployments, security rules
and certificates were checked against Forge's API reference. These were **not** confirmed, and are marked
`VERIFY` in `src/forge.ts`:

- `GET` and `DELETE /sites/{site}`
- `GET /database/schemas`, `GET` and `DELETE /database/schemas/{id}`
- `GET /database/users`, `DELETE /database/users/{id}`
- `GET /sites/{site}/domains`, and that domain records expose `name`

Also check on the first preview:

- The site gets `/web` as its web directory. v2 might expect a different path format than `/web`.
- Deleting a site also removes its security rule and certificate.
- `craft install/craft` and `craft db/restore` run cleanly for a Craft 5 project on the server.

## Capacity and cost

Non-isolated sites share one PHP-FPM pool, so idle previews cost little beyond disk and the database.
The main memory spike is `npm run build` on the server. If several PRs deploy at once and the droplet
struggles, move the frontend build into GitHub Actions and ship the built assets instead.

## Development

```bash
npm install
npm run typecheck
```

The action runs `src/cli.ts` directly on Node 24 with built-in type stripping. There's no build step,
so only erasable TypeScript syntax is allowed (no enums, namespaces or parameter properties).
