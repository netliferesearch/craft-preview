import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("prInfo returns state and label names from one pulls call", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ state: "open", labels: [{ name: "preview" }, { name: "renovate" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const info = await new GitHub("tok", "Feedsystem/nch").prInfo(42);
  assert.deepEqual(info, { state: "open", labels: ["preview", "renovate"] });
  assert.deepEqual(calls, ["https://api.github.com/repos/Feedsystem/nch/pulls/42"]);
});
