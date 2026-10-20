# craft-preview

Per-PR preview sites for Craft CMS projects, on a Laravel Forge server.

Add the `preview` label to a PR and a few minutes later the PR has a link: a Forge site on the PR
branch, seeded from the same scrubbed database snapshot that `verify` uses, reachable over HTTPS
on a Forge-provided `on-forge.com` hostname, behind basic auth. Every push to the PR redeploys it.
Removing the label, closing the PR, or the nightly sweep removes the site, its database and user.

It is a composite GitHub Action. This repo holds the fixed core; each client repo carries a small
`.craft-preview.json` and a short workflow that calls it (see `examples/client-repo/`).

Part of Netlife's Craft fleet update automation. Previews are for the PRs automation hands back
to people: Craft minor updates and anything else that cannot automerge on `verify` alone.
Design: `docs/superpowers/specs/2026-10-19-craft-preview-design.md`.

## What happens

| Event on the PR | Result |
| --- | --- |
| `preview` label added | Site created and deployed. Comment with the URL, basic auth user and admin login. |
| Push while labelled | Redeployed. Same database, so content survives; the PR's migrations and project config are applied. |
| `preview` label removed, or PR closed | Site, database and DB user removed. |
| Nightly sweep (03:00 UTC) | Removes previews whose PR is closed, lost the label, or is older than `maxAgeDays`. |

PRs from forks are skipped (no secrets). Other labels do nothing.

### How a preview is built

1. **Database** `pv_<slug>_<pr>` plus a matching user, through the Forge API.
2. **Site** named `pr-<pr>-<slug>`, a PHP site on the PR branch, web directory `/web`, in-place
   deploys, sharing the server's PHP-FPM pool. Forge assigns `<name>.on-forge.com` with HTTPS.
3. **Basic auth** on the whole site.
4. **`.env`**, regenerated on every run: the repo's `.env.example` (or `.env.example.dev`) first,
   then the preview values on top, then the manifest's `env`, then the workflow's `extra-env`.
   Per-preview secrets are derived from `PREVIEW_SECRET` and the site name, so nothing is stored.
5. **Deploy** (`deploy-script.sh`): fetch and hard-reset to the branch, `composer install`, the
   optional build command. On the first deploy it restores the snapshot (or installs Craft from
   project config when the manifest has no snapshot) and creates the `preview` admin user, because
   the snapshot has every password scrubbed. Then `craft up`.

Previews run with `CRAFT_ENVIRONMENT=preview`, dev mode off, admin changes on (update migrations
write project config; the branch stays the source of truth because every push redeploys),
robots disallowed and the queue running automatically. Mail is not configured: the preview server
blocks SMTP ports, so a send attempt is logged and nothing leaves. Uploads are not supported.

### The Craft license banner

Craft treats `pr-42-nch.on-forge.com` as a public domain, so the control panel shows a
license-mismatch banner on previews. The front end is unaffected. Accepted for now; the manifest's
`domain` block can switch a site to a custom catch-all domain later (see below).

## One-time setup

**Preview server.** In Forge, create a Laravel VPS app server (Ubuntu 24.04, MySQL, the PHP
versions your sites need, Medium or Large, an EU region). Ubuntu 26.04 offers only PHP 8.4 and 8.5
on Forge, so stay on 24.04 while any site in the fleet runs 8.2 or 8.3. Keep it separate from client production
and staging servers. Confirm Redis is running (Forge app servers ship it; sites that cache in Redis
expect it on localhost). Make sure Forge's GitHub connection can read every client repo that will
use previews.

**Snapshots.** Produced by `netliferesearch/craft-ci`'s nightly job into `netlife-craft-snapshots`
(`fra1`) as `snapshots/<slug>/latest.sql.gz`. The action presigns a 7-day URL with the same
read-only key `verify` uses, so the preview server never holds bucket credentials.

**Secrets and variables** (org level once available, repo level until then):

| Name | Kind | Value |
| --- | --- | --- |
| `FORGE_API_TOKEN` | secret | Forge API token. Scopes: site create, delete, meta, manage-deploys, manage-environment, manage-security, manage-ssl; server view, create-databases, delete-databases. |
| `PREVIEW_SECRET` | secret | `openssl rand -hex 32` |
| `PREVIEW_BASIC_AUTH_PASSWORD` | secret | Shared basic auth password for previews |
| `SNAPSHOT_READ_KEY`, `SNAPSHOT_READ_SECRET` | secret | Already present for `verify` |
| `FORGE_ORG` | variable | Forge organization slug |
| `FORGE_PREVIEW_SERVER_ID` | variable | ID of the preview server |

## Onboarding a client repo

1. Copy `examples/client-repo/.craft-preview.json` and `.github/workflows/preview.yml` into the repo.
2. Set `slug` (2 to 12 chars), `phpVersion`, `buildCommand` and `snapshotKey`. Adjust `siteUrls`
   for multi-site setups.
3. Create the `preview` label in the repo.
4. If the site keeps assets in S3, pass read-only credentials through `extra-env` so images render.
5. Label a PR.

### Manifest

| Field | Default | Notes |
| --- | --- | --- |
| `slug` | required | Lowercase, 2 to 12 chars, starts with a letter. Used in site and DB names. |
| `phpVersion` | `php84` | `php82` to `php85` |
| `webDirectory` | `/web` | |
| `buildCommand` | none | Runs on the server during deploy |
| `snapshotKey` | none | Omit for a fresh install from project config |
| `siteUrls` | `{ "PRIMARY_SITE_URL": "/" }` | Env var to path, resolved against the preview origin |
| `env` | `{}` | Non-secret env vars for this client |
| `domain` | `{ "mode": "on-forge" }` | See below |
| `language` | `nb-NO` | Fresh installs only |
| `maxAgeDays` | `14` | The sweep removes older previews even if the PR is open |

### Custom catch-all domain (later)

`"domain": { "mode": "custom", "baseDomain": "preview.netlife.no", "certificateId": 123 }` names
sites `pr-42-nch.preview.netlife.no` and clones the given certificate onto each one. It needs a
wildcard DNS record for the base domain and an anchor site in Forge holding a DNS-01 wildcard
certificate. Craft treats a `preview` subdomain as a development domain, so the license banner
goes away. The code path exists; it has not been run.

## First-run checklist

On the first preview, with a developer watching:

1. On-forge naming through the API: what the site `name` produced, the hostname in the site
   resource, HTTPS answering before the security rule, basic auth after it.
2. `/web` is the web directory; the deployment log shows `db/restore`, `users/create`, `up`.
3. The site renders with images; the control panel logs in as `preview` with the comment's
   password and shows the license banner only.
4. Push, unlabel, relabel, close, and the next morning's sweep.

## Development

```bash
nvm use 24
npm install
npm run check          # typecheck + node:test
bash tests/deploy-script.test.sh
bash tests/action-yml.test.sh
```

The action runs `src/cli.ts` directly on Node 24 with built-in type stripping. There is no build
step, so only erasable TypeScript syntax is allowed (no enums, namespaces or parameter properties).
