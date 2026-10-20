# craft-preview: per-PR preview sites on Laravel Forge

Design, 19 October 2026. Supersedes the draft README's architecture where they differ.
Part of the Craft Fleet Update Automation (layer 4, "Previews"). The fleet design lives in the
Claude doc "Craft Fleet Update Automation"; this document is the preview track in full.

## Intent

A developer who has to merge a Craft minor update, or any other PR that cannot automerge,
should be able to click a link and look at the site running that branch against real content,
without checking anything out. Verify (layer 1) proves the branch boots and the sitemap renders.
A preview lets a human look at it. That is the whole purpose: a reviewing surface for the PRs
automation hands back to people.

## Goals

- A PR labelled `preview` gets a working Craft site on its branch, seeded from the same scrubbed
  snapshot verify uses, reachable over HTTPS behind basic auth, within a few minutes of the label.
- Every push to a labelled PR redeploys the preview.
- Removing the label, closing the PR, or a nightly sweep removes everything the preview created.
- A client repo adopts previews by copying one manifest and one workflow file. No new snapshot
  secrets: it reuses what verify already has.
- Nothing stateful lives outside Forge, the bucket and GitHub. Any run can rebuild a preview's full
  configuration from the secret, the manifest and the PR number.

## Non-goals

- Previews for every PR. Patches automerge on verify alone.
- Reviewer uploads or content work on a preview. Previews are for looking.
- Production-like performance or isolation. Previews share one server and one PHP-FPM pool.
- A custom preview domain in the first version. The design keeps the door open (see Domain).
- Moving the frontend build off the server. Noted as a follow-up if the server struggles.

## Anti-goals

- A preview that touches production or staging: no shared database, no writes to the live site.
- A leaked preview: no preview without basic auth, no preview indexable by robots.
- Orphans that cost money: a preview the sweep cannot find and remove is a failure.
- A preview that silently shows the wrong branch or stale config.

## Decisions already made

| Decision | Choice | Decided by |
| --- | --- | --- |
| Hostnames | Forge-provided `on-forge.com` domains, zero DNS. Craft's control panel shows a license-mismatch banner on them; accepted for now. | Svale, 19 Oct 2026 |
| When a preview is built | Only PRs carrying the `preview` label. | Svale, 19 Oct 2026 |
| Preview server | One shared Laravel VPS server, created in Forge, billed hourly through Forge. Per-PR sites on it, non-isolated. | Claude's call, accepted |
| Custom domain later | Supported through a `domain.mode: custom` manifest option that reuses the draft's clone-certificate code. Not built or tested in v1 beyond keeping the code path. | Svale: "as long as we can enhance with a custom catch-all domain later" |

## Constraints from research (19 Oct 2026)

Forge API v2 facts the design rests on. Source: the published OpenAPI spec at
`forge.laravel.com/api/docs.openapi` and the Forge docs.

- Base path `https://forge.laravel.com/api/orgs/{org}/servers/{server}/...`. Bearer token.
  60 requests per minute per user. Cursor pagination, 30 per page, `filter[name]` on list endpoints.
- **Site show is org-scoped:** `GET /orgs/{org}/sites/{site}`. There is no
  `GET /orgs/{org}/servers/{server}/sites/{site}` (only PUT and DELETE). The draft polls the wrong path.
- Create site: `POST .../sites` with `type`, `name`, `domain_mode` (`on-forge` or `custom`),
  `web_directory`, `php_version`, `is_isolated`, `zero_downtime_deployments`, `source_control_provider`,
  `repository`, `branch`, `install_composer_dependencies`, `push_to_deploy`, `tags`. Returns 202 with
  the site resource; status moves through `creating`/`installing` to `installed`, and
  `repository.status` to `installed`. Site attributes include `url` and `name`.
- Zero-downtime deployments default on and can only be set at creation. Previews pass `false`.
- Databases: `POST .../database/schemas` with `name`, `user`, `password` creates schema plus user.
  `GET`/`DELETE .../database/schemas/{id}`, `GET`/`DELETE .../database/users/{id}`, both lists filterable.
- Environment: `PUT .../sites/{site}/environment` `{ environment }`. Deploy script:
  `PUT .../sites/{site}/deployments/script` `{ content, auto_source }`. Deploy:
  `POST .../sites/{site}/deployments`, poll `GET .../deployments/{id}` until not
  `pending|queued|deploying`; terminal states `finished|failed|failed-build|cancelled`.
- Security rules: `POST .../sites/{site}/security-rules` `{ name, credentials: [{username,password}] }`,
  no `path` protects the whole site.
- Domains: `GET .../sites/{site}/domains` returns records with `name`, `type` (`primary|alias`),
  `status`. Certificates per domain record, `POST .../domains/{id}/certificates`
  with `type: clone, clone: { certificate_id }`. Needed only for the future custom mode.
- Forge domains: every site gets `<label>.on-forge.com`, proxied by Cloudflare with HTTPS, available
  as soon as the site exists. Not for production use, intended for previews. Not available on load balancers.
- Laravel VPS: `POST /orgs/{org}/servers` with `provider: laravel`, `laravel: { region_id, size_id }`,
  `type: app`, `ubuntu_version`, `php_version`, `database_type`. Instant provisioning for sizes
  Small to X Large in the Laravel-managed network. Cannot be archived or transferred; deleting removes
  the VM. Mail ports 25, 465, 587 are blocked. Hourly billing, 1-hour minimum, from about $6 a month.
- Craft licensing: a hostname is a development domain only if a subdomain segment is exactly one of
  Craft's keywords (`preview`, `staging`, `test`, ...) or the platform is on Craft's list
  (`ddev.site`, `herokuapp.com`, ...). `pr-42-nch.on-forge.com` is public, so the control panel shows
  a mismatch banner. The front end is never affected. Pixel & Tonic add platform exemptions on request.
- The Forge CLI has no site-creation command and is not used by the action. Community Forge MCP
  servers exist (no official one); useful for driving the first live run by hand, not part of the action.

## How a preview works

### Triggers

The client workflow runs on `pull_request` with types `labeled`, `unlabeled`, `synchronize`,
`reopened`, `closed`, plus a nightly `schedule` and `workflow_dispatch` for the sweep.

| Event | Condition | Command |
| --- | --- | --- |
| `labeled` with `preview` | label name is `preview` | `up` |
| `synchronize`, `reopened` | PR has the `preview` label | `up` |
| `unlabeled` | the removed label is `preview` | `down` |
| `closed` | PR has the `preview` label, or had one (a site exists) | `down` |
| `schedule`, `workflow_dispatch` | always | `sweep` |

Everything else is skipped by the job's `if`. Forks are skipped (no secrets). Concurrency group per
PR, never cancelling a run in progress. Renovate adds the label to the monthly minor group through
the preset once the track has worked on a real PR; that is a change in netliferesearch/renovate,
not here. Developers add the label by hand on feature PRs.

### `up`

1. Read the manifest. Compute names: site label `pr-<n>-<slug>`, database and user `pv_<slug>_<n>`.
2. Post or update the single PR comment: building.
3. Find the site by name with `filter[name]` on the server's site list. The name to filter on is
   the hostname Forge assigned, which on-forge mode decides; the run therefore matches on the
   label prefix and keeps the full hostname from the site resource. The builder confirms on the
   first run whether `name` becomes the label or the full host, and fixes the lookup accordingly.
4. If no site: create the database (reuse a leftover one with the same name), wait until
   `installed`; create the site with `domain_mode: on-forge`, `type: php`, PR branch, `/web`,
   non-isolated, no zero-downtime, no push-to-deploy, tags `craft-preview` and the slug; poll
   `GET /orgs/{org}/sites/{id}` until site and repository are `installed`; add the whole-site
   security rule. In `custom` domain mode, clone the certificate before the security rule.
5. Every run: write the `.env` and the deploy script, trigger a deployment, poll to a terminal
   state, update the PR comment with the URL, control panel link, basic auth user and commit.
   A failed deployment fails the job and the comment says so.

The `.env` is regenerated on every run from the secret, the hostname and the manifest, so a
config change reaches existing previews on their next push and no state is stored. Per-preview
secrets (DB password, security key, admin password) are HMAC derivations of `PREVIEW_SECRET`
and the hostname, as in the draft.

The `.env` is composed in the runner the way verify composes its own: the client repo's
`.env.example` (or `.env.example.dev`) first, then the generated preview values on top, then the
manifest's `env`, then `extra-env`. That is how site-specific variables such as `CRAFT_WEB_URL`,
Redis settings and asset bucket names reach a preview without being repeated in the manifest.
The workflow's sparse checkout widens to include that file.

Preview `.env` facts: `CRAFT_ENVIRONMENT=preview`, dev mode off, `allowAdminChanges` on,
robots disallowed, queue run automatically, `PRIMARY_SITE_URL` and the manifest's `siteUrls`
built from the assigned hostname, `CRAFT_APP_ID` unique per preview.

Admin changes are on for the same reason verify turned them on: Craft update migrations write to
project config, and a minor-update PR, the main use case, would fail at `craft up` with project
config read-only. The branch stays the source of truth because every push redeploys and
`craft up` reapplies the branch's YAML. If a preview deploy races verify's project-config commit,
verify's push fires `synchronize` and the preview redeploys.

Mail: nothing is configured, as in verify. SMTP variables from `.env.example` stay unset, Laravel
VPS blocks the ports anyway, and a send attempt is logged as an error. No mail leaves a preview.
The draft's `test-email` input and `CRAFT_TEST_TO_EMAIL_ADDRESS` go away.

### Deploy script

Unchanged in shape from the draft: fetch the branch and `git reset --hard origin/<branch>`
(Renovate force-pushes on rebase, so `git pull` would fail), `composer install`, optional build
command, seed once, then `craft up`. The seed marker stays in `storage/` and in-place deploys keep
it. To reset, remove and re-add the label.

Seeding restores the presigned snapshot, or runs `install/craft` from project config when the
manifest has no snapshot key. The scrub nulls every user's password, so after a restore the script
creates (or resets) an admin user `preview` with the derived admin password and the preview
admin email, so the control panel is usable. The PR comment prints the control panel link, the
user and that password: the content is scrubbed, the site sits behind basic auth, and the readers
of the comment are the people with read access to the repo.

### `down`

Delete the site, the database and the user by name lookup, remove preview uploads if any, update
the PR comment. Idempotent: missing resources are fine.

### `sweep`

List sites tagged `craft-preview` for this slug and databases matching `pv_<slug>_*`. For each PR
number: closed PR, or site older than `maxAgeDays`, means `down`. Open PRs that lost their label
but kept a site (a missed `unlabeled` event) are also removed. Databases without a site are only
removed once their PR is closed.

### Snapshots and assets

The snapshot is the one craft-ci already produces: bucket `netlife-craft-snapshots` in `fra1`,
key `snapshots/<slug>/latest.sql.gz`, read with the read-only key verify already has
(`SNAPSHOT_READ_KEY`, `SNAPSHOT_READ_SECRET`). The action presigns a 7-day URL so the server never
holds bucket credentials. The draft's separate `netlife-previews` bucket and `SPACES_*` secrets go.

Assets: previews point their volumes at the same asset storage as the snapshot source, with
whatever credentials verify receives through `extra-env` (on nch today: none; images render
through the public CDN URL from `.env.example`), so existing images render. Uploading in a
preview is unsupported and the PR comment says so. The draft's `ASSETS_SUBPATH` under
`previews/<slug>/pr-<n>` is dropped, since a preview seeded from a snapshot needs the source
assets, not an empty prefix. Image transforms that need a write will fail the same way verify's
do today until the asset-credentials question in the fleet design is settled.

## Manifest (`.craft-preview.json` in the client repo)

| Field | Default | Notes |
| --- | --- | --- |
| `slug` | required | 2 to 12 lowercase chars, starts with a letter. Hostname label and DB names. |
| `phpVersion` | `php84` | `php82` to `php85`. |
| `webDirectory` | `/web` | |
| `buildCommand` | none | Runs on the server during deploy. |
| `snapshotKey` | none | Omit for a fresh install from project config. |
| `siteUrls` | `{ "PRIMARY_SITE_URL": "/" }` | Env var to path, for multi-site. |
| `env` | `{}` | Non-secret env vars for this client. |
| `domain` | `{ "mode": "on-forge" }` | Or `{ "mode": "custom", "baseDomain": "preview.netlife.no", "certificateId": 123 }`. |
| `language` | `nb-NO` | Fresh installs only. |
| `maxAgeDays` | 14 | Sweep removes older previews even if the PR is open. |

The `ssl` block is replaced by `domain`. The draft's `db-driver` input goes: craft-ci snapshots
are MySQL dumps, so the preview server runs MySQL and nothing else is supported. Whether this file later merges with verify's inputs into
one manifest is a fleet-design question, not decided here.

## Secrets and variables

| Name | Kind | Scope | Value |
| --- | --- | --- | --- |
| `FORGE_API_TOKEN` | secret | org | Forge API token limited to the preview server's org, scopes: site create/delete/meta/manage-deploys/manage-environment/manage-security/manage-ssl, server create/delete-databases, server view. |
| `PREVIEW_SECRET` | secret | org | `openssl rand -hex 32`. |
| `PREVIEW_BASIC_AUTH_PASSWORD` | secret | org | Shared across previews. |
| `SNAPSHOT_READ_KEY`, `SNAPSHOT_READ_SECRET` | secret | repo today, org later | Already exist for verify. |
| `FORGE_ORG` | variable | org | Organization slug. |
| `FORGE_PREVIEW_SERVER_ID` | variable | org | The Laravel VPS server. |

Until org secrets exist (admin request already on the list), all are repo secrets on the pilot.
Client-specific secrets go through the `extra-env` input as today.

## One-time setup

1. Create the preview server in Forge: Laravel VPS, app server, Ubuntu 24.04, MySQL, PHP versions
   the fleet uses, size Medium or Large (instant tier). Region: an EU region, chosen in the Forge UI
   since the region list needs a token to read. Name `craft-preview`. Done by hand the first time;
   the API call is documented for later. Confirm Redis is installed and running: Forge app servers
   ship it, and the pilot's `config/app.php` points its cache at `localhost:6379`. A site whose
   Redis lives elsewhere sets `REDIS_HOSTNAME` through the manifest's `env`.
2. Make sure Forge's GitHub connection can read every client repo that will use previews.
3. Create the Forge API token, the two preview secrets, and the two variables.
4. Push this repo to `netliferesearch/craft-preview`, tag `v1`, public. The pilot lives in a
   different GitHub org (Feedsystem) and already consumes the public craft-ci, so a private action
   would not be reachable from it. No secrets or client data live here.

## First-run checklist

In order, on the pilot (Feedsystem/nch), with a developer watching and a Forge MCP or the API
at hand:

1. How on-forge naming works through the API: what `name` must contain, what hostname comes back
   in the site resource, and that the hostname is reachable with HTTPS before basic auth is added.
2. `GET /orgs/{org}/sites/{id}` reports the statuses the poll expects.
3. The site gets `/web` as web directory and `type: php` is accepted with `domain_mode: on-forge`.
4. Deleting the site removes its security rule; the sweep finds nothing left behind.
5. `craft db/restore` and `craft up` run cleanly for a Craft 5 project on the server.
6. The Craft control panel shows the license banner and nothing else is wrong.
7. Label, push, unlabel, relabel, close, and the next morning's sweep.

## Left to the builder

- Exact TypeScript shape of the client changes, as long as `src/forge.ts` stays a thin client
  with no Forge-specific SDK dependency.
- The label-matching expressions in the example workflow.
- How the PR comment reads.
- Test coverage for config parsing, naming, label logic and the sweep's decisions (pure functions),
  following the shell-test style craft-ci uses where that fits.
- Whether to keep Node 24 type stripping or add a build step.

## Deferred, with a pointer

- Custom catch-all domain: `domain.mode: custom` needs wildcard DNS for the base domain, an anchor
  site with a DNS-01 wildcard certificate (one CNAME to Forge, no DNS provider token), and the
  certificate id in the manifest. The clone code from the draft stays for this.
- Ask Pixel & Tonic to add `on-forge.com` to Craft's development-domain list.
- Frontend build in Actions with built assets shipped to the server, if the shared server's
  memory becomes the bottleneck.
- Asset credentials: a write-capable key scoped to the preview, or a transform strategy, once the
  fleet design settles the verify-side question.
- Per-PR throwaway Laravel VPS servers instead of per-PR sites, if isolation ever matters.
  Cheap and fast enough to be worth a spike, not needed for the stated purpose.
