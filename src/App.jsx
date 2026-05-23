import { useState } from "react";
import Papa from "papaparse";

// ─── INTENT FILTERS ───
// These words signal a DIFFERENT intent — never group with plain service pages.
// All matching is done via slug token (word) boundaries, not substring.

const BRAND_TOKENS = new Set([
  "sub-zero","subzero","lg","samsung","whirlpool","ge","thermador","viking",
  "wolf","bosch","kitchenaid","maytag","frigidaire","kenmore","amana","electrolux",
  "miele","speed-queen","jenn-air","jennair","dacor","fisher-paykel","haier","hisense",
]);

// Symptom tokens: multi-word patterns matched as token sequences
const SYMPTOM_PATTERNS = [
  "not-cooling","not-heating","not-spinning","not-making-ice","not-draining",
  "not-drying","not-dispensing","not-filling","not-working",
  "wont-drain","wont-start","wont-turn-on","wont-turn-off","wont-close",
  "wont-open","wont-light","wont-ignite","wont-heat",
  "won-t-drain","won-t-start","won-t-turn-on","won-t-turn-off","won-t-close",
  "won-t-open","won-t-light","won-t-ignite","won-t-heat",
  "takes-too-long","ice-buildup","burning-smell","tripping-breaker","error-code",
];
const SYMPTOM_SINGLE = new Set([
  "leaking","noisy","loud","vibrating","shaking","overheating",
  "smoking","beeping","flashing","frost",
]);

// Modifier tokens: matched as whole words
const MODIFIER_TOKENS = new Set([
  "cost","price","pricing","best","cheap","cheapest","free","near-me",
  "same-day","emergency","affordable","rated","reviews","review",
  "how-much","estimate","quote","warranty","certified","licensed",
]);

// Content tokens: matched as whole words
const CONTENT_TOKENS = new Set([
  "guide","tips","vs","versus","comparison","how-to","diy","troubleshoot",
  "troubleshooting","signs","when-to","should-i","replacement",
  "maintenance","checklist","faq","common-problems","lifespan",
  "statistics","stats","history","recall","recalls",
]);

// Informational / non-service pages — never group
const INFORMATIONAL_TOKENS = new Set([
  "about","contact","careers","become","join","team","hiring","apply",
  "privacy","terms","sitemap","login","signup","register","account",
  "blog","news","press","media","testimonials","portfolio","gallery",
]);

// Safe state abbreviations for trailing stripping.
// Excluded: common English words (in, me, or, hi, al, de, la, ma, pa, id, oh, ok)
const SAFE_STATES = new Set([
  "ak","az","ar","ca","co","ct","fl","ga","ia","il",
  "ks","ky","md","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy","dc",
]);

// ─── TOKEN MATCHING HELPERS ───

function slugContainsPattern(slug, pattern) {
  // Check if slug contains the exact multi-word pattern at token boundaries.
  // "not-cooling" in "refrigerator-not-cooling-repair" → true
  // "not" in "knot-repair" → false (checked separately as single token)
  return slug === pattern ||
    slug.startsWith(pattern + "-") ||
    slug.endsWith("-" + pattern) ||
    slug.includes("-" + pattern + "-");
}

function slugHasToken(slug, token) {
  // For single-word tokens, match at hyphen boundaries.
  if (token.includes("-")) return slugContainsPattern(slug, token);
  const words = slug.split("-");
  return words.includes(token);
}

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
  try {
    let path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "").replace(/^\//, "");
    const section = getSection(url);
    const parts = path.split("/").filter(Boolean);

    if (["service-area","locations","services","category","blog"].includes(parts[0])) {
      parts.shift();
    }
    if (section === "LOCATIONS" && parts.length > 1) {
      parts.shift();
    }

    const slug = parts[parts.length - 1] || "";
    if (!slug || slug.length < 3) return null;

    const slugWords = slug.split("-");

    // ── INFORMATIONAL PAGE? ──
    // If the first meaningful word is informational, skip entirely
    if (INFORMATIONAL_TOKENS.has(slugWords[0])) return null;

    // ── CHECK INTENT (token-boundary matching) ──

    // Brand: single tokens + multi-word brands
    for (const w of slugWords) {
      if (BRAND_TOKENS.has(w)) return { slug, section, intent: "brand" };
    }
    for (const brand of BRAND_TOKENS) {
      if (brand.includes("-") && slugContainsPattern(slug, brand)) {
        return { slug, section, intent: "brand" };
      }
    }

    // Symptom: multi-word patterns first, then single tokens
    for (const pattern of SYMPTOM_PATTERNS) {
      if (slugContainsPattern(slug, pattern)) return { slug, section, intent: "symptom" };
    }
    for (const token of SYMPTOM_SINGLE) {
      if (slugHasToken(slug, token)) return { slug, section, intent: "symptom" };
    }

    // Modifier: whole-word matching
    for (const token of MODIFIER_TOKENS) {
      if (slugHasToken(slug, token)) return { slug, section, intent: "modifier" };
    }

    // Content: whole-word matching
    for (const token of CONTENT_TOKENS) {
      if (slugHasToken(slug, token)) return { slug, section, intent: "content" };
    }

    // ── EXTRACT SERVICE + GEO ──
    let normalized = slug
      .replace(/-in-/g, "-")
      .replace(/^in-/, "")
      .replace(/-in$/, "");

    // Strip trailing state abbreviation (safe list only)
    const lastWord = normalized.split("-").pop();
    if (lastWord && SAFE_STATES.has(lastWord)) {
      normalized = normalized.replace(new RegExp(`-${lastWord}$`), "");
    }

    const serviceTerms = ["repair","installation","install","service","replacement","cleaning"];
    const nWords = normalized.split("-");
    let serviceEnd = -1;

    for (let i = 0; i < nWords.length; i++) {
      if (serviceTerms.includes(nWords[i])) {
        serviceEnd = i;
        break;
      }
    }

    // ── FIX #1: No service term → not groupable ──
    if (serviceEnd < 0) return null;

    const service = nWords.slice(0, serviceEnd + 1).join("-");
    const geoRaw = nWords.slice(serviceEnd + 1).filter(w => w.length > 0).join("-") || null;

    const cleanService = service.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
    const geo = geoRaw ? geoRaw.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") : null;
    if (!cleanService || cleanService.length < 3) return null;

    return { service: cleanService, geo, section, intent: "service", slug };
  } catch {
    return null;
  }
}

// ─── TRAILING SLASH DETECTION ───

function findTrailingSlashDupes(pagesData) {
  const pages = pagesData.map(row => ({
    url: (row["Top pages"] || "").trim(),
    clicks: parseInt(row["Clicks"]) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g, "")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%", "")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url);

  // Build map: normalized URL (no trailing slash) → list of actual URLs
  const map = {};
  pages.forEach(p => {
    try {
      const u = new URL(p.url);
      const key = u.origin + u.pathname.replace(/\/+$/, "") + u.search;
      if (!map[key]) map[key] = [];
      map[key].push(p);
    } catch {}
  });

  const dupes = [];
  Object.values(map).forEach(group => {
    if (group.length < 2) return;
    // Check that they truly differ only by trailing slash
    const pathnames = group.map(p => getPathname(p.url));
    const stripped = pathnames.map(p => p.replace(/\/+$/, ""));
    if (new Set(stripped).size !== 1) return; // differ by more than slash

    const sorted = [...group].sort(
      (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position
    );
    const winner = sorted[0];
    const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
    const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
    const winnerPath = getPathname(winner.url);

    // Slug for label
    const slugRaw = winnerPath.replace(/^\//, "").replace(/\/+$/, "").split("/").pop() || winnerPath;
    const label = slugRaw.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) + " — Trailing Slash";

    const pageActions = sorted.map((p, i) => ({
      ...p,
      section: getSection(p.url),
      action: i === 0
        ? "KEEP — canonical URL"
        : "Technical fix: set server redirect or canonical tag",
    }));

    dupes.push({
      label,
      service: slugRaw,
      geo: "trailing-slash",
      pages: pageActions,
      pageCount: sorted.length,
      totalClicks,
      totalImpressions,
      sections: [...new Set(pageActions.map(p => p.section))],
      winner,
      risk: "LOW",
      score: 10,
      reasons: ["Trailing slash duplicate — same content, different URL format"],
      recommendation:
        `Technical duplicate: ${winnerPath} exists with and without trailing slash. ` +
        `Fix in server config (301 redirect) or set rel=canonical. Not an SEO intent conflict.`,
      isTechnical: true,
    });
  });

  return dupes;
}

// ─── SEVERITY SCORING ───

function computeSeverity(sorted, sections) {
  let score = 0;
  const reasons = [];

  if (sections.length >= 2) {
    score += 40;
    reasons.push(`Same target across ${sections.join(" + ")}`);
  }

  const withClicks = sorted.filter(p => p.clicks > 0);
  if (withClicks.length >= 2) {
    score += 25;
    reasons.push(`${withClicks.length} URLs getting clicks (split traffic)`);
  }

  if (sorted.length >= 2) {
    const positions = sorted.map(p => p.position).filter(p => p > 0 && p <= 50);
    if (positions.length >= 2) {
      const diff = Math.abs(positions[0] - positions[1]);
      if (diff <= 5) {
        score += 20;
        reasons.push(`Close positions (${positions[0].toFixed(1)} vs ${positions[1].toFixed(1)})`);
      } else if (diff <= 15) {
        score += 10;
        reasons.push(`Competing positions (${positions[0].toFixed(1)} vs ${positions[1].toFixed(1)})`);
      }
    }
  }

  const totalImpr = sorted.reduce((s, p) => s + p.impressions, 0);
  if (totalImpr >= 2000) {
    score += 15;
    reasons.push(`High volume (${totalImpr.toLocaleString()} total impressions)`);
  } else if (totalImpr >= 500) {
    score += 8;
    reasons.push(`Moderate volume (${totalImpr.toLocaleString()} impressions)`);
  }

  if (sorted.length >= 3) {
    score += 10;
    reasons.push(`${sorted.length} URLs fragmenting authority`);
  }

  let risk;
  if (score >= 45) risk = "HIGH";
  else if (score >= 25) risk = "MEDIUM";
  else risk = "LOW";

  // Confidence: how sure are we this is real cannibalization vs architecture
  let confidence;
  const withClicks2 = sorted.filter(p => p.clicks > 0).length;
  if (withClicks2 >= 2 && sections.length >= 2) confidence = "HIGH";
  else if (withClicks2 >= 2 || (sections.length >= 2 && totalImpr >= 500)) confidence = "HIGH";
  else if (sections.length >= 2 || totalImpr >= 200) confidence = "MEDIUM";
  else confidence = "LOW";

  // Confidence label for display
  let confidenceLabel;
  if (confidence === "HIGH") confidenceLabel = "High confidence duplicate";
  else if (confidence === "MEDIUM") confidenceLabel = "Likely duplicate";
  else confidenceLabel = "Possible overlap";

  return { risk, score, reasons, confidence, confidenceLabel };
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

  // Track ignored intents for "Why NOT flagged" summary
  const ignoredCounts = { brand: 0, symptom: 0, modifier: 0, content: 0, informational: 0, noServiceTerm: 0 };

  const classified = pages.map(p => {
    const c = classifyURL(p.url);
    if (!c) { ignoredCounts.noServiceTerm++; return null; }
    if (c.intent === "brand") { ignoredCounts.brand++; return null; }
    if (c.intent === "symptom") { ignoredCounts.symptom++; return null; }
    if (c.intent === "modifier") { ignoredCounts.modifier++; return null; }
    if (c.intent === "content") { ignoredCounts.content++; return null; }
    return { ...p, ...c };
  }).filter(Boolean);

  const groups = {};
  classified.forEach(p => {
    const key = `${p.service}|${p.geo || "generic"}`;
    if (!groups[key]) groups[key] = [];
    if (!groups[key].find(x => x.url === p.url)) {
      groups[key].push(p);
    }
  });

  // Collect URLs already in SEO conflicts (to avoid double-counting with trailing slash)
  const seoConflictURLs = new Set();

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

      const serviceName = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const geoName = geo === "generic"
        ? "Generic"
        : geo.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const label = `${serviceName} — ${geoName}`;

      const { risk, score, reasons, confidence, confidenceLabel } = computeSeverity(sorted, sections);

      // ── INTENTIONAL ARCHITECTURE DETECTION ──
      const isLikelyArchitecture =
        geo !== "generic" &&
        sections.length >= 2 &&
        sections.includes("ROOT") &&
        (sections.includes("SERVICE-AREA") || sections.includes("LOCATIONS")) &&
        (getSection(winner.url) === "ROOT" || sections.some(s => s === "SERVICE-AREA" || s === "LOCATIONS"));

      const winnerPath = getPathname(winner.url);

      let recommendation;
      if (isLikelyArchitecture) {
        recommendation =
          `Likely intentional multi-location architecture. ` +
          `${winnerPath} (ROOT) and geo landing pages in ${sections.filter(s => s !== "ROOT").join(" + ")} ` +
          `often serve different purposes in local SEO. Review manually — ` +
          `if both pages have unique content and different user intents, no action needed.`;
        reasons.push("⚠ Possibly intentional architecture (ROOT + geo section)");
      } else if (confidence === "HIGH" && sections.length >= 2) {
        recommendation =
          `High confidence: ${sorted.length} pages target the same service+geo across ${sections.join(" + ")}. ` +
          `Winner by GSC data: ${winnerPath}. Likely safe to consolidate — ` +
          `verify content overlap before redirecting.`;
      } else if (sections.length >= 2) {
        recommendation =
          `Possible duplicate target across ${sections.join(" + ")}. ` +
          `Winner by GSC data: ${winnerPath}. Review whether pages serve ` +
          `different intents before consolidating.`;
      } else if (confidence === "HIGH") {
        recommendation =
          `${sorted.length} URL variants with the same target in ${sections[0]}. ` +
          `Winner by GSC data: ${winnerPath}. ` +
          `Likely safe to consolidate with 301 or canonical.`;
      } else {
        recommendation =
          `${sorted.length} URL variants with similar targets in ${sections[0]}. ` +
          `Winner by GSC data: ${winnerPath}. ` +
          `Review manually — may be duplicate or intentional variation.`;
      }

      const pageActions = sorted.map((p, i) => {
        if (i === 0) return { ...p, action: "KEEP — winner by GSC data" };

        // De-prioritized: 0 clicks, tiny impressions, bad position → Google already ignoring it
        const isDePrioritized =
          p.clicks === 0 &&
          p.impressions <= 10 &&
          p.position > 30;
        if (isDePrioritized) {
          return { ...p, action: "Likely already de-prioritized by Google — low urgency" };
        }

        if (isLikelyArchitecture && p.section !== winner.section) {
          return { ...p, action: "Review — may be intentional geo architecture" };
        }

        // Only say "likely safe to redirect" with high confidence
        if (confidence === "HIGH") {
          if (p.clicks === 0 && p.impressions < winner.impressions * 0.3) {
            return { ...p, action: "Likely safe to 301 redirect to winner" };
          }
          if (p.section !== winner.section) {
            return { ...p, action: "Check if 301/canonical exists → likely safe to consolidate" };
          }
          return { ...p, action: "Likely safe to 301 redirect (same section duplicate)" };
        }

        // Medium/low confidence → always review
        if (p.section !== winner.section) {
          return { ...p, action: "Review — possible duplicate across sections" };
        }
        return { ...p, action: "Review — possible same-section duplicate" };
      });

      sorted.forEach(p => seoConflictURLs.add(p.url));

      return {
        label, service, geo, pages: pageActions, pageCount: sorted.length,
        totalClicks, totalImpressions, sections, winner, risk, score, reasons, recommendation,
        confidence, confidenceLabel, isLikelyArchitecture,
        isTechnical: false,
      };
    })
    .sort((a, b) => {
      const ro = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (ro[a.risk] !== ro[b.risk]) return ro[a.risk] - ro[b.risk];
      return b.score - a.score;
    });

  // Find trailing-slash dupes (exclude URLs already in SEO conflicts)
  const trailingSlashDupes = findTrailingSlashDupes(pagesData)
    .filter(d => !d.pages.some(p => seoConflictURLs.has(p.url)));

  return { conflicts: [...conflicts, ...trailingSlashDupes], ignoredCounts, totalPages: pages.length };
}

// ─── REPORT TEXT ───

function generateReportText(conflicts) {
  let r = "";
  r += "=================================================\n";
  r += "  CANNISCOPE — Duplicate URL Targets Report\n";
  r += "=================================================\n\n";

  const seo = conflicts.filter(c => !c.isTechnical);
  const tech = conflicts.filter(c => c.isTechnical);

  const high = seo.filter(c => c.risk === "HIGH").length;
  const medium = seo.filter(c => c.risk === "MEDIUM").length;
  const low = seo.filter(c => c.risk === "LOW").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;

  r += `Summary:\n`;
  r += `  SEO duplicate clusters: ${seo.length}\n`;
  r += `  Technical duplicates: ${tech.length}\n`;
  r += `  URLs involved: ${totalURLs}\n`;
  r += `  HIGH: ${high} | MEDIUM: ${medium} | LOW: ${low}\n\n`;

  const buckets = [
    { label: "HIGH RISK — FIX FIRST", filter: c => !c.isTechnical && c.risk === "HIGH" },
    { label: "MEDIUM RISK — CHECK", filter: c => !c.isTechnical && c.risk === "MEDIUM" },
    { label: "LOW RISK — MONITOR", filter: c => !c.isTechnical && c.risk === "LOW" },
    { label: "TECHNICAL DUPLICATES", filter: c => c.isTechnical },
  ];

  buckets.forEach(sec => {
    const items = conflicts.filter(sec.filter);
    if (items.length === 0) return;
    r += `=== ${sec.label} ===\n\n`;
    items.forEach((c, idx) => {
      r += `#${idx + 1}: ${c.label}\n`;
      r += `${c.sections.join(" + ")} · ${c.pageCount} URLs · ${c.totalClicks} clicks · ${c.totalImpressions.toLocaleString()} impr · Severity: ${c.score} · ${c.confidenceLabel || "—"}\n\n`;
      r += `Why flagged:\n`;
      c.reasons.forEach(reason => { r += `  • ${reason}\n`; });
      r += `\n${c.recommendation}\n\n`;
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

// ─── CSV EXPORT ───

function generateCSV(conflicts) {
  const rows = [["Cluster","Type","Risk","Confidence","Score","Service","Geo","Sections","URL","Clicks","Impressions","CTR","Position","Section","Action","Why Flagged"]];
  conflicts.forEach(c => {
    const whyFlagged = c.reasons.join("; ");
    const type = c.isTechnical ? "Technical" : c.isLikelyArchitecture ? "Architecture" : "SEO";
    c.pages.forEach(p => {
      rows.push([
        c.label, type, c.risk, c.confidence || "—", c.score, c.service, c.geo || "generic",
        c.sections.join(" + "), p.url, p.clicks, p.impressions,
        p.ctr + "%", p.position.toFixed(1), p.section, p.action, whyFlagged,
      ]);
    });
  });
  return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
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
    color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: font, minWidth: 120,
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
  let bg, color;
  if (action.startsWith("KEEP")) {
    bg = "#E8F5E9"; color = "#2E7D32";
  } else if (action.startsWith("Likely safe")) {
    bg = "#FFF3E0"; color = "#E65100";
  } else if (action.startsWith("Technical")) {
    bg = "#E3F2FD"; color = "#1565C0";
  } else if (action.startsWith("Review")) {
    bg = "#F3E5F5"; color = "#7B1FA2";
  } else if (action.startsWith("Likely already")) {
    bg = "#F5F5F5"; color = "#9E9E9E";
  } else {
    bg = "#FFF8E1"; color = "#F57F17";
  }
  return (
    <div style={{ marginTop: 4, fontSize: 12, padding: "3px 8px", background: bg, color, borderRadius: 4, display: "inline-block", fontWeight: 600 }}>
      → {action}
    </div>
  );
}

function WhyFlagged({ reasons }) {
  return (
    <div style={{ margin: "0 20px 10px", padding: "10px 14px", background: "#F8F8F6", borderRadius: 8, fontSize: 13 }}>
      <div style={{ fontWeight: 700, color: "#999", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Why flagged</div>
      {reasons.map((r, i) => (
        <div key={i} style={{ color: "#666", lineHeight: 1.6 }}>• {r}</div>
      ))}
    </div>
  );
}

function ConflictCard({ conflict: c }) {
  const [open, setOpen] = useState(false);
  const rc = c.isTechnical ? "#1565C0" : c.risk === "HIGH" ? "#E03E2D" : c.risk === "MEDIUM" ? "#E67E22" : "#27AE60";
  const badge = c.isTechnical ? "TECH" : c.risk;
  const confColor = c.confidence === "HIGH" ? "#E03E2D" : c.confidence === "MEDIUM" ? "#E67E22" : "#999";

  return (
    <div style={s.card(open, rc)}>
      <div onClick={() => setOpen(!open)} style={{ padding: "16px 20px", cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ padding: "3px 10px", borderRadius: 20, background: rc + "14", color: rc, fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{badge}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginBottom: 2 }}>
            {c.isLikelyArchitecture && "🏗 "}{c.label}
          </div>
          <div style={{ fontSize: 13, color: "#999" }}>
            {c.sections.join(" + ")} · {c.pageCount} URLs · {c.totalClicks} clicks · {c.totalImpressions.toLocaleString()} impr
          </div>
        </div>
        {c.confidenceLabel && <span style={{ fontSize: 10, fontWeight: 700, color: confColor, letterSpacing: 0.5, flexShrink: 0 }}>{c.confidenceLabel}</span>}
        <span style={{ color: "#bbb", fontSize: 12, fontWeight: 600, marginRight: 4 }}>{c.score}</span>
        <span style={{ color: "#ccc", fontSize: 14, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>▸</span>
      </div>
      {open && (
        <div>
          <WhyFlagged reasons={c.reasons} />
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
  const [ignoredCounts, setIgnoredCounts] = useState(null);
  const [totalPages, setTotalPages] = useState(0);
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
            const { conflicts: results, ignoredCounts: ignored, totalPages: tp } = analyzePages(pagesData);
            setIgnoredCounts(ignored);
            setTotalPages(tp);
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

  const downloadCSV = () => {
    const csv = generateCSV(conflicts);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "canniscope-export.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const reset = () => { setConflicts(null); setReportText(""); setError(null); setCleanMsg(null); setIgnoredCounts(null); setTotalPages(0); };

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
  const seo = conflicts.filter(c => !c.isTechnical);
  const tech = conflicts.filter(c => c.isTechnical);
  const high = seo.filter(c => c.risk === "HIGH").length;
  const medium = seo.filter(c => c.risk === "MEDIUM").length;
  const low = seo.filter(c => c.risk === "LOW").length;
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
            {seo.length} SEO clusters · {tech.length} technical · {totalURLs} URLs
          </p>
        </div>

        <div style={{ padding: "10px 16px", background: "#FFF8E1", border: "1px solid #FFE082", borderRadius: 8, marginBottom: 20, fontSize: 13, color: "#F57F17", lineHeight: 1.5 }}>
          <span style={{ fontWeight: 700 }}>Experimental beta</span> — may produce false positives. Always review manually before making redirects.
        </div>

        <div style={s.statRow}>
          {[
            { label: "SEO", val: seo.length, color: "#1a1a1a" },
            { label: "Technical", val: tech.length, color: "#1565C0" },
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
          <button onClick={downloadReport} style={s.primaryBtn}>📥 Report</button>
          <button onClick={downloadCSV} style={s.primaryBtn}>📊 CSV</button>
          <button onClick={copyReport} style={s.secBtn}>{copied ? "✓ Copied!" : "📋 Copy"}</button>
          <button onClick={reset} style={s.secBtn}>↻ New</button>
        </div>

        {high > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E03E2D")}>🔴 High Risk — Fix First</div>
            {seo.filter(c => c.risk === "HIGH").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {medium > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#E67E22")}>🟡 Medium Risk — Check</div>
            {seo.filter(c => c.risk === "MEDIUM").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {low > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#27AE60")}>🟢 Low Risk — Monitor</div>
            {seo.filter(c => c.risk === "LOW").map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}
        {tech.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            <div style={s.sectionTitle("#1565C0")}>🔧 Technical Duplicates</div>
            {tech.map((c, i) => <ConflictCard key={i} conflict={c} />)}
          </div>
        )}

        {ignoredCounts && (
          <div style={{ marginBottom: 32, padding: "20px 24px", background: "#fff", borderRadius: 12, border: "1px solid #eee" }}>
            <div style={{ fontWeight: 700, color: "#999", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Why NOT flagged</div>
            <div style={{ fontSize: 13, color: "#777", lineHeight: 1.8 }}>
              {totalPages > 0 && <div>Analyzed <span style={{ color: "#1a1a1a", fontWeight: 600 }}>{totalPages}</span> pages total</div>}
              {ignoredCounts.brand > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.brand}</span> brand-specific pages skipped (different intent)</div>}
              {ignoredCounts.symptom > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.symptom}</span> symptom/troubleshooting pages skipped</div>}
              {ignoredCounts.modifier > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.modifier}</span> modifier pages skipped (cost, best, near-me, etc.)</div>}
              {ignoredCounts.content > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.content}</span> content/informational pages skipped (guides, tips, FAQ, etc.)</div>}
              {ignoredCounts.noServiceTerm > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.noServiceTerm}</span> non-service pages skipped (about, contact, blog, etc.)</div>}
              <div style={{ marginTop: 8, fontSize: 12, color: "#bbb" }}>These pages have different search intent and are not considered duplicate targets.</div>
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", padding: "32px 0 16px", fontSize: 12, color: "#ccc", letterSpacing: 1.5, textTransform: "uppercase" }}>
          CanniScope · Experimental Beta
        </div>
      </div>
    </div>
  );
}
