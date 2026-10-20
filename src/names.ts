import { createHmac } from "node:crypto";

// Naming conventions shared by up, down and the sweep. The site label is what the action
// asks Forge for; the hostname is whatever Forge assigns (on-forge mode) or <label>.<baseDomain>.

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function previewLabel(slug: string, pr: number): string {
  return `pr-${pr}-${slug}`;
}

export function databaseName(slug: string, pr: number): string {
  return `pv_${slug}_${pr}`;
}

// Matches both the bare label and any hostname built from it.
export function prFromSiteName(slug: string, name: string): number | null {
  const match = new RegExp(`^pr-(\\d+)-${escape(slug)}(?:\\.|$)`).exec(name);
  return match ? Number(match[1]) : null;
}

export function prFromDatabaseName(slug: string, name: string): number | null {
  const match = new RegExp(`^pv_${escape(slug)}_(\\d+)$`).exec(name);
  return match ? Number(match[1]) : null;
}

// Every per-preview secret is derived from (PREVIEW_SECRET, label), so any run can regenerate
// the complete configuration without stored state. Keyed by the label, not the hostname,
// because the database password is needed before the site (and its hostname) exists.
export function derive(secret: string, purpose: string, label: string, length = 32): string {
  return createHmac("sha256", secret).update(`${purpose}:${label}`).digest("hex").slice(0, length);
}

export function originFor(site: { name: string; url?: string | null }): string {
  const host = site.url ? new URL(site.url).host : site.name;
  return `https://${host}`;
}
