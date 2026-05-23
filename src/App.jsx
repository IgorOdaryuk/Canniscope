import { useState } from "react";
import Papa from "papaparse";

// Known cities/geos to normalize
const CITIES = {
  "tampa":"tampa","tampa-fl":"tampa","tampa-bay":"tampa",
  "wesley-chapel":"wesley-chapel","wesley-chapel-fl":"wesley-chapel",
  "brandon":"brandon","brandon-fl":"brandon","sarasota":"sarasota","sarasota-fl":"sarasota",
  "miami":"miami","miami-fl":"miami","doral":"doral","doral-fl":"doral",
  "coral-gables":"coral-gables","coral-gables-fl":"coral-gables",
  "bal-harbour":"bal-harbour","bal-harbour-fl":"bal-harbour",
  "delray-beach":"delray-beach","delray-beach-fl":"delray-beach",
  "charlotte":"charlotte","charlotte-nc":"charlotte",
  "concord":"concord","concord-nc":"concord",
  "fort-mill":"fort-mill","fort-mill-sc":"fort-mill",
  "belmont":"belmont","belmont-charlotte-nc":"belmont",
  "ballantyne":"ballantyne","ballantyne-nc":"ballantyne",
  "jacksonville":"jacksonville","jacksonville-fl":"jacksonville",
  "jacksonville-beach":"jacksonville-beach","jacksonville-beach-fl":"jacksonville-beach",
  "atlanta":"atlanta","atlanta-ga":"atlanta",
  "roswell":"roswell","roswell-ga":"roswell",
  "alpharetta":"alpharetta","alpharetta-ga":"alpharetta",
  "chastain-park-atlanta-ga":"chastain-park",
  "winder":"winder","winder-ga":"winder",
  "philadelphia":"philadelphia",
};

// Known services to normalize
const SERVICES = [
  "refrigerator-repair","fridge-repair",
  "washer-repair","washing-machine-repair",
  "dryer-repair",
  "oven-repair",
  "cooktop-repair",
  "microwave-repair",
  "dishwasher-repair",
  "icemaker-repair","ice-maker-repair",
  "freezer-repair",
  "appliance-repair",
  "range-repair",
  "stove-repair",
];

const SERVICE_NORMALIZE = {
  "fridge-repair":"refrigerator-repair",
  "washing-machine-repair":"washer-repair",
  "ice-maker-repair":"icemaker-repair",
};

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

function parseServiceAndGeo(url) {
  try {
    let path = new URL(url).pathname.replace(/\/$/, "").replace(/^\//, "");
    // Remove known prefixes
    path = path.replace(/^(service-area|locations|services|category)\//, "");
    // Remove city folder prefixes like "tampa/" "charlotte/" "atlanta/" "miami/"
    path = path.replace(/^(tampa|charlotte|atlanta|miami|jacksonville)\//, "");

    const slug = path;

    // Find service
    let service = null;
    for (const svc of SERVICES) {
      if (slug.includes(svc)) {
        service = SERVICE_NORMALIZE[svc] || svc;
        break;
      }
    }
    if (!service) return null;

    // Find geo: check remaining slug parts against known cities
    let geo = null;
    const remaining = slug.replace(service, "").replace(/^-+|-+$/g, "").replace(/-?in-?/, "");
    // Try to match the full remaining or parts of it
    if (CITIES[remaining]) {
      geo = CITIES[remaining];
    } else {
      // Try matching substrings
      for (const [pattern, normalized] of Object.entries(CITIES)) {
        if (remaining.includes(pattern) && pattern.length > 3) {
          geo = normalized;
          break;
        }
      }
    }

    return { service, geo: geo || "generic" };
  } catch {
    return null;
  }
}

function analyzePages(pagesData) {
  const pages = pagesData.map(row => ({
    url: (row["Top pages"] || "").trim(),
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g, "")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%", "")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url);

  // Parse each page's service + geo
  const parsed = pages.map(p => {
    const sg = parseServiceAndGeo(p.url);
    if (!sg) return null;
    return { ...p, ...sg, section: getSection(p.url) };
  }).filter(Boolean);

  // Group by service + geo
  const groups = {};
  parsed.forEach(p => {
    const key = `${p.service}|${p.geo}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  // Only keep groups with 2+ pages (actual cannibalization)
  const conflicts = Object.entries(groups)
    .filter(([_, ps]) => ps.length >= 2)
    .map(([key, ps]) => {
      const [service, geo] = key.split("|");
      const sorted = [...ps].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const winner = sorted[0];
      const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
      const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
      const sections = [...new Set(sorted.map(p => p.section))];

      // Human-readable label
      const serviceName = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const geoName = geo === "generic" ? "Generic" : geo.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const label = `${serviceName} — ${geoName}`;

      // Risk based on impressions + page count
      let risk = "LOW";
      if (totalImpressions >= 1000 || sorted.length >= 3) risk = "HIGH";
      else if (totalImpressions >= 200) risk = "MEDIUM";

      // Recommendation
      let recommendation = "";
      const winnerPath = (() => { try { return new URL(winner.url).pathname; } catch { return winner.url; } })();
      if (geo === "generic") {
        recommendation = `Generic page duplicate. Winner by GSC data: ${winnerPath}. If weaker URLs are not already 301/canonical, consolidate.`;
      } else {
        recommendation = `Same service + same geo + same intent. Winner by GSC data: ${winnerPath}. If weaker URLs are not already 301, redirect them. If 301 already exists, wait for Google.`;
      }

      return {
        label, service, geo, pages: sorted, pageCount: sorted.length,
        totalClicks, totalImpressions, sections, winner, risk, recommendation,
      };
    })
    .sort((a, b) => {
      const ro = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (ro[a.risk] !== ro[b.risk]) return ro[a.risk] - ro[b.risk];
      return b.totalImpressions - a.totalImpressions;
    });

  return conflicts;
}

function generateReportText(conflicts) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — Cannibalization Report\n";
  r += "=================================================\n\n";
  const high = conflicts.filter(c => c.risk === "HIGH").length;
  const medium = conflicts.filter(c => c.risk === "MEDIUM").length;
  const low = conflicts.filter(c => c.risk === "LOW").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;
  r += `Summary:\n  Conflict groups: ${conflicts.length}\n  URLs involved: ${totalURLs}\n  HIGH: ${high} | MEDIUM: ${medium} | LOW: ${low}\n\n`;

  [
    { label: "HIGH RISK — Fix First", filter: "HIGH" },
    { label: "MEDIUM RISK — Check", filter: "MEDIUM" },
    { label: "LOW RISK — Monitor", filter: "LOW" },
  ].forEach(sec => {
    const items = conflicts.filter(c => c.risk === sec.filter);
    if (items.length === 0) return;
    r += `=== ${sec.label} ===\n\n`;
    items.forEach((c, idx) => {
      r += `#${idx + 1}: ${c.label}\n`;
      r += `${c.sections.join(" + ")} · ${c.pageCount} URLs · ${c.totalClicks} clicks · ${c.totalImpressions.toLocaleString()} impressions\n\n`;
      r += `Winner: ${c.winner.url}\n\n`;
      r += `${c.recommendation}\n\n`;
      r += `Pages:\n`;
      c.pages.forEach((p, pi) => {
        let path; try { path = new URL(p.url).pathname; } catch { path = p.url; }
        r += `  ${pi === 0 ? "👑" : "  "} ${path}\n`;
        r += `     Clicks: ${p.clicks} | Impr: ${p.impressions.toLocaleString()} | CTR: ${p.ctr}% | Pos: ${p.position.toFixed(1)} | ${p.section}\n`;
      });
      r += `\n---\n\n`;
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
    border: `2px dashed ${active ? "#E03E2D" : "#d0d0d0"}`, borderRadius: 12, padding: "56px 32px",
    cursor: "pointer", textAlign: "center", background: active ? "#FFF5F4" : "#fff", transition: "all 0.15s",
  }),
  folderBtn: {
    marginTop: 12, width: "100%", padding: "14px", background: "#fff", border: "1px solid #e0e0e0",
    borderRadius: 10, color: "#555", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: font,
  },
  howTo: {
    marginTop: 32, padding: "20px 24px", background: "#fff", borderRadius: 12, border: "1px solid #eee",
    fontSize: 14, color: "#888", lineHeight: 1.8,
  },
  error: { marginTop: 20, padding: "14px 18px", background: "#FFF0EE", border: "1px solid #FFCFC9", borderRadius: 10, fontSize: 14, color: "#C0392B" },
  statRow: { display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" },
  stat: { flex: "1 1 100px", padding: "16px 20px", background: "#fff", borderRadius: 10, border: "1px solid #eee", textAlign: "center", minWidth: 100 },
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
    fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5, color, marginBottom: 12,
    paddingBottom: 8, borderBottom: `2px solid ${color}20`,
  }),
  card: (open, color) => ({
    background: "#fff", border: `1px solid ${open ? color + "40" : "#eee"}`,
    borderRadius: 10, marginBottom: 8, overflow: "hidden", boxShadow: open ? `0 2px 12px ${color}10` : "none",
  }),
};

function ConflictCard({ conflict: c }) {
  const [open, setOpen] = useState(false);
  const rc = c.risk === "HIGH" ? "#E03E2D" : c.risk === "MEDIUM" ? "#E67E22" : "#27AE60";

  return (
    <div style={s.card(open, rc)}>
      <div onClick={() => setOpen(!open)} style={{ padding: "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ padding: "3px 10px", borderRadius: 20, background: rc + "14", color: rc, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{c.risk}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 2 }}>{c.label}</div>
          <div style={{ fontSize: 13, color: "#999" }}>
            {c.sections.join(" + ")} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impressions
          </div>
        </div>
        <span style={{ color: "#ccc", fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>▸</span>
      </div>
      {open && (
        <div>
          <div style={{ margin: "0 20px 14px", fontSize: 13, color: "#777" }}>
            Winner: <span style={{ color: "#1a1a1a", fontWeight: 600 }}>{c.winner.url}</span>
          </div>
          <div style={{ margin: "0 20px 14px", padding: "14px 18px", background: rc + "08", borderLeft: `3px solid ${rc}`, borderRadius: "0 8px 8px 0", fontSize: 14, color: "#555", lineHeight: 1.6 }}>
            {c.recommendation}
          </div>
          {c.pages.map((p, pi) => (
            <div key={pi} style={{ padding: "12px 20px", borderTop: "1px solid #f3f3f3", background: pi === 0 ? "#F0FAF0" : "transparent" }}>
              <div style={{ fontSize: 14, fontWeight: pi === 0 ? 700 : 400, color: pi === 0 ? "#27AE60" : "#555", wordBreak: "break-all", marginBottom: 4 }}>
                {pi === 0 && "👑 "}{(() => { try { return new URL(p.url).pathname; } catch { return p.url; } })()}
              </div>
              <div style={{ fontSize: 13, color: "#999", display: "flex", gap: 16, flexWrap: "wrap" }}>
                <span>Clicks: <span style={{ color: "#555", fontWeight: 600 }}>{p.clicks}</span></span>
                <span>Impr: <span style={{ color: "#555", fontWeight: 600 }}>{p.impressions.toLocaleString()}</span></span>
                <span>CTR: <span style={{ color: "#555", fontWeight: 600 }}>{p.ctr}%</span></span>
                <span>Pos: <span style={{ color: "#555", fontWeight: 600 }}>{p.position.toFixed(1)}</span></span>
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
  const [conflicts, setConflicts] = useState(null);
  const [reportText, setReportText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const processFiles = (files) => {
    setError(null); setLoading(true); setCopied(false);
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) { setError("No CSV files found."); setLoading(false); return; }
    let pagesData = null;
    let done = 0;
    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          if (file.name.toLowerCase().includes("page") || (res.data[0] && res.data[0]["Top pages"])) pagesData = res.data;
          done++;
          if (done === csvFiles.length) {
            if (!pagesData) { setError("Couldn't find Pages.csv. Upload files from your GSC export."); setLoading(false); return; }
            const results = analyzePages(pagesData);
            if (results.length === 0) { setError("No cannibalization found — your pages look clean!"); setLoading(false); return; }
            setConflicts(results); setReportText(generateReportText(results)); setLoading(false);
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

  if (!conflicts) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 540, width: "100%" }}>
            <div style={s.logo}>CanniScope</div>
            <h1 style={s.h1}>Find pages fighting<br/>each other on Google</h1>
            <p style={s.subtitle}>Upload your Search Console CSV export. See which pages cannibalize each other.</p>
            <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={s.dropzone(dragOver)}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>⚔️</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a", marginBottom: 4 }}>{loading ? "Analyzing..." : "Select CSV files"}</div>
              <div style={{ fontSize: 13, color: "#999" }}>Upload all files from your GSC export</div>
              <input id="csv-input" type="file" multiple onChange={onFileSelect} style={{ display: "none" }} />
            </div>
            <button onClick={() => document.getElementById("folder-input").click()} style={s.folderBtn}>📂 Or select the entire export folder</button>
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />
            {error && <div style={s.error}>{error}</div>}
            <div style={s.howTo}>
              <div style={{ fontWeight: 700, color: "#555", marginBottom: 6, fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>How to get the files</div>
              1. Google Search Console → Performance<br/>
              2. Set date range (3–6 months works best)<br/>
              3. Click Export → Download CSV<br/>
              4. Unzip → upload the folder or pick files above
            </div>
          </div>
        </div>
      </div>
    );
  }

  const high = conflicts.filter(c => c.risk === "HIGH").length;
  const medium = conflicts.filter(c => c.risk === "MEDIUM").length;
  const low = conflicts.filter(c => c.risk === "LOW").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;

  return (
    <div style={s.page}>
      <div style={s.container}>
        <div style={{ marginBottom: 28 }}>
          <div style={s.logo}>CanniScope</div>
          <h2 style={{ ...s.h1, fontSize: 28, margin: "8px 0 0" }}>
            {high > 0 ? `${high} high-risk conflicts found` : "Analysis Complete"}
          </h2>
          <p style={{ fontSize: 14, color: "#999", margin: "4px 0 0" }}>{conflicts.length} groups · {totalURLs} URLs involved</p>
        </div>

        <div style={s.statRow}>
          {[
            { label: "Groups", val: conflicts.length, color: "#1a1a1a" },
            { label: "URLs", val: totalURLs, color: "#1a1a1a" },
            { label: "High", val: high, color: "#E03E2D" },
            { label: "Medium", val: medium, color: "#E67E22" },
          ].map((item, i) => (
            <div key={i} style={s.stat}>
              <div style={{ fontSize: 28, fontWeight: 800, color: item.color, letterSpacing: "-0.02em" }}>{item.val}</div>
              <div style={{ fontSize: 11, color: "#999", marginTop: 2, textTransform: "uppercase", letterSpacing: 1, fontWeight: 600 }}>{item.label}</div>
            </div>
          ))}
        </div>

        <div style={s.actionRow}>
          <button onClick={downloadReport} style={s.primaryBtn}>📥 Download Report</button>
          <button onClick={copyReport} style={s.secBtn}>{copied ? "✓ Copied!" : "📋 Copy"}</button>
          <button onClick={() => { setConflicts(null); setReportText(""); setError(null); }} style={s.secBtn}>↻ New</button>
        </div>

        {high > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E03E2D")}>🔴 High Risk — Fix First</div>
            {conflicts.filter(c => c.risk === "HIGH").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {medium > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E67E22")}>🟡 Medium Risk — Check</div>
            {conflicts.filter(c => c.risk === "MEDIUM").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {low > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#27AE60")}>🟢 Low Risk — Monitor</div>
            {conflicts.filter(c => c.risk === "LOW").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}

        <div style={{ textAlign: "center", padding: "32px 0 16px", fontSize: 12, color: "#ccc", letterSpacing: 1.5, textTransform: "uppercase" }}>CanniScope</div>
      </div>
    </div>
  );
}
