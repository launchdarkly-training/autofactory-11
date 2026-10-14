import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createApp,
  FLAG_KEY,
  LD_CONTEXT,
  renderPage,
  resolveVariation,
  TELEMETRY_PATH,
} from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Stands in for the LaunchDarkly client. `honorDefault` makes it behave like
 * the real SDK does for a flag that is absent — it returns the caller's
 * default — which is what pins the fail-safe default down.
 */
function stubClient({
  value = "control",
  honorDefault = false,
  throwOnVariation = false,
  throwOnTrack = false,
} = {}) {
  const calls = { variation: [], track: [] };
  const client = {
    async variation(key, context, defaultValue) {
      calls.variation.push({ key, context, defaultValue });
      if (throwOnVariation) throw new Error("evaluation failed");
      return honorDefault ? defaultValue : value;
    },
    track(key, context, data, metricValue) {
      calls.track.push({ key, context, data, metricValue });
      if (throwOnTrack) throw new Error("tracking failed");
    },
  };
  return { calls, client };
}

async function withServer(ldClient, fn) {
  const server = createApp({ ldClient }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://localhost:${server.address().port}`);
  } finally {
    server.close();
  }
}

function beacon(base, body) {
  return fetch(`${base}${TELEMETRY_PATH}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
  });
}

// --- variation resolution -------------------------------------------------

test("control: no LaunchDarkly client resolves to the existing behavior", async () => {
  assert.equal(await resolveVariation(null), "control");
  assert.equal(await resolveVariation(undefined), "control");
});

test("control: the flag is evaluated with a fail-safe default of control", async () => {
  // honorDefault mirrors the real SDK on an absent flag, so this fails if the
  // default argument is ever changed away from "control".
  const { calls, client } = stubClient({ honorDefault: true });
  assert.equal(await resolveVariation(client), "control");
  assert.deepEqual(calls.variation, [
    { key: FLAG_KEY, context: LD_CONTEXT, defaultValue: "control" },
  ]);
});

test("control: a throwing evaluation falls back instead of failing the request", async () => {
  const { client } = stubClient({ throwOnVariation: true });
  assert.equal(await resolveVariation(client), "control");
});

test("control: a non-string variation value degrades to control", async () => {
  for (const value of [true, 1, null, {}, undefined]) {
    const { client } = stubClient({ value });
    assert.equal(await resolveVariation(client), "control");
  }
});

test("v1: the treatment variation resolves verbatim", async () => {
  const { client } = stubClient({ value: "v1" });
  assert.equal(await resolveVariation(client), "v1");
});

// --- rendering ------------------------------------------------------------

test("control: the page renders exactly as it did before the flag existed", () => {
  const html = renderPage("control");
  assert.ok(!html.includes("<button"), "control must render no button");
  assert.ok(!html.includes("refresh"), "control must not mention refresh");
  assert.ok(!html.includes(TELEMETRY_PATH), "control must not beacon");
  assert.ok(!html.includes("loadGreeting"), "control keeps the inline fetch");
  assert.ok(html.includes('fetch("http://localhost:8000/api/greeting")'));
  assert.ok(html.includes('<p id="greeting">'));
});

test("control: unknown and absent variations render the control page", () => {
  const control = renderPage("control");
  for (const value of ["v2", "", "CONTROL", undefined]) {
    assert.equal(renderPage(value), control);
  }
});

test("v1: the page renders the refresh button wired to the greeting fetch", () => {
  const html = renderPage("v1");
  assert.ok(
    html.includes('<button id="refresh" type="button">Refresh greeting</button>'),
  );
  assert.ok(html.includes("function loadGreeting(isRefresh)"));
  assert.ok(html.includes('document.getElementById("refresh").addEventListener'));
  assert.ok(html.includes(`navigator.sendBeacon("${TELEMETRY_PATH}"`));
  // The initial load is not a refresh, so it must not report an outcome.
  assert.ok(html.includes("loadGreeting(false)"));
  assert.ok(html.includes("() => loadGreeting(true)"));
  assert.ok(html.includes('if (isRefresh) reportRefresh("ok")'));
  assert.ok(html.includes('if (isRefresh) reportRefresh("error")'));
});

test("the status contract is untouched by the flag", async () => {
  for (const value of ["control", "v1"]) {
    const { client } = stubClient({ value });
    await withServer(client, async (base) => {
      const res = await fetch(`${base}/api/status`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        service: "demo-frontend",
        version: "dev",
      });
    });
  }
});

// --- guarded-release telemetry -------------------------------------------

test("latency is emitted on BOTH variations, so the comparison is two-armed", async () => {
  for (const value of ["control", "v1"]) {
    const { calls, client } = stubClient({ value });
    await withServer(client, async (base) => {
      const res = await fetch(`${base}/`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.equal(html.includes("<button"), value === "v1");
    });
    const latency = calls.track.filter(
      (c) => c.key === "shift2-enable-greeting-refresh-latency",
    );
    assert.equal(latency.length, 1, `${value} must emit one latency event`);
    assert.deepEqual(latency[0].context, LD_CONTEXT);
    assert.equal(typeof latency[0].metricValue, "number");
    assert.ok(
      Number.isFinite(latency[0].metricValue) && latency[0].metricValue >= 0,
      "latency must carry a finite, non-negative duration",
    );
  }
});

test("a refresh that succeeded emits the success event only", async () => {
  const { calls, client } = stubClient({ value: "v1" });
  await withServer(client, async (base) => {
    const res = await beacon(base, '{"outcome":"ok"}');
    assert.equal(res.status, 204);
  });
  const keys = calls.track
    .map((c) => c.key)
    .filter((k) => k !== "shift2-enable-greeting-refresh-latency");
  assert.deepEqual(keys, ["shift2-enable-greeting-refresh-success"]);
  assert.deepEqual(calls.track.at(-1).context, LD_CONTEXT);
  assert.equal(calls.track.at(-1).metricValue, undefined);
});

test("a refresh that failed emits the error event, which is the killswitch", async () => {
  const { calls, client } = stubClient({ value: "v1" });
  await withServer(client, async (base) => {
    const res = await beacon(base, '{"outcome":"error"}');
    assert.equal(res.status, 204);
  });
  assert.deepEqual(
    calls.track.map((c) => c.key),
    ["shift2-enable-greeting-refresh-error"],
  );
});

test("the beacon accepts only known outcomes and never throws on junk", async () => {
  const { calls, client } = stubClient({ value: "v1" });
  await withServer(client, async (base) => {
    for (const body of [
      '{"outcome":"bogus"}',
      "not json",
      "",
      "null",
      "[]",
      '{"outcome":{"nested":true}}',
    ]) {
      const res = await beacon(base, body);
      assert.equal(res.status, 204, `${JSON.stringify(body)} must be accepted quietly`);
    }
  });
  assert.deepEqual(calls.track, [], "junk must emit no guarded-release events");
});

test("a telemetry failure never breaks the page or the beacon", async () => {
  const { client } = stubClient({ value: "v1", throwOnTrack: true });
  await withServer(client, async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await beacon(base, '{"outcome":"error"}')).status, 204);
  });
});

test("with no LaunchDarkly client the page still serves and emits nothing", async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes("<button"));
    assert.equal((await beacon(base, '{"outcome":"ok"}')).status, 204);
  });
});

// --- the contract with LaunchDarkly and Phase 2 ---------------------------

test("flag key, context and event keys are pinned literally and match the manifest", () => {
  const source = readFileSync(join(here, "server.mjs"), "utf8");
  const manifest = JSON.parse(
    readFileSync(
      join(here, "..", ".release-flags", "shift-2-refresh-greeting.json"),
      "utf8",
    ),
  );

  // Pinned literally on purpose: asserting against the imported constants
  // would move with any rename and catch nothing.
  assert.equal(FLAG_KEY, "shift2-enable-greeting-refresh");
  assert.deepEqual(LD_CONTEXT, { kind: "user", key: "demo-user" });
  assert.equal(manifest.flagKey, "shift2-enable-greeting-refresh");
  assert.equal(manifest.targetVariation, "v1");
  assert.equal(manifest.releasePlan.randomizationUnit, "user");
  assert.ok(source.includes('"shift2-enable-greeting-refresh"'));
  // The treatment is entered on an exact string match, not a truthiness check.
  assert.ok(source.includes('=== "v1"'));
  assert.ok(source.includes('"control"'));

  const eventKeys = [
    "shift2-enable-greeting-refresh-latency",
    "shift2-enable-greeting-refresh-success",
    "shift2-enable-greeting-refresh-error",
  ];
  for (const key of eventKeys) {
    assert.ok(
      source.includes(`"${key}"`),
      `${key} must appear in server.mjs as a quoted literal`,
    );
    const metricKey = key.endsWith("-latency") ? key : `${key}-rate`;
    assert.ok(
      manifest.releasePlan.metricKeys.includes(metricKey),
      `${metricKey} must be listed in the manifest`,
    );
  }
});
