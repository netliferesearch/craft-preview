# Forge deploy script for Craft CMS preview sites.
# Managed by netlife/craft-preview: edits made in the Forge UI are overwritten on every push.
# The site's .env is sourced into this script (auto_source), so PREVIEW_* and CRAFT_* vars are available.
set -eo pipefail
cd "$FORGE_SITE_PATH"

git pull origin "$FORGE_SITE_BRANCH"
$FORGE_COMPOSER install --no-dev --no-interaction --prefer-dist --optimize-autoloader

if [ -n "${PREVIEW_BUILD_COMMAND:-}" ]; then
  eval "$PREVIEW_BUILD_COMMAND"
fi

# Seed the database once. Later pushes keep whatever content reviewers have created.
# To reset a preview, close and reopen the PR.
if [ ! -f storage/.preview-seeded ]; then
  if [ -n "${PREVIEW_SNAPSHOT_URL:-}" ]; then
    tmp="$(mktemp -d)"
    curl -fsSL "$PREVIEW_SNAPSHOT_URL" -o "$tmp/snapshot.sql.gz"
    gunzip "$tmp/snapshot.sql.gz"
    $FORGE_PHP craft db/restore "$tmp/snapshot.sql" --interactive=0
    rm -rf "$tmp"
  else
    $FORGE_PHP craft install/craft --interactive=0 \
      --username=admin \
      --email="$PREVIEW_ADMIN_EMAIL" \
      --password="$PREVIEW_ADMIN_PASSWORD" \
      --site-name="Preview" \
      --site-url="$PRIMARY_SITE_URL" \
      --language="$PREVIEW_LANGUAGE"
  fi
  mkdir -p storage && touch storage/.preview-seeded
fi

# Applies the PR's migrations and project config changes.
$FORGE_PHP craft up --interactive=0
