import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand, readEvent, type TriggerEvent } from "../src/trigger.ts";

const repo = { full_name: "Feedsystem/nch" };
function pr(labels: string[], opts: { action: string; label?: string; fork?: boolean }): TriggerEvent {
  return {
    event_name: "pull_request",
    action: opts.action,
    label: opts.label ? { name: opts.label } : undefined,
    pull_request: {
      number: 42,
      labels: labels.map((name) => ({ name })),
      head: { ref: "renovate/x", sha: "abc", repo: { full_name: opts.fork ? "someone/nch" : repo.full_name } },
    },
    repository: repo,
  };
}

test("schedule and workflow_dispatch sweep", () => {
  assert.equal(resolveCommand({ event_name: "schedule", repository: repo }), "sweep");
  assert.equal(resolveCommand({ event_name: "workflow_dispatch", repository: repo }), "sweep");
});
test("labeled with preview → up", () => assert.equal(resolveCommand(pr(["preview"], { action: "labeled", label: "preview" })), "up"));
test("labeled with another label → skip", () => assert.equal(resolveCommand(pr(["wip"], { action: "labeled", label: "wip" })), "skip"));
test("synchronize with the label → up, without → skip", () => {
  assert.equal(resolveCommand(pr(["preview"], { action: "synchronize" })), "up");
  assert.equal(resolveCommand(pr([], { action: "synchronize" })), "skip");
});
test("reopened with the label → up", () => assert.equal(resolveCommand(pr(["preview"], { action: "reopened" })), "up"));
test("unlabeled preview → down", () => assert.equal(resolveCommand(pr([], { action: "unlabeled", label: "preview" })), "down"));
test("unlabeled another label while preview stays → skip", () =>
  assert.equal(resolveCommand(pr(["preview"], { action: "unlabeled", label: "wip" })), "skip"));
test("closed → down regardless of label", () => {
  assert.equal(resolveCommand(pr([], { action: "closed" })), "down");
  assert.equal(resolveCommand(pr(["preview"], { action: "closed" })), "down");
});
test("fork PR → skip", () => assert.equal(resolveCommand(pr(["preview"], { action: "labeled", label: "preview", fork: true })), "skip"));
test("unknown events → skip", () => assert.equal(resolveCommand({ event_name: "push", repository: repo }), "skip"));
test("custom label name", () => assert.equal(resolveCommand(pr(["pv"], { action: "labeled", label: "pv" }), "pv"), "up"));

test("readEvent attaches event_name to the payload", () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-"));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ action: "closed", repository: repo }));
  assert.deepEqual(readEvent("pull_request", path), { event_name: "pull_request", action: "closed", repository: repo });
});
