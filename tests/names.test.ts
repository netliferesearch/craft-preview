import { test } from "node:test";
import assert from "node:assert/strict";
import {
  previewLabel,
  databaseName,
  prFromSiteName,
  prFromDatabaseName,
  derive,
  originFor,
} from "../src/names.ts";

test("previewLabel", () => assert.equal(previewLabel("nch", 42), "pr-42-nch"));
test("databaseName", () => assert.equal(databaseName("nch", 42), "pv_nch_42"));

test("prFromSiteName matches the label and the on-forge hostname", () => {
  assert.equal(prFromSiteName("nch", "pr-42-nch"), 42);
  assert.equal(prFromSiteName("nch", "pr-42-nch.on-forge.com"), 42);
  assert.equal(prFromSiteName("nch", "pr-42-other.on-forge.com"), null);
  assert.equal(prFromSiteName("nch", "pr-42-nchx.on-forge.com"), null);
});

test("prFromDatabaseName", () => {
  assert.equal(prFromDatabaseName("nch", "pv_nch_42"), 42);
  assert.equal(prFromDatabaseName("nch", "pv_nch_42_old"), null);
  assert.equal(prFromDatabaseName("nch", "pv_other_42"), null);
});

test("derive is deterministic, per purpose, default length 32", () => {
  assert.equal(derive("s", "db-password", "pr-42-nch"), derive("s", "db-password", "pr-42-nch"));
  assert.notEqual(derive("s", "db-password", "pr-42-nch"), derive("s", "admin-password", "pr-42-nch"));
  assert.equal(derive("s", "db-password", "pr-42-nch").length, 32);
  assert.equal(derive("s", "security-key", "pr-42-nch", 64).length, 64);
});

test("originFor prefers the url host and always uses https", () => {
  assert.equal(originFor({ name: "pr-42-nch", url: "http://pr-42-nch.on-forge.com" }), "https://pr-42-nch.on-forge.com");
  assert.equal(originFor({ name: "pr-42-nch.on-forge.com", url: null }), "https://pr-42-nch.on-forge.com");
});
