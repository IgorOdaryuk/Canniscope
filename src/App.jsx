import { useState } from "react";
import Papa from "papaparse";

import { analyzePages, getPathname, getSection } from "./lib/analyze.js";
import { analyzeQueries, pagesFromQueries } from "./lib/queries.js";
import { detectFile, buildDeadIndex, DEAD_ISSUE } from "./lib/files.js";
import { generateReportText, generateCSV } from "./lib/report.js";

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
        <div style={{ borderTop: `1px solid ${C.borderLight}` }}>
          <DecisionBlock conflict={c} />
          <WhyFlagged reasons={c.reasons} />
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.borderLight}` }}>
                <th style={{ padding: "6px 16px", textAlign: "left", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>URL</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Clicks</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Impr</th>
                <th style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pos</th>
                <th style={{ padding: "6px 16px", textAlign: "left", fontWeight: 600, color: C.textTertiary, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>Action</th>
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
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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

  const processFiles = async (files) => {
    setError(null); setCleanMsg(null); setLoading(true); setCopied(false);
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) { setError("No CSV files found."); setLoading(false); return; }

    const parsed = await Promise.all(csvFiles.map(file => new Promise(resolve => {
      Papa.parse(file, {
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
      setError("Couldn't find page data. Upload Pages.csv from the GSC Performance export, or a query + page CSV.");
      setLoading(false); return;
    }

    const { dead, isDead } = buildDeadIndex(statusFiles);
    const brands = brandInput.split(",").map(b => b.trim()).filter(Boolean);
    const pageRows = pagesFile ? pagesFile.rows : pagesFromQueries(queryFile.rows);
    const slug = analyzePages(pageRows, { isDead });
    const q = queryFile ? analyzeQueries(queryFile.rows, { isDead, brands }) : null;

    const totalImpr = pageRows.reduce((s, r) => s + (parseInt(String(r.Impressions).replace(/,/g, "")) || 0), 0);
    const results = [...(q ? q.conflicts : []), ...slug.conflicts];
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
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);
  const downloadReport = () => { const b = new Blob([reportText], { type: "text/plain;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-report.txt"; a.click(); URL.revokeObjectURL(u); };
  const downloadCSV = () => { const csv = generateCSV(conflicts); const b = new Blob([csv], { type: "text/csv;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-export.csv"; a.click(); URL.revokeObjectURL(u); };
  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const reset = () => { setConflicts(null); setReportText(""); setError(null); setCleanMsg(null); setIgnoredCounts(null); setTotalPages(0); setConfFilter("all"); setRunInfo(null); };

  if (!conflicts) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 480, width: "100%" }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4, letterSpacing: "-0.02em" }}>CanniScope</div>
            <div style={{ display: "inline-block", fontSize: 10, fontWeight: 600, color: C.textTertiary, background: C.borderLight, padding: "3px 10px", borderRadius: 10, letterSpacing: "0.04em", textTransform: "uppercase", marginBottom: 20 }}>Built for local SEO structures</div>
            <h1 style={{ fontSize: 24, fontWeight: 600, color: C.text, lineHeight: 1.15, letterSpacing: "-0.025em", marginBottom: 6 }}>Find duplicate URL targets<br/>on your site</h1>
            <p style={{ fontSize: 13, color: C.textSecondary, marginBottom: 24, lineHeight: 1.5 }}>Upload your Google Search Console export. Add query + page data to see which pages really compete for the same searches, and a redirect list so URLs you already fixed are left out.</p>
            <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={s.dropzone(dragOver)}>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: "#059669" + "14", color: "#059669", border: "1px solid #059669" + "30", fontFamily: mono, letterSpacing: "0.03em" }}>.CSV</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.text, marginBottom: 3 }}>{loading ? "Analyzing..." : "Drop your GSC export here"}</div>
              <div style={{ fontSize: 12, color: C.textTertiary }}>Pages.csv · query + page CSV · redirect / 404 list — drop them together or click to browse</div>
              <input id="csv-input" type="file" multiple accept=".csv" onChange={onFileSelect} style={{ display: "none" }} />
            </div>
            <button onClick={() => document.getElementById("folder-input").click()} style={{ ...s.btn(false), width: "100%", justifyContent: "center", marginTop: 8 }}>Select entire export folder</button>
            <input value={brandInput} onChange={(e) => setBrandInput(e.target.value)} placeholder="Brand names and misspellings, comma separated (optional)" style={{ width: "100%", boxSizing: "border-box", marginTop: 8, padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 13, fontFamily: sans, color: C.text, background: C.surface }} />
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />
            {error && <div style={{ marginTop: 16, padding: "10px 14px", background: C.highBg, border: `1px solid ${C.highBorder}`, borderRadius: 6, fontSize: 13, color: C.high }}>{error}</div>}
            {cleanMsg && <div style={{ marginTop: 16, padding: "10px 14px", background: C.lowBg, border: `1px solid ${C.lowBorder}`, borderRadius: 6, fontSize: 13, color: C.low }}>{cleanMsg}</div>}
            <div style={{ marginTop: 24, padding: "14px 18px", background: C.surface, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.textSecondary, lineHeight: 1.8, textAlign: "left" }}>
              <div style={{ fontWeight: 600, color: C.text, marginBottom: 4, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>Files the scan understands</div>
              <b style={{ color: C.text }}>Pages.csv</b> — GSC → Performance → 3 months → Export → unzip.<br/>
              <b style={{ color: C.text }}>Query + page CSV</b> (recommended) — columns query, page, clicks, impressions, position. GSC's own export can't pair them; use the Search Console API, Looker Studio or the Search Analytics for Sheets add-on.<br/>
              <b style={{ color: C.text }}>Redirect / 404 list</b> (recommended) — GSC → Indexing → Pages → “Page with redirect” and “Not found (404)” → Export, or a Screaming Frog export with Status Code. Without it, URLs you already redirected show up as conflicts.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const queryC = conflicts.filter(c => c.isQuery);
  const seo = conflicts.filter(c => !c.isTechnical && !c.isQuery);
  const tech = conflicts.filter(c => c.isTechnical);
  const high = [...queryC, ...seo].filter(c => c.risk === "HIGH").length;
  const medium = [...queryC, ...seo].filter(c => c.risk === "MEDIUM").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;

  const actionCounts = conflicts.reduce((acc, c) => {
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
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text, letterSpacing: "-0.02em" }}>CanniScope</div>
            <div style={{ fontSize: 9, fontWeight: 600, color: C.textTertiary, letterSpacing: "0.05em", textTransform: "uppercase" }}>Local SEO audit</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button onClick={downloadReport} style={s.btn(true)}>Export Report</button>
            <button onClick={downloadCSV} style={s.btn(true)}>Export CSV</button>
            <button onClick={copyReport} style={s.btn(false)}>{copied ? "✓ Copied" : "Copy"}</button>
            <button onClick={reset} style={s.btn(false)}>New Scan</button>
          </div>
        </div>

        <h2 style={s.h1}>{conflicts.length} possible clusters found</h2>
        <p style={{ fontSize: 13, color: C.textTertiary, margin: "0 0 16px" }}>
          {runInfo && runInfo.hasQueries && <>{queryC.length} competing in search · </>}{seo.length} same-target URLs · {tech.length} technical · {totalURLs} URLs involved
        </p>

        {runInfo && (runInfo.statusFiles > 0 ? (
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
          <DistributionBar conflicts={conflicts} />
          <SectionTree conflicts={conflicts} />
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
          </div>
        </div>
      </div>
    </div>
  );
}
