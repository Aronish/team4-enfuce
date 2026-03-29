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
const SNOWFLAKE_ACCOUNT   = Deno.env.get("SNOWFLAKE_ACCOUNT")   ?? "";
const SNOWFLAKE_DATABASE  = Deno.env.get("SNOWFLAKE_DATABASE")  ?? "";
const SNOWFLAKE_SCHEMA    = Deno.env.get("SNOWFLAKE_SCHEMA")    ?? "";
const SNOWFLAKE_AGENT     = Deno.env.get("SNOWFLAKE_AGENT")     ?? "";
const SNOWFLAKE_PAT       = Deno.env.get("SNOWFLAKE_PAT")       ?? "";

const AGENT_URL =
  `https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com` +
  `/api/v2/databases/${SNOWFLAKE_DATABASE}/schemas/${SNOWFLAKE_SCHEMA}` +
  `/agents/${SNOWFLAKE_AGENT}:run`;

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
  if (!SNOWFLAKE_PAT) {
    return c.json({ error: "SNOWFLAKE_PAT is not configured" }, 500);
  }

  const body = await c.req.text();

  const upstream = await fetch(AGENT_URL, {
    method: "POST",
    headers: {
      "Content-Type":                          "application/json",
      "Accept":                                "text/event-stream",
      "Authorization":                         `Bearer ${SNOWFLAKE_PAT}`,
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
// Use import.meta.dirname to build an absolute path — Deno Deploy's working
// directory is not always the project root, so relative paths like "./dist"
// can silently resolve to nothing, producing a blank MIME type response.
const DIST = `${import.meta.dirname}/dist`;

// Assets (JS, CSS, images) have content-hashed filenames — long cache TTL.
app.use("/assets/*", serveStatic({ root: DIST }));

// All other static files (favicon, manifest, robots.txt, etc.)
app.use("/*", serveStatic({ root: DIST }));

// SPA fallback — any unmatched route serves index.html so React Router can boot.
app.get("*", serveStatic({ path: `${DIST}/index.html` }));

// ── Start ─────────────────────────────────────────────────────────────────────
Deno.serve(app.fetch);