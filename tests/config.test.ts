import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewConfig } from "../src/config.ts";

test("domain defaults to on-forge", () => {
  assert.deepEqual(PreviewConfig.parse({ slug: "nch" }).domain, { mode: "on-forge" });
});

test("custom domain needs baseDomain and certificateId", () => {
  const r = PreviewConfig.safeParse({ slug: "nch", domain: { mode: "custom", baseDomain: "preview.netlife.no" } });
  assert.equal(r.success, false);
});

test("custom domain parses", () => {
  const cfg = PreviewConfig.parse({
    slug: "nch",
    domain: { mode: "custom", baseDomain: "preview.netlife.no", certificateId: 12 },
  });
  assert.equal(cfg.domain.mode, "custom");
});

test("ssl key is rejected", () => {
  assert.equal(PreviewConfig.safeParse({ slug: "nch", ssl: { mode: "letsencrypt" } }).success, false);
});

test("slug rules", () => {
  assert.equal(PreviewConfig.safeParse({ slug: "1ab" }).success, false);
  assert.equal(PreviewConfig.safeParse({ slug: "abcdefghijklm" }).success, false);
  assert.equal(PreviewConfig.safeParse({ slug: "ab" }).success, true);
});
