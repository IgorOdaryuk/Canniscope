import { useState } from "react";
import Papa from "papaparse";

const SERVICE_ALIASES = [
  ["sub-zero-refrigerator-repair", "sub-zero-repair"],
  ["sub-zero-repair", "sub-zero-repair"],
  ["ge-appliance-repair", "ge-appliance-repair"],
  ["lg-appliance-repair", "lg-appliance-repair"],
  ["samsung-appliance-repair", "samsung-appliance-repair"],
  ["whirlpool-appliance-repair", "whirlpool-appliance-repair"],
  ["refrigerator-repair", "refrigerator-repair"],
  ["fridge-repair", "refrigerator-repair"],
  ["washer-repair", "washer-repair"],
  ["dryer-repair", "dryer-repair"],
  ["dishwasher-repair", "dishwasher-repair"],
  ["cooktop-repair", "cooktop-repair"],
  ["oven-repair", "oven-repair"],
  ["ice-maker-repair", "icemaker-repair"],
  ["icemaker-repair", "icemaker-repair"],
  ["freezer-repair", "freezer-repair"],
  ["microwave-repair", "microwave-repair"],
  ["appliance-repair", "appliance-repair"],
];

const INTENTS = [
  ["cost", ["cost", "price", "how-much"]],
  ["best", ["best"]],
  ["cheap", ["cheap"]],
  ["free", ["free"]],
  ["near-me", ["near-me"]],
  ["same-day", ["same-day"]],
  ["brand", ["sub-zero", "samsung", "lg-", "whirlpool", "ge-appliance"]],
  [
    "symptom",
    [
      "not-cooling",
      "not-heating",
      "not-draining",
      "wont-drain",
      "won-t-drain",
      "wont-light",
      "won-t-light",
      "not-spinning",
      "not-making-ice",
      "temperature-off",
      "temperature-issues",
      "takes-too-long",
      "not-drying-fast",
      "not-cleaning",
    ],
  ],
];

function num(v) {
  return Number(String(v || "0").replace(/,/g, "").replace("%", "")) || 0;
}

function pathFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\/|\/$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

function title(slug) {
  return String(slug || "generic")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function sectionOf(path) {
  if (path.startsWith("blog/")) return "BLOG";
  if (path.startsWith("locations/")) return "LOCATIONS";
  if (path.startsWith("service-area/")) return "SERVICE AREA";
  if (path.startsWith("category/")) return "CATEGORY";
  if (path.startsWith("services/")) return "LEGACY";
  return "ROOT";
}

function lastSlug(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function stripState(slug) {
  return slug.replace(/-fl$/, "").replace(/-ga$/, "").replace(/-nc$/, "").replace(/-sc$/, "");
}

function detectIntent(path) {
  for (const [intent, words] of INTENTS) {
    if (words.some((w) => path.includes(w))) return intent;
  }
  return "service";
}

function detectService(path) {
  const slug = stripState(lastSlug(path).replace(/-in-/g, "-"));

  for (const [raw, normalized] of SERVICE_ALIASES.sort((a, b) => b[0].length - a[0].length)) {
    if (slug.includes(raw)) return normalized;
  }

  return null;
}

function detectGeo(path, service) {
  if (!service) return "generic";

  let slug = stripState(lastSlug(path));

  const rawServices = SERVICE_ALIASES
    .filter(([, normalized]) => normalized === service)
    .map(([raw]) => raw)
    .sort((a, b) => b.length - a.length);

  for (const raw of rawServices) {
    if (slug === raw) return "generic";

    if (slug.startsWith(`${raw}-in-`)) {
      slug = slug.replace(`${raw}-in-`, "");
      return slug || "generic";
    }

    if (slug.startsWith(`${raw}-`)) {
      slug = slug.replace(`${raw}-`, "");
      return slug || "generic";
    }
  }

  return "generic";
}

function contentKey(path) {
  return path
    .replace(/^blog\//, "")
    .replace(/^category\//, "category-")
    .replace(/^services\//, "services-");
}

function rowToPage(row) {
  const url = row["Top pages"] || row.Page || row.Pages || "";
  const path = pathFromUrl(url);
  const section = sectionOf(path);
  const service = detectService(path);
  const geo = detectGeo(path, service);
  const intent = detectIntent(path);

  const key = service
    ? `service|${service}|${geo}|${intent}`
    : `content|${contentKey(path)}`;

  return {
    url,
    path,
    section,
    service,
    geo,
    intent,
    key,
    clicks: num(row.Clicks),
    impressions: num(row.Impressions),
    ctr: num(row.CTR),
    position: num(row.Position),
  };
}

function winnerOf(pages) {
  return [...pages].sort((a, b) => {
    if (b.clicks !== a.clicks) return b.clicks - a.clicks;
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    return a.position - b.position;
  })[0];
}

function isUsefulConflict(group) {
  if (group.length < 2) return false;

  const sections = new Set(group.map((p) => p.section));
  const paths = new Set(group.map((p) => p.path));

  if (paths.size < 2) return false;

  if (sections.has("CATEGORY") || sections.has("LEGACY")) return true;

  if (sections.size >= 2) return true;

  const hasServiceAreaDuplicate = group.some((p) => p.path.includes("service-area/"));
  const hasRootDuplicate = group.some((p) => p.section === "ROOT");

  if (hasServiceAreaDuplicate && hasRootDuplicate) return true;

  const locationDuplicates = group.filter((p) => p.section === "LOCATIONS");
  if (locationDuplicates.length >= 2) return true;

  return false;
}

function actionText(c) {
  const w = c.winner;

  if (c.intent !== "service") {
    return `Different intent: ${c.intent}. Do not redirect blindly. Check overlap. Winner by GSC data: ${w.url}`;
  }

  if (c.geo === "generic") {
    return `Generic page duplicate. Winner by GSC data: ${w.url}. If weaker URLs are not already 301/canonical, consolidate.`;
  }

  return `Same service + same geo + same intent. Winner by GSC data: ${w.url}. If weaker URLs are not already 301, redirect them. If 301 already exists, wait for Google.`;
}

function analyzePages(rows) {
  const pages = rows
    .map(rowToPage)
    .filter((p) => {
      if (!p.url || !p.path || p.url.includes("#")) return false;
      if (p.url === "https://bozmanfix.com/") return false;
      if (!p.service && !["BLOG", "CATEGORY", "LEGACY"].includes(p.section)) return false;
      return true;
    });

  const map = {};
  pages.forEach((p) => {
    if (!map[p.key]) map[p.key] = [];
    map[p.key].push(p);
  });

  return Object.values(map)
    .filter(isUsefulConflict)
    .map((group) => {
      const sorted = [...group].sort((a, b) => {
        if (b.clicks !== a.clicks) return b.clicks - a.clicks;
        if (b.impressions !== a.impressions) return b.impressions - a.impressions;
        return a.position - b.position;
      });

      const winner = winnerOf(sorted);
      const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
      const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
      const service = sorted[0].service || contentKey(sorted[0].path);
      const geo = sorted[0].geo || "generic";
      const intent = sorted[0].intent || "content";

      let risk = "LOW";
      if (totalImpressions >= 1000 && intent === "service") risk = "HIGH";
      else if (totalImpressions >= 300) risk = "MEDIUM";
      else if (sorted.length >= 3) risk = "MEDIUM";

      if (intent !== "service" && risk === "HIGH") risk = "MEDIUM";

      const sections = [...new Set(sorted.map((p) => p.section))].join(" + ");

      const conflict = {
        label: `${title(service)} — ${title(geo)}${intent !== "service" ? ` — ${title(intent)}` : ""}`,
        service,
        geo,
        intent,
        sections,
        pages: sorted,
        pageCount: sorted.length,
        totalClicks,
        totalImpressions,
        winner,
        risk,
      };

      conflict.action = actionText(conflict);

      return conflict;
    })
    .sort((a, b) => {
      const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (order[a.risk] !== order[b.risk]) return order[a.risk] - order[b.risk];
      return b.totalImpressions - a.totalImpressions;
    });
}

function reportText(conflicts) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — SEO X-RAY REPORT\n";
  r += "=================================================\n\n";

  const high = conflicts.filter((c) => c.risk === "HIGH").length;
  const medium = conflicts.filter((c) => c.risk === "MEDIUM").length;
  const low = conflicts.filter((c) => c.risk === "LOW").length;

  r += `Groups found: ${conflicts.length}\n`;
  r += `HIGH: ${high}\n`;
  r += `MEDIUM: ${medium}\n`;
  r += `LOW: ${low}\n\n`;

  ["HIGH", "MEDIUM", "LOW"].forEach((risk) => {
    const items = conflicts.filter((c) => c.risk === risk);
    if (!items.length) return;

    r += "=================================================\n";
    r += `  ${risk}\n`;
    r += "=================================================\n\n";

    items.forEach((c, i) => {
      r += `#${i + 1}: ${c.label}\n`;
      r += `Sections: ${c.sections}\n`;
      r += `Combined: ${c.totalClicks} clicks, ${c.totalImpressions.toLocaleString()} impressions\n`;
      r += `Winner: ${c.winner.url}\n`;
      r += `Action: ${c.action}\n\n`;

      c.pages.forEach((p, idx) => {
        const mark = p.url === c.winner.url ? " << WINNER" : "";
        r += `  ${idx + 1}. ${p.url}${mark}\n`;
        r += `     ${p.clicks} clicks | ${p.impressions.toLocaleString()} impressions | CTR ${p.ctr}% | Pos ${p.position.toFixed(1)} | ${p.section}\n`;
      });

      r += "\n";
    });
  });

  r += "NOTE: GSC may show old URLs after 301 redirects. If redirect already exists, wait. If not, fix it.\n";
  return r;
}

export default function CanniScope() {
  const [conflicts, setConflicts] = useState(null);
  const [report, setReport] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  function processFiles(files) {
    setError("");
    setLoading(true);
    setCopied(false);

    const csvFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith(".csv"));

    if (!csvFiles.length) {
      setError("No CSV files found.");
      setLoading(false);
      return;
    }

    let pagesRows = null;
    let done = 0;

    csvFiles.forEach((file) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (res) => {
          const first = res.data?.[0] || {};
          const name = file.name.toLowerCase();

          if (name.includes("page") || first["Top pages"]) {
            pagesRows = res.data;
          }

          done += 1;

          if (done === csvFiles.length) {
            if (!pagesRows) {
              setError("Pages.csv not found. Upload full unzipped GSC CSV export.");
              setLoading(false);
              return;
            }

            const result = analyzePages(pagesRows);

            if (!result.length) {
              setError("No strong duplicate clusters found.");
              setLoading(false);
              return;
            }

            setConflicts(result);
            setReport(reportText(result));
            setLoading(false);
          }
        },
        error: () => {
          done += 1;
          if (done === csvFiles.length && !pagesRows) {
            setError("CSV parse error.");
            setLoading(false);
          }
        },
      });
    });
  }

  function downloadReport() {
    const blob = new Blob([report], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "canniscope-report.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyReport() {
    navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  if (!conflicts) {
    return (
      <div style={s.centerPage}>
        <div style={s.homeBox}>
          <div style={s.logo}>CanniScope</div>
          <h1 style={s.h1}>SEO X-Ray for GSC Page Exports</h1>
          <p style={s.sub}>
            Upload the full unzipped Google Search Console CSV export. The tool finds same-service, same-geo URL clusters.
          </p>

          <div
            style={{
              ...s.drop,
              borderColor: dragOver ? "#ff3b30" : "#333",
              background: dragOver ? "#ff3b300d" : "transparent",
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              processFiles(e.dataTransfer.files);
            }}
            onClick={() => document.getElementById("csv-input").click()}
          >
            <div style={s.icon}>🩻</div>
            <div style={s.dropTitle}>{loading ? "Analyzing..." : "Select CSV files"}</div>
            <div style={s.dropSub}>Pick all files from GSC export</div>
            <input
              id="csv-input"
              type="file"
              multiple
              onChange={(e) => processFiles(e.target.files)}
              style={{ display: "none" }}
            />
          </div>

          <button style={s.folderBtn} onClick={() => document.getElementById("folder-input").click()}>
            📂 Select export folder
          </button>

          <input
            id="folder-input"
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            onChange={(e) => processFiles(e.target.files)}
            style={{ display: "none" }}
          />

          {error && <div style={s.error}>{error}</div>}

          <div style={s.how}>
            <b>Flow:</b>
            <br />
            GSC → Performance → Export → Download CSV → Unzip → Upload folder here
          </div>
        </div>
      </div>
    );
  }

  const high = conflicts.filter((c) => c.risk === "HIGH").length;
  const medium = conflicts.filter((c) => c.risk === "MEDIUM").length;
  const totalUrls = conflicts.reduce((sum, c) => sum + c.pageCount, 0);

  return (
    <div style={s.results}>
      <div style={s.top}>
        <div style={s.logo}>CanniScope</div>
        <h2 style={s.h2}>{high ? `🔥 ${high} high-risk clusters found` : "SEO X-Ray Complete"}</h2>
        <p style={s.meta}>
          {conflicts.length} groups · {totalUrls} URLs · {medium} medium-risk groups
        </p>
      </div>

      <div style={s.actions}>
        <button style={s.primary} onClick={downloadReport}>📥 Download Report</button>
        <button style={s.secondary} onClick={copyReport}>{copied ? "✓ Copied" : "📋 Copy"}</button>
        <button
          style={s.secondary}
          onClick={() => {
            setConflicts(null);
            setReport("");
            setError("");
          }}
        >
          ↻ New
        </button>
      </div>

      <RiskBlock title="🔴 High Risk — Fix First" risk="HIGH" conflicts={conflicts} />
      <RiskBlock title="🟡 Medium Risk — Check" risk="MEDIUM" conflicts={conflicts} />
      <RiskBlock title="🟢 Low Risk — Monitor" risk="LOW" conflicts={conflicts} />
    </div>
  );
}

function RiskBlock({ title, risk, conflicts }) {
  const items = conflicts.filter((c) => c.risk === risk);
  if (!items.length) return null;

  const color = risk === "HIGH" ? "#ff3b30" : risk === "MEDIUM" ? "#ff9900" : "#34c759";

  return (
    <div style={s.block}>
      <div style={{ ...s.blockTitle, color }}>{title}</div>
      {items.map((c, i) => (
        <Card key={`${risk}-${i}`} c={c} />
      ))}
    </div>
  );
}

function Card({ c }) {
  const [open, setOpen] = useState(false);
  const color = c.risk === "HIGH" ? "#ff3b30" : c.risk === "MEDIUM" ? "#ff9900" : "#34c759";

  return (
    <div style={{ ...s.card, borderColor: open ? `${color}88` : "#1e1e1e" }}>
      <div style={s.cardHead} onClick={() => setOpen(!open)}>
        <div style={{ flex: 1 }}>
          <div style={s.cardTitle}>{c.label}</div>
          <div style={s.cardMeta}>
            {c.sections} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impressions
          </div>
        </div>
        <div style={{ ...s.chev, transform: open ? "rotate(90deg)" : "none" }}>▸</div>
      </div>

      {open && (
        <div style={s.body}>
          <div style={{ ...s.reco, borderLeftColor: color }}>
            <b>Winner:</b> {c.winner.url}
            <br />
            <br />
            {c.action}
          </div>

          {c.pages.map((p, i) => (
            <div key={i} style={s.row}>
              <div style={{ ...s.url, color: p.url === c.winner.url ? "#34c759" : "#aaa" }}>
                {p.url === c.winner.url ? "👑 " : ""}
                /{p.path}
              </div>
              <div style={s.metrics}>
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

const s = {
  centerPage: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#e5e5e5",
    fontFamily: font,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  homeBox: {
    width: "100%",
    maxWidth: 580,
    textAlign: "center",
  },
  logo: {
    color: "#ff3b30",
    textTransform: "uppercase",
    letterSpacing: 6,
    fontSize: 12,
    fontWeight: 800,
    marginBottom: 14,
  },
  h1: {
    color: "#fff",
    fontSize: 30,
    lineHeight: 1.15,
    margin: "0 0 12px",
  },
  h2: {
    color: "#fff",
    fontSize: 25,
    margin: "0 0 6px",
  },
  sub: {
    color: "#888",
    fontSize: 13,
    lineHeight: 1.6,
    marginBottom: 34,
  },
  drop: {
    border: "2px dashed #333",
    borderRadius: 16,
    padding: "50px 22px",
    cursor: "pointer",
  },
  icon: {
    fontSize: 42,
    marginBottom: 14,
  },
  dropTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: 800,
    marginBottom: 8,
  },
  dropSub: {
    color: "#666",
    fontSize: 12,
  },
  folderBtn: {
    width: "100%",
    marginTop: 12,
    padding: 15,
    background: "#161616",
    color: "#bbb",
    border: "1px solid #2a2a2a",
    borderRadius: 12,
    fontFamily: font,
    fontWeight: 800,
    cursor: "pointer",
  },
  error: {
    marginTop: 18,
    background: "#ff3b3014",
    border: "1px solid #ff3b3044",
    color: "#ff7770",
    borderRadius: 10,
    padding: 14,
    fontSize: 13,
  },
  how: {
    marginTop: 28,
    background: "#131313",
    border: "1px solid #1e1e1e",
    borderRadius: 12,
    color: "#777",
    fontSize: 12,
    textAlign: "left",
    lineHeight: 1.8,
    padding: 16,
  },
  results: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#e5e5e5",
    fontFamily: font,
    padding: 20,
  },
  top: {
    marginBottom: 20,
  },
  meta: {
    color: "#666",
    fontSize: 12,
    margin: 0,
  },
  actions: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 24,
  },
  primary: {
    flex: 1,
    minWidth: 180,
    background: "#ff3b30",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "14px 20px",
    fontFamily: font,
    fontWeight: 900,
    cursor: "pointer",
  },
  secondary: {
    background: "#1a1a1a",
    color: "#ccc",
    border: "1px solid #333",
    borderRadius: 10,
    padding: "14px 20px",
    fontFamily: font,
    cursor: "pointer",
  },
  block: {
    marginBottom: 28,
  },
  blockTitle: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 2,
    fontWeight: 900,
    marginBottom: 10,
  },
  card: {
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: 12,
    marginBottom: 8,
    overflow: "hidden",
  },
  cardHead: {
    padding: "15px 16px",
    display: "flex",
    alignItems: "center",
    gap: 12,
    cursor: "pointer",
  },
  cardTitle: {
    color: "#fff",
    fontSize: 14,
    fontWeight: 900,
    marginBottom: 4,
  },
  cardMeta: {
    color: "#666",
    fontSize: 11,
  },
  chev: {
    color: "#555",
    transition: "transform .15s",
  },
  body: {
    borderTop: "1px solid #1e1e1e",
    padding: "0 16px 16px",
  },
  reco: {
    margin: "12px 0",
    background: "#ffffff06",
    borderLeft: "3px solid #ff3b30",
    borderRadius: "0 8px 8px 0",
    color: "#bbb",
    padding: "12px 14px",
    fontSize: 12,
    lineHeight: 1.55,
    wordBreak: "break-word",
  },
  row: {
    padding: "10px 0",
    borderBottom: "1px solid #1e1e1e",
  },
  url: {
    fontSize: 12,
    wordBreak: "break-all",
    marginBottom: 6,
  },
  metrics: {
    color: "#555",
    fontSize: 11,
    display: "flex",
    gap: 14,
    flexWrap: "wrap",
  },
};