import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewConfig } from "../src/config.ts";

test("manifest schema loads", () => {
  assert.equal(PreviewConfig.parse({ slug: "nch" }).slug, "nch");
});
