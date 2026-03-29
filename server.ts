/**
 * server.ts — Hono server for Deno Deploy
 *
 * Responsibilities:
 *  1. POST /api/agent  — Proxy to Snowflake Cortex Agent, injecting the PAT
 *                        server-side so it is never exposed to the browser.
 *  2. GET  /*          — Serve the Vite build output from ./dist, with SPA
 *                        fallback to index.html for client-side navigation.
 *
 * Environment variables (set in Deno Deploy dashboard):
 *   SNOWFLAKE_ACCOUNT   e.g. "xy12345.eu-west-1"
 *   SNOWFLAKE_DATABASE  e.g. "COMPLIANCE_DB"
 *   SNOWFLAKE_SCHEMA    e.g. "PUBLIC"
 *   SNOWFLAKE_AGENT     e.g. "SANCTIONS_AGENT"
 *   SNOWFLAKE_PAT       Programmatic Access Token
 */

import { Hono } from "jsr:@hono/hono";
import { serveStatic } from "jsr:@hono/hono/deno";

// ── Read config from environment ──────────────────────────────────────────────
const VITE_SNOWFLAKE_ACCOUNT   = Deno.env.get("SNOWFLAKE_ACCOUNT")   ?? "";
const VITE_SNOWFLAKE_DATABASE  = Deno.env.get("SNOWFLAKE_DATABASE")  ?? "";
const VITE_SNOWFLAKE_SCHEMA    = Deno.env.get("SNOWFLAKE_SCHEMA")    ?? "";
const VITE_SNOWFLAKE_AGENT     = Deno.env.get("SNOWFLAKE_AGENT")     ?? "";
const VITE_SNOWFLAKE_PAT       = Deno.env.get("SNOWFLAKE_PAT")       ?? "";

const AGENT_URL =
  `https://${VITE_SNOWFLAKE_ACCOUNT}.snowflakecomputing.com` +
  `/api/v2/databases/${VITE_SNOWFLAKE_DATABASE}/schemas/${VITE_SNOWFLAKE_SCHEMA}` +
  `/agents/${VITE_SNOWFLAKE_AGENT}:run`;

// ── App ───────────────────────────────────────────────────────────────────────
const app = new Hono();

/**
 * POST /api/agent
 *
 * Accepts the same JSON body the frontend would send, forwards it to
 * Snowflake, and streams the SSE response straight back to the client.
 * The PAT is injected here — the browser never sees it.
 */
app.post("/api/agent", async (c) => {
  if (!VITE_SNOWFLAKE_PAT) {
    return c.json({ error: "SNOWFLAKE_PAT is not configured" }, 500);
  }

  const body = await c.req.text();

  const upstream = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type":                          "application/json",
      "Accept":                                "text/event-stream",
      "Authorization":                         `Bearer ${VITE_SNOWFLAKE_PAT}`,
      "X-Snowflake-Authorization-Token-Type":  "PROGRAMMATIC_ACCESS_TOKEN",
    },
    body,
  });

  if (!upstream.ok) {
    const err = await upstream.text();
    return c.text(err, upstream.status as 400 | 401 | 403 | 404 | 500);
  }

  // Stream the SSE response directly back — no buffering.
  return new Response(upstream.body, {
    status:  upstream.status,
    headers: {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "X-Accel-Buffering": "no", // disable proxy buffering if behind nginx
    },
  });
});

// ── Static files from Vite build ──────────────────────────────────────────────
// Use import.meta.dirname to build an absolute path — Deno Deploy's wong cache TTL.
app.use(
  "/assets/*",
  serveStatic({
    root: "./dist",
    // Hono's serveStatic resolves paths relative to the entrypoint file,
    // so ./dist maps to <project-root>/dist after `deno task build`.
    onNotFound: (_path, c) => c.notFound(),
  })
);

// All other static files (favicon, manifest, etc.)
app.use("/*", serveStatic({ root: "./dist" }));

// SPA fallback — any unmatched route returns index.html so React can boot.
app.get("*", serveStatic({ path: "./dist/index.html" }));

// ── Start ─────────────────────────────────────────────────────────────────────
Deno.serve(app.fetch);