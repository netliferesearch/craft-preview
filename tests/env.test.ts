import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewConfig } from "../src/config.ts";
import { parseDotenv, previewVars, composeEnv, renderDotenv, readExampleEnv } from "../src/env.ts";

test("parseDotenv handles quotes, export, comments", () => {
  const vars = parseDotenv(`# c\nexport A="x=y"\nB='q'\nC=plain\n\nD=`);
  assert.deepEqual(vars, { A: "x=y", B: "q", C: "plain", D: "" });
});

test("parseDotenv rejects a line without a key", () => {
  assert.throws(() => parseDotenv("=nokey"), /Invalid/);
});

test("previewVars sets fixed preview values and site urls", () => {
  const cfg = PreviewConfig.parse({ slug: "nch", siteUrls: { PRIMARY_SITE_URL: "/", EN_URL: "/en" } });
  const v = previewVars({ cfg, pr: 42, origin: "https://pr-42-nch.on-forge.com", secret: "s", adminEmail: "p@x.no" });
  assert.equal(v.CRAFT_ENVIRONMENT, "preview");
  assert.equal(v.CRAFT_ALLOW_ADMIN_CHANGES, "true");
  assert.equal(v.CRAFT_DEV_MODE, "false");
  assert.equal(v.CRAFT_DB_DRIVER, "mysql");
  assert.equal(v.CRAFT_DB_DATABASE, "pv_nch_42");
  assert.equal(v.CRAFT_DB_USER, "pv_nch_42");
  assert.equal(v.CRAFT_DB_PASSWORD.length, 32);
  assert.equal(v.CRAFT_SECURITY_KEY.length, 64);
  assert.equal(v.CRAFT_APP_ID, "preview-nch-42");
  assert.equal(v.PRIMARY_SITE_URL, "https://pr-42-nch.on-forge.com/");
  assert.equal(v.EN_URL, "https://pr-42-nch.on-forge.com/en");
  assert.equal(v.PREVIEW_ADMIN_EMAIL, "p@x.no");
  assert.equal(v.PREVIEW_ADMIN_PASSWORD.length, 20);
  assert.equal(v.PREVIEW_LANGUAGE, "nb-NO");
  assert.equal("PREVIEW_SNAPSHOT_URL" in v, false);
  assert.equal("PREVIEW_BUILD_COMMAND" in v, false);
  assert.equal("CRAFT_TEST_TO_EMAIL_ADDRESS" in v, false);
});

test("previewVars passes snapshot url and build command when set", () => {
  const cfg = PreviewConfig.parse({ slug: "nch", buildCommand: "npm ci && npm run build" });
  const v = previewVars({ cfg, pr: 1, origin: "https://x", secret: "s", adminEmail: "p@x.no", snapshotUrl: "https://b/s.sql.gz" });
  assert.equal(v.PREVIEW_SNAPSHOT_URL, "https://b/s.sql.gz");
  assert.equal(v.PREVIEW_BUILD_COMMAND, "npm ci && npm run build");
});

test("composeEnv: later layers win", () => {
  assert.deepEqual(composeEnv([{ A: "1", B: "2" }, { B: "3" }]), { A: "1", B: "3" });
});

test("renderDotenv single-quotes values and rejects single quotes", () => {
  assert.equal(renderDotenv({ K: "v w", L: "" }), "K='v w'\nL=''\n");
  assert.throws(() => renderDotenv({ K: "it's" }), /K/);
});

test("readExampleEnv returns {} when no file", () => {
  assert.deepEqual(readExampleEnv(mkdtempSync(join(tmpdir(), "pv-"))), {});
});

test("readExampleEnv prefers .env.example.dev over .env.example", () => {
  const dir = mkdtempSync(join(tmpdir(), "pv-"));
  writeFileSync(join(dir, ".env.example"), "A=prod\n");
  assert.deepEqual(readExampleEnv(dir), { A: "prod" });
  writeFileSync(join(dir, ".env.example.dev"), "A=dev\n");
  assert.deepEqual(readExampleEnv(dir), { A: "dev" });
});

test("parseDotenv drops inline comments like phpdotenv", () => {
  const vars = parseDotenv(`A=value # inline comment\nB="x" # c\nC='y # not a comment'\nD=http://h/#anchor\nE=#\n`);
  assert.deepEqual(vars, { A: "value", B: "x", C: "y # not a comment", D: "http://h/#anchor", E: "" });
});
