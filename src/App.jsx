import { useState } from "react";
import Papa from "papaparse";
import { unzipSync, strFromU8 } from "fflate";

import { analyzePages, getPathname, getSection } from "./lib/analyze.js";
import { analyzeQueries, pagesFromQueries, dropCovered } from "./lib/queries.js";
import { detectFile, buildDeadIndex, DEAD_ISSUE } from "./lib/files.js";
import { generateReportText, generateCSV } from "./lib/report.js";
import { withLive, urlsToCheck } from "./lib/live.js";
import { DEMO } from "./demo.js";
import { signIn, listSites, loadSite, revoke } from "./lib/gsc.js";
import { explain, summarize } from "./lib/plain.js";

// Public OAuth client ID (not a secret). Sign-in stays hidden until it is set.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const REPO = "https://github.com/IgorOdaryuk/Canniscope";

// Prefilled "wrong call" issue: paths and the suggested action only, the reporter edits before posting.
function reportUrl(c) {
  const pair = c.pages.map(p => `${getPathname(p.url)} (${p.action})`).join("\n");
  const q = new URLSearchParams({
    template: "wrong-call.yml",
    title: `Wrong call: ${c.isTechnical ? "technical" : c.actionType} — ${c.pages.map(p => getPathname(p.url)).join(" vs ")}`.slice(0, 200),
    pair: `${pair}\nSuggested: ${c.suggestedAction}${c.live ? `\nLive check: ${c.live.verdict}` : ""}`,
  });
  return `${REPO}/issues/new?${q}`;
}

const LIVE_CHUNK = 25;  // URLs per request to /api/check
const LIVE_MAX = 300;   // URLs per scan

const VERDICT_STYLE = {
  real:      { label: "Real problem", color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  broken:    { label: "Fixed with a mistake", color: "#ea580c", bg: "#fff7ed", border: "#fed7aa" },
  fixed:     { label: "Already fixed", color: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
  unchecked: { label: "Not checked", color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb" },
};

// ─── STYLES (Enterprise SaaS — light, clean, boring = good) ───

const sans = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const mono = "'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace";

const C = {
  bg: "#f8f9fa",
  surface: "#ffffff",
  border: "#e5e7eb",
  borderLight: "#f0f1f3",
  text: "#111827",
  textSecondary: "#6b7280",
  textTertiary: "#9ca3af",
  accent: "#2563eb",
  accentLight: "#eff6ff",
  accentBorder: "#bfdbfe",
  high: "#dc2626",
  highBg: "#fef2f2",
  highBorder: "#fecaca",
  medium: "#d97706",
  medBg: "#fffbeb",
  medBorder: "#fde68a",
  low: "#059669",
  lowBg: "#ecfdf5",
  lowBorder: "#a7f3d0",
  tech: "#6366f1",
  techBg: "#eef2ff",
  techBorder: "#c7d2fe",
};

const s = {
  page: { minHeight: "100vh", fontFamily: sans, background: C.bg, color: C.text, fontSize: 14, lineHeight: 1.5 },
  container: { maxWidth: 960, margin: "0 auto", padding: "32px 24px" },
  h1: { fontSize: 20, fontWeight: 600, margin: "0 0 4px", color: C.text, letterSpacing: "-0.02em", lineHeight: 1.2 },
  dropzone: (active) => ({
    border: `1.5px dashed ${active ? C.accent : "#d1d5db"}`, borderRadius: 8, padding: "32px 24px",
    cursor: "pointer", textAlign: "center", background: active ? C.accentLight : C.surface, transition: "all 0.15s",
  }),
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 },
  cardHover: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  btn: (primary) => ({
    padding: primary ? "8px 16px" : "8px 14px",
    background: primary ? C.accent : C.surface,
    border: primary ? "none" : `1px solid ${C.border}`,
    borderRadius: 6, color: primary ? "#fff" : C.textSecondary,
    fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: sans,
    display: "inline-flex", alignItems: "center", gap: 5,
  }),
  filterBtn: (active) => ({
    padding: "6px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", fontFamily: sans,
    border: `1px solid ${active ? C.accent : C.border}`,
    background: active ? C.accentLight : C.surface,
    color: active ? C.accent : C.textSecondary, fontWeight: active ? 600 : 400,
  }),
  sectionTitle: (color) => ({
    fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color,
    marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${C.borderLight}`,
  }),
};

// ─── RISK STYLES ───
const RISK_STYLE = {
  HIGH: { bg: C.highBg, border: C.highBorder, color: C.high, label: "High" },
  MEDIUM: { bg: C.medBg, border: C.medBorder, color: C.medium, label: "Medium" },
  LOW: { bg: C.lowBg, border: C.lowBorder, color: C.low, label: "Low" },
  TECH: { bg: C.techBg, border: C.techBorder, color: C.tech, label: "Tech" },
};

// ─── COMPONENTS ───

function StatCard({ value, label, color }) {
  return (
    <div style={{ ...s.card, padding: "16px 20px", flex: "1 1 120px", minWidth: 120 }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: color || C.text, letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 4, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
    </div>
  );
}

const ACTION_COLORS = {
  KEEP:         { bg: C.lowBg,    color: C.low,           border: C.lowBorder },
  REDIRECT:     { bg: C.highBg,   color: C.high,          border: C.highBorder },
  MERGE:        { bg: "#fff7ed",  color: "#ea580c",       border: "#fed7aa" },
  RETARGET:     { bg: C.accentLight, color: C.accent,      border: C.accentBorder },
  REVIEW:       { bg: C.medBg,    color: C.medium,        border: C.medBorder },
  ARCHITECTURE: { bg: C.techBg,   color: C.tech,          border: C.techBorder },
  IGNORE:       { bg: "#f9fafb",  color: C.textTertiary,  border: C.borderLight },
};

// Business-friendly labels for agency owners (the counter & section headers use these)
const ACTION_LABELS = {
  REDIRECT:     "Ready to Fix",
  MERGE:        "Merge & Consolidate",
  RETARGET:     "Retarget Page",
  REVIEW:       "Manual Review",
  ARCHITECTURE: "Architecture Conflicts",
  IGNORE:       "Low Priority",
};

function ActionBadge({ action }) {
  const a = ACTION_COLORS[action] || ACTION_COLORS.REVIEW;
  return (
    <span style={{ fontSize: 10, padding: "2px 8px", background: a.bg, color: a.color, border: `1px solid ${a.border}`, borderRadius: 4, fontWeight: 700, fontFamily: mono, letterSpacing: "0.03em" }}>
      {action}
    </span>
  );
}

function WhyFlagged({ reasons }) {
  return (
    <div style={{ margin: "0 16px 8px", padding: "10px 14px", background: "#f9fafb", borderRadius: 6, border: `1px solid ${C.borderLight}` }}>
      <div style={{ fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Why flagged</div>
      {reasons.map((r, i) => (
        <div key={i} style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.7 }}>• {r}</div>
      ))}
    </div>
  );
}

function DistributionBar({ conflicts }) {
  const seo = conflicts.filter(c => !c.isTechnical);
  const tech = conflicts.filter(c => c.isTechnical);
  const items = [
    { val: seo.filter(c => c.risk === "HIGH").length, ...RISK_STYLE.HIGH },
    { val: seo.filter(c => c.risk === "MEDIUM").length, ...RISK_STYLE.MEDIUM },
    { val: seo.filter(c => c.risk === "LOW").length, ...RISK_STYLE.LOW },
    { val: tech.length, ...RISK_STYLE.TECH },
  ].filter(b => b.val > 0);

  return (
    <div style={{ ...s.card, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Distribution</div>
      <div style={{ display: "flex", gap: 2, height: 24, borderRadius: 4, overflow: "hidden" }}>
        {items.map((b, i) => (
          <div key={i} style={{ flex: b.val, background: b.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, color: "#fff" }}>{b.val}</div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
        {items.map((b, i) => (
          <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.textTertiary }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color }} /> {b.label} ({b.val})
          </span>
        ))}
      </div>
    </div>
  );
}

function SectionTree({ conflicts }) {
  const counts = {};
  const examples = {};
  conflicts.forEach(c => c.pages.forEach(p => {
    const sec = p.section || getSection(p.url);
    counts[sec] = (counts[sec] || 0) + 1;
    if (!examples[sec]) examples[sec] = getPathname(p.url);
  }));
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = sorted[0]?.[1] || 1;
  const SEC_C = {
    "ROOT": C.high, "SERVICE-AREA": C.low, "LOCATIONS": C.accent,
    "SERVICES": C.accent, "CATEGORY": C.medium, "BLOG": C.textTertiary,
  };

  return (
    <div style={{ ...s.card, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Conflicts by section</div>
      {sorted.map(([sec, count]) => (
        <div key={sec} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `1px solid ${C.borderLight}` }}>
          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 3, background: (SEC_C[sec] || C.textTertiary) + "12", color: SEC_C[sec] || C.textTertiary, minWidth: 80, textAlign: "center", fontFamily: mono }}>{sec.toLowerCase()}</span>
          <span style={{ fontSize: 12, color: C.textTertiary, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: mono }}>{examples[sec]}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text, minWidth: 20, textAlign: "right" }}>{count}</span>
          <div style={{ width: 48, height: 3, background: C.borderLight, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(count / max) * 100}%`, background: SEC_C[sec] || C.textTertiary, borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveVerdict({ live }) {
  const v = VERDICT_STYLE[live.verdict];
  const lead = {
    real: "Both pages are live, indexable and canonical to themselves — this is a real conflict.",
    broken: "Someone already started fixing this, but the fix has a problem:",
    fixed: "Already handled on the live site. Google still reports the old URL for a while; nothing to do.",
    unchecked: "The live check couldn't open enough of these pages to tell.",
  }[live.verdict];
  return (
    <div style={{ margin: "12px 16px 0", padding: "10px 14px", borderRadius: 8, background: v.bg, border: `1px solid ${v.border}`, fontSize: 12.5, color: v.color, lineHeight: 1.6 }}>
      <b>{v.label}.</b> {lead}
      {live.problems.map((x, i) => <div key={"p" + i}>• {x}</div>)}
      {live.verdict !== "broken" && live.done.map((x, i) => <div key={"d" + i} style={{ color: C.textSecondary }}>• {x}</div>)}
    </div>
  );
}

function DecisionBlock({ conflict: c }) {
  const [showWhy, setShowWhy] = useState(false);
  const a = ACTION_COLORS[c.actionType] || ACTION_COLORS.REVIEW;
  const primaryPath = getPathname(c.winner.url);
  const secondaryPath = c.loser ? getPathname(c.loser.url) : null;
  const impactColor = c.impact === "High" ? C.high : c.impact === "Medium" ? C.medium : C.low;

  return (
    <div style={{ margin: "12px 16px 10px", border: `1px solid ${a.border}`, borderRadius: 8, overflow: "hidden" }}>
      {c.positionConflict && (
        <div style={{ padding: "7px 14px", background: C.medBg, borderBottom: `1px solid ${C.medBorder}`, fontSize: 11.5, color: C.medium, fontWeight: 600 }}>
          ⚠️ Rank/traffic mismatch — a lower-traffic URL ranks higher. Review structure before redirecting; do not redirect blindly.
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", background: a.bg, borderBottom: `1px solid ${a.border}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, fontFamily: mono, letterSpacing: "0.04em", padding: "3px 8px", borderRadius: 4, background: a.color, color: "#fff" }}>{c.actionType}</span>
        <span style={{ fontSize: 12, color: a.color, fontWeight: 500, flex: 1, minWidth: 160 }}>{c.suggestedAction}</span>
        {c.recLong && (
          <button onClick={() => setShowWhy(v => !v)} style={{ fontSize: 11, fontWeight: 600, color: a.color, background: "transparent", border: `1px solid ${a.border}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontFamily: sans }}>
            {showWhy ? "Hide" : "Why?"}
          </button>
        )}
      </div>

      {showWhy && c.recLong && (
        <div style={{ padding: "10px 14px", background: "#fcfcfd", borderBottom: `1px solid ${C.borderLight}`, fontSize: 12.5, color: C.textSecondary, lineHeight: 1.6 }}>
          {c.recLong}
        </div>
      )}

      <div style={{ padding: "10px 14px", background: C.surface }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", alignItems: "baseline" }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.low, textTransform: "uppercase", letterSpacing: "0.05em" }}>Primary</span>
          <span style={{ fontFamily: mono, fontSize: 12, color: C.text, fontWeight: 600, wordBreak: "break-all" }}>
            {primaryPath} <span style={{ color: C.textTertiary, fontWeight: 400 }}>· {c.winner.clicks} clicks · {c.winner.impressions.toLocaleString()} impr · pos {c.winner.position.toFixed(1)}</span>
          </span>
          {secondaryPath && (
            <>
              <span style={{ fontSize: 10, fontWeight: 700, color: C.high, textTransform: "uppercase", letterSpacing: "0.05em" }}>Secondary</span>
              <span style={{ fontFamily: mono, fontSize: 12, color: C.text, wordBreak: "break-all" }}>
                {secondaryPath} <span style={{ color: C.textTertiary }}>· {c.loser.clicks} clicks · {c.loser.impressions.toLocaleString()} impr · pos {c.loser.position.toFixed(1)}</span>
              </span>
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.borderLight}`, flexWrap: "wrap" }}>
          <span style={{ fontSize: 22 }}>{c.splitEmoji}</span>
          <div style={{ display: "flex", flexDirection: "column", minWidth: 120 }}>
            <span style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
              {c.splitPct}% <span style={{ fontSize: 12, fontWeight: 500, color: C.textTertiary }}>traffic split</span>
            </span>
            <span style={{ fontSize: 11, color: C.textSecondary, marginTop: 2 }}>{c.splitStrength}</span>
          </div>
          <div style={{ flex: 1, height: 6, background: C.borderLight, borderRadius: 3, overflow: "hidden", minWidth: 80, maxWidth: 180 }}>
            <div style={{ height: "100%", width: `${Math.min(c.splitPct, 100)}%`, background: c.splitPct >= 30 ? C.high : c.splitPct >= 10 ? C.medium : C.low, borderRadius: 3 }} />
          </div>
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, padding: "4px 11px", borderRadius: 6, background: impactColor + "12", color: impactColor, border: `1px solid ${impactColor}30`, fontWeight: 700 }}>
            Impact: {c.impact}
          </span>
        </div>
        {c.impactReason && (
          <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 6 }}>{c.impactReason}</div>
        )}

        {c.pageCount > 2 && (
          <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 8 }}>
            +{c.pageCount - 2} more URL{c.pageCount - 2 > 1 ? "s" : ""} in this cluster — see table below
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictCard({ conflict: c }) {
  const [open, setOpen] = useState(false);
  const rs = c.isTechnical ? RISK_STYLE.TECH : RISK_STYLE[c.risk] || RISK_STYLE.LOW;

  return (
    <div style={{ ...s.card, marginBottom: 6, overflow: "hidden", borderColor: open ? rs.border : C.border }}>
      <div onClick={() => setOpen(!open)} style={{ padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "background 0.1s" }}
           onMouseEnter={e => e.currentTarget.style.background = "#fafbfc"}
           onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 8px", borderRadius: 3, background: rs.bg, color: rs.color, border: `1px solid ${rs.border}` }}>{rs.label}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: C.text }}>
            {!c.isTechnical && (() => {
              const ac = ACTION_COLORS[c.actionType] || ACTION_COLORS.REVIEW;
              return <span style={{ fontSize: 9, fontWeight: 700, fontFamily: mono, padding: "1px 6px", borderRadius: 3, background: ac.bg, color: ac.color, border: `1px solid ${ac.border}`, marginRight: 6, letterSpacing: "0.03em" }}>{c.actionType}</span>;
            })()}
            {c.label}
          </div>
          <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 2 }}>
            {c.sections.join(" + ")} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impr
          </div>
        </div>
        {!c.isTechnical && (
          <span style={{ fontSize: 10, color: C.textTertiary }}>
            <span style={{ color: rs.color, fontWeight: 600 }}>{c.risk}</span>
            {" · "}
            <span style={{ fontWeight: 500 }}>{c.confidence}</span>
          </span>
        )}
        <span style={{ fontSize: 18, fontWeight: 700, color: C.text, minWidth: 36, textAlign: "right", opacity: 0.6 }}>{c.score}</span>
        <span style={{ color: C.textTertiary, fontSize: 12, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
      </div>
      {open && (
        <ConflictDetails c={c} />
      )}
    </div>
  );
}

// Technical internals of one cluster: live verdict, decision, reasons, page table.
function ConflictDetails({ c }) {
  return (
        <div style={{ borderTop: `1px solid ${C.borderLight}` }}>
          <div style={{ margin: "10px 16px 0", textAlign: "right", fontSize: 11 }}>
            <a href={reportUrl(c)} target="_blank" rel="noopener noreferrer" style={{ color: C.textTertiary }}>Wrong call? Report it on GitHub</a>
          </div>
          {c.live && <LiveVerdict live={c.live} />}
          <DecisionBlock conflict={c} />
          <WhyFlagged reasons={c.reasons} />
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.borderLight}` }}>
                <th style={{ padding: "6px 16px", textAlign: "left", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>URL</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Clicks</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Impr</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pos</th>
                <th style={{ padding: "6px 16px", textAlign: "left", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Action</th>
                {c.live && <th style={{ padding: "6px 16px", textAlign: "left", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Live site now</th>}
              </tr>
            </thead>
            <tbody>
              {c.pages.map((p, pi) => {
                const isPrimary = p.action === "KEEP";
                return (
                <tr key={pi} style={{ borderBottom: `1px solid ${C.borderLight}`, background: isPrimary ? C.lowBg : "transparent" }}>
                  <td style={{ padding: "8px 16px", fontFamily: mono, fontSize: 12, color: isPrimary ? C.low : C.text, fontWeight: isPrimary ? 600 : 400, wordBreak: "break-all", maxWidth: 300 }}>
                    {isPrimary && "★ "}{getPathname(p.url)}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, fontFamily: mono }}>{p.clicks}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: mono }}>{p.impressions.toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: mono }}>{p.position.toFixed(1)}</td>
                  <td style={{ padding: "8px 16px" }}><ActionBadge action={p.action} /></td>
                  {c.live && (() => {
                    const lp = c.live.pages.find(x => x.url === p.url);
                    const k = lp ? lp.state.kind : "unknown";
                    const col = k === "live" ? C.text : k === "unknown" ? C.textTertiary : k === "gone" || k === "redirect-dead" ? C.high : C.low;
                    return <td style={{ padding: "8px 16px", fontSize: 11, color: col, wordBreak: "break-all" }}>{lp ? lp.label : "—"}</td>;
                  })()}
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
  );
}

// ─── SIMPLE VIEW ───

const KIND_COLOR = { broken: "#ea580c", fight: "#dc2626", steal: "#d97706", choose: "#d97706", tech: "#6366f1", maybe: "#6b7280" };

function SimpleCard({ conflict }) {
  const e = explain(conflict);
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const copy = () => { navigator.clipboard.writeText(e.devNote); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  return (
    <div style={{ ...s.card, padding: "18px 20px", marginBottom: 10, borderLeft: `4px solid ${KIND_COLOR[e.kind]}` }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: C.text, marginBottom: 10, lineHeight: 1.35 }}>{e.title}</div>
      <div style={{ marginBottom: 12 }}>
        {e.pages.map((p, i) => (
          <div key={i} style={{ fontSize: 13, lineHeight: 1.6, wordBreak: "break-all" }}>
            <span style={{ color: C.textTertiary, display: "inline-block", minWidth: 120, marginRight: 8 }}>{p.label}</span>
            <span style={{ fontFamily: mono, fontSize: 12, color: C.text }}>{p.path}</span>
          </div>
        ))}
      </div>
      {conflict.live && conflict.live.verdict === "unchecked" && (
        <div style={{ fontSize: 12.5, color: C.textTertiary, marginBottom: 8 }}>We couldn't open one of these pages to double-check, so this one may already be fixed.</div>
      )}
      {[["What's happening", e.what], ["Why it matters", e.why], ["If you leave it", e.ifLeft], ["What to do", e.todo]].map(([h, t]) => (
        <div key={h} style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 8, color: h === "What to do" ? C.text : C.textSecondary }}>
          <b style={{ color: C.text }}>{h}:</b> {t}
        </div>
      ))}
      <div style={{ height: 4 }} />
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={copy} style={{ ...s.btn(false), color: C.accent, borderColor: C.accentBorder }}>{copied ? "✓ Copied — paste it to your developer" : "Copy note for your web developer"}</button>
        <button onClick={() => setOpen(v => !v)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 13, color: C.textTertiary, fontFamily: sans }}>
          Advanced details <span style={{ display: "inline-block", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
        </button>
      </div>
      {open && <div style={{ margin: "14px -20px -18px", borderTop: `1px solid ${C.borderLight}`, paddingBottom: 12 }}><ConflictDetails c={conflict} /></div>}
    </div>
  );
}

// ─── MAIN APP ───

export default function CanniScope() {
  const [conflicts, setConflicts] = useState(null);
  const [ignoredCounts, setIgnoredCounts] = useState(null);
  const [totalPages, setTotalPages] = useState(0);
  const [reportText, setReportText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [cleanMsg, setCleanMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confFilter, setConfFilter] = useState("all");
  const [brandInput, setBrandInput] = useState("");
  const [runInfo, setRunInfo] = useState(null);
  const [liveOn, setLiveOn] = useState(true);
  const [showTech, setShowTech] = useState(false);
  const [gToken, setGToken] = useState(null);
  const [gSites, setGSites] = useState(null);
  const [gSite, setGSite] = useState("");
  const [gBusy, setGBusy] = useState("");

  const googleSignIn = async () => {
    setError(null); setGBusy("Waiting for Google…");
    try {
      const token = await signIn(GOOGLE_CLIENT_ID);
      setGToken(token);
      const sites = await listSites(token);
      setGSites(sites); setGSite(sites[0] || "");
      if (!sites.length) setError("This Google account has no Search Console properties.");
    } catch (e) { setError(e.message); }
    setGBusy("");
  };

  const googleScan = async () => {
    if (!gToken || !gSite) return;
    setError(null); setCleanMsg(null); setLoading(true);
    try {
      const { range, pageRows, queryRows } = await loadSite(gToken, gSite, (msg) => setGBusy(`Downloading from Search Console — ${msg}`));
      setGBusy("");
      const pagesFile = detectFile(pageRows, ["Top pages", "Clicks", "Impressions", "CTR", "Position"]);
      const queryFile = queryRows.length ? detectFile(queryRows, ["query", "page", "clicks", "impressions", "position"]) : null;
      runScan({ pagesFile, queryFile, notes: [`Search Console: ${gSite} · ${range}`] });
    } catch (e) { setError(e.message); setGBusy(""); setLoading(false); }
  };

  const googleSignOut = () => { if (gToken) revoke(gToken); setGToken(null); setGSites(null); setGSite(""); };
  const [liveCheck, setLiveCheck] = useState(null);

  // Open every flagged URL on the live site (via /api/check) and sort clusters
  // into real problems / already fixed / fixed with a mistake.
  // Example run on made-up data: same pipeline, live answers baked in.
  const runDemo = () => {
    setError(null); setCleanMsg(null); setCopied(false);
    const pageRows = pagesFromQueries(DEMO.queryRows);
    const slug = analyzePages(pageRows);
    const q = analyzeQueries(DEMO.queryRows, { brands: DEMO.brands });
    const found = [...q.conflicts, ...dropCovered(q.conflicts, slug.conflicts).kept];
    const live = new Map(DEMO.liveResults.map(r => [r.url, r]));
    const judged = found.map(c => withLive(c, live));
    setIgnoredCounts(slug.ignoredCounts); setTotalPages(slug.totalPages);
    setRunInfo({ hasQueries: true, queryStats: q.stats, deadCount: 0, resolved: 0, statusFiles: 0, notes: [`Example data for a made-up site (${DEMO.site}). Upload your own files to scan your site.`], totalImpr: 0, demo: true });
    setConflicts(judged); setReportText(generateReportText(judged));
    setLiveCheck({ state: "done", done: DEMO.liveResults.length, total: DEMO.liveResults.length, failed: 0, skipped: 0 });
  };

  const runLiveCheck = async (found) => {
    const urls = urlsToCheck(found, LIVE_MAX);
    if (!urls.length) return;
    setLiveCheck({ state: "running", done: 0, total: urls.length });
    const results = new Map();
    const chunks = [];
    for (let i = 0; i < urls.length; i += LIVE_CHUNK) chunks.push(urls.slice(i, i + LIVE_CHUNK));
    let done = 0, failed = 0;
    for (let i = 0; i < chunks.length; i += 2) {
      await Promise.all(chunks.slice(i, i + 2).map(async (chunk) => {
        try {
          const r = await fetch("/api/check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls: chunk }) });
          if (!r.ok) throw new Error(String(r.status));
          const j = await r.json();
          j.results.forEach(x => results.set(x.url, x));
        } catch { failed += chunk.length; }
        done += chunk.length;
        setLiveCheck({ state: "running", done, total: urls.length });
      }));
    }
    const judged = found.map(c => withLive(c, results));
    setConflicts(judged); setReportText(generateReportText(judged));
    setLiveCheck({ state: failed === urls.length ? "error" : "done", done, total: urls.length, failed, skipped: Math.max(0, new Set(found.flatMap(c => c.pages.map(p => p.url))).size - urls.length) });
  };

  const processFiles = async (files) => {
    setError(null); setCleanMsg(null); setLoading(true); setCopied(false);
    // GSC's Export button gives a .zip — open it here, no need to unzip first.
    const csvFiles = [];
    for (const f of Array.from(files)) {
      const n = f.name.toLowerCase();
      if (n.endsWith(".csv")) csvFiles.push({ file: f, text: null });
      else if (n.endsWith(".zip")) {
        try {
          const entries = unzipSync(new Uint8Array(await f.arrayBuffer()));
          Object.entries(entries).forEach(([name, data]) => {
            if (name.toLowerCase().endsWith(".csv") && !name.startsWith("__MACOSX")) {
              const folder = (f.webkitRelativePath || f.name) + "/" + name.split("/").slice(0, -1).join("/");
              csvFiles.push({ file: { name: name.split("/").pop(), webkitRelativePath: folder + "/" + name.split("/").pop() }, text: strFromU8(data) });
            }
          });
        } catch { setError(`Couldn't open ${f.name}. Is it a zip from Search Console?`); setLoading(false); return; }
      }
    }
    if (csvFiles.length === 0) { setError("That's not a Search Console file. In Search Console: Performance → Export → Download CSV, then drop the downloaded file here."); setLoading(false); return; }

    const parsed = await Promise.all(csvFiles.map(({ file, text }) => new Promise(resolve => {
      Papa.parse(text ?? file, {
        header: true, skipEmptyLines: true,
        complete: (res) => resolve({ file, ...detectFile(res.data, res.meta.fields) }),
        error: () => resolve({ file, kind: "unknown" }),
      });
    })));

    // A GSC indexing export folder = Table.csv + Metadata.csv. Only keep its URL list
    // when the issue really means "not a live page" (redirect / 404).
    const folderOf = (f) => (f.webkitRelativePath || "").split("/").slice(0, -1).join("/");
    const metaByFolder = {};
    parsed.filter(x => x.kind === "meta").forEach(x => { metaByFolder[folderOf(x.file)] = x.issue; });
    const notes = [];
    const statusFiles = parsed.filter(x => x.kind === "status").filter(x => {
      const issue = metaByFolder[folderOf(x.file)];
      if (issue && !DEAD_ISSUE.test(issue)) { notes.push(`Ignored URL list “${issue}” — only redirect and 404 lists are used.`); return false; }
      return true;
    }).map(x => ({ ...x, label: metaByFolder[folderOf(x.file)] || x.file.name }));

    const pagesFile = parsed.find(x => x.kind === "pages");
    const queryFile = parsed.find(x => x.kind === "queries");
    if (!pagesFile && !queryFile) {
      setError("We couldn't find your pages in that file. In Search Console open Performance → Export → Download CSV and drop the downloaded file here as it is.");
      setLoading(false); return;
    }

    runScan({ pagesFile, queryFile, statusFiles, notes });
  };

  // Shared by file upload and Google sign-in.
  const runScan = ({ pagesFile, queryFile, statusFiles = [], notes = [] }) => {
    const merged = (pagesFile ? pagesFile.mergedVariants : 0) + (queryFile ? queryFile.mergedVariants : 0);
    if (merged > 0) notes.push(`${merged.toLocaleString()} rows for URLs with tracking tags or #anchors were merged into their page (e.g. “/?utm_source=gbp” counts as “/”).`);
    const { dead, isDead } = buildDeadIndex(statusFiles);
    const brands = brandInput.split(",").map(b => b.trim()).filter(Boolean);
    const pageRows = pagesFile ? pagesFile.rows : pagesFromQueries(queryFile.rows);
    const slug = analyzePages(pageRows, { isDead });
    const q = queryFile ? analyzeQueries(queryFile.rows, { isDead, brands }) : null;

    const totalImpr = pageRows.reduce((s, r) => s + (parseInt(String(r.Impressions).replace(/,/g, "")) || 0), 0);
    const results = q ? [...q.conflicts, ...dropCovered(q.conflicts, slug.conflicts).kept] : slug.conflicts;
    setIgnoredCounts(slug.ignoredCounts); setTotalPages(slug.totalPages);
    setRunInfo({
      hasQueries: !!q, queryStats: q ? q.stats : null, deadCount: dead.size,
      resolved: slug.resolvedClusters, statusFiles: statusFiles.length, notes, totalImpr,
      pagesFromQueries: !pagesFile,
    });
    const thin = totalImpr < 20000;
    if (results.length === 0) {
      setCleanMsg(thin
        ? `Scanned ${slug.totalPages} pages, nothing flagged — but the file has only ${totalImpr.toLocaleString()} impressions. That is too little data to rule cannibalization out; re-run when the site has more search traffic.`
        : `Scanned ${slug.totalPages} pages${q ? ` and ${q.stats.queries.toLocaleString()} queries` : ""} — no pages competing for the same target found.`);
      setLoading(false); return;
    }
    setConflicts(results); setReportText(generateReportText(results)); setLoading(false);
    if (liveOn) runLiveCheck(results);
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);
  const downloadReport = () => { const b = new Blob([reportText], { type: "text/plain;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-report.txt"; a.click(); URL.revokeObjectURL(u); };
  const downloadCSV = () => { const csv = generateCSV(conflicts); const b = new Blob([csv], { type: "text/csv;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-export.csv"; a.click(); URL.revokeObjectURL(u); };
  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const reset = () => { setConflicts(null); setReportText(""); setError(null); setCleanMsg(null); setIgnoredCounts(null); setTotalPages(0); setConfFilter("all"); setRunInfo(null); setLiveCheck(null); setShowTech(false); };

  if (!conflicts) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 480, width: "100%" }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 2, letterSpacing: "-0.02em" }}>CanniScope</div>
            <div style={{ marginBottom: 8 }}><a href="https://odariuk.com" target="_blank" rel="noopener" style={{ fontSize: 12, fontWeight: 500, color: C.textSecondary, textDecoration: "none" }}>by <span style={{ color: C.accent, fontWeight: 600 }}>Igor Odariuk</span></a></div>
            <h1 style={{ fontSize: 26, fontWeight: 700, color: C.text, lineHeight: 1.2, letterSpacing: "-0.025em", margin: "18px 0 10px" }}>Are your own pages competing with each other on Google?</h1>
            <p style={{ fontSize: 15, color: C.textSecondary, marginBottom: 24, lineHeight: 1.55 }}>When two pages on your site go after the same search, Google splits its attention and both end up lower. CanniScope finds those pairs and tells you in plain English what to do. Free.</p>
            {GOOGLE_CLIENT_ID && (
              <div style={{ ...s.card, padding: "14px 16px", marginBottom: 12, textAlign: "left" }}>
                {!gToken ? (
                  <>
                    <button onClick={googleSignIn} disabled={!!gBusy} style={{ ...s.btn(true), width: "100%", justifyContent: "center", padding: "10px 16px" }}>
                      {gBusy || "Check my site — sign in with Google"}
                    </button>
                    <div style={{ fontSize: 11.5, color: C.textTertiary, marginTop: 8, lineHeight: 1.5 }}>
                      We only read your Search Console numbers. They go from Google to this tab and nowhere else. <a href="/privacy.html" style={{ color: C.textTertiary }}>Privacy</a>
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: C.textSecondary, marginBottom: 6 }}>Pick a Search Console property:</div>
                    <select value={gSite} onChange={(e) => setGSite(e.target.value)} style={{ width: "100%", padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: sans, background: C.surface, color: C.text }}>
                      {(gSites || []).map(x => <option key={x} value={x}>{x}</option>)}
                    </select>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={googleScan} disabled={loading || !gSite} style={{ ...s.btn(true), flex: 1, justifyContent: "center" }}>{gBusy || (loading ? "Analyzing…" : "Scan last 90 days")}</button>
                      <button onClick={googleSignOut} style={s.btn(false)}>Sign out</button>
                    </div>
                  </>
                )}
              </div>
            )}
            {GOOGLE_CLIENT_ID && <div style={{ fontSize: 11, color: C.textTertiary, margin: "4px 0 10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>or upload files</div>}
            <div style={{ ...s.card, padding: "16px 18px", marginBottom: 12, textAlign: "left", borderColor: C.accentBorder }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>Get the full check (about 5 minutes)</div>
              <div style={{ fontSize: 13, color: C.textSecondary, lineHeight: 1.55, marginBottom: 10 }}>
                The normal Search Console export doesn't say which searches each page shows up for. Without that, CanniScope can only do a quick check and will miss most problems. Here's how to get it for free:
              </div>
              <ol style={{ fontSize: 13, color: C.text, lineHeight: 1.65, paddingLeft: 18, margin: 0 }}>
                <li>Open a new Google Sheet and install the free add-on <a href="https://searchanalyticsforsheets.com/" target="_blank" rel="noopener" style={{ color: C.accent }}>Search Analytics for Sheets</a>.</li>
                <li>In the sheet: Extensions (or Add-ons) → Search Analytics for Sheets → Open Sidebar.</li>
                <li>Pick your site and the last 3 months. Under <b>Group by</b> add <b>Queries</b> and <b>Pages</b>. Click <b>Request Data</b>.</li>
                <li>File → Download → CSV, and drop that file below.</li>
              </ol>
            </div>
            <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={s.dropzone(dragOver)}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: "#059669" + "14", color: "#059669", border: "1px solid #059669" + "30", fontFamily: mono, letterSpacing: "0.03em" }}>.CSV</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 3 }}>{loading ? "Checking your site…" : "Drop your file here"}</div>
              <div style={{ fontSize: 12, color: C.textTertiary }}>The file from the add-on (full check) · or Search Console → Performance → Export (quick check, zip is fine)</div>
              <input id="csv-input" type="file" multiple accept=".csv,.zip" onChange={onFileSelect} style={{ display: "none" }} />
            </div>
            <button onClick={runDemo} style={{ ...s.btn(false), width: "100%", justifyContent: "center", marginTop: 8, padding: "10px 14px", color: C.accent, borderColor: C.accentBorder }}>Not sure? See an example first →</button>
            {error && <div style={{ marginTop: 16, padding: "10px 14px", background: C.highBg, border: `1px solid ${C.highBorder}`, borderRadius: 6, fontSize: 13, color: C.high }}>{error}</div>}
            {cleanMsg && <div style={{ marginTop: 16, padding: "10px 14px", background: C.lowBg, border: `1px solid ${C.lowBorder}`, borderRadius: 6, fontSize: 13, color: C.low }}>{cleanMsg}</div>}
            <details style={{ marginTop: 24, textAlign: "left" }}>
              <summary style={{ cursor: "pointer", fontSize: 12, color: C.textTertiary }}>Advanced options (for SEOs)</summary>
            <button onClick={() => document.getElementById("folder-input").click()} style={{ ...s.btn(false), width: "100%", justifyContent: "center", marginTop: 8 }}>Select entire export folder</button>
            <input value={brandInput} onChange={(e) => setBrandInput(e.target.value)} placeholder="Brand names and misspellings, comma separated (optional)" style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: sans, color: C.text, background: C.surface }} />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, fontSize: 12, color: C.textSecondary, textAlign: "left", lineHeight: 1.5, cursor: "pointer" }}>
              <input type="checkbox" checked={liveOn} onChange={(e) => setLiveOn(e.target.checked)} style={{ marginTop: 2 }} />
              <span>Check flagged URLs on the live site — finds pairs you already fixed with a 301, canonical or noindex. Only the addresses of flagged pages are sent to our checker; clicks, impressions and queries stay in your browser.</span>
            </label>
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />
            <div style={{ marginTop: 12, padding: "14px 18px", background: C.surface, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.textSecondary, lineHeight: 1.8, textAlign: "left" }}>
              <div style={{ fontWeight: 600, color: C.text, marginBottom: 4, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Files the scan understands</div>
              <b style={{ color: C.text }}>Pages.csv</b> — GSC → Performance → 3 months → Export → unzip.<br/>
              <b style={{ color: C.text }}>Query + page CSV</b> (recommended) — columns query, page, clicks, impressions, position. GSC's own export can't pair them; use the Search Console API, Looker Studio or the Search Analytics for Sheets add-on.<br/>
              <b style={{ color: C.text }}>Redirect / 404 list</b> (optional) — not needed when the live check is on. Useful if your site blocks bots: GSC → Indexing → Pages → “Page with redirect” / “Not found (404)” → Export, or a Screaming Frog export with Status Code.
            </div>
            </details>
            <div style={{ marginTop: 16, fontSize: 12, color: C.textTertiary }}>
              by <a href="https://odariuk.com" target="_blank" rel="noopener" style={{ color: C.accent, textDecoration: "none", fontWeight: 600 }}>Igor Odariuk</a>
              {" · "}<a href={REPO} target="_blank" rel="noopener noreferrer" style={{ color: C.textTertiary }}>Open source on GitHub — issues and PRs welcome</a>
              {" · "}<a href="/privacy.html" style={{ color: C.textTertiary }}>Privacy</a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!showTech) {
    const { todo, fixed } = summarize(conflicts);
    const order = { broken: 0, fight: 1, steal: 2, choose: 3, tech: 4, maybe: 5 };
    const cards = [...todo].sort((a, b) => (order[explain(a).kind] - order[explain(b).kind]) || ((b.contested || b.totalImpressions || 0) - (a.contested || a.totalImpressions || 0)));
    const running = liveCheck && liveCheck.state === "running";
    return (
      <div style={s.page}>
        <div style={{ ...s.container, maxWidth: 760 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 28, flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>CanniScope</div>
              <a href="https://odariuk.com" target="_blank" rel="noopener" style={{ fontSize: 12, color: C.textSecondary, textDecoration: "none" }}>by <span style={{ color: C.accent, fontWeight: 600 }}>Igor Odariuk</span></a>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {cards.length > 0 && <button onClick={() => { navigator.clipboard.writeText(cards.map((c, i) => { const e = explain(c); return `${i + 1}. ${e.title}\n${e.pages.map(p => `${p.label}: ${p.path}`).join("\n")}\n${e.devNote}`; }).join("\n\n")); setCopied(true); setTimeout(() => setCopied(false), 2000); }} style={s.btn(false)}>{copied ? "✓ Copied" : "Copy all notes"}</button>}
              <button onClick={() => setShowTech(true)} style={s.btn(false)}>Technical details</button>
              <button onClick={reset} style={s.btn(false)}>Check another site</button>
            </div>
          </div>

          {runInfo && runInfo.demo && <div style={{ fontSize: 13, color: C.textTertiary, marginBottom: 12 }}>This is an example on a made-up site.</div>}
          {running ? (
            <h2 style={{ fontSize: 24, fontWeight: 700, color: C.text, margin: "0 0 8px" }}>Checking your pages… {liveCheck.done} / {liveCheck.total}</h2>
          ) : (
            <h2 style={{ fontSize: 26, fontWeight: 700, color: C.text, margin: "0 0 8px", letterSpacing: "-0.02em" }}>
              {cards.length === 0
                ? (runInfo && !runInfo.hasQueries && !runInfo.demo ? "Nothing found in the quick check" : "Nothing to fix. Your pages don't compete with each other.")
                : `${cards.length} thing${cards.length === 1 ? "" : "s"} to fix on your site`}
            </h2>
          )}
          {!running && fixed.length > 0 && (
            <div style={{ fontSize: 14, color: "#059669", marginBottom: 8 }}>✓ {fixed.length} older issue{fixed.length === 1 ? " is" : "s are"} already fixed on your site. Nothing to do there.</div>
          )}
          {!running && runInfo && !runInfo.hasQueries && !runInfo.demo && (
            <div style={{ padding: "12px 14px", background: C.medBg, border: `1px solid ${C.medBorder}`, borderRadius: 8, fontSize: 13.5, color: C.text, margin: "10px 0", lineHeight: 1.55 }}>
              <b>This was a quick check.</b> Search Console's export only lists your pages, not which searches each page shows up for, so we can't see most pages that compete with each other. A short list here doesn't mean your site is fine. <button onClick={reset} style={{ background: "none", border: "none", padding: 0, color: C.accent, cursor: "pointer", fontSize: 13.5, fontFamily: sans, textDecoration: "underline" }}>See how to get the full check</button> (free, about 5 minutes).
              {GOOGLE_CLIENT_ID && <> <button onClick={reset} style={{ background: "none", border: "none", padding: 0, color: C.accent, cursor: "pointer", fontSize: 13.5, fontFamily: sans, textDecoration: "underline" }}>Sign in with Google for the full check</button>.</>}
            </div>
          )}

          <div style={{ marginTop: 20 }}>
            {cards.map((c, i) => <SimpleCard key={i} conflict={c} />)}
          </div>

          <div style={{ ...s.card, padding: "20px 22px", marginTop: 24, background: C.accentLight, borderColor: C.accentBorder }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 6 }}>Don't have time to deal with this?</div>
            <div style={{ fontSize: 14, color: C.textSecondary, lineHeight: 1.6, marginBottom: 12 }}>I'm Igor. I fix this kind of thing for service businesses. A fixed-price check of your site, with a clear list of what to change, is $490.</div>
            <a href="https://odariuk.com/pricing#snapshot" target="_blank" rel="noopener" style={{ ...s.btn(true), textDecoration: "none" }}>See what's included →</a>
          </div>

          <div style={{ textAlign: "center", padding: "28px 0 8px", fontSize: 12, color: C.textTertiary }}>
            <a href="/privacy.html" style={{ color: C.textTertiary }}>Privacy</a>{" · "}
            <a href={REPO} target="_blank" rel="noopener noreferrer" style={{ color: C.textTertiary }}>Open source on GitHub</a>
          </div>
        </div>
      </div>
    );
  }

  // With a live check, only real (or unchecked) clusters go into the main lists.
  const active = conflicts.filter(c => !c.live || c.live.verdict === "real" || c.live.verdict === "unchecked");
  const fixedC = conflicts.filter(c => c.live && c.live.verdict === "fixed");
  const brokenC = conflicts.filter(c => c.live && c.live.verdict === "broken");
  const queryC = active.filter(c => c.isQuery);
  const seo = active.filter(c => !c.isTechnical && !c.isQuery);
  const tech = active.filter(c => c.isTechnical);
  const high = [...queryC, ...seo].filter(c => c.risk === "HIGH").length;
  const medium = [...queryC, ...seo].filter(c => c.risk === "MEDIUM").length;
  const totalURLs = new Set(active.flatMap(c => c.pages.map(p => p.url))).size;

  const actionCounts = active.reduce((acc, c) => {
    acc[c.actionType] = (acc[c.actionType] || 0) + 1;
    return acc;
  }, {});
  const actionOrder = ["REDIRECT", "MERGE", "RETARGET", "REVIEW", "ARCHITECTURE", "IGNORE"];

  const filterFn = (c) => confFilter === "all" ? true : confFilter === "HIGH" ? c.confidence === "HIGH" : (c.confidence === "HIGH" || c.confidence === "MEDIUM");
  const filteredSeo = seo.filter(filterFn);
  const fHigh = filteredSeo.filter(c => c.risk === "HIGH");
  const fMed = filteredSeo.filter(c => c.risk === "MEDIUM");
  const fLow = filteredSeo.filter(c => c.risk === "LOW");
  const fQuery = queryC.filter(filterFn);

  const topActions = [...queryC, ...seo].filter(c => c.confidence === "HIGH" && c.risk === "HIGH").sort((a, b) => b.score - a.score).slice(0, 5);

  return (
    <div style={s.page}>
      <div style={s.container}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, letterSpacing: "-0.02em" }}>CanniScope <span style={{ fontWeight: 400 }}>{" "}</span><a href="https://odariuk.com" target="_blank" rel="noopener" style={{ fontSize: 12, fontWeight: 500, color: C.textSecondary, textDecoration: "none" }}>by <span style={{ color: C.accent, fontWeight: 600 }}>Igor Odariuk</span></a></div>
            <div style={{ fontSize: 9, fontWeight: 600, color: C.textTertiary, letterSpacing: "0.05em", textTransform: "uppercase" }}>Local SEO audit</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={downloadReport} style={s.btn(true)}>Export Report</button>
            <button onClick={downloadCSV} style={s.btn(true)}>Export CSV</button>
            <button onClick={copyReport} style={s.btn(false)}>{copied ? "✓ Copied" : "Copy"}</button>
            <button onClick={() => setShowTech(false)} style={s.btn(false)}>Simple view</button>
            <button onClick={reset} style={s.btn(false)}>New Scan</button>
          </div>
        </div>

        <h2 style={s.h1}>{conflicts.length} possible clusters found</h2>
        {liveCheck && liveCheck.state === "running" && (
          <div style={{ padding: "8px 12px", background: C.accentLight, border: `1px solid ${C.accentBorder}`, borderRadius: 6, margin: "8px 0", fontSize: 12, color: C.accent }}>
            Checking flagged URLs on the live site… {liveCheck.done} / {liveCheck.total}
          </div>
        )}
        {liveCheck && liveCheck.state !== "running" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 12px" }}>
            {[["real", active.length], ["broken", brokenC.length], ["fixed", fixedC.length]].map(([k, n]) => (
              <span key={k} style={{ display: "inline-flex", flexDirection: "column", gap: 2, padding: "8px 14px", borderRadius: 8, background: VERDICT_STYLE[k].bg, border: `1px solid ${VERDICT_STYLE[k].border}`, minWidth: 120 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: VERDICT_STYLE[k].color, lineHeight: 1 }}>{n}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: VERDICT_STYLE[k].color }}>{k === "real" ? "To fix" : VERDICT_STYLE[k].label}</span>
              </span>
            ))}
            {liveCheck.state === "error" && <span style={{ fontSize: 12, color: C.high, alignSelf: "center" }}>Live check failed — results below are not filtered.</span>}
            {liveCheck.skipped > 0 && <span style={{ fontSize: 12, color: C.textTertiary, alignSelf: "center" }}>{liveCheck.skipped} lower-risk URLs not checked (limit {LIVE_MAX}).</span>}
          </div>
        )}
        <p style={{ fontSize: 13, color: C.textTertiary, margin: "0 0 16px" }}>
          {runInfo && runInfo.hasQueries && <>{queryC.length} competing in search · </>}{seo.length} same-target URLs · {tech.length} technical · {totalURLs} URLs involved
        </p>

        {runInfo && !(liveCheck && liveCheck.state === "done") && (runInfo.statusFiles > 0 ? (
          <div style={{ padding: "8px 12px", background: C.lowBg, border: `1px solid ${C.lowBorder}`, borderRadius: 6, marginBottom: 8, fontSize: 12, color: C.low }}>
            {runInfo.deadCount.toLocaleString()} redirected / removed URLs left out{runInfo.resolved > 0 ? ` · ${runInfo.resolved} clusters already resolved by those redirects` : ""}.
          </div>
        ) : (
          <div style={{ padding: "8px 12px", background: C.medBg, border: `1px solid ${C.medBorder}`, borderRadius: 6, marginBottom: 8, fontSize: 12, color: C.medium }}>
            No redirect / 404 list uploaded — GSC keeps reporting URLs for months after a 301, so some clusters below may already be fixed.
          </div>
        ))}
        {runInfo && !runInfo.hasQueries && (
          <div style={{ padding: "8px 12px", background: C.accentLight, border: `1px solid ${C.accentBorder}`, borderRadius: 6, marginBottom: 8, fontSize: 12, color: C.accent }}>
            Pages only: clusters are matched by URL pattern. Add a query + page file to confirm which pages actually compete in search.
          </div>
        )}
        {runInfo && runInfo.notes.map((n, i) => (
          <div key={i} style={{ padding: "8px 12px", background: "#f9fafb", border: `1px solid ${C.borderLight}`, borderRadius: 6, marginBottom: 8, fontSize: 12, color: C.textSecondary }}>{n}</div>
        ))}

        <div style={{ padding: "8px 12px", background: C.medBg, border: `1px solid ${C.medBorder}`, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.medium }}>
          Experimental beta — may produce false positives. Always review manually before making redirects.
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          {runInfo && runInfo.hasQueries && <StatCard value={queryC.length} label="Competing in search" />}
          <StatCard value={seo.length} label="Same-target URLs" />
          <StatCard value={high} label="High risk" color={C.high} />
          <StatCard value={medium} label="Medium risk" color={C.medium} />
          <StatCard value={tech.length} label="Technical" color={C.tech} />
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "stretch" }}>
          {actionOrder.filter(t => actionCounts[t]).map(t => {
            const a = ACTION_COLORS[t];
            return (
              <span key={t} style={{ display: "inline-flex", flexDirection: "column", gap: 2, padding: "8px 14px", borderRadius: 8, background: a.bg, border: `1px solid ${a.border}`, minWidth: 96 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: a.color, lineHeight: 1, letterSpacing: "-0.02em" }}>{actionCounts[t]}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: a.color }}>{ACTION_LABELS[t]}</span>
              </span>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 8, marginBottom: 16 }}>
          <DistributionBar conflicts={active} />
          <SectionTree conflicts={active} />
        </div>

        {topActions.length > 0 && (
          <div style={{ ...s.card, padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.textTertiary, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Start here — top priority</div>
            {topActions.map((c, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: i < topActions.length - 1 ? `1px solid ${C.borderLight}` : "none" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.textTertiary, minWidth: 20 }}>{i + 1}.</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: C.text, flex: 1 }}>{c.label}</span>
                <span style={{ fontSize: 11, color: C.textTertiary }}>{c.sections.join(" + ")}</span>
                <span style={{ fontSize: 15, fontWeight: 600, color: C.text, opacity: 0.5, minWidth: 30, textAlign: "right" }}>{c.score}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          {[{ label: "All", val: "all" }, { label: "High confidence", val: "HIGH" }, { label: "Likely + High", val: "MEDIUM" }].map(f => (
            <button key={f.val} onClick={() => setConfFilter(f.val)} style={s.filterBtn(confFilter === f.val)}>{f.label}</button>
          ))}
        </div>

        {fQuery.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(C.accent)}>Competing for the same searches — from query data ({fQuery.length})</div>
            {fQuery.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {fHigh.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(C.high)}>High risk — fix first ({fHigh.length})</div>
            {fHigh.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {fMed.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(C.medium)}>Medium risk — review ({fMed.length})</div>
            {fMed.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {fLow.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(C.low)}>Low risk — monitor ({fLow.length})</div>
            {fLow.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {tech.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(C.tech)}>Technical duplicates ({tech.length})</div>
            {tech.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {brokenC.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(VERDICT_STYLE.broken.color)}>Fixed with a mistake ({brokenC.length})</div>
            {brokenC.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {fixedC.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={s.sectionTitle(VERDICT_STYLE.fixed.color)}>Already fixed on the live site — nothing to do ({fixedC.length})</div>
            {fixedC.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}

        {ignoredCounts && (
          <div style={{ ...s.card, marginBottom: 24, padding: "14px 18px" }}>
            <div style={{ fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Why NOT flagged</div>
            <div style={{ fontSize: 12, color: C.textSecondary, lineHeight: 1.8 }}>
              {totalPages > 0 && <div>Analyzed <span style={{ color: C.text, fontWeight: 600 }}>{totalPages}</span> pages total</div>}
              {ignoredCounts.brand > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.brand}</span> brand-specific pages skipped</div>}
              {ignoredCounts.symptom > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.symptom}</span> symptom pages skipped</div>}
              {ignoredCounts.modifier > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.modifier}</span> modifier pages skipped (cost, best, near-me)</div>}
              {ignoredCounts.content > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.content}</span> content pages skipped</div>}
              {ignoredCounts.informational > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.informational}</span> informational pages skipped (about, contact, blog…)</div>}
              {ignoredCounts.noServiceTerm > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.noServiceTerm}</span> non-service pages skipped</div>}
              {ignoredCounts.dead > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.dead}</span> redirected / removed URLs left out</div>}
              {runInfo && runInfo.queryStats && <>
                <div>• <span style={{ fontWeight: 600 }}>{runInfo.queryStats.brandQueries}</span> brand queries ignored</div>
                <div>• <span style={{ fontWeight: 600 }}>{runInfo.queryStats.localizedSkips}</span> shared generic queries ignored — pages for different cities, Google localizes them</div>
                <div>• <span style={{ fontWeight: 600 }}>{runInfo.queryStats.homepagePairs}</span> overlaps with the homepage ignored</div>
              </>}
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", padding: "24px 0 8px", fontSize: 11, color: C.textTertiary, lineHeight: 1.8 }}>
          <div>CanniScope · Experimental Beta · Free &amp; open source</div>
          <div>
            Built by{" "}
            <a href="https://odariuk.com" target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "none", fontWeight: 600 }}>Igor Odariuk</a>
            {" · "}
            Need help fixing cannibalization?{" "}
            <a href="https://odariuk.com" target="_blank" rel="noopener noreferrer" style={{ color: C.accent, textDecoration: "none", fontWeight: 600 }}>Get in touch</a>
            {" · "}
            <a href="/privacy.html" style={{ color: C.textTertiary }}>Privacy</a>
            {" · "}
            <a href={REPO} target="_blank" rel="noopener noreferrer" style={{ color: C.textTertiary }}>Source &amp; feedback on GitHub</a>
          </div>
        </div>
      </div>
    </div>
  );
}
