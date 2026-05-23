import { useState } from "react";
import Papa from "papaparse";

const STOP_WORDS = new Set(["in","the","a","an","and","or","of","for","to","is","my","me","near","how","much","does","do","what","why","best","cheap","top","vs","can","should","cost","it","with","at","on","by","from","your","not","are","this","that","i"]);
const BRAND_TERMS = ["bozmanfix","bozman","bozeman"];

function parseQueries(data) {
  return data.map(row => ({
    query: (row["Top queries"] || "").trim().toLowerCase(),
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g,"")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%","")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(q => q.query && q.impressions > 0);
}

function parsePages(data) {
  return data.map(row => ({
    url: (row["Top pages"] || "").trim(),
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g,"")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%","")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url);
}

function getSlugWords(url) {
  try {
    let path = new URL(url).pathname.replace(/\/$/, "").replace(/^\//, "");
    return path.split(/[\/\-]/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  } catch { return []; }
}

function getSection(url) {
  try {
    const path = new URL(url).pathname;
    if (path.startsWith("/service-area/")) return "SERVICE AREA";
    if (path.startsWith("/locations/")) return "LOCATIONS";
    if (path.startsWith("/services/")) return "SERVICES";
    if (path.startsWith("/category/")) return "CATEGORY";
    return "ROOT";
  } catch { return "ROOT"; }
}

function matchQueryToPages(query, pages) {
  const queryWords = query.query.split(/\s+/).filter(w =>
    w.length > 2 && !STOP_WORDS.has(w) && !BRAND_TERMS.some(b => w.includes(b))
  );
  if (queryWords.length === 0) return [];
  const matches = [];
  pages.forEach(page => {
    const slugWords = getSlugWords(page.url);
    if (slugWords.length === 0) return;
    const matched = queryWords.filter(qw =>
      slugWords.some(sw => sw.includes(qw) || qw.includes(sw))
    );
    const matchRatio = matched.length / queryWords.length;
    if (matched.length >= 1 && matchRatio >= 0.5) {
      matches.push({ ...page, matchedWords: matched, matchScore: matchRatio, section: getSection(page.url) });
    }
  });
  return matches;
}

function analyzeData(queriesData, pagesData) {
  const queries = parseQueries(queriesData);
  const pages = parsePages(pagesData);
  const nonBrandQueries = queries.filter(q => !BRAND_TERMS.some(b => q.query.includes(b)));
  const conflicts = [];

  nonBrandQueries.forEach(query => {
    const matches = matchQueryToPages(query, pages);
    if (matches.length >= 2) {
      matches.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const winner = matches[0];
      const sections = [...new Set(matches.map(m => m.section))];
      conflicts.push({ query: query.query, queryClicks: query.clicks, queryImpressions: query.impressions, queryPosition: query.position, pages: matches, pageCount: matches.length, sections, winner });
    }
  });

  conflicts.sort((a, b) => b.queryImpressions - a.queryImpressions);
  conflicts.forEach(c => {
    if (c.queryImpressions >= 1000 && c.pageCount >= 2) c.risk = "HIGH";
    else if (c.queryImpressions >= 500 || c.pageCount >= 3) c.risk = "HIGH";
    else if (c.queryImpressions >= 200) c.risk = "MEDIUM";
    else c.risk = "LOW";
  });

  const groupMap = new Map();
  conflicts.forEach(c => {
    const key = c.pages.map(p => p.url).sort().join("|");
    if (groupMap.has(key)) {
      groupMap.get(key).queries.push({ query: c.query, clicks: c.queryClicks, impressions: c.queryImpressions, position: c.queryPosition });
      if (c.risk === "HIGH") groupMap.get(key).risk = "HIGH";
      else if (c.risk === "MEDIUM" && groupMap.get(key).risk === "LOW") groupMap.get(key).risk = "MEDIUM";
    } else {
      groupMap.set(key, {
        queries: [{ query: c.query, clicks: c.queryClicks, impressions: c.queryImpressions, position: c.queryPosition }],
        pages: c.pages, pageCount: c.pageCount, sections: c.sections, winner: c.winner, risk: c.risk,
      });
    }
  });

  const groups = Array.from(groupMap.values());
  groups.sort((a, b) => {
    const ro = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    if (ro[a.risk] !== ro[b.risk]) return ro[a.risk] - ro[b.risk];
    return b.queries.reduce((s, q) => s + q.impressions, 0) - a.queries.reduce((s, q) => s + q.impressions, 0);
  });

  groups.forEach(g => {
    const winnerPath = (() => { try { return new URL(g.winner.url).pathname; } catch { return g.winner.url; } })();
    if (g.pageCount >= 3) {
      g.recommendation = `${g.pageCount} pages compete for the same queries. Winner by GSC data: ${winnerPath}. Consolidate — redirect weaker pages with 301, or clearly differentiate each page's intent and content.`;
    } else if (g.sections.length > 1) {
      g.recommendation = `Same content in different site sections (${g.sections.join(" + ")}). Winner by GSC data: ${winnerPath}. If content is the same, 301 redirect the weaker URL. If intent is genuinely different, differentiate titles and H1s.`;
    } else {
      g.recommendation = `2 pages compete for these queries. Winner: ${winnerPath}. Consider consolidating or adding canonical tag.`;
    }
  });

  return groups;
}

function generateReportText(groups) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — Cannibalization Report\n";
  r += "=================================================\n\n";
  const high = groups.filter(g => g.risk === "HIGH").length;
  const medium = groups.filter(g => g.risk === "MEDIUM").length;
  const low = groups.filter(g => g.risk === "LOW").length;
  const totalPages = new Set(groups.flatMap(g => g.pages.map(p => p.url))).size;
  r += `Summary:\n  Conflict groups: ${groups.length}\n  URLs involved: ${totalPages}\n  HIGH: ${high} | MEDIUM: ${medium} | LOW: ${low}\n\n`;

  const sections = [
    { label: "HIGH RISK — Fix First", filter: "HIGH" },
    { label: "MEDIUM RISK — Check", filter: "MEDIUM" },
    { label: "LOW RISK — Monitor", filter: "LOW" },
  ];
  sections.forEach(sec => {
    const items = groups.filter(g => g.risk === sec.filter);
    if (items.length === 0) return;
    r += `=== ${sec.label} ===\n\n`;
    items.forEach((g, idx) => {
      const topQ = g.queries[0];
      r += `#${idx + 1}: "${topQ.query}"${g.queries.length > 1 ? ` (+${g.queries.length - 1} more)` : ""}\n\n`;
      r += `Queries:\n`;
      g.queries.slice(0, 10).forEach(q => { r += `  "${q.query}" — ${q.clicks} clicks, ${q.impressions.toLocaleString()} impr, pos ${q.position.toFixed(1)}\n`; });
      if (g.queries.length > 10) r += `  +${g.queries.length - 10} more\n`;
      r += `\nCompeting pages (${g.sections.join(" + ")}):\n`;
      g.pages.forEach((p, pi) => {
        let path; try { path = new URL(p.url).pathname; } catch { path = p.url; }
        r += `  ${pi + 1}. ${path}${pi === 0 ? " << WINNER" : ""}\n`;
        r += `     Clicks: ${p.clicks} | Impr: ${p.impressions.toLocaleString()} | CTR: ${p.ctr}% | Pos: ${p.position.toFixed(1)} | ${p.section}\n`;
      });
      r += `\nAction: ${g.recommendation}\n\n---\n\n`;
    });
  });
  r += "Generated by CanniScope\n";
  return r;
}

// ─── STYLES ───
const font = "'DM Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const s = {
  page: { minHeight: "100vh", fontFamily: font, background: "#F7F7F5", color: "#1a1a1a", fontSize: 15, lineHeight: 1.5 },
  container: { maxWidth: 800, margin: "0 auto", padding: "40px 20px" },
  logo: { fontSize: 13, fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", color: "#E03E2D" },
  h1: { fontSize: 36, fontWeight: 800, margin: "16px 0 8px", lineHeight: 1.15, color: "#1a1a1a", letterSpacing: "-0.02em" },
  subtitle: { fontSize: 16, color: "#777", margin: "0 0 40px", lineHeight: 1.5 },
  dropzone: (active) => ({
    border: `2px dashed ${active ? "#E03E2D" : "#d0d0d0"}`,
    borderRadius: 12,
    padding: "56px 32px",
    cursor: "pointer",
    textAlign: "center",
    background: active ? "#FFF5F4" : "#fff",
    transition: "all 0.15s",
  }),
  dropIcon: { fontSize: 48, marginBottom: 16 },
  dropTitle: { fontSize: 17, fontWeight: 700, color: "#1a1a1a", marginBottom: 4 },
  dropSub: { fontSize: 13, color: "#999" },
  folderBtn: {
    marginTop: 12, width: "100%", padding: "14px", background: "#fff", border: "1px solid #e0e0e0",
    borderRadius: 10, color: "#555", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: font,
  },
  howTo: {
    marginTop: 32, padding: "20px 24px", background: "#fff", borderRadius: 12, border: "1px solid #eee",
    fontSize: 14, color: "#888", lineHeight: 1.8,
  },
  howToTitle: { fontWeight: 700, color: "#555", marginBottom: 6, fontSize: 13, textTransform: "uppercase", letterSpacing: 1 },
  error: { marginTop: 20, padding: "14px 18px", background: "#FFF0EE", border: "1px solid #FFCFC9", borderRadius: 10, fontSize: 14, color: "#C0392B" },
  // Results
  statRow: { display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" },
  stat: (color) => ({
    flex: "1 1 100px", padding: "16px 20px", background: "#fff", borderRadius: 10, border: "1px solid #eee",
    textAlign: "center", minWidth: 100,
  }),
  statNum: (color) => ({ fontSize: 28, fontWeight: 800, color, letterSpacing: "-0.02em" }),
  statLabel: { fontSize: 11, color: "#999", marginTop: 2, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 },
  actionRow: { display: "flex", gap: 10, marginBottom: 32, flexWrap: "wrap" },
  primaryBtn: {
    flex: 1, padding: "14px 24px", background: "#E03E2D", border: "none", borderRadius: 10,
    color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font, minWidth: 160,
  },
  secBtn: {
    padding: "14px 20px", background: "#fff", border: "1px solid #ddd", borderRadius: 10,
    color: "#555", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: font,
  },
  sectionTitle: (color) => ({
    fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color, marginBottom: 12, paddingBottom: 8,
    borderBottom: `2px solid ${color}20`,
  }),
  card: (open, color) => ({
    background: "#fff", border: `1px solid ${open ? color + "40" : "#eee"}`,
    borderRadius: 10, marginBottom: 8, overflow: "hidden", transition: "border-color 0.15s",
    boxShadow: open ? `0 2px 12px ${color}10` : "none",
  }),
  cardHeader: { padding: "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 },
  badge: (color) => ({
    padding: "3px 10px", borderRadius: 20, background: color + "14", color,
    fontSize: 11, fontWeight: 700, letterSpacing: 0.5, flexShrink: 0,
  }),
  cardTitle: { fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 2 },
  cardMeta: { fontSize: 13, color: "#999" },
  arrow: (open) => ({ color: "#ccc", fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }),
  rec: (color) => ({
    margin: "14px 20px", padding: "14px 18px", background: color + "08", borderLeft: `3px solid ${color}`,
    borderRadius: "0 8px 8px 0", fontSize: 14, color: "#555", lineHeight: 1.6,
  }),
  pageRow: (isWinner) => ({
    padding: "12px 20px", borderBottom: "1px solid #f5f5f5",
    background: isWinner ? "#F0FAF0" : "transparent",
  }),
  pageUrl: (isWinner) => ({
    fontSize: 14, fontWeight: isWinner ? 700 : 400, color: isWinner ? "#27AE60" : "#555",
    wordBreak: "break-all", marginBottom: 4,
  }),
  pageStats: { fontSize: 13, color: "#999", display: "flex", gap: 16, flexWrap: "wrap" },
  pageStatVal: { color: "#555", fontWeight: 600 },
};

function ConflictCard({ group: g }) {
  const [open, setOpen] = useState(false);
  const riskColor = g.risk === "HIGH" ? "#E03E2D" : g.risk === "MEDIUM" ? "#E67E22" : "#27AE60";
  const topQ = g.queries[0];
  const totalImpr = g.queries.reduce((sum, q) => sum + q.impressions, 0);
  const totalClicks = g.queries.reduce((sum, q) => sum + q.clicks, 0);

  return (
    <div style={s.card(open, riskColor)}>
      <div onClick={() => setOpen(!open)} style={s.cardHeader}>
        <span style={s.badge(riskColor)}>{g.risk}</span>
        <div style={{ flex: 1 }}>
          <div style={s.cardTitle}>
            "{topQ.query}"{g.queries.length > 1 ? ` (+${g.queries.length - 1})` : ""}
          </div>
          <div style={s.cardMeta}>
            {g.sections.join(" + ")} · {g.pageCount} URLs · {totalClicks} clicks · {totalImpr.toLocaleString()} impr
          </div>
        </div>
        <span style={s.arrow(open)}>▸</span>
      </div>
      {open && (
        <div>
          <div style={s.rec(riskColor)}>{g.recommendation}</div>

          {g.queries.length > 1 && (
            <div style={{ padding: "0 20px 12px" }}>
              <div style={{ fontSize: 11, color: "#bbb", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontWeight: 700 }}>Related Queries</div>
              {g.queries.slice(0, 8).map((q, qi) => (
                <div key={qi} style={{ fontSize: 13, color: "#777", padding: "3px 0" }}>
                  "{q.query}" — <span style={{ color: "#555", fontWeight: 600 }}>{q.clicks}</span> clicks, <span style={{ color: "#555", fontWeight: 600 }}>{q.impressions.toLocaleString()}</span> impr
                </div>
              ))}
              {g.queries.length > 8 && <div style={{ fontSize: 13, color: "#bbb" }}>+{g.queries.length - 8} more</div>}
            </div>
          )}

          <div style={{ padding: "0 20px" }}>
            <div style={{ fontSize: 11, color: "#bbb", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontWeight: 700 }}>Competing Pages</div>
          </div>
          {g.pages.map((p, pi) => (
            <div key={pi} style={s.pageRow(pi === 0)}>
              <div style={s.pageUrl(pi === 0)}>
                {pi === 0 && "👑 "}{(() => { try { return new URL(p.url).pathname; } catch { return p.url; } })()}
              </div>
              <div style={s.pageStats}>
                <span>Clicks: <span style={s.pageStatVal}>{p.clicks}</span></span>
                <span>Impr: <span style={s.pageStatVal}>{p.impressions.toLocaleString()}</span></span>
                <span>CTR: <span style={s.pageStatVal}>{p.ctr}%</span></span>
                <span>Pos: <span style={s.pageStatVal}>{p.position.toFixed(1)}</span></span>
                <span style={{ fontSize: 12, color: "#bbb" }}>{p.section}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CanniScope() {
  const [groups, setGroups] = useState(null);
  const [reportText, setReportText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const processFiles = (files) => {
    setError(null); setLoading(true); setCopied(false);
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) { setError("No CSV files found."); setLoading(false); return; }
    const parsed = {};
    let done = 0;
    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          const name = file.name.toLowerCase();
          if (name.includes("quer") || (res.data[0] && res.data[0]["Top queries"])) parsed.queries = res.data;
          if (name.includes("page") || (res.data[0] && res.data[0]["Top pages"])) parsed.pages = res.data;
          done++;
          if (done === csvFiles.length) {
            if (!parsed.queries || !parsed.pages) { setError("Need both Queries.csv and Pages.csv from your GSC export."); setLoading(false); return; }
            const results = analyzeData(parsed.queries, parsed.pages);
            if (results.length === 0) { setError("No cannibalization found — your site looks clean!"); setLoading(false); return; }
            setGroups(results); setReportText(generateReportText(results)); setLoading(false);
          }
        },
        error: () => { done++; if (done === csvFiles.length) { setError("Failed to parse."); setLoading(false); } },
      });
    });
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);
  const downloadReport = () => {
    const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = "canniscope-report.txt"; a.click(); URL.revokeObjectURL(url);
  };
  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };

  if (!groups) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 540, width: "100%" }}>
            <div style={s.logo}>CanniScope</div>
            <h1 style={s.h1}>Find pages fighting<br/>each other on Google</h1>
            <p style={s.subtitle}>Upload your Search Console CSV export. See which pages cannibalize each other — backed by real query data.</p>

            <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={s.dropzone(dragOver)}>
              <div style={s.dropIcon}>⚔️</div>
              <div style={s.dropTitle}>{loading ? "Analyzing..." : "Select CSV files"}</div>
              <div style={s.dropSub}>Pick Queries.csv + Pages.csv (or all files from export)</div>
              <input id="csv-input" type="file" multiple onChange={onFileSelect} style={{ display: "none" }} />
            </div>

            <button onClick={() => document.getElementById("folder-input").click()} style={s.folderBtn}>
              📂 Or select the entire export folder
            </button>
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />

            {error && <div style={s.error}>{error}</div>}

            <div style={s.howTo}>
              <div style={s.howToTitle}>How to get the files</div>
              1. Go to Google Search Console → Performance<br/>
              2. Set your date range (3–6 months works best)<br/>
              3. Click Export → Download CSV<br/>
              4. Unzip → upload the folder or pick files above
            </div>
          </div>
        </div>
      </div>
    );
  }

  const high = groups.filter(g => g.risk === "HIGH").length;
  const medium = groups.filter(g => g.risk === "MEDIUM").length;
  const low = groups.filter(g => g.risk === "LOW").length;
  const totalURLs = new Set(groups.flatMap(g => g.pages.map(p => p.url))).size;

  return (
    <div style={s.page}>
      <div style={s.container}>
        <div style={{ marginBottom: 28 }}>
          <div style={s.logo}>CanniScope</div>
          <h2 style={{ ...s.h1, fontSize: 28, margin: "8px 0 0" }}>
            {high > 0 ? `${high} high-risk conflicts found` : "Analysis Complete"}
          </h2>
          <p style={{ fontSize: 14, color: "#999", margin: "4px 0 0" }}>{groups.length} groups · {totalURLs} URLs involved</p>
        </div>

        <div style={s.statRow}>
          {[
            { label: "Groups", val: groups.length, color: "#1a1a1a" },
            { label: "URLs", val: totalURLs, color: "#1a1a1a" },
            { label: "High", val: high, color: "#E03E2D" },
            { label: "Medium", val: medium, color: "#E67E22" },
          ].map((item, i) => (
            <div key={i} style={s.stat(item.color)}>
              <div style={s.statNum(item.color)}>{item.val}</div>
              <div style={s.statLabel}>{item.label}</div>
            </div>
          ))}
        </div>

        <div style={s.actionRow}>
          <button onClick={downloadReport} style={s.primaryBtn}>📥 Download Report</button>
          <button onClick={copyReport} style={s.secBtn}>{copied ? "✓ Copied!" : "📋 Copy"}</button>
          <button onClick={() => { setGroups(null); setReportText(""); setError(null); }} style={s.secBtn}>↻ New</button>
        </div>

        {high > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E03E2D")}>🔴 High Risk — Fix First</div>
            {groups.filter(g => g.risk === "HIGH").map((g, i) => <ConflictCard key={i} group={g} />)}
          </div>
        )}
        {medium > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E67E22")}>🟡 Medium Risk — Check</div>
            {groups.filter(g => g.risk === "MEDIUM").map((g, i) => <ConflictCard key={i} group={g} />)}
          </div>
        )}
        {low > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#27AE60")}>🟢 Low Risk — Monitor</div>
            {groups.filter(g => g.risk === "LOW").map((g, i) => <ConflictCard key={i} group={g} />)}
          </div>
        )}

        <div style={{ textAlign: "center", padding: "32px 0 16px", fontSize: 12, color: "#ccc", letterSpacing: 1.5, textTransform: "uppercase" }}>
          CanniScope
        </div>
      </div>
    </div>
  );
}
