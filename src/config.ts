import { readFileSync } from "node:fs";
import { z } from "zod";

const Domain = z.discriminatedUnion("mode", [
  // Forge assigns <label>.on-forge.com with HTTPS. Zero DNS. The default.
  z.object({ mode: z.literal("on-forge") }),
  // <label>.<baseDomain> with a wildcard certificate cloned from another site on the server.
  // Needs wildcard DNS for baseDomain and an anchor site holding the certificate.
  z.object({ mode: z.literal("custom"), baseDomain: z.string().min(1), certificateId: z.number().int() }),
]);

// Per-client settings, read from .craft-preview.json in the client repo.
// Infrastructure (Forge org, server, domain, secrets) comes from workflow inputs instead.
export const PreviewConfig = z.strictObject({
  // Short client id used in hostnames and DB names: pr-42-acme.preview.netlife.no, pv_acme_42
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9]{1,11}$/, "2–12 chars, lowercase letters/digits, starting with a letter"),
  phpVersion: z.enum(["php82", "php83", "php84", "php85"]).default("php84"),
  webDirectory: z.string().default("/web"),
  // Runs on the server during deploy, e.g. "npm ci && npm run build".
  buildCommand: z.string().optional(),
  // Key of a sanitized .sql.gz dump in the Spaces bucket. Omit for a fresh install from project config.
  snapshotKey: z.string().optional(),
  // Env var → path. Each is set to the preview origin plus the path (for multi-site setups).
  siteUrls: z.record(z.string(), z.string()).default({ PRIMARY_SITE_URL: "/" }),
  // Non-secret env vars for this client. Secrets go in the workflow's `extra-env` input.
  env: z.record(z.string(), z.string()).default({}),
  domain: Domain.default({ mode: "on-forge" }),
  // Used only for fresh installs.
  language: z.string().default("nb-NO"),
  // The nightly sweep removes previews older than this even if the PR is open.
  maxAgeDays: z.number().int().positive().default(14),
});

export type PreviewConfig = z.infer<typeof PreviewConfig>;

export function loadConfig(path: string): PreviewConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const parsed = PreviewConfig.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
