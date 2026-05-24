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

      let { risk, score, reasons, confidence, confidenceLabel } = computeSeverity(sorted, sections);

      // ── INTENTIONAL ARCHITECTURE DETECTION ──
      const isLikelyArchitecture =
        geo !== "generic" &&
        sections.length >= 2 &&
        sections.includes("ROOT") &&
        (sections.includes("SERVICE-AREA") || sections.includes("LOCATIONS")) &&
        (getSection(winner.url) === "ROOT" || sections.some(s => s === "SERVICE-AREA" || s === "LOCATIONS"));

      // Architecture overlap → cap confidence, never "High confidence duplicate"
      if (isLikelyArchitecture && confidence === "HIGH") {
        confidence = "MEDIUM";
        confidenceLabel = "Likely duplicate";
      }

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
  h1: { fontSize: 22, fontWeight: 600, margin: "0 0 4px", color: C.text, letterSpacing: "-0.01em" },
  dropzone: (active) => ({
    border: `1.5px dashed ${active ? C.accent : "#d1d5db"}`, borderRadius: 8, padding: "48px 24px",
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

function ActionBadge({ action }) {
  let bg, color, borderColor;
  if (action.startsWith("KEEP")) { bg = C.lowBg; color = C.low; borderColor = C.lowBorder; }
  else if (action.startsWith("Likely safe")) { bg = C.highBg; color = C.high; borderColor = C.highBorder; }
  else if (action.startsWith("Technical")) { bg = C.techBg; color = C.tech; borderColor = C.techBorder; }
  else if (action.startsWith("Review")) { bg = C.medBg; color = C.medium; borderColor = C.medBorder; }
  else if (action.startsWith("Likely already")) { bg = "#f9fafb"; color = C.textTertiary; borderColor = C.borderLight; }
  else { bg = "#f9fafb"; color = C.textSecondary; borderColor = C.border; }
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", background: bg, color, border: `1px solid ${borderColor}`, borderRadius: 4, fontWeight: 500 }}>
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
          <span style={{ fontSize: 12, color: C.textTertiary, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: mono }}>{examples[sec]}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.text, minWidth: 20, textAlign: "right" }}>{count}</span>
          <div style={{ width: 48, height: 3, background: C.borderLight, borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(count / max) * 100}%`, background: SEC_C[sec] || C.textTertiary, borderRadius: 2 }} />
          </div>
        </div>
      ))}
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
            {c.isLikelyArchitecture && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 3, background: C.techBg, color: C.tech, border: `1px solid ${C.techBorder}`, marginRight: 6 }}>architecture</span>}
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
          <WhyFlagged reasons={c.reasons} />
          <div style={{ margin: "0 16px 10px", padding: "10px 14px", background: rs.bg, borderLeft: `3px solid ${rs.color}`, borderRadius: "0 6px 6px 0", fontSize: 13, color: C.textSecondary, lineHeight: 1.6 }}>
            {c.recommendation}
          </div>
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
              {c.pages.map((p, pi) => (
                <tr key={pi} style={{ borderBottom: `1px solid ${C.borderLight}`, background: pi === 0 ? C.lowBg : "transparent" }}>
                  <td style={{ padding: "8px 16px", fontFamily: mono, fontSize: 12, color: pi === 0 ? C.low : C.text, fontWeight: pi === 0 ? 600 : 400, wordBreak: "break-all", maxWidth: 300 }}>
                    {pi === 0 && "👑 "}{getPathname(p.url)}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", fontWeight: 600, fontFamily: mono }}>{p.clicks}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: mono }}>{p.impressions.toLocaleString()}</td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: mono }}>{p.position.toFixed(1)}</td>
                  <td style={{ padding: "8px 16px" }}><ActionBadge action={p.action} /></td>
                </tr>
              ))}
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

  const processFiles = (files) => {
    setError(null); setCleanMsg(null); setLoading(true); setCopied(false);
    const csvFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith(".csv"));
    if (csvFiles.length === 0) { setError("No CSV files found."); setLoading(false); return; }
    let pagesData = null; let done = 0;
    csvFiles.forEach(file => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true,
        complete: (res) => {
          const name = file.name.toLowerCase();
          if (name.includes("page") || (res.data[0] && res.data[0]["Top pages"])) pagesData = res.data;
          done++;
          if (done === csvFiles.length) {
            if (!pagesData) { setError("Couldn't find Pages.csv. Upload files from your GSC export."); setLoading(false); return; }
            const { conflicts: results, ignoredCounts: ignored, totalPages: tp } = analyzePages(pagesData);
            setIgnoredCounts(ignored); setTotalPages(tp);
            if (results.length === 0) { setCleanMsg("No duplicate URL targets found — site structure looks clean."); setLoading(false); return; }
            setConflicts(results); setReportText(generateReportText(results)); setLoading(false);
          }
        },
        error: () => { done++; if (done === csvFiles.length) { setError("Failed to parse CSV."); setLoading(false); } },
      });
    });
  };

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); processFiles(e.dataTransfer.files); };
  const onFileSelect = (e) => processFiles(e.target.files);
  const downloadReport = () => { const b = new Blob([reportText], { type: "text/plain;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-report.txt"; a.click(); URL.revokeObjectURL(u); };
  const downloadCSV = () => { const csv = generateCSV(conflicts); const b = new Blob([csv], { type: "text/csv;charset=utf-8" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = "canniscope-export.csv"; a.click(); URL.revokeObjectURL(u); };
  const copyReport = () => { navigator.clipboard.writeText(reportText); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const reset = () => { setConflicts(null); setReportText(""); setError(null); setCleanMsg(null); setIgnoredCounts(null); setTotalPages(0); setConfFilter("all"); };

  if (!conflicts) {
    return (
      <div style={s.page}>
        <div style={{ ...s.container, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
          <div style={{ textAlign: "center", maxWidth: 480, width: "100%" }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: C.text, marginBottom: 4 }}>CanniScope</div>
            <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 28 }}>Duplicate URL Target Detector</div>
            <h1 style={{ fontSize: 28, fontWeight: 600, color: C.text, lineHeight: 1.2, letterSpacing: "-0.02em", marginBottom: 8 }}>Find duplicate URL targets on your site</h1>
            <p style={{ fontSize: 14, color: C.textSecondary, marginBottom: 32, lineHeight: 1.6 }}>Upload Pages.csv from Google Search Console. Surface structural conflicts, service-area overlaps, and trailing slash issues.</p>
            <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop} onClick={() => document.getElementById("csv-input").click()} style={s.dropzone(dragOver)}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>📄</div>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.text, marginBottom: 4 }}>{loading ? "Analyzing..." : "Drop CSV files here"}</div>
              <div style={{ fontSize: 12, color: C.textTertiary }}>or click to browse</div>
              <input id="csv-input" type="file" multiple accept=".csv" onChange={onFileSelect} style={{ display: "none" }} />
            </div>
            <button onClick={() => document.getElementById("folder-input").click()} style={{ ...s.btn(false), width: "100%", justifyContent: "center", marginTop: 8 }}>Select entire export folder</button>
            <input id="folder-input" type="file" webkitdirectory="" directory="" onChange={onFileSelect} style={{ display: "none" }} />
            {error && <div style={{ marginTop: 16, padding: "10px 14px", background: C.highBg, border: `1px solid ${C.highBorder}`, borderRadius: 6, fontSize: 13, color: C.high }}>{error}</div>}
            {cleanMsg && <div style={{ marginTop: 16, padding: "10px 14px", background: C.lowBg, border: `1px solid ${C.lowBorder}`, borderRadius: 6, fontSize: 13, color: C.low }}>{cleanMsg}</div>}
            <div style={{ marginTop: 24, padding: "14px 18px", background: C.surface, borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 13, color: C.textSecondary, lineHeight: 1.8, textAlign: "left" }}>
              <div style={{ fontWeight: 600, color: C.text, marginBottom: 4, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>How to get the file</div>
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

  const seo = conflicts.filter(c => !c.isTechnical);
  const tech = conflicts.filter(c => c.isTechnical);
  const high = seo.filter(c => c.risk === "HIGH").length;
  const medium = seo.filter(c => c.risk === "MEDIUM").length;
  const low = seo.filter(c => c.risk === "LOW").length;
  const totalURLs = new Set(conflicts.flatMap(c => c.pages.map(p => p.url))).size;

  const filterFn = (c) => confFilter === "all" ? true : confFilter === "HIGH" ? c.confidence === "HIGH" : (c.confidence === "HIGH" || c.confidence === "MEDIUM");
  const filteredSeo = seo.filter(filterFn);
  const fHigh = filteredSeo.filter(c => c.risk === "HIGH");
  const fMed = filteredSeo.filter(c => c.risk === "MEDIUM");
  const fLow = filteredSeo.filter(c => c.risk === "LOW");

  const topActions = seo.filter(c => c.confidence === "HIGH" && c.risk === "HIGH").sort((a, b) => b.score - a.score).slice(0, 5);

  return (
    <div style={s.page}>
      <div style={s.container}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.text }}>CanniScope</div>
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
          {seo.length} SEO · {tech.length} technical · {totalURLs} URLs involved
        </p>

        <div style={{ padding: "8px 12px", background: C.medBg, border: `1px solid ${C.medBorder}`, borderRadius: 6, marginBottom: 16, fontSize: 12, color: C.medium }}>
          Experimental beta — may produce false positives. Always review manually before making redirects.
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <StatCard value={seo.length} label="SEO clusters" />
          <StatCard value={high} label="High risk" color={C.high} />
          <StatCard value={medium} label="Medium risk" color={C.medium} />
          <StatCard value={tech.length} label="Technical" color={C.tech} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
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
              {ignoredCounts.noServiceTerm > 0 && <div>• <span style={{ fontWeight: 600 }}>{ignoredCounts.noServiceTerm}</span> non-service pages skipped</div>}
            </div>
          </div>
        )}

        <div style={{ textAlign: "center", padding: "24px 0 8px", fontSize: 11, color: C.textTertiary }}>
          CanniScope · Experimental Beta
        </div>
      </div>
    </div>
  );
}
