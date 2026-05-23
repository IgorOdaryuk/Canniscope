import { useState } from "react";
import Papa from "papaparse";

function extractTargetKeyword(url) {
  try {
    let path = new URL(url).pathname.replace(/\/$/, "").replace(/^\//, "");
    // Remove location prefixes like locations/tampa/ locations/charlotte/
    path = path.replace(/^locations\/[^/]+\/?/, "");
    path = path.replace(/^service-area\/?/, "");
    path = path.replace(/^services\/?/, "");
    path = path.replace(/^category\/?/, "");
    // Remove city/state suffixes for grouping
    const slug = path.split("/").pop() || "";
    // Normalize: remove city names, state codes, "in", "near", "best", "cost", "how-much"
    let normalized = slug
      .replace(/-in-[a-z-]+$/, "")
      .replace(/-near-[a-z-]+$/, "")
      .replace(/-[a-z]+-fl$/, "")
      .replace(/-[a-z]+-nc$/, "")
      .replace(/-[a-z]+-ga$/, "")
      .replace(/-tampa[a-z-]*$/, "")
      .replace(/-miami[a-z-]*$/, "")
      .replace(/-charlotte[a-z-]*$/, "")
      .replace(/-jacksonville[a-z-]*$/, "")
      .replace(/-atlanta[a-z-]*$/, "")
      .replace(/-wesley-chapel[a-z-]*$/, "")
      .replace(/-brandon[a-z-]*$/, "")
      .replace(/-concord[a-z-]*$/, "")
      .replace(/-ballantyne[a-z-]*$/, "")
      .replace(/-alpharetta[a-z-]*$/, "")
      .replace(/-bal-harbour[a-z-]*$/, "")
      .replace(/-delray-beach[a-z-]*$/, "")
      .replace(/-beach[a-z-]*$/, "")
      .replace(/^best-/, "")
      .replace(/^cheap-/, "")
      .replace(/-cost$/, "")
      .replace(/-2$/, "")
      .replace(/^how-much-does-/, "")
      .replace(/-cost$/, "")
      .replace(/-bay$/, "");
    return normalized || null;
  } catch {
    return null;
  }
}

function analyzePages(pagesData) {
  const pages = pagesData.map(row => ({
    url: row["Top pages"] || "",
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g, "")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%", "")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url && p.url !== "https://bozmanfix.com/" && !p.url.includes("#"));

  // Group by target keyword
  const groups = {};
  pages.forEach(p => {
    const kw = extractTargetKeyword(p.url);
    if (!kw || kw.length < 4) return;
    if (!groups[kw]) groups[kw] = [];
    groups[kw].push(p);
  });

  // Filter to only groups with 2+ pages (actual cannibalization)
  const conflicts = Object.entries(groups)
    .filter(([_, ps]) => ps.length >= 2)
    .map(([keyword, ps]) => {
      const sorted = [...ps].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
      const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
      const winner = sorted[0];
      const winnerClickShare = totalClicks > 0 ? ((winner.clicks / totalClicks) * 100) : 0;

      // Risk scoring
      let risk = "LOW";
      if (sorted.length >= 4) risk = "HIGH";
      else if (sorted.length >= 3 && totalImpressions > 1000) risk = "HIGH";
      else if (sorted.length >= 2 && winnerClickShare < 60 && totalClicks > 5) risk = "HIGH";
      else if (sorted.length >= 2 && totalImpressions > 2000) risk = "MEDIUM";

      // Generate recommendation
      let recommendation = "";
      if (risk === "HIGH") {
        if (sorted.length >= 4) {
          recommendation = `${sorted.length} pages target "${keyword.replace(/-/g, " ")}". Google doesn't know which to rank. Pick ONE primary page, redirect the rest with 301s. Keep location-specific pages only if they have unique content.`;
        } else {
          recommendation = `Multiple pages compete for "${keyword.replace(/-/g, " ")}". Consolidate into one strong page or clearly differentiate intent (e.g., informational vs. service page vs. location page).`;
        }
      } else if (risk === "MEDIUM") {
        recommendation = `Two pages target similar keywords. Differentiate H1/title tags and ensure each serves a distinct user intent. Add canonical if one is clearly secondary.`;
      } else {
        recommendation = `Minor overlap. Monitor — no action needed yet.`;
      }

      return {
        keyword: keyword.replace(/-/g, " "),
        pages: sorted,
        pageCount: sorted.length,
        totalClicks,
        totalImpressions,
        winnerClickShare: winnerClickShare.toFixed(0),
        risk,
        recommendation,
      };
    })
    .sort((a, b) => {
      const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (riskOrder[a.risk] !== riskOrder[b.risk]) return riskOrder[a.risk] - riskOrder[b.risk];
      return b.totalImpressions - a.totalImpressions;
    });

  return conflicts;
}

function generateReport(conflicts) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — Cannibalization Report\n";
  r += "=================================================\n\n";

  const high = conflicts.filter(c => c.risk === "HIGH").length;
  const medium = conflicts.filter(c => c.risk === "MEDIUM").length;
  const low = conflicts.filter(c => c.risk === "LOW").length;
  const totalConflictPages = conflicts.reduce((s, c) => s + c.pageCount, 0);

  r += `Summary:\n`;
  r += `  Cannibalization groups found: ${conflicts.length}\n`;
  r += `  Total pages involved: ${totalConflictPages}\n`;
  r += `  HIGH risk: ${high}\n`;
  r += `  MEDIUM risk: ${medium}\n`;
  r += `  LOW risk: ${low}\n\n`;

  r += "=================================================\n";
  r += "  HIGH RISK — Fix these first\n";
  r += "=================================================\n\n";

  conflicts.filter(c => c.risk === "HIGH").forEach((c, idx) => {
    r += `--- #${idx + 1}: "${c.keyword}" (${c.pageCount} pages fighting) ---\n\n`;
    r += `Problem: ${c.pageCount} pages on your site target "${c.keyword}".\n`;
    r += `Google sees them all and doesn't know which to rank.\n`;
    r += `Combined: ${c.totalClicks} clicks, ${c.totalImpressions.toLocaleString()} impressions\n\n`;
    r += `Pages:\n`;
    c.pages.forEach((p, pi) => {
      const label = pi === 0 ? " << STRONGEST" : "";
      r += `  ${pi + 1}. ${p.url}${label}\n`;
      r += `     Clicks: ${p.clicks} | Impressions: ${p.impressions.toLocaleString()} | CTR: ${p.ctr}% | Avg Position: ${p.position.toFixed(1)}\n`;
    });
    r += `\nWhat to do:\n`;
    r += `  ${c.recommendation}\n\n`;
  });

  if (medium > 0) {
    r += "=================================================\n";
    r += "  MEDIUM RISK — Monitor closely\n";
    r += "=================================================\n\n";

    conflicts.filter(c => c.risk === "MEDIUM").forEach((c, idx) => {
      r += `--- #${idx + 1}: "${c.keyword}" (${c.pageCount} pages) ---\n\n`;
      r += `Pages:\n`;
      c.pages.forEach((p, pi) => {
        const label = pi === 0 ? " << STRONGEST" : "";
        r += `  ${pi + 1}. ${p.url}${label}\n`;
        r += `     Clicks: ${p.clicks} | Impr: ${p.impressions.toLocaleString()} | CTR: ${p.ctr}% | Pos: ${p.position.toFixed(1)}\n`;
      });
      r += `\nAction: ${c.recommendation}\n\n`;
    });
  }

  if (low > 0) {
    r += "=================================================\n";
    r += "  LOW RISK — Keep an eye on\n";
    r += "=================================================\n\n";

    conflicts.filter(c => c.risk === "LOW").forEach((c, idx) => {
      r += `--- "${c.keyword}": ${c.pages.map(p => { try { return new URL(p.url).pathname; } catch { return p.url; } }).join(" vs ")} ---\n`;
    });
    r += "\n";
  }

  r += "=================================================\n";
  r += "  Generated by CanniScope\n";
  r += "=================================================\n";
  return r;
}

export default function CanniScope() {
  const [conflicts, setConflicts] = useState(null);
  const [reportText, setReportText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const processFiles = (files) => {
    setError(null);
    setLoading(true);
    setCopied(false);
    const fileArray = Array.from(files);
    const csvFiles = fileArray.filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) {
      setError("No CSV files found.");
      setLoading(false);
      return;
    }
    let pagesData = null;
    let done = 0;
    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          if (file.name.toLowerCase().includes("page")) pagesData = res.data;
          // Also detect by header
          if (!pagesData && res.data[0] && res.data[0]["Top pages"]) pagesData = res.data;
          done++;
          if (done === csvFiles.length) {
            if (!pagesData) {
              setError("Couldn't find Pages.csv. Make sure you upload files from GSC export.");
              setLoading(false);
              return;
            }
            const results = analyzePages(pagesData);
            if (results.length === 0) {
              setError("No cannibalization found — your pages look clean!");
              setLoading(false);
              return;
            }
            setConflicts(results);
            setReportText(generateReport(results));
            setLoading(false);
          }
        },
        error: () => { done++; if (done === csvFiles.length && !pagesData) { setError("Failed to parse CSV."); setLoading(false); } },
      });
    });
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);

  const downloadReport = () => {
    const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "canniscope-report.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyReport = () => {
    navigator.clipboard.writeText(reportText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!conflicts) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "'JetBrains Mono','SF Mono','Fira Code',monospace", background: "#0A0A0A", color: "#E5E5E5" }}>
        <div style={{ textAlign: "center", maxWidth: 520, width: "100%" }}>
          <div style={{ fontSize: 12, letterSpacing: 6, textTransform: "uppercase", color: "#FF3B30", marginBottom: 12, fontWeight: 600 }}>CanniScope</div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: "0 0 8px", lineHeight: 1.2, color: "#fff" }}>Find Pages Fighting<br/>Each Other on Google</h1>
          <p style={{ fontSize: 13, color: "#888", margin: "0 0 36px", lineHeight: 1.6 }}>Upload your Google Search Console export.<br/>Get a list of pages cannibalizing each other.</p>

          <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={{ border: `2px dashed ${dragOver ? "#FF3B30" : "#333"}`, borderRadius: 16, padding: "52px 24px", cursor: "pointer", transition: "all 0.2s", background: dragOver ? "#FF3B3008" : "transparent" }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>⚔️</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: "#fff" }}>{loading ? "Analyzing..." : "Select CSV files"}</div>
            <div style={{ fontSize: 12, color: "#666" }}>Pick all files from your GSC export</div>
            <input id="csv-input" type="file" multiple onChange={onFileSelect} style={{ display: "none" }} />
          </div>

          <button onClick={() => document.getElementById("folder-input").click()} style={{ marginTop: 12, width: "100%", padding: "16px", background: "#161616", border: "1px solid #2a2a2a", borderRadius: 12, color: "#bbb", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            📂 Or select the entire export folder
          </button>
          <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />

          {error && <div style={{ marginTop: 20, padding: "14px 18px", background: "#FF3B3012", border: "1px solid #FF3B3040", borderRadius: 10, fontSize: 13, color: "#FF6B6B", lineHeight: 1.4 }}>{error}</div>}

          <div style={{ marginTop: 32, padding: "16px 20px", background: "#131313", borderRadius: 12, textAlign: "left", fontSize: 12, color: "#777", lineHeight: 1.8, border: "1px solid #1a1a1a" }}>
            <div style={{ fontWeight: 600, color: "#aaa", marginBottom: 4 }}>How to get the files:</div>
            1. Google Search Console → Performance<br/>
            2. Set date range (last 3–6 months recommended)<br/>
            3. Export → Download CSV<br/>
            4. Unzip → upload the folder or files here
          </div>
        </div>
      </div>
    );
  }

  const high = conflicts.filter(c => c.risk === "HIGH").length;
  const medium = conflicts.filter(c => c.risk === "MEDIUM").length;
  const totalPages = conflicts.reduce((s, c) => s + c.pageCount, 0);

  return (
    <div style={{ minHeight: "100vh", fontFamily: "'JetBrains Mono','SF Mono','Fira Code',monospace", background: "#0A0A0A", color: "#E5E5E5", padding: 20 }}>
      <div style={{ marginBottom: 20 }}>
        <span style={{ fontSize: 10, letterSpacing: 4, textTransform: "uppercase", color: "#FF3B30", fontWeight: 600 }}>CanniScope</span>
        <h2 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 700, color: "#fff" }}>
          {high > 0 ? `🔥 ${high} keyword conflicts found` : "Analysis Complete"}
        </h2>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "#666" }}>{totalPages} pages involved in {conflicts.length} cannibalization groups</p>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <button onClick={downloadReport} style={{ flex: 1, padding: "14px 20px", background: "#FF3B30", border: "none", borderRadius: 10, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", minWidth: 160 }}>📥 Download Report</button>
        <button onClick={copyReport} style={{ padding: "14px 20px", background: "#1a1a1a", border: "1px solid #333", borderRadius: 10, color: "#ccc", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>{copied ? "✓ Copied" : "📋 Copy"}</button>
        <button onClick={() => { setConflicts(null); setReportText(""); setError(null); }} style={{ padding: "14px 20px", background: "#1a1a1a", border: "1px solid #333", borderRadius: 10, color: "#ccc", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>↻ New</button>
      </div>

      {/* Conflict cards */}
      {conflicts.filter(c => c.risk === "HIGH").length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#FF3B30", fontWeight: 600, marginBottom: 12 }}>🔴 High Risk — Fix These</div>
          {conflicts.filter(c => c.risk === "HIGH").map((c, i) => (
            <ConflictCard key={i} conflict={c} />
          ))}
        </div>
      )}

      {conflicts.filter(c => c.risk === "MEDIUM").length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#FF9900", fontWeight: 600, marginBottom: 12 }}>🟡 Medium Risk — Monitor</div>
          {conflicts.filter(c => c.risk === "MEDIUM").map((c, i) => (
            <ConflictCard key={i} conflict={c} />
          ))}
        </div>
      )}

      {conflicts.filter(c => c.risk === "LOW").length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#34C759", fontWeight: 600, marginBottom: 12 }}>🟢 Low Risk</div>
          {conflicts.filter(c => c.risk === "LOW").map((c, i) => (
            <ConflictCard key={i} conflict={c} />
          ))}
        </div>
      )}

      <div style={{ textAlign: "center", padding: "20px 0", fontSize: 10, color: "#333", letterSpacing: 2, textTransform: "uppercase" }}>CanniScope</div>
    </div>
  );
}

function ConflictCard({ conflict: c }) {
  const [open, setOpen] = useState(false);
  const riskColor = c.risk === "HIGH" ? "#FF3B30" : c.risk === "MEDIUM" ? "#FF9900" : "#34C759";

  return (
    <div style={{ background: "#111", border: `1px solid ${open ? riskColor + "40" : "#1a1a1a"}`, borderRadius: 12, marginBottom: 8, overflow: "hidden", transition: "border-color 0.2s" }}>
      <div onClick={() => setOpen(!open)} style={{ padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 3 }}>"{c.keyword}"</div>
          <div style={{ fontSize: 11, color: "#666" }}>{c.pageCount} pages fighting · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impressions</div>
        </div>
        <span style={{ color: "#444", fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>▸</span>
      </div>
      {open && (
        <div style={{ padding: "0 16px 16px", borderTop: "1px solid #1a1a1a" }}>
          <div style={{ margin: "12px 0", padding: "10px 14px", background: riskColor + "0A", borderLeft: `3px solid ${riskColor}`, borderRadius: "0 8px 8px 0", fontSize: 12, color: "#bbb", lineHeight: 1.5 }}>
            {c.recommendation}
          </div>
          {c.pages.map((p, pi) => (
            <div key={pi} style={{ padding: "10px 0", borderBottom: pi < c.pages.length - 1 ? "1px solid #1a1a1a" : "none" }}>
              <div style={{ fontSize: 12, color: pi === 0 ? "#34C759" : "#999", wordBreak: "break-all", marginBottom: 4 }}>
                {pi === 0 && "👑 "}{(() => { try { return new URL(p.url).pathname; } catch { return p.url; } })()}
              </div>
              <div style={{ fontSize: 11, color: "#555", display: "flex", gap: 16, flexWrap: "wrap" }}>
                <span>Clicks: <span style={{ color: "#aaa" }}>{p.clicks}</span></span>
                <span>Impr: <span style={{ color: "#aaa" }}>{p.impressions.toLocaleString()}</span></span>
                <span>CTR: <span style={{ color: "#aaa" }}>{p.ctr}%</span></span>
                <span>Pos: <span style={{ color: "#aaa" }}>{p.position.toFixed(1)}</span></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
