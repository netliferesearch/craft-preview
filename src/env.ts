import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewConfig } from "./config.ts";
import { databaseName, derive, previewLabel } from "./names.ts";

// The preview .env is composed from layers, later layers winning:
//   1. the client repo's .env.example(.dev)   site-specific defaults (asset CDN, Redis, Vite URL)
//   2. previewVars()                           what makes it a preview
//   3. the manifest's `env`                    non-secret client settings
//   4. the workflow's extra-env input          client secrets

// Blank lines and comments are skipped; `export KEY=` is accepted; matching quotes are stripped.
export function parseDotenv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`Invalid env line: ${line.slice(0, 40)}`);
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

export function readExampleEnv(dir: string): Record<string, string> {
  for (const name of [".env.example.dev", ".env.example"]) {
    const path = join(dir, name);
    if (existsSync(path)) return parseDotenv(readFileSync(path, "utf8"));
  }
  return {};
}

export function previewVars(input: {
  cfg: PreviewConfig;
  pr: number;
  origin: string;
  secret: string;
  adminEmail: string;
  snapshotUrl?: string;
}): Record<string, string> {
  const { cfg, pr, origin, secret } = input;
  const label = previewLabel(cfg.slug, pr);
  const db = databaseName(cfg.slug, pr);
  const vars: Record<string, string> = {
    CRAFT_APP_ID: `preview-${cfg.slug}-${pr}`,
    CRAFT_ENVIRONMENT: "preview",
    CRAFT_SECURITY_KEY: derive(secret, "security-key", label, 64),
    CRAFT_DEV_MODE: "false",
    // Update migrations write to project config; read-only would fail at `craft up` (same as verify).
    CRAFT_ALLOW_ADMIN_CHANGES: "true",
    CRAFT_DISALLOW_ROBOTS: "true",
    CRAFT_RUN_QUEUE_AUTOMATICALLY: "true",
    CRAFT_DB_DRIVER: "mysql",
    CRAFT_DB_SERVER: "127.0.0.1",
    CRAFT_DB_PORT: "3306",
    CRAFT_DB_DATABASE: db,
    CRAFT_DB_USER: db,
    CRAFT_DB_PASSWORD: derive(secret, "db-password", label),
    PREVIEW_ADMIN_EMAIL: input.adminEmail,
    PREVIEW_ADMIN_PASSWORD: derive(secret, "admin-password", label, 20),
    PREVIEW_LANGUAGE: cfg.language,
  };
  if (cfg.buildCommand) vars.PREVIEW_BUILD_COMMAND = cfg.buildCommand;
  if (input.snapshotUrl) vars.PREVIEW_SNAPSHOT_URL = input.snapshotUrl;
  for (const [key, path] of Object.entries(cfg.siteUrls)) {
    vars[key] = new URL(path, `${origin}/`).toString();
  }
  return vars;
}

export function composeEnv(layers: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...layers);
}

// Single quotes are literal in both bash (Forge sources the file into the deploy script) and
// phpdotenv, so no escaping is needed. The one character they cannot hold is a single quote.
export function renderDotenv(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([key, value]) => {
        if (value.includes("'")) throw new Error(`Env var ${key} contains a single quote`);
        return `${key}='${value}'`;
      })
      .join("\n") + "\n"
  );
}
