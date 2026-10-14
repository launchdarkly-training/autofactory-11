/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The manual "Refresh greeting" control is gated by the LaunchDarkly flag
 * `shift2-enable-greeting-refresh`: the `control` variation renders the page
 * exactly as it was before the flag existed, `v1` adds the refresh button.
 *
 * Guarded-release telemetry: the page handler times its own render on BOTH
 * variations, and the v1 page reports whether a refresh the user asked for
 * actually loaded the greeting.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init as initLd } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "shift2-enable-greeting-refresh";
export const LD_CONTEXT = { kind: "user", key: "demo-user" };

export const TELEMETRY_PATH = "/api/telemetry/greeting-refresh";

/** Emit a custom event. A telemetry failure must never break a request. */
function track(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, LD_CONTEXT, undefined, metricValue);
  } catch {
    /* ignore */
  }
}

/**
 * Resolve the flag as a STRING variation with a fail-safe default of "control".
 * A missing client, a thrown evaluation, or a non-string value all degrade to
 * the existing behavior.
 */
export async function resolveVariation(ldClient) {
  if (!ldClient) return "control";
  try {
    const value = await ldClient.variation(FLAG_KEY, LD_CONTEXT, "control");
    return typeof value === "string" ? value : "control";
  } catch {
    return "control";
  }
}

const CONTROL_BODY = `  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>`;

const TREATMENT_BODY = `  <button id="refresh" type="button">Refresh greeting</button>
  <script>
    function reportRefresh(outcome) {
      try { navigator.sendBeacon("${TELEMETRY_PATH}", JSON.stringify({ outcome: outcome })); } catch (e) {}
    }
    function loadGreeting(isRefresh) {
      document.getElementById("greeting").textContent = "Loading greeting from backend…";
      fetch("${BACKEND_URL}/api/greeting")
        .then(r => r.json())
        .then(d => { document.getElementById("greeting").textContent =
          d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")";
          if (isRefresh) reportRefresh("ok"); })
        .catch(() => { document.getElementById("greeting").textContent = "backend unavailable";
          if (isRefresh) reportRefresh("error"); });
    }
    loadGreeting(false);
    document.getElementById("refresh").addEventListener("click", () => loadGreeting(true));
  </script>`;

export function renderPage(variation) {
  const body = variation === "v1" ? TREATMENT_BODY : CONTROL_BODY;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
${body}
</body></html>`;
}

export function createApp({ ldClient } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await resolveVariation(ldClient);
    res.type("html").send(renderPage(variation));
    // Measured on both variations, so the release compares like with like.
    track(ldClient, "shift2-enable-greeting-refresh-latency", Date.now() - startedAt);
  });

  // Outcome of a refresh the user asked for on the v1 page, which happens in
  // the browser where this server SDK cannot see it. The body is read as text
  // because sendBeacon posts a Blob, and only a known outcome emits an event.
  app.post(
    TELEMETRY_PATH,
    express.text({ type: "*/*", limit: "1kb" }),
    (req, res) => {
      let outcome;
      try {
        outcome = JSON.parse(req.body)?.outcome;
      } catch {
        outcome = undefined;
      }
      if (outcome === "ok") {
        track(ldClient, "shift2-enable-greeting-refresh-success");
      } else if (outcome === "error") {
        track(ldClient, "shift2-enable-greeting-refresh-error");
      }
      res.status(204).end();
    },
  );

  return app;
}

export async function initLdClient(sdkKey = process.env.LD_SDK_KEY) {
  if (!sdkKey) return null;
  const client = initLd(sdkKey);
  try {
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    // Degrade to the control path rather than blocking startup on LaunchDarkly.
    await client.close();
    return null;
  }
}

// `process.argv[1]` is undefined under `node -e`, where pathToFileURL throws.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const ldClient = await initLdClient();
  const port = process.env.PORT || 3000;
  createApp({ ldClient }).listen(port, () =>
    console.log(`demo-frontend on :${port}`),
  );
}
