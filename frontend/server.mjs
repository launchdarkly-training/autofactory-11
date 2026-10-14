/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend status line is gated by the LaunchDarkly flag
 * "enable-backend-status": the string variation "v1" renders it, and every
 * other value (including the "control" fallback used whenever LaunchDarkly is
 * unavailable) serves the page exactly as it was before the flag existed.
 *
 * Guarded-release telemetry: the page handler times its own render on BOTH
 * variations, and the v1 page reports whether its backend fetch succeeded.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

export const FLAG_KEY = "enable-backend-status";
export const LD_CONTEXT = { kind: "user", key: "demo-user" };

export const TELEMETRY_PATH = "/api/telemetry/backend-status";

/**
 * Resolve the flag as a STRING variation with a fail-safe default of
 * "control". Never throws: an unreachable or misbehaving LaunchDarkly leaves
 * the page on the existing-behavior path.
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

/** Emit a custom event. A telemetry failure must never break a request. */
function track(ldClient, eventKey, metricValue) {
  if (!ldClient) return;
  try {
    ldClient.track(eventKey, LD_CONTEXT, undefined, metricValue);
  } catch {
    /* ignore */
  }
}

function renderPage({ showBackendStatus }) {
  const statusLine = showBackendStatus
    ? `
  <p id="backend-status">Checking backend status…</p>`
    : "";
  const statusScript = showBackendStatus
    ? `
    function reportBackendStatus(outcome) {
      try { navigator.sendBeacon("${TELEMETRY_PATH}", JSON.stringify({ outcome: outcome })); } catch (e) {}
    }
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version;
        reportBackendStatus("ok"); })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline";
        reportBackendStatus("error"); });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${statusLine}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${statusScript}
  </script>
</body></html>`;
}

export function createApp({ ldClient = null } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const startedAt = Date.now();
    const variation = await resolveVariation(ldClient);
    res.type("html").send(renderPage({ showBackendStatus: variation === "v1" }));
    // Measured on both variations, so the release compares like with like.
    track(ldClient, "enable-backend-status-latency", Date.now() - startedAt);
  });

  // Outcome of the v1 page's backend fetch, which happens in the browser where
  // this server SDK cannot see it. Body is read as text because sendBeacon
  // posts a Blob; only a known outcome emits an event.
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
        track(ldClient, "enable-backend-status-success");
      } else if (outcome === "error") {
        track(ldClient, "enable-backend-status-error");
      }
      res.status(204).end();
    },
  );

  return app;
}

/** Initialize the LaunchDarkly client, or return null if it is unavailable. */
export async function initLdClient() {
  const sdkKey = process.env.LD_SDK_KEY;
  if (!sdkKey) return null;
  const client = init(sdkKey);
  try {
    await client.waitForInitialization({ timeout: 5 });
    return client;
  } catch {
    await client.close();
    return null;
  }
}

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
