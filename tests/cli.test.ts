import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fork PR gets no secrets. The CLI must decide "skip" before it asks for any of them.
test("a fork PR without secrets exits 0 with nothing to do", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const eventPath = join(dir, "event.json");
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "synchronize",
      pull_request: { number: 7, labels: [{ name: "preview" }], head: { ref: "x", sha: "abc1234", repo: { full_name: "fork/nch" } } },
      repository: { full_name: "Feedsystem/nch" },
    }),
  );
  const result = spawnSync(process.execPath, ["src/cli.ts"], {
    env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing to do/);
});
