import { useState } from "react";
import Papa from "papaparse";

// ─── INTENT FILTERS ───
// These words signal a DIFFERENT intent — never group with plain service pages.

const BRAND_WORDS = new Set([
  "sub-zero","subzero","lg","samsung","whirlpool","ge","thermador","viking",
  "wolf","bosch","kitchenaid","maytag","frigidaire","kenmore","amana","electrolux",
  "miele","speed-queen","jenn-air","jennair","dacor","fisher-paykel","haier","hisense",
]);

const SYMPTOM_WORDS = new Set([
  "not-cooling","not-heating","wont-drain","not-spinning","not-making-ice",
  "wont-start","not-working","leaking","noisy","loud","vibrating","shaking",
  "temperature","takes-too-long","wont-turn-on","wont-turn-off","error-code",
  "not-draining","not-drying","not-dispensing","ice-buildup","frost",
  "wont-close","wont-open","not-filling","overheating","smoking","burning-smell",
  "tripping-breaker","beeping","flashing",
]);

const MODIFIER_WORDS = new Set([
  "cost","price","pricing","best","cheap","cheapest","free","near-me","near",
  "same-day","emergency","affordable","top","rated","review","reviews",
  "how-much","estimate","quote","warranty","certified","licensed",
  "professional","expert","trusted","reliable",
]);

const CONTENT_WORDS = new Set([
  "guide","tips","vs","versus","comparison","how-to","diy","troubleshoot",
  "troubleshooting","signs","when-to","should-i","replacement",
  "maintenance","checklist","faq","common-problems","lifespan",
]);

// US state abbreviations for stripping
const STATES = new Set([
  "al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia",
  "ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy","dc",
]);

// ─── URL PARSER ───

function getSection(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.startsWith("/service-area/")) return "SERVICE-AREA";
    if (path.startsWith("/locations/")) return "LOCATIONS";
    if (path.startsWith("/services/")) return "SERVICES";
    if (path.startsWith("/category/")) return "CATEGORY";
    if (path.startsWith("/blog/")) return "BLOG";
    return "ROOT";
  } catch {
    return "ROOT";
  }
}

function getPathname(url) {
  try { return new URL(url).pathname; } catch { return url; }
}

function classifyURL(url) {
  // Returns { service, geo, section, intent } or null if URL is not groupable.
  // intent = "service" | "brand" | "symptom" | "modifier" | "content"
  // Only "service" intent pages get grouped for cannibalization.

  try {
    let path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "").replace(/^\//, "");
    const section = getSection(url);

    // Strip section prefix and city-folder prefix
    // e.g. "locations/jacksonville/dryer-repair-jacksonville-beach-fl" → "dryer-repair-jacksonville-beach-fl"
    // e.g. "service-area/appliance-repair-in-atlanta" → "appliance-repair-in-atlanta"
    const parts = path.split("/").filter(Boolean);

    // Remove known section prefixes
    if (["service-area","locations","services","category","blog"].includes(parts[0])) {
      parts.shift();
    }
    // If locations/city-folder/slug, skip the city folder too
    if (section === "LOCATIONS" && parts.length > 1) {
      parts.shift(); // remove the city folder (e.g., "jacksonville")
    }

    const slug = parts[parts.length - 1] || "";
    if (!slug || slug.length < 3) return null;

    const slugWords = slug.split("-");

    // ── CHECK INTENT ──

    // Brand page?
    for (const w of slugWords) {
      if (BRAND_WORDS.has(w)) return { slug, section, intent: "brand" };
    }
    // Check multi-word brands
    for (const brand of BRAND_WORDS) {
      if (brand.includes("-") && slug.includes(brand)) return { slug, section, intent: "brand" };
    }

    // Symptom page?
    for (const symptom of SYMPTOM_WORDS) {
      if (slug.includes(symptom)) return { slug, section, intent: "symptom" };
    }

    // Modifier page?
    for (const mod of MODIFIER_WORDS) {
      if (slug.includes(mod)) return { slug, section, intent: "modifier" };
    }

    // Content page?
    for (const cw of CONTENT_WORDS) {
      if (slug.includes(cw)) return { slug, section, intent: "content" };
    }

    // ── EXTRACT SERVICE + GEO ──
    // Normalize: remove "in", remove state abbreviations, then split into
    // service-words and geo-words.
    // Strategy: known service patterns are multi-word (e.g., "refrigerator-repair",
    // "appliance-repair", "washer-repair"). Everything else after the service = geo.

    let normalized = slug
      .replace(/-in-/g, "-")         // "repair-in-atlanta" → "repair-atlanta"
      .replace(/^in-/, "")           // "in-atlanta-..." → "atlanta-..."
      .replace(/-in$/, "");          // "...-in" → "..."

    // Strip trailing state abbreviation
    const lastWord = normalized.split("-").pop();
    if (lastWord && STATES.has(lastWord)) {
      normalized = normalized.replace(new RegExp(`-${lastWord}$`), "");
    }

    // Find service pattern: look for "X-repair" or "repair" or "installation" etc.
    // Service = all words up to and including "repair"/"installation"/"service"/"maintenance"
    const serviceTerms = ["repair","installation","install","service","maintenance","replacement","cleaning"];
    const nWords = normalized.split("-");
    let serviceEnd = -1;

    for (let i = 0; i < nWords.length; i++) {
      if (serviceTerms.includes(nWords[i])) {
        serviceEnd = i;
        break;
      }
    }

    let service, geo;

    if (serviceEnd >= 0) {
      service = nWords.slice(0, serviceEnd + 1).join("-");
      geo = nWords.slice(serviceEnd + 1).filter(w => w.length > 0).join("-") || null;
    } else {
      // No service term found — treat whole slug as a single unit
      service = normalized;
      geo = null;
    }

    // Clean up
    service = service.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (geo) geo = geo.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    if (!service || service.length < 3) return null;

    return { service, geo: geo || null, section, intent: "service", slug };
  } catch {
    return null;
  }
}

// ─── ANALYSIS ───

function analyzePages(pagesData) {
  const pages = pagesData.map(row => ({
    url: (row["Top pages"] || "").trim(),
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g, "")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%", "")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url);

  // Classify every page
  const classified = pages.map(p => {
    const c = classifyURL(p.url);
    if (!c || c.intent !== "service") return null;
    return { ...p, ...c };
  }).filter(Boolean);

  // Group by exact service + exact geo
  const groups = {};
  classified.forEach(p => {
    const key = `${p.service}|${p.geo || "generic"}`;
    if (!groups[key]) groups[key] = [];
    // No exact-URL duplicates
    if (!groups[key].find(x => x.url === p.url)) {
      groups[key].push(p);
    }
  });

  // ── CRITICAL RULE: generic ≠ city pages ──
  // /refrigerator-repair/ (generic, geo=null) should NOT group with
  // /refrigerator-repair-tampa/ (geo=tampa).
  // They're already in separate groups because geo differs.
  // But double-check: a page with geo=null is "generic" key,
  // a page with geo="tampa" is "tampa" key. ✓ They won't mix.

  // Only keep groups with 2–5 pages
  const conflicts = Object.entries(groups)
    .filter(([_, ps]) => ps.length >= 2 && ps.length <= 5)
    .map(([key, ps]) => {
      const [service, geo] = key.split("|");
      const sorted = [...ps].sort(
        (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position
      );
      const winner = sorted[0];
      const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
      const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
      const sections = [...new Set(sorted.map(p => p.section))];

      // Label
      const serviceName = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const geoName = geo === "generic"
        ? "Generic"
        : geo.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const label = `${serviceName} — ${geoName}`;

      // Risk
      let risk = "LOW";
      if (sections.length >= 2 && totalImpressions >= 200) risk = "HIGH";
      else if (totalImpressions >= 1000 || sorted.length >= 3) risk = "HIGH";
      else if (totalImpressions >= 200 || sections.length >= 2) risk = "MEDIUM";

      // Winner path
      const winnerPath = getPathname(winner.url);

      // Recommendation
      let recommendation;
      if (sections.length >= 2) {
        recommendation =
          `${sorted.length} pages compete for the same service+geo across ${sections.join(" + ")}. ` +
          `Winner by GSC data: ${winnerPath}. Consolidate — redirect ` +
          `weaker pages with 301, or clearly differentiate each page's intent and content.`;
      } else {
        recommendation =
          `${sorted.length} URL variants with the same target in ${sections[0]}. ` +
          `Winner by GSC data: ${winnerPath}. ` +
          `Redirect weaker URLs with 301 to the winner, or add canonical tags.`;
      }

      // Action items per page
      const pageActions = sorted.map((p, i) => {
        if (i === 0) return { ...p, action: "KEEP — winner by GSC data" };
        // If same section as winner and much fewer clicks
        if (p.clicks === 0 && p.impressions < winner.impressions * 0.3) {
          return { ...p, action: "301 redirect to winner" };
        }
        if (p.section !== winner.section) {
          return { ...p, action: "Check if 301/canonical exists → if not, redirect to winner" };
        }
        return { ...p, action: "301 redirect to winner (same section duplicate)" };
      });

      return {
        label, service, geo, pages: pageActions, pageCount: sorted.length,
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

// ─── REPORT TEXT ───

function generateReportText(conflicts) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — Duplicate URL Targets Report\n";
  r += "=================================================\n\n";

  const high = conflicts.filter(c => c.risk === "HIGH").length;
  const medium = conflicts.filter(c => c.risk === "MEDIUM").length;
  const low = conflicts.filter(c => c.risk === "LOW").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;

  r += `Summary:\n`;
  r += `  Duplicate clusters: ${conflicts.length}\n`;
  r += `  URLs involved: ${totalURLs}\n`;
  r += `  HIGH: ${high} | MEDIUM: ${medium} | LOW: ${low}\n\n`;

  const buckets = [
    { label: "HIGH RISK — FIX FIRST", filter: "HIGH" },
    { label: "MEDIUM RISK — CHECK", filter: "MEDIUM" },
    { label: "LOW RISK — MONITOR", filter: "LOW" },
  ];

  buckets.forEach(sec => {
    const items = conflicts.filter(c => c.risk === sec.filter);
    if (items.length === 0) return;
    r += `=== ${sec.label} ===\n\n`;
    items.forEach((c, idx) => {
      r += `#${idx + 1}: ${c.label}\n`;
      r += `${c.sections.join(" + ")} · ${c.pageCount} URLs · ${c.totalClicks} clicks · ${c.totalImpressions.toLocaleString()} impr\n\n`;
      r += `${c.recommendation}\n\n`;
      r += `Pages:\n`;
      c.pages.forEach((p, pi) => {
        const path = getPathname(p.url);
        r += `  ${pi === 0 ? "👑" : "  "} ${path}\n`;
        r += `     Clicks: ${p.clicks} | Impr: ${p.impressions.toLocaleString()} | CTR: ${p.ctr}% | Pos: ${p.position.toFixed(1)} | ${p.section}\n`;
        r += `     → ${p.action}\n`;
      });
      r += `\n- - - - - - - - - - - - - - - - - - - - - - - -\n\n`;
    });
  });

  r += "=================================================\n";
  r += "  Generated by CanniScope\n";
  r += "=================================================\n";
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
  clean: { marginTop: 20, padding: "14px 18px", background: "#F0FAF0", border: "1px solid #C9FFCF", borderRadius: 10, fontSize: 14, color: "#27AE60" },
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

// ─── COMPONENTS ───

function ActionBadge({ action }) {
  let bg, color, text;
  if (action.startsWith("KEEP")) {
    bg = "#E8F5E9"; color = "#2E7D32"; text = action;
  } else if (action.startsWith("301")) {
    bg = "#FFF3E0"; color = "#E65100"; text = action;
  } else {
    bg = "#FFF8E1"; color = "#F57F17"; text = action;
  }
  return (
    <div style={{ marginTop: 4, fontSize: 12, padding: "3px 8px", background: bg, color, borderRadius: 4, display: "inline-block", fontWeight: 600 }}>
      → {text}
    </div>
  );
}

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
            {c.sections.join(" + ")} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impr
          </div>
        </div>
        <span style={{ color: "#ccc", fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>▸</span>
      </div>
      {open && (
        <div>
          <div style={{ margin: "0 20px 14px", padding: "14px 18px", background: rc + "08", borderLeft: `3px solid ${rc}`, borderRadius: "0 8px 8px 0", fontSize: 14, color: "#555", lineHeight: 1.6 }}>
            {c.recommendation}
          </div>
          {c.pages.map((p, pi) => (
            <div key={pi} style={{ padding: "12px 20px", borderTop: "1px solid #f3f3f3", background: pi === 0 ? "#F0FAF0" : "transparent" }}>
              <div style={{ fontSize: 14, fontWeight: pi === 0 ? 700 : 400, color: pi === 0 ? "#27AE60" : "#555", wordBreak: "break-all", marginBottom: 4 }}>
                {pi === 0 && "👑 "}{getPathname(p.url)}
              </div>
              <div style={{ fontSize: 13, color: "#999", display: "flex", gap: 16, flexWrap: "wrap" }}>
                <span>Clicks: <span style={{ color: "#555", fontWeight: 600 }}>{p.clicks}</span></span>
                <span>Impr: <span style={{ color: "#555", fontWeight: 600 }}>{p.impressions.toLocaleString()}</span></span>
                <span>CTR: <span style={{ color: "#555", fontWeight: 600 }}>{p.ctr}%</span></span>
                <span>Pos: <span style={{ color: "#555", fontWeight: 600 }}>{p.position.toFixed(1)}</span></span>
                <span style={{ fontSize: 12, color: "#bbb" }}>{p.section}</span>
              </div>
              <ActionBadge action={p.action} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ───

export default function CanniScope() {
  const [conflicts, setConflicts] = useState(null);
  const [reportText, setReportText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [cleanMsg, setCleanMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const processFiles = (files) => {
    setError(null); setCleanMsg(null); setLoading(true); setCopied(false);
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) { setError("No CSV files found."); setLoading(false); return; }

    let pagesData = null;
    let done = 0;

    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          const name = file.name.toLowerCase();
          if (name.includes("page") || (res.data[0] && res.data[0]["Top pages"])) {
            pagesData = res.data;
          }
          done++;
          if (done === csvFiles.length) {
            if (!pagesData) {
              setError("Couldn't find Pages.csv. Upload files from your GSC export.");
              setLoading(false);
              return;
            }
            const results = analyzePages(pagesData);
            if (results.length === 0) {
              setCleanMsg("No duplicate URL targets found — your site structure looks clean.");
              setLoading(false);
              return;
            }
            setConflicts(results);
            setReportText(generateReportText(results));
            setLoading(false);
          }
        },
        error: () => {
          done++;
          if (done === csvFiles.length) { setError("Failed to parse CSV."); setLoading(false); }
        },
      });
    });
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);
  const downloadReport = () => {
    const blob = new Blob([reportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "canniscope-report.txt"; a.click();
    URL.revokeObjectURL(url);
  };
  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const reset = () => { setConflicts(null); setReportText(""); setError(null); setCleanMsg(null); };

  // ── UPLOAD SCREEN ──
  if (!conflicts) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 540, width: "100%" }}>
            <div style={s.logo}>CanniScope</div>
            <h1 style={s.h1}>Find duplicate URL<br/>targets on your site</h1>
            <p style={s.subtitle}>Upload Pages.csv from your GSC export.<br/>See which URLs target the same service + geo.</p>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => document.getElementById("csv-input").click()}
              style={s.dropzone(dragOver)}
            >
              <div style={{ fontSize: 48, marginBottom: 16 }}>⚔️</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a", marginBottom: 4 }}>
                {loading ? "Analyzing..." : "Select CSV files"}
              </div>
              <div style={{ fontSize: 13, color: "#999" }}>Upload Pages.csv from your GSC export</div>
              <input id="csv-input" type="file" multiple accept=".csv" onChange={onFileSelect} style={{ display: "none" }} />
            </div>
            <button onClick={() => document.getElementById("folder-input").click()} style={s.folderBtn}>
              📂 Or select the entire export folder
            </button>
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />
            {error && <div style={s.error}>{error}</div>}
            {cleanMsg && <div style={s.clean}>{cleanMsg}</div>}
            <div style={s.howTo}>
              <div style={{ fontWeight: 700, color: "#555", marginBottom: 6, fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>How to get the file</div>
              1. Google Search Console → Performance<br/>
              2. Set date range (3–6 months recommended)<br/>
              3. Click Export → Download CSV<br/>
              4. Unzip → upload Pages.csv or the whole folder
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── RESULTS SCREEN ──
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
            {high > 0 ? `${high} high-risk duplicate clusters found` : "Analysis Complete"}
          </h2>
          <p style={{ fontSize: 14, color: "#999", margin: "4px 0 0" }}>
            {conflicts.length} clusters · {totalURLs} URLs with duplicate targets
          </p>
        </div>

        <div style={s.statRow}>
          {[
            { label: "Clusters", val: conflicts.length, color: "#1a1a1a" },
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
          <button onClick={reset} style={s.secBtn}>↻ New</button>
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

        <div style={{ textAlign: "center", padding: "32px 0 16px", fontSize: 12, color: "#ccc", letterSpacing: 1.5, textTransform: "uppercase" }}>
          CanniScope · Duplicate URL Target Detector
        </div>
      </div>
    </div>
  );
}
