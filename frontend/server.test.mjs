import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createApp,
  resolveVariation,
  FLAG_KEY,
  LD_CONTEXT,
  TELEMETRY_PATH,
} from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** A client that always serves `value`, recording what it was asked. */
function stubClient(value) {
  const calls = { variation: [], track: [] };
  return {
    calls,
    variation: async (key, context, defaultValue) => {
      calls.variation.push({ key, context, defaultValue });
      return value;
    },
    track: (key, context, data, metricValue) => {
      calls.track.push({ key, context, metricValue });
    },
  };
}

/**
 * A client that behaves like the real SDK for a flag that does not exist:
 * it returns the caller's default. Without this, a mutation flipping the
 * fail-safe default from "control" to "v1" goes undetected.
 */
function absentFlagClient() {
  const calls = { variation: [], track: [] };
  return {
    calls,
    variation: async (key, context, defaultValue) => {
      calls.variation.push({ key, context, defaultValue });
      return defaultValue;
    },
    track: (key, context, data, metricValue) => {
      calls.track.push({ key, context, metricValue });
    },
  };
}

async function withServer(ldClient, fn) {
  const server = await new Promise((resolve) => {
    const s = createApp({ ldClient }).listen(0, () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const getPage = (ldClient) =>
  withServer(ldClient, async (base) => (await fetch(`${base}/`)).text());

const postBeacon = (ldClient, body) =>
  withServer(ldClient, async (base) => {
    const res = await fetch(base + TELEMETRY_PATH, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    return res.status;
  });

// --- control path (flag off / absent) -------------------------------------

test("control renders the page exactly as before the flag", async () => {
  const html = await getPage(stubClient("control"));
  assert.ok(!html.includes('id="backend-status"'));
  assert.ok(!html.includes("/api/status"));
  assert.ok(!html.includes("Backend online"));
  assert.ok(!html.includes("Backend offline"));
  assert.ok(!html.includes("sendBeacon"));
  // the pre-existing greeting behavior is untouched
  assert.ok(html.includes('id="greeting"'));
  assert.ok(html.includes("/api/greeting"));
});

test("no LaunchDarkly client at all serves control", async () => {
  const html = await getPage(null);
  assert.ok(!html.includes('id="backend-status"'));
});

test("a throwing client serves control", async () => {
  const html = await getPage({
    variation: async () => {
      throw new Error("LaunchDarkly unreachable");
    },
    track: () => {},
  });
  assert.ok(!html.includes('id="backend-status"'));
});

test("a non-string variation value serves control", async () => {
  for (const value of [true, 1, null, undefined, { v: "v1" }]) {
    const html = await getPage(stubClient(value));
    assert.ok(
      !html.includes('id="backend-status"'),
      `value ${JSON.stringify(value)} must serve control`,
    );
  }
});

test("an unknown future variation serves control", async () => {
  const html = await getPage(stubClient("v2"));
  assert.ok(!html.includes('id="backend-status"'));
});

test("the fail-safe default passed to the SDK is 'control'", async () => {
  // This client returns the default, like the real SDK does for an absent
  // flag, so the assertion fails if the default is ever changed to "v1".
  const client = absentFlagClient();
  const html = await getPage(client);
  assert.equal(await resolveVariation(client), "control");
  assert.ok(!html.includes('id="backend-status"'));
  const [call] = client.calls.variation;
  assert.equal(call.defaultValue, "control");
  assert.equal(call.key, FLAG_KEY);
  assert.deepEqual(call.context, LD_CONTEXT);
});

// --- treatment path (v1) ---------------------------------------------------

test("v1 renders the backend status line", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.includes('<p id="backend-status">Checking backend status…</p>'));
  assert.ok(html.includes("/api/status"));
  assert.ok(html.includes('"Backend online: " + d.service + " version " + d.version'));
  assert.ok(html.includes('"Backend offline"'));
  assert.ok(html.includes("sendBeacon"));
});

test("v1 keeps the pre-existing greeting behavior", async () => {
  const html = await getPage(stubClient("v1"));
  assert.ok(html.includes('id="greeting"'));
  assert.ok(html.includes("/api/greeting"));
  assert.ok(html.includes("backend unavailable"));
});

test("the flag is evaluated on the same context the events use", async () => {
  const client = stubClient("v1");
  await getPage(client);
  assert.equal(client.calls.variation.length, 1);
  assert.deepEqual(client.calls.variation[0].context, LD_CONTEXT);
  assert.equal(client.calls.track[0].context, LD_CONTEXT);
});

// --- latency metric (must be two-armed) ------------------------------------

test("latency is emitted on BOTH control and v1", async () => {
  for (const value of ["control", "v1"]) {
    const client = stubClient(value);
    await getPage(client);
    const latency = client.calls.track.filter(
      (c) => c.key === "enable-backend-status-latency",
    );
    assert.equal(latency.length, 1, `${value} must emit exactly one latency event`);
    assert.equal(typeof latency[0].metricValue, "number");
    assert.ok(Number.isFinite(latency[0].metricValue));
    assert.ok(latency[0].metricValue >= 0);
  }
});

// --- beacon route ----------------------------------------------------------

test("an 'ok' beacon emits the success event only", async () => {
  const client = stubClient("v1");
  const status = await postBeacon(client, JSON.stringify({ outcome: "ok" }));
  assert.equal(status, 204);
  assert.deepEqual(
    client.calls.track.map((c) => c.key),
    ["enable-backend-status-success"],
  );
  assert.equal(client.calls.track[0].metricValue, undefined);
});

test("an 'error' beacon emits the error event only", async () => {
  const client = stubClient("v1");
  const status = await postBeacon(client, JSON.stringify({ outcome: "error" }));
  assert.equal(status, 204);
  assert.deepEqual(
    client.calls.track.map((c) => c.key),
    ["enable-backend-status-error"],
  );
});

test("malformed or unknown beacon payloads emit nothing", async () => {
  for (const body of [
    "not json",
    '{"outcome":"bogus"}',
    "",
    "[]",
    "null",
    '{"outcome":null}',
    '{"outcome":"ok","extra":1}'.replace('"ok"', '"OK"'),
  ]) {
    const client = stubClient("v1");
    const status = await postBeacon(client, body);
    assert.equal(status, 204, `${JSON.stringify(body)} must not error`);
    assert.deepEqual(
      client.calls.track,
      [],
      `${JSON.stringify(body)} must emit no event`,
    );
  }
});

test("the beacon never reports a client-supplied metric value", async () => {
  const client = stubClient("v1");
  await postBeacon(
    client,
    JSON.stringify({ outcome: "ok", elapsedMs: null, value: 999999 }),
  );
  assert.equal(client.calls.track.length, 1);
  assert.equal(client.calls.track[0].metricValue, undefined);
});

test("a telemetry failure never breaks the request", async () => {
  const exploding = {
    variation: async () => "v1",
    track: () => {
      throw new Error("event pipeline down");
    },
  };
  const html = await getPage(exploding);
  assert.ok(html.includes('id="backend-status"'));
  assert.equal(
    await postBeacon(exploding, JSON.stringify({ outcome: "ok" })),
    204,
  );
});

// --- untouched contract ----------------------------------------------------

test("GET /api/status is unaffected by the flag", async () => {
  for (const value of ["control", "v1"]) {
    const body = await withServer(stubClient(value), async (base) =>
      (await fetch(`${base}/api/status`)).json(),
    );
    assert.equal(body.service, "demo-frontend");
    assert.equal(typeof body.version, "string");
  }
});

// --- the keys are the contract ---------------------------------------------

test("flag and event keys are literal strings matching the manifest", () => {
  const source = readFileSync(join(here, "server.mjs"), "utf8");
  const manifest = JSON.parse(
    readFileSync(
      join(here, "..", ".release-flags", "shift-1-backend-status.json"),
      "utf8",
    ),
  );

  assert.equal(FLAG_KEY, "enable-backend-status");
  // Pinned literally: asserting against the imported constants elsewhere would
  // move with any rename, so this is what actually anchors the keys. The
  // context kind must stay "user" to match the metrics' randomization unit.
  assert.deepEqual(LD_CONTEXT, { kind: "user", key: "demo-user" });
  assert.equal(manifest.flagKey, "enable-backend-status");
  assert.equal(manifest.targetVariation, "v1");
  assert.ok(source.includes('"enable-backend-status"'));
  // the treatment is entered on an exact string comparison, not a truthiness check
  assert.ok(source.includes('=== "v1"'));

  const eventKeys = [
    "enable-backend-status-latency",
    "enable-backend-status-success",
    "enable-backend-status-error",
  ];
  for (const key of eventKeys) {
    assert.ok(
      source.includes(`"${key}"`),
      `${key} must appear in server.mjs as a quoted literal`,
    );
  }
  for (const key of eventKeys) {
    const metricKey = key.endsWith("-latency") ? key : `${key}-rate`;
    assert.ok(
      manifest.releasePlan.metricKeys.includes(metricKey),
      `${metricKey} must be listed in the manifest`,
    );
  }
  assert.equal(manifest.releasePlan.randomizationUnit, "user");
});
