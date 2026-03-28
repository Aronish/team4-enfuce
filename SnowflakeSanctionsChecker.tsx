/**
 * Snowflake Cortex Agent – Sanctions & PEP Checker
 *
 * ─── CONFIGURATION PLACEHOLDERS ──────────────────────────────────────────────
 *
 *  SNOWFLAKE_ACCOUNT   Your Snowflake account identifier, e.g. "xy12345.eu-west-1"
 *  SNOWFLAKE_DATABASE  Database that owns the agent, e.g. "COMPLIANCE_DB"
 *  SNOWFLAKE_SCHEMA    Schema that owns the agent, e.g. "PUBLIC"
 *  SNOWFLAKE_AGENT     Name of the agent you created in Snowflake Console, e.g. "SANCTIONS_AGENT"
 *  SNOWFLAKE_PAT       Snowflake Programmatic Access Token
 *
 *  ⚠️  SECURITY NOTE
 *  Never ship a real PAT in client-side code. The fetch() below should point at
 *  YOUR OWN thin backend proxy that injects the Authorization header server-side.
 *  Replace the direct Snowflake URL with your proxy endpoint and remove the
 *  Authorization header from the frontend.
 *
 *  Example proxy endpoint: https://your-api.example.com/api/sanctions-check
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useCallback } from "react";

// ── Configuration ─────────────────────────────────────────────────────────────
const SNOWFLAKE_ACCOUNT = import.meta.env.VITE_SNOWFLAKE_ACCOUNT;   // e.g. "xy12345.eu-west-1"
const SNOWFLAKE_DATABASE = import.meta.env.VITE_SNOWFLAKE_DATABASE;             // e.g. "COMPLIANCE_DB"
const SNOWFLAKE_SCHEMA = import.meta.env.VITE_SNOWFLAKE_SCHEMA;                 // e.g. "PUBLIC"
const SNOWFLAKE_AGENT = import.meta.env.VITE_SNOWFLAKE_AGENT;              // e.g. "SANCTIONS_AGENT"
const SNOWFLAKE_PAT = import.meta.env.VITE_SNOWFLAKE_PAT;

const AGENT_URL =
  `https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com` +
  `/api/v2/databases/${SNOWFLAKE_DATABASE}/schemas/${SNOWFLAKE_SCHEMA}` +
  `/agents/${SNOWFLAKE_AGENT}:run`;

// ── Types ─────────────────────────────────────────────────────────────────────
type CheckStatus = "idle" | "loading" | "done" | "error";
 
interface RawSSEEvent {
  event: string;
  data: string;
}
 
interface SuggestedQuery {
  query: string;
}
 
// ── SSE streaming helper ──────────────────────────────────────────────────────
async function* streamSSE(
  url: string,
  body: object,
  headers: Record<string, string>
): AsyncGenerator<RawSSEEvent> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
 
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HTTP ${response.status}: ${err}`);
  }
 
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let currentData = "";
 
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
 
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
 
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line === "") {
        if (currentEvent || currentData) {
          yield { event: currentEvent, data: currentData };
        }
        currentEvent = "";
        currentData = "";
      }
    }
  }
}
 
// ── Parse the final "response" event (schema_version: v2) ────────────────────
// The top-level object has a "content" array with typed blocks:
//   { type: "text",              text: "..." }
//   { type: "thinking",          thinking: { text: "..." } }
//   { type: "tool_result",       ... }
//   { type: "suggested_queries", suggested_queries: [{ query: "..." }] }
function parseFinalResponse(data: string): {
  text: string;
  suggestedQueries: SuggestedQuery[];
} {
  const parsed = JSON.parse(data);
  const content: { type: string; text?: string; suggested_queries?: SuggestedQuery[] }[] =
    parsed?.content ?? [];
 
  const text = content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
 
  const suggestedQueries: SuggestedQuery[] = content
    .filter((c) => c.type === "suggested_queries")
    .flatMap((c) => c.suggested_queries ?? []);
 
  return { text, suggestedQueries };
}
 
// ── Main component ────────────────────────────────────────────────────────────
export default function SanctionsChecker() {
  const [name, setName] = useState("");
  const [status, setStatus] = useState<CheckStatus>("idle");
 
  const [result, setResult] = useState<string>("");
  const [suggestedQueries, setSuggestedQueries] = useState<SuggestedQuery[]>([]);
 
  // Streamed while loading
  const [thinkingText, setThinkingText] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
 
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [debugLog, setDebugLog] = useState<RawSSEEvent[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const abortRef = useRef<boolean>(false);
 
  const handleCheck = useCallback(async () => {
    if (!name.trim()) return;
 
    setStatus("loading");
    setResult("");
    setSuggestedQueries([]);
    setThinkingText("");
    setStatusMessage("Starting…");
    setErrorMsg("");
    setDebugLog([]);
    abortRef.current = false;
 
    const prompt = `Check the name "${name.trim()}" against sanctions lists and PEP (Politically Exposed Person) databases. Provide a clear summary of any matches found, including the list name, match confidence, and any relevant details. If no matches are found, state that clearly.`;
 
    const body = {
      stream: true,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    };
 
    const headers = {
      Authorization: `Bearer ${SNOWFLAKE_PAT}`, // ⚠️ move to backend proxy
      Accept: "text/event-stream",
      "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN",
    };
 
    try {
      for await (const evt of streamSSE(AGENT_URL, body, headers)) {
        if (abortRef.current) break;
 
        setDebugLog((prev) => [...prev, evt]);
 
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(evt.data); } catch { /* non-JSON events like [DONE] */ }
 
        switch (evt.event) {
 
          // Thinking delta — stream token by token
          case "response.thinking.delta":
            if (typeof parsed?.text === "string") {
              setThinkingText((prev) => prev + (parsed!.text as string));
            }
            break;
 
          // Status update — show current operation
          case "response.status":
          case "response.tool_result.status":
            if (typeof parsed?.message === "string") {
              setStatusMessage(parsed.message as string);
            }
            break;
 
          // Final aggregated response — extract text + suggested queries
          case "response": {
            if (!parsed) break;
            try {
              const { text, suggestedQueries: sq } = parseFinalResponse(evt.data);
              setResult(text || "The agent returned an empty response.");
              setSuggestedQueries(sq);
            } catch (e) {
              setResult(`Failed to parse response: ${e}`);
            }
            setThinkingText("");
            setStatusMessage("");
            setStatus("done");
            return;
          }
 
          case "error":
            throw new Error(`Agent error: ${evt.data}`);
        }
      }
 
      // Stream ended without a "response" event
      setResult("No response received from the agent.");
      setStatus("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [name]);
 
  const handleReset = () => {
    abortRef.current = true;
    setStatus("idle");
    setResult("");
    setSuggestedQueries([]);
    setThinkingText("");
    setStatusMessage("");
    setErrorMsg("");
    setDebugLog([]);
    setName("");
  };
 
  const isLoading = status === "loading";
 
  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerInner}>
          <div style={styles.logoMark}>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <polygon points="14,2 26,8 26,20 14,26 2,20 2,8" fill="none" stroke="#00BEFF" strokeWidth="1.5" />
              <polygon points="14,7 21,11 21,19 14,23 7,19 7,11" fill="none" stroke="#00BEFF" strokeWidth="1" opacity="0.5" />
              <circle cx="14" cy="15" r="3" fill="#00BEFF" />
            </svg>
          </div>
          <div>
            <h1 style={styles.title}>Compliance Screening</h1>
            <p style={styles.subtitle}>Sanctions &amp; PEP Database Lookup</p>
          </div>
        </div>
        <div style={styles.headerRight}>
          <button
            onClick={() => setShowDebug((v) => !v)}
            style={{ ...styles.debugToggle, ...(showDebug ? styles.debugToggleActive : {}) }}
          >
            {showDebug ? "Hide Debug" : "Debug"}
          </button>
          <div style={styles.poweredBy}>
            <span style={styles.poweredByText}>Powered by</span>
            <span style={styles.snowflakeBadge}>❄ Snowflake Cortex</span>
          </div>
        </div>
      </header>
 
      <main style={styles.main}>
        <div style={styles.card}>
 
          {/* Input */}
          <section style={styles.inputSection}>
            <label style={styles.label} htmlFor="name-input">Subject Name</label>
            <p style={styles.hint}>Enter the full name of the individual or entity to screen.</p>
            <div style={styles.inputRow}>
              <input
                id="name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !isLoading && handleCheck()}
                placeholder="e.g. John Smith"
                disabled={isLoading}
                style={{ ...styles.input, ...(isLoading ? styles.inputDisabled : {}) }}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                onClick={handleCheck}
                disabled={isLoading || !name.trim()}
                style={{ ...styles.button, ...(isLoading || !name.trim() ? styles.buttonDisabled : {}) }}
              >
                {isLoading
                  ? <span style={styles.spinnerWrap}><span style={styles.spinner} />Checking…</span>
                  : "Screen"}
              </button>
            </div>
          </section>
 
          {/* Loading state */}
          {isLoading && (
            <>
              <hr style={styles.divider} />
              <section style={styles.loadingSection}>
                {statusMessage && (
                  <div style={styles.statusPill}>
                    <span style={styles.statusDot} />
                    <span style={styles.statusText}>{statusMessage}</span>
                  </div>
                )}
                {thinkingText ? (
                  <div style={styles.thinkingBox}>
                    <div style={styles.thinkingHeader}>
                      <span style={styles.thinkingIcon}>◈</span>
                      <span style={styles.thinkingLabel}>Agent reasoning</span>
                    </div>
                    <p style={styles.thinkingText}>
                      {thinkingText}
                      <span style={styles.cursor}>▋</span>
                    </p>
                  </div>
                ) : (
                  <div style={styles.skeleton}>
                    <div style={{ ...styles.skeletonLine, width: "70%" }} />
                    <div style={{ ...styles.skeletonLine, width: "55%" }} />
                    <div style={{ ...styles.skeletonLine, width: "65%" }} />
                  </div>
                )}
              </section>
            </>
          )}
 
          {/* Result */}
          {status === "done" && (
            <>
              <hr style={styles.divider} />
              <section style={styles.resultSection}>
                <div style={styles.resultHeader}>
                  <span style={styles.resultLabel}>Screening Result</span>
                  <button onClick={handleReset} style={styles.resetBtn}>New Search</button>
                </div>
                <div style={styles.resultBox}>
                  <pre style={styles.resultText}>{result}</pre>
                </div>
                {suggestedQueries.length > 0 && (
                  <div style={styles.suggestedSection}>
                    <span style={styles.suggestedLabel}>Suggested follow-ups</span>
                    <div style={styles.suggestedList}>
                      {suggestedQueries.map((sq, i) => (
                        <button
                          key={i}
                          style={styles.suggestedChip}
                          onClick={() => setName(sq.query)}
                        >
                          {sq.query}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </>
          )}
 
          {/* Error */}
          {status === "error" && (
            <>
              <hr style={styles.divider} />
              <div style={styles.errorBox}>
                <span style={styles.errorIcon}>⚠</span>
                <div>
                  <strong>Request failed</strong>
                  <p style={styles.errorDetail}>{errorMsg}</p>
                  <button onClick={handleReset} style={{ ...styles.resetBtn, marginTop: 8 }}>Try again</button>
                </div>
              </div>
            </>
          )}
        </div>
 
        {/* Debug panel */}
        {showDebug && (
          <div style={styles.debugPanel}>
            <div style={styles.debugHeader}>
              <span style={styles.debugTitle}>SSE Event Log</span>
              <span style={styles.debugCount}>{debugLog.length} events</span>
            </div>
            <div style={styles.debugScroll}>
              {debugLog.length === 0
                ? <p style={styles.debugEmpty}>No events yet. Run a search to see the raw stream.</p>
                : debugLog.map((evt, i) => (
                  <div key={i} style={styles.debugEvent}>
                    <span style={styles.debugEventName}>{evt.event || "(no event)"}</span>
                    <pre style={styles.debugEventData}>
                      {(() => { try { return JSON.stringify(JSON.parse(evt.data), null, 2); } catch { return evt.data || "(empty)"; } })()}
                    </pre>
                  </div>
                ))
              }
            </div>
          </div>
        )}
 
        <p style={styles.disclaimer}>
          This tool is for informational purposes only and does not constitute legal or compliance advice.
          Results should be reviewed by a qualified compliance professional.
        </p>
      </main>
 
      <style>{keyframes}</style>
    </div>
  );
}
 
// ── Styles ────────────────────────────────────────────────────────────────────
const keyframes = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  @keyframes shimmer { 0% { background-position: -400px 0; } 100% { background-position: 400px 0; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
`;
 
const styles: Record<string, React.CSSProperties> = {
  root: { fontFamily: "'DM Sans', sans-serif", minHeight: "100vh", background: "#0A0F1E", color: "#E2E8F0", display: "flex", flexDirection: "column" },
  header: { borderBottom: "1px solid rgba(0,190,255,0.12)", padding: "18px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,190,255,0.03)" },
  headerInner: { display: "flex", alignItems: "center", gap: 14 },
  logoMark: { display: "flex", alignItems: "center" },
  title: { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: "0.01em", color: "#F1F5F9" },
  subtitle: { margin: "2px 0 0", fontSize: 12, color: "#64748B", letterSpacing: "0.06em", textTransform: "uppercase" },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  poweredBy: { display: "flex", alignItems: "center", gap: 8 },
  poweredByText: { fontSize: 11, color: "#475569" },
  snowflakeBadge: { fontSize: 11, fontWeight: 500, color: "#00BEFF", background: "rgba(0,190,255,0.08)", border: "1px solid rgba(0,190,255,0.2)", borderRadius: 4, padding: "2px 8px" },
  debugToggle: { fontSize: 11, fontWeight: 500, color: "#64748B", background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "3px 10px", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" },
  debugToggleActive: { color: "#F59E0B", borderColor: "rgba(245,158,11,0.4)", background: "rgba(245,158,11,0.06)" },
  main: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 24px", gap: 16 },
  card: { width: "100%", maxWidth: 680, background: "#111827", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "32px 36px", boxShadow: "0 4px 32px rgba(0,0,0,0.4)" },
  inputSection: { display: "flex", flexDirection: "column", gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: "#94A3B8", letterSpacing: "0.08em", textTransform: "uppercase" },
  hint: { margin: 0, fontSize: 13, color: "#475569" },
  inputRow: { display: "flex", gap: 10, marginTop: 4 },
  input: { flex: 1, background: "#0D1117", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "11px 16px", fontSize: 15, color: "#E2E8F0", fontFamily: "'DM Sans', sans-serif", outline: "none" },
  inputDisabled: { opacity: 0.5, cursor: "not-allowed" },
  button: { background: "#00BEFF", color: "#0A0F1E", border: "none", borderRadius: 8, padding: "11px 24px", fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans', sans-serif", cursor: "pointer", whiteSpace: "nowrap" },
  buttonDisabled: { opacity: 0.4, cursor: "not-allowed" },
  spinnerWrap: { display: "flex", alignItems: "center", gap: 8 },
  spinner: { display: "inline-block", width: 13, height: 13, border: "2px solid rgba(10,15,30,0.3)", borderTopColor: "#0A0F1E", borderRadius: "50%", animation: "spin 0.7s linear infinite" },
  divider: { margin: "28px 0", border: "none", borderTop: "1px solid rgba(255,255,255,0.06)" },
  loadingSection: { display: "flex", flexDirection: "column", gap: 14 },
  statusPill: { display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(0,190,255,0.06)", border: "1px solid rgba(0,190,255,0.15)", borderRadius: 20, padding: "5px 12px", alignSelf: "flex-start" },
  statusDot: { width: 6, height: 6, borderRadius: "50%", background: "#00BEFF", animation: "pulse 1.4s ease-in-out infinite" },
  statusText: { fontSize: 12, color: "#7DD3FC", fontWeight: 500 },
  thinkingBox: { background: "#0D1117", border: "1px solid rgba(139,92,246,0.2)", borderRadius: 8, padding: "14px 18px" },
  thinkingHeader: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  thinkingIcon: { fontSize: 12, color: "#8B5CF6" },
  thinkingLabel: { fontSize: 11, fontWeight: 600, color: "#7C3AED", letterSpacing: "0.08em", textTransform: "uppercase" },
  thinkingText: { margin: 0, fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#6B7280", lineHeight: 1.7, whiteSpace: "pre-wrap" },
  cursor: { display: "inline-block", fontSize: 13, color: "#8B5CF6", animation: "blink 1s step-end infinite", marginLeft: 1 },
  skeleton: { display: "flex", flexDirection: "column", gap: 10, padding: "4px 0" },
  skeletonLine: { height: 12, borderRadius: 4, backgroundImage: "linear-gradient(90deg, #1E293B 25%, #2D3748 50%, #1E293B 75%)", backgroundSize: "800px 100%", animation: "shimmer 1.5s infinite linear" },
  resultSection: { display: "flex", flexDirection: "column", gap: 12 },
  resultHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  resultLabel: { fontSize: 12, fontWeight: 600, color: "#64748B", letterSpacing: "0.08em", textTransform: "uppercase" },
  resetBtn: { background: "transparent", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "4px 12px", fontSize: 12, color: "#94A3B8", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" },
  resultBox: { background: "#0D1117", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "20px 22px" },
  resultText: { margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 13, lineHeight: 1.75, color: "#CBD5E1", whiteSpace: "pre-wrap", wordBreak: "break-word" },
  suggestedSection: { display: "flex", flexDirection: "column", gap: 8, marginTop: 4 },
  suggestedLabel: { fontSize: 11, fontWeight: 600, color: "#475569", letterSpacing: "0.08em", textTransform: "uppercase" },
  suggestedList: { display: "flex", flexWrap: "wrap", gap: 8 },
  suggestedChip: { background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "5px 12px", fontSize: 12, color: "#94A3B8", cursor: "pointer", fontFamily: "'DM Sans', sans-serif", textAlign: "left" },
  errorBox: { display: "flex", alignItems: "flex-start", gap: 12, background: "rgba(220,38,38,0.08)", border: "1px solid rgba(220,38,38,0.2)", borderRadius: 8, padding: "16px 18px", color: "#FCA5A5" },
  errorIcon: { fontSize: 18, lineHeight: 1, flexShrink: 0 },
  errorDetail: { margin: "4px 0 0", fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#F87171", wordBreak: "break-all" },
  debugPanel: { width: "100%", maxWidth: 680, background: "#0D1117", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, overflow: "hidden" },
  debugHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid rgba(245,158,11,0.1)", background: "rgba(245,158,11,0.04)" },
  debugTitle: { fontSize: 11, fontWeight: 600, color: "#F59E0B", letterSpacing: "0.08em", textTransform: "uppercase" },
  debugCount: { fontSize: 11, color: "#78716C", fontFamily: "'DM Mono', monospace" },
  debugScroll: { maxHeight: 400, overflowY: "auto", padding: "12px 0" },
  debugEmpty: { margin: 0, padding: "8px 18px", fontSize: 12, color: "#44403C", fontStyle: "italic" },
  debugEvent: { padding: "8px 18px", borderBottom: "1px solid rgba(255,255,255,0.03)" },
  debugEventName: { display: "inline-block", fontSize: 10, fontWeight: 600, color: "#F59E0B", background: "rgba(245,158,11,0.1)", borderRadius: 3, padding: "1px 6px", marginBottom: 4, fontFamily: "'DM Mono', monospace" },
  debugEventData: { margin: 0, fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#78716C", whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 },
  disclaimer: { maxWidth: 680, fontSize: 11, color: "#334155", textAlign: "center", lineHeight: 1.6 },
};