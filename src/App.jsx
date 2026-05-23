import { useState } from "react";
import Papa from "papaparse";

const SERVICES = [
  "appliance-repair",
  "refrigerator-repair",
  "fridge-repair",
  "washer-repair",
  "dryer-repair",
  "dishwasher-repair",
  "cooktop-repair",
  "oven-repair",
  "icemaker-repair",
  "ice-maker-repair",
  "freezer-repair",
  "microwave-repair",
  "sub-zero-repair",
  "sub-zero-refrigerator-repair",
  "lg-appliance-repair",
  "samsung-appliance-repair",
  "whirlpool-appliance-repair",
  "ge-appliance-repair",
];

const LOCATIONS = [
  "atlanta",
  "charlotte",
  "jacksonville",
  "miami",
  "tampa",
  "tampa-bay",
  "philadelphia",
  "jacksonville-beach",
  "wesley-chapel",
  "brandon",
  "sarasota",
  "roswell",
  "alpharetta",
  "milton",
  "johns-creek",
  "east-cobb",
  "chastain-park",
  "concord",
  "belmont",
  "ballantyne",
  "huntersville",
  "rock-hill",
  "fort-mill",
  "waxhaw",
  "doral",
  "coral-gables",
  "delray-beach",
  "miami-beach",
  "boca-raton",
  "orange-park",
  "ponte-vedra",
  "fernandina-beach",
];

const INTENT_PATTERNS = [
  { intent: "cost", words: ["cost", "price", "how-much"] },
  { intent: "best", words: ["best"] },
  { intent: "cheap", words: ["cheap"] },
  { intent: "free", words: ["free"] },
  { intent: "near-me", words: ["near-me"] },
  { intent: "same-day", words: ["same-day"] },
  { intent: "symptom", words: ["not-cooling", "not-heating", "not-draining", "wont-drain", "wont-light", "not-spinning", "not-making-ice", "temperature-off", "temperature-issues", "takes-too-long", "not-drying-fast"] },
  { intent: "brand", words: ["sub-zero", "samsung", "lg", "whirlpool", "ge-appliance"] },
];

function normalizeNumber(value) {
  return Number(String(value || "0").replace(/,/g, "").replace("%", "")) || 0;
}

function getPath(url) {
  try {
    return new URL(url).pathname.replace(/^\/|\/$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function humanize(slug) {
  return String(slug || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function getSection(path) {
  if (path.startsWith("blog/")) return "BLOG";
  if (path.startsWith("service-area/")) return "SERVICE AREA";
  if (path.startsWith("locations/")) return "LOCATIONS";
  if (path.startsWith("category/")) return "CATEGORY";
  if (path.startsWith("services/")) return "LEGACY SERVICES";
  return "ROOT";
}

function getIntent(path) {
  for (const item of INTENT_PATTERNS) {
    if (item.words.some((w) => path.includes(w))) return item.intent;
  }
  return "service";
}

function getService(path) {
  const normalized = path
    .replace(/\/$/, "")
    .replace(/-in-/g, "-")
    .replace(/-nc/g, "")
    .replace(/-ga/g, "")
    .replace(/-fl/g, "");

  const found = SERVICES
    .filter((service) => normalized.includes(service))
    .sort((a, b) => b.length - a.length)[0];

  if (!found) return null;

  if (found === "fridge-repair") return "refrigerator-repair";
  if (found === "ice-maker-repair") return "icemaker-repair";

  return found;
}

function getLocation(path) {
  const found = LOCATIONS
    .filter((loc) => path.includes(loc))
    .sort((a, b) => b.length - a.length)[0];

  if (!found) return "generic";

  if (found === "tampa-bay") return "tampa";
  return found;
}

function isLikelyDuplicate(a, b) {
  if (a.service !== b.service) return false;
  if (a.location !== b.location) return false;
  if (a.intent !== b.intent) return false;

  const samePathWithoutPrefix =
    a.path.replace(/^service-area\//, "").replace(/^locations\/[^/]+\//, "") ===
    b.path.replace(/^service-area\//, "").replace(/^locations\/[^/]+\//, "");

  const rootVsService =
    (a.section === "ROOT" && b.section === "SERVICE AREA") ||
    (a.section === "SERVICE AREA" && b.section === "ROOT");

  const blogVsRoot =
    (a.section === "BLOG" && b.section === "ROOT") ||
    (a.section === "ROOT" && b.section === "BLOG");

  const similarServiceCity =
    a.service &&
    a.location &&
    a.location !== "generic" &&
    a.intent === "service" &&
    b.intent === "service";

  return samePathWithoutPrefix || rootVsService || blogVsRoot || similarServiceCity;
}

function pickWinner(pages) {
  return [...pages].sort((a, b) => {
    if (b.clicks !== a.clicks) return b.clicks - a.clicks;
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    return a.position - b.position;
  })[0];
}

function makeRecommendation(group, pages) {
  const winner = pickWinner(pages);
  const losers = pages.filter((p) => p.url !== winner.url);

  if (group.intent !== "service") {
    return `Different intent detected: ${group.intent}. Do NOT redirect blindly. Check content overlap first. Main candidate: ${winner.url}`;
  }

  if (group.location === "generic") {
    return `Generic duplicate cluster. Pick the strongest page as canonical/main. Main candidate: ${winner.url}. Redirect or canonical weaker duplicates if they are same intent.`;
  }

  return `Same service + same location + same intent. Main candidate: ${winner.url}. Check if weaker URLs already 301. If not, redirect them to the main candidate.`;
}

function analyzePages(pagesData) {
  const pages = pagesData
    .map((row) => {
      const url = row["Top pages"] || row["Page"] || row["Pages"] || "";
      const path = getPath(url);
      const service = getService(path);
      const location = getLocation(path);
      const intent = getIntent(path);
      const section = getSection(path);

      return {
        url,
        path,
        service,
        location,
        intent,
        section,
        clicks: normalizeNumber(row["Clicks"]),
        impressions: normalizeNumber(row["Impressions"]),
        ctr: normalizeNumber(row["CTR"]),
        position: normalizeNumber(row["Position"]),
      };
    })
    .filter((p) => {
      if (!p.url || !p.path || p.url.includes("#")) return false;
      if (p.url === "https://bozmanfix.com/") return false;
      if (!p.service && p.section !== "BLOG" && p.section !== "CATEGORY" && p.section !== "LEGACY SERVICES") return false;
      return true;
    });

  const groups = {};

  pages.forEach((page) => {
    const key = `${page.section}|${page.location}|${page.service || page.path.split("/").pop()}|${page.intent}`;

    if (!groups[key]) {
      groups[key] = {
        section: page.section,
        location: page.location,
        service: page.service || page.path.split("/").pop(),
        intent: page.intent,
        pages: [],
      };
    }

    groups[key].pages.push(page);
  });

  const conflicts = Object.values(groups)
    .filter((group) => group.pages.length >= 2)
    .map((group) => {
      const pagesInGroup = group.pages.filter((a, idx, arr) =>
        arr.some((b, bidx) => idx !== bidx && isLikelyDuplicate(a, b))
      );

      if (pagesInGroup.length < 2) return null;

      const sorted = [...pagesInGroup].sort((a, b) => {
        if (b.clicks !== a.clicks) return b.clicks - a.clicks;
        if (b.impressions !== a.impressions) return b.impressions - a.impressions;
        return a.position - b.position;
      });

      const totalClicks = sorted.reduce((sum, p) => sum + p.clicks, 0);
      const totalImpressions = sorted.reduce((sum, p) => sum + p.impressions, 0);
      const winner = pickWinner(sorted);
      const bestPosition = Math.min(...sorted.map((p) => p.position || 999));
      const worstPosition = Math.max(...sorted.map((p) => p.position || 0));

      let risk = "LOW";
      if (totalImpressions >= 1000 && sorted.length >= 2 && group.intent === "service") risk = "HIGH";
      else if (totalImpressions >= 300 && sorted.length >= 2) risk = "MEDIUM";
      else if (sorted.length >= 3) risk = "MEDIUM";

      if (group.section === "CATEGORY" || group.section === "LEGACY SERVICES") risk = "MEDIUM";
      if (group.intent !== "service") risk = risk === "HIGH" ? "MEDIUM" : risk;

      return {
        keyword: `${humanize(group.service)} — ${humanize(group.location)}${group.intent !== "service" ? ` — ${humanize(group.intent)}` : ""}`,
        section: group.section,
        location: group.location,
        service: group.service,
        intent: group.intent,
        pages: sorted,
        pageCount: sorted.length,
        totalClicks,
        totalImpressions,
        bestPosition,
        worstPosition,
        winner,
        risk,
        recommendation: makeRecommendation(group, sorted),
      };
    })
    .filter(Boolean)
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
  r += "  CANNISCOPE — SEO X-RAY REPORT\n";
  r += "=================================================\n\n";

  const high = conflicts.filter((c) => c.risk === "HIGH").length;
  const medium = conflicts.filter((c) => c.risk === "MEDIUM").length;
  const low = conflicts.filter((c) => c.risk === "LOW").length;

  r += `Summary:\n`;
  r += `  Groups found: ${conflicts.length}\n`;
  r += `  HIGH risk: ${high}\n`;
  r += `  MEDIUM risk: ${medium}\n`;
  r += `  LOW risk: ${low}\n\n`;

  const sections = ["SERVICE AREA", "ROOT", "LOCATIONS", "BLOG", "LEGACY SERVICES", "CATEGORY"];

  sections.forEach((section) => {
    const items = conflicts.filter((c) => c.section === section);
    if (!items.length) return;

    r += "=================================================\n";
    r += `  ${section}\n`;
    r += "=================================================\n\n";

    items.forEach((c, idx) => {
      r += `#${idx + 1}: ${c.keyword}\n`;
      r += `Risk: ${c.risk}\n`;
      r += `Combined: ${c.totalClicks} clicks, ${c.totalImpressions.toLocaleString()} impressions\n`;
      r += `Main candidate: ${c.winner.url}\n\n`;
      r += `Pages:\n`;

      c.pages.forEach((p, pi) => {
        const label = p.url === c.winner.url ? " << MAIN CANDIDATE" : "";
        r += `  ${pi + 1}. ${p.url}${label}\n`;
        r += `     ${p.clicks} clicks | ${p.impressions.toLocaleString()} impressions | CTR ${p.ctr}% | pos ${p.position.toFixed(1)} | ${p.section}\n`;
      });

      r += `\nAction:\n  ${c.recommendation}\n\n`;
    });
  });

  r += "=================================================\n";
  r += "  IMPORTANT NOTE\n";
  r += "=================================================\n";
  r += "GSC may keep old URLs visible after 301 redirects. If a redirect already exists, do not panic — wait for Google to process it. If no redirect exists, fix it.\n\n";

  r += "Generated by CanniScope\n";

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
    const csvFiles = fileArray.filter((f) => f.name.toLowerCase().endsWith(".csv"));

    if (csvFiles.length === 0) {
      setError("No CSV files found.");
      setLoading(false);
      return;
    }

    let pagesData = null;
    let done = 0;

    csvFiles.forEach((file) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          if (file.name.toLowerCase().includes("page")) pagesData = res.data;
          if (!pagesData && res.data[0] && res.data[0]["Top pages"]) pagesData = res.data;

          done++;

          if (done === csvFiles.length) {
            if (!pagesData) {
              setError("Couldn't find Pages.csv. Upload the full unzipped GSC CSV export.");
              setLoading(false);
              return;
            }

            const results = analyzePages(pagesData);

            if (results.length === 0) {
              setError("No strong duplicate clusters found. Your Pages.csv looks mostly clean.");
              setLoading(false);
              return;
            }

            setConflicts(results);
            setReportText(generateReport(results));
            setLoading(false);
          }
        },
        error: () => {
          done++;
          if (done === csvFiles.length && !pagesData) {
            setError("Failed to parse CSV.");
            setLoading(false);
          }
        },
      });
    });
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    processFiles(e.dataTransfer.files);
  };

  const onFileSelect = (e) => processFiles(e.target.files);

  const downloadReport = () => {
    const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "canniscope-xray-report.txt";
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
      <div style={styles.pageCenter}>
        <div style={styles.container}>
          <div style={styles.logo}>CanniScope</div>
          <h1 style={styles.h1}>SEO X-Ray for<br />GSC Page Exports</h1>
          <p style={styles.sub}>
            Upload your Google Search Console CSV export.
            <br />
            Find same-service, same-location URL conflicts.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById("csv-input").click()}
            style={{
              ...styles.dropzone,
              borderColor: dragOver ? "#FF3B30" : "#333",
              background: dragOver ? "#FF3B3008" : "transparent",
            }}
          >
            <div style={styles.icon}>🩻</div>
            <div style={styles.dropTitle}>{loading ? "Analyzing..." : "Select CSV files"}</div>
            <div style={styles.dropSub}>Pick all files from your GSC export</div>
            <input id="csv-input" type="file" multiple onChange={onFileSelect} style={{ display: "none" }} />
          </div>

          <button
            onClick={() => document.getElementById("folder-input").click()}
            style={styles.folderButton}
          >
            📂 Or select the entire export folder
          </button>

          <input
            id="folder-input"
            type="file"
            webkitdirectory=""
            directory=""
            onChange={onFileSelect}
            style={{ display: "none" }}
          />

          {error && <div style={styles.error}>{error}</div>}

          <div style={styles.howto}>
            <div style={{ fontWeight: 700, color: "#aaa", marginBottom: 6 }}>How to get the files:</div>
            1. Google Search Console → Performance
            <br />
            2. Set date range
            <br />
            3. Export → Download CSV
            <br />
            4. Unzip → upload the folder or all CSV files here
          </div>
        </div>
      </div>
    );
  }

  const high = conflicts.filter((c) => c.risk === "HIGH").length;
  const medium = conflicts.filter((c) => c.risk === "MEDIUM").length;
  const totalPages = conflicts.reduce((s, c) => s + c.pageCount, 0);

  return (
    <div style={styles.resultsPage}>
      <div style={styles.header}>
        <span style={styles.logo}>CanniScope</span>
        <h2 style={styles.h2}>
          {high > 0 ? `🔥 ${high} high-risk clusters found` : "SEO X-Ray Complete"}
        </h2>
        <p style={styles.summary}>
          {conflicts.length} groups · {totalPages} URLs · {medium} medium-risk groups
        </p>
      </div>

      <div style={styles.buttons}>
        <button onClick={downloadReport} style={styles.primaryButton}>📥 Download Report</button>
        <button onClick={copyReport} style={styles.secondaryButton}>{copied ? "✓ Copied" : "📋 Copy"}</button>
        <button
          onClick={() => {
            setConflicts(null);
            setReportText("");
            setError(null);
          }}
          style={styles.secondaryButton}
        >
          ↻ New
        </button>
      </div>

      <RiskSection title="🔴 High Risk — Fix First" risk="HIGH" conflicts={conflicts} />
      <RiskSection title="🟡 Medium Risk — Check" risk="MEDIUM" conflicts={conflicts} />
      <RiskSection title="🟢 Low Risk — Monitor" risk="LOW" conflicts={conflicts} />

      <div style={styles.footer}>CanniScope</div>
    </div>
  );
}

function RiskSection({ title, risk, conflicts }) {
  const items = conflicts.filter((c) => c.risk === risk);
  if (!items.length) return null;

  const color = risk === "HIGH" ? "#FF3B30" : risk === "MEDIUM" ? "#FF9900" : "#34C759";

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ ...styles.sectionTitle, color }}>{title}</div>
      {items.map((c, i) => (
        <ConflictCard key={`${risk}-${i}`} conflict={c} />
      ))}
    </div>
  );
}

function ConflictCard({ conflict: c }) {
  const [open, setOpen] = useState(false);
  const riskColor = c.risk === "HIGH" ? "#FF3B30" : c.risk === "MEDIUM" ? "#FF9900" : "#34C759";

  return (
    <div style={{ ...styles.card, borderColor: open ? `${riskColor}66` : "#1a1a1a" }}>
      <div onClick={() => setOpen(!open)} style={styles.cardTop}>
        <div style={{ flex: 1 }}>
          <div style={styles.cardTitle}>{c.keyword}</div>
          <div style={styles.cardMeta}>
            {c.section} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impressions
          </div>
        </div>
        <span style={{ ...styles.arrow, transform: open ? "rotate(90deg)" : "none" }}>▸</span>
      </div>

      {open && (
        <div style={styles.cardBody}>
          <div style={{ ...styles.reco, borderLeftColor: riskColor }}>
            <strong>Main candidate:</strong> {c.winner.url}
            <br />
            <br />
            {c.recommendation}
          </div>

          {c.pages.map((p, pi) => (
            <div key={pi} style={styles.urlRow}>
              <div style={{ ...styles.url, color: p.url === c.winner.url ? "#34C759" : "#999" }}>
                {p.url === c.winner.url && "👑 "}
                /{p.path}
              </div>
              <div style={styles.metrics}>
                <span>Clicks: <b>{p.clicks}</b></span>
                <span>Impr: <b>{p.impressions.toLocaleString()}</b></span>
                <span>CTR: <b>{p.ctr}%</b></span>
                <span>Pos: <b>{p.position.toFixed(1)}</b></span>
                <span>Section: <b>{p.section}</b></span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const font = "'JetBrains Mono','SF Mono','Fira Code',monospace";

const styles = {
  pageCenter: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    fontFamily: font,
    background: "#0A0A0A",
    color: "#E5E5E5",
  },
  container: {
    textAlign: "center",
    maxWidth: 560,
    width: "100%",
  },
  logo: {
    fontSize: 12,
    letterSpacing: 6,
    textTransform: "uppercase",
    color: "#FF3B30",
    marginBottom: 12,
    fontWeight: 700,
  },
  h1: {
    fontSize: 30,
    fontWeight: 800,
    margin: "0 0 10px",
    lineHeight: 1.15,
    color: "#fff",
  },
  h2: {
    margin: "6px 0 0",
    fontSize: 24,
    fontWeight: 800,
    color: "#fff",
  },
  sub: {
    fontSize: 13,
    color: "#888",
    margin: "0 0 36px",
    lineHeight: 1.6,
  },
  dropzone: {
    border: "2px dashed #333",
    borderRadius: 16,
    padding: "52px 24px",
    cursor: "pointer",
    transition: "all 0.2s",
  },
  icon: {
    fontSize: 44,
    marginBottom: 16,
  },
  dropTitle: {
    fontSize: 16,
    fontWeight: 700,
    marginBottom: 8,
    color: "#fff",
  },
  dropSub: {
    fontSize: 12,
    color: "#666",
  },
  folderButton: {
    marginTop: 12,
    width: "100%",
    padding: "16px",
    background: "#161616",
    border: "1px solid #2a2a2a",
    borderRadius: 12,
    color: "#bbb",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    fontFamily: font,
  },
  error: {
    marginTop: 20,
    padding: "14px 18px",
    background: "#FF3B3012",
    border: "1px solid #FF3B3040",
    borderRadius: 10,
    fontSize: 13,
    color: "#FF6B6B",
    lineHeight: 1.4,
  },
  howto: {
    marginTop: 32,
    padding: "16px 20px",
    background: "#131313",
    borderRadius: 12,
    textAlign: "left",
    fontSize: 12,
    color: "#777",
    lineHeight: 1.8,
    border: "1px solid #1a1a1a",
  },
  resultsPage: {
    minHeight: "100vh",
    fontFamily: font,
    background: "#0A0A0A",
    color: "#E5E5E5",
    padding: 20,
  },
  header: {
    marginBottom: 20,
  },
  summary: {
    margin: "5px 0 0",
    fontSize: 12,
    color: "#666",
  },
  buttons: {
    display: "flex",
    gap: 10,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  primaryButton: {
    flex: 1,
    padding: "14px 20px",
    background: "#FF3B30",
    border: "none",
    borderRadius: 10,
    color: "#fff",
    fontSize: 14,
    fontWeight: 800,
    cursor: "pointer",
    fontFamily: font,
    minWidth: 170,
  },
  secondaryButton: {
    padding: "14px 20px",
    background: "#1a1a1a",
    border: "1px solid #333",
    borderRadius: 10,
    color: "#ccc",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: font,
  },
  sectionTitle: {
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    fontWeight: 800,
    marginBottom: 12,
  },
  card: {
    background: "#111",
    border: "1px solid #1a1a1a",
    borderRadius: 12,
    marginBottom: 8,
    overflow: "hidden",
    transition: "border-color 0.2s",
  },
  cardTop: {
    padding: "14px 16px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 800,
    color: "#fff",
    marginBottom: 4,
  },
  cardMeta: {
    fontSize: 11,
    color: "#666",
  },
  arrow: {
    color: "#444",
    fontSize: 14,
    transition: "transform 0.15s",
    flexShrink: 0,
  },
  cardBody: {
    padding: "0 16px 16px",
    borderTop: "1px solid #1a1a1a",
  },
  reco: {
    margin: "12px 0",
    padding: "10px 14px",
    background: "#ffffff05",
    borderLeft: "3px solid #FF3B30",
    borderRadius: "0 8px 8px 0",
    fontSize: 12,
    color: "#bbb",
    lineHeight: 1.5,
    wordBreak: "break-word",
  },
  urlRow: {
    padding: "10px 0",
    borderBottom: "1px solid #1a1a1a",
  },
  url: {
    fontSize: 12,
    wordBreak: "break-all",
    marginBottom: 5,
  },
  metrics: {
    fontSize: 11,
    color: "#555",
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
  },
  footer: {
    textAlign: "center",
    padding: "20px 0",
    fontSize: 10,
    color: "#333",
    letterSpacing: 2,
    textTransform: "uppercase",
  },
};