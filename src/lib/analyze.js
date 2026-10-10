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

// Locale prefixes for multilingual sites (/blog/ja/slug, /de/slug …).
// Same slug in different languages = hreflang variants, NOT cannibalization.
// Allowlist of real language codes only — so short slugs like "ai"/"os"/"vs" are never mistaken for a locale.
const LOCALE_CODES = new Set([
  "en","de","ja","fr","zh","zh-cn","zh-hant","ko","es","it","pl","pt","pt-br",
  "sv","nl","tr","th","id","fi","da","cs","ar","ro","hu","el","uk","ua","ru",
  "nn","no","nb","vi","vn","he","il","sk","bg","hr","sr","sl","lt","lv","et",
  "fa","hi","ms","ca","gl","eu","is","ga","mt","sq","mk","az","ka","hy","kk",
]);

// Safe state abbreviations for trailing stripping.
// Excluded: common English words (in, me, or, hi, al, de, la, ma, pa, id, oh, ok)
const SAFE_STATES = new Set([
  "ak","az","ar","ca","co","ct","fl","ga","ia","il",
  "ks","ky","md","mi","mn","ms","mo","mt","ne","nv","nh","nj",
  "nm","ny","nc","nd","ri","sc","sd","tn","tx","ut","vt",
  "va","wa","wv","wi","wy","dc",
]);

// Full list for folders only: a folder named exactly "in" or "oh" is a state, not a word.
const US_STATES = new Set(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc").split(" "));
const US_STATE_NAMES = new Set(("alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new-hampshire new-jersey new-mexico new-york north-carolina north-dakota ohio oklahoma oregon pennsylvania rhode-island south-carolina south-dakota tennessee texas utah vermont virginia washington west-virginia wisconsin wyoming").split(" "));

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

    // ── LOCALE PREFIX (multilingual sites) ──
    // e.g. /blog/ja/mac-disk-repair-software → locale "ja". Keep it so language
    // variants of the SAME slug are never grouped as cannibalization (hreflang pairs).
    let locale = "en";
    // Under /locations/ and /service-area/ "ga" is Georgia, not Irish.
    const inGeoSection = section === "LOCATIONS" || section === "SERVICE-AREA";
    if (parts.length > 1 && LOCALE_CODES.has(parts[0]) && !(inGeoSection && US_STATES.has(parts[0]))) {
      locale = parts.shift();
    }

    // ── GEO FROM FOLDERS ──
    // /locations/ga/atlanta/appliance-repair/ names the city in a folder, not in the slug.
    // Read folders as geo only where they are clearly places: a location section,
    // or a path that has a state-code folder. Plain category folders stay out.
    const folders = parts.slice(0, -1);
    const folderState = folders.find(f => US_STATES.has(f)) || null;
    const folderGeoOk = inGeoSection || !!folderState;
    const folderCity = folderGeoOk
      ? [...folders].reverse().find(f => !US_STATES.has(f) && !US_STATE_NAMES.has(f)) || null
      : null;

    const slug = parts[parts.length - 1] || "";
    if (!slug || slug.length < 3) return null;

    const slugWords = slug.split("-");

    // ── INFORMATIONAL PAGE? ──
    // If the first meaningful word is informational, skip entirely
    if (INFORMATIONAL_TOKENS.has(slugWords[0])) return { slug, section, intent: "informational" };

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

    // Strip trailing state abbreviation (safe list only), but remember it:
    // "dallas-ga" and "dallas" may be two different cities.
    let state = null;
    const lastWord = normalized.split("-").pop();
    if (lastWord && SAFE_STATES.has(lastWord)) {
      normalized = normalized.replace(new RegExp(`-${lastWord}$`), "");
      state = lastWord;
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
    let geo = geoRaw ? geoRaw.replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-") : null;
    if (!cleanService || cleanService.length < 3) return null;

    // The slug wins; folders only fill what the slug left out.
    // A state folder belongs to the folder city, not to a city named in the slug.
    if (!geo && folderCity) {
      geo = folderCity;
      if (!state && folderState) state = folderState;
    }

    // "miami-city" is usually the same target as "miami". Group them, but flag
    // the match as loose so it never produces an automatic redirect.
    let geoLoose = false;
    if (geo && /-city$/.test(geo)) {
      geo = geo.replace(/-city$/, "");
      geoLoose = true;
    }

    return { service: cleanService, geo, state, geoLoose, section, intent: "service", slug, locale };
  } catch {
    return null;
  }
}

// ─── TRAILING SLASH DETECTION ───

function findTrailingSlashDupes(pages) {
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
      action: i === 0 ? "KEEP" : "REDIRECT",
    }));

    const splitPct = totalImpressions > 0
      ? Math.round(((totalImpressions - winner.impressions) / totalImpressions) * 100)
      : 0;

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
      loser: sorted[1] || null,
      actionType: "REDIRECT",
      suggestedAction: "301 redirect or rel=canonical to the slash-normalized URL (server config)",
      recShort: "Same content, different URL format",
      recLong: `Technical duplicate: ${winnerPath} exists with and without a trailing slash. Fix in server config (301) or set rel=canonical. Not an SEO intent conflict.`,
      splitPct,
      splitStrength: "Technical duplicate",
      splitEmoji: "⚙️",
      impact: "Low",
      impactReason: "Trailing-slash duplicate — minor technical cleanup",
      positionConflict: false,
      risk: "LOW",
      score: 10,
      reasons: ["Trailing slash duplicate — same content, different URL format"],
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

// Group service pages by locale + service + geo, then split by state:
// "dallas-ga" and "dallas-tx" never share a cluster. A page with no state joins
// a stated group only when that group is the only one, and the cluster is
// marked ambiguous so it is never auto-redirected.
function groupServicePages(classified) {
  const raw = {};
  classified.forEach(p => {
    // Include locale in the key so same-slug pages in different languages
    // (hreflang variants) are never merged into one cannibalization cluster.
    const key = `${p.locale || "en"}|${p.service}|${p.geo || "generic"}`;
    if (!raw[key]) raw[key] = [];
    if (!raw[key].find(x => x.url === p.url)) raw[key].push(p);
  });

  const groups = {};
  const flags = {};
  Object.entries(raw).forEach(([key, ps]) => {
    const byState = {};
    const stateless = [];
    ps.forEach(p => (p.state ? (byState[p.state] = byState[p.state] || []).push(p) : stateless.push(p)));
    const states = Object.keys(byState);
    if (states.length === 0) { groups[key] = ps; flags[key] = { ambiguousState: null }; return; }
    if (states.length === 1) {
      groups[key] = ps;
      flags[key] = { ambiguousState: stateless.length && byState[states[0]].length ? states[0] : null };
      return;
    }
    states.forEach(st => { groups[`${key}|${st}`] = byState[st]; flags[`${key}|${st}`] = { ambiguousState: null }; });
    if (stateless.length) { groups[`${key}|nostate`] = stateless; flags[`${key}|nostate`] = { ambiguousState: null }; }
  });
  Object.keys(groups).forEach(k => { flags[k].geoLoose = groups[k].some(p => p.geoLoose) && !groups[k].every(p => p.geoLoose); });
  return { groups, flags };
}

// Normalize rows (Pages.csv) into page objects.
function toPages(pagesData) {
  return pagesData.map(row => ({
    url: (row["Top pages"] || "").trim(),
    clicks: parseInt(String(row["Clicks"]).replace(/,/g, "")) || 0,
    impressions: parseInt(String(row["Impressions"]).replace(/,/g, "")) || 0,
    ctr: parseFloat(String(row["CTR"]).replace("%", "")) || 0,
    position: parseFloat(row["Position"]) || 0,
  })).filter(p => p.url);
}

// opts.isDead(url) → true when the URL is known to redirect or 404.
function analyzePages(pagesData, opts = {}) {
  const isDead = opts.isDead || (() => false);
  const allPages = toPages(pagesData);
  const deadPages = allPages.filter(p => isDead(p.url));
  const pages = allPages.filter(p => !isDead(p.url));

  // Track ignored intents for "Why NOT flagged" summary
  const ignoredCounts = { brand: 0, symptom: 0, modifier: 0, content: 0, informational: 0, noServiceTerm: 0, dead: deadPages.length };

  // Trailing-slash variants are a server issue, not an intent conflict:
  // detect them first and keep only the stronger variant for SEO grouping.
  const trailingSlashDupes = findTrailingSlashDupes(pages);
  const slashLosers = new Set(trailingSlashDupes.flatMap(d => d.pages.slice(1).map(p => p.url)));

  const classify = (list, count) => list.map(p => {
    const c = classifyURL(p.url);
    const bump = (k) => { if (count) ignoredCounts[k]++; };
    if (!c) { bump("noServiceTerm"); return null; }
    if (c.intent === "informational") { bump("informational"); return null; }
    if (c.intent === "brand") { bump("brand"); return null; }
    if (c.intent === "symptom") { bump("symptom"); return null; }
    if (c.intent === "modifier") { bump("modifier"); return null; }
    if (c.intent === "content") { bump("content"); return null; }
    return { ...p, ...c };
  }).filter(Boolean);

  const classified = classify(pages.filter(p => !slashLosers.has(p.url)), true);
  const { groups, flags } = groupServicePages(classified);

  // Clusters that existed before the redirects/404s were taken out = already resolved.
  let resolvedClusters = 0;
  if (deadPages.length) {
    const before = groupServicePages(classify(allPages, false)).groups;
    resolvedClusters = Object.values(before).filter(ps =>
      ps.length >= 2 && ps.some(p => isDead(p.url)) && ps.filter(p => !isDead(p.url)).length < 2
    ).length;
  }

  const conflicts = Object.entries(groups)
    .filter(([_, ps]) => ps.length >= 2 && ps.length <= 5)
    .map(([key, ps]) => {
      const [locale, service, geo] = key.split("|");
      const { ambiguousState, geoLoose } = flags[key];
      const sorted = [...ps].sort(
        (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position
      );
      const totalClicks = sorted.reduce((s, p) => s + p.clicks, 0);
      const totalImpressions = sorted.reduce((s, p) => s + p.impressions, 0);
      const sections = [...new Set(sorted.map(p => p.section))];

      const serviceName = service.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const geoName = geo === "generic"
        ? "Generic"
        : geo.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      const label = `${serviceName} — ${geoName}${locale && locale !== "en" ? ` [${locale.toUpperCase()}]` : ""}`;

      let { risk, score, reasons, confidence, confidenceLabel } = computeSeverity(sorted, sections);

      // ── HYBRID PRIMARY SELECTION ──
      // Don't pick "winner" on clicks alone — a page ranking far higher should be primary
      // even with fewer clicks (Google may still be mid-reindex). Position only overrides
      // when BOTH pages have enough impressions to trust the position, and the gap is real.
      const TRUST_IMPR = 100;   // min impressions to trust a position figure
      const POS_GAP = 2;        // ranking gap (in positions) considered meaningful

      const byClicks = [...sorted].sort(
        (a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.position - b.position
      );
      const trafficLeader = byClicks[0];

      // Best-ranked page among those with trustworthy impressions
      const ranked = sorted.filter(p => p.impressions >= TRUST_IMPR && p.position > 0);
      const rankLeader = ranked.length
        ? [...ranked].sort((a, b) => a.position - b.position)[0]
        : null;

      let primary = trafficLeader;
      let positionConflict = false;
      if (rankLeader && rankLeader.url !== trafficLeader.url) {
        const gap = trafficLeader.position - rankLeader.position; // >0 means rankLeader is higher
        if (gap >= POS_GAP) {
          // A different page ranks meaningfully higher — flag the conflict.
          positionConflict = true;
          // Primary stays the traffic leader, but we no longer recommend a blind redirect.
        }
      }

      const secondaries = sorted.filter(p => p.url !== primary.url);
      const secondary = secondaries.length
        ? [...secondaries].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)[0]
        : null;
      const primaryPath = getPathname(primary.url);

      // ── INTENTIONAL ARCHITECTURE DETECTION ──
      const isLikelyArchitecture =
        geo !== "generic" &&
        sections.length >= 2 &&
        sections.includes("ROOT") &&
        (sections.includes("SERVICE-AREA") || sections.includes("LOCATIONS"));

      if (isLikelyArchitecture && confidence === "HIGH") {
        confidence = "MEDIUM";
        confidenceLabel = "Likely duplicate";
      }

      // ── TRAFFIC SPLIT (honest metric) — share NOT going to primary ──
      const splitPct = totalImpressions > 0
        ? Math.round(((totalImpressions - primary.impressions) / totalImpressions) * 100)
        : 0;
      let splitStrength, splitEmoji;
      if (splitPct >= 30) { splitStrength = "Strong cannibalization"; splitEmoji = "🔥"; }
      else if (splitPct >= 10) { splitStrength = "Moderate cannibalization"; splitEmoji = "🟡"; }
      else { splitStrength = "Weak cannibalization"; splitEmoji = "🟢"; }
      reasons.push(`Traffic split ${splitPct}% (secondary URLs vs primary impressions)`);

      // ── EXPECTED IMPACT (derived from real traffic at stake) ──
      let impact, impactReason;
      if (splitPct >= 30) { impact = "High"; impactReason = `Traffic split ${splitPct}% — real traffic divided across URLs`; }
      else if (splitPct >= 10) { impact = "Medium"; impactReason = `Secondary URLs hold ${splitPct}% of impressions`; }
      else { impact = "Low"; impactReason = `Secondary URLs receive only ${splitPct}% of impressions`; }

      const secondaryDead = secondary &&
        secondaries.every(p => p.clicks === 0 && p.impressions <= 10 && p.position > 30);

      // ── ACTION: KEEP / REDIRECT / MERGE / REVIEW / ARCHITECTURE / IGNORE ──
      let actionType, suggestedAction, recShort, recLong;
      if (!secondary) {
        actionType = "REVIEW"; suggestedAction = "Review — single URL cluster";
      } else if (ambiguousState || geoLoose) {
        // The slugs only match after dropping a state or a "city" suffix.
        // That is a guess about geography, so never recommend a redirect on it.
        actionType = "REVIEW";
        confidence = "LOW"; confidenceLabel = "Possible overlap";
        risk = "LOW";
        suggestedAction = "Check that both URLs mean the same city before touching anything";
        recShort = "Same service, geo matched loosely";
        recLong = ambiguousState
          ? `Only some of these URLs name a state (${ambiguousState.toUpperCase()}). "dallas-${ambiguousState}" and "dallas" can be two different cities. If they are the same place, treat this as a duplicate; if not, leave both pages alone.`
          : `The URLs match only after dropping "city" from the location (e.g. "miami-city" vs "miami"). Confirm they target the same place before consolidating.`;
        reasons.push(ambiguousState ? `⚠ Only one side names the state (${ambiguousState.toUpperCase()})` : "⚠ Location matched without the \"city\" suffix");
      } else if (positionConflict) {
        // Lower-traffic URL ranks higher. We know the mismatch, not the cause.
        actionType = "ARCHITECTURE";
        const higher = primary.position <= secondary.position ? primary : secondary;
        const higherPath = getPathname(higher.url);
        suggestedAction = "Rank/traffic mismatch detected — review before redirecting";
        recShort = "A lower-traffic URL ranks higher — don't redirect blindly";
        recLong = `These URLs target the same service+geo, but the page with MORE traffic isn't the one ranking higher. ${primaryPath} pulls most impressions, yet ${higherPath} ranks better (pos ${higher.position.toFixed(1)}). This often happens during an architecture transition while Google re-evaluates — but it can also be two genuinely different pages. Decide which URL should be canonical based on site architecture, internal links, backlinks, and business intent — not on current traffic alone. Then 301 the other one to it and let it settle. Do not 301 the better-ranking page away by default.`;
        reasons.push("⚠ Rank/traffic mismatch — structural conflict, not clean cannibalization");
      } else if (secondaryDead) {
        actionType = "IGNORE";
        suggestedAction = "Low urgency — secondary URLs already de-prioritized by Google";
        recShort = "Google already ignores the secondary URLs";
        recLong = `The secondary URL(s) have ~0 clicks, minimal impressions and rank past position 30. Google has effectively dropped them. Safe to 301 for cleanliness, but no traffic at stake — low priority.`;
      } else if (isLikelyArchitecture) {
        actionType = "ARCHITECTURE";
        suggestedAction = "Structural overlap — verify intent before consolidating";
        recShort = "Core page + geo section targeting the same term";
        recLong = `${primaryPath} (Core page) and the geo landing pages in ${sections.filter(s => s !== "ROOT").join(" + ")} often serve different purposes in local SEO. If both have unique content and different user intent, no action needed. If they're near-duplicates, consolidate to the stronger one.`;
        reasons.push("⚠ Core + geo section targeting the same term");
      } else if (confidence === "HIGH" && splitPct >= 25) {
        actionType = "MERGE";
        suggestedAction = "Merge content into primary, then 301 secondary → primary";
        recShort = "Both URLs pull real traffic for the same target";
        recLong = `${sorted.length} pages target the same service+geo across ${sections.join(" + ")} and the secondary carries ${splitPct}% of cluster impressions — real traffic, not noise. Merge the unique content into ${primaryPath}, then 301 the secondary so you keep the equity instead of dropping it.`;
      } else if (confidence === "HIGH") {
        actionType = "REDIRECT";
        suggestedAction = "301 redirect secondary → primary";
        recShort = "High confidence duplicate, primary clearly stronger";
        recLong = `${sorted.length} pages target the same service+geo across ${sections.join(" + ")}. ${primaryPath} is stronger on both traffic and ranking, and the secondary pulls only ${splitPct}% of impressions. Likely safe to 301 — verify content overlap first.`;
      } else {
        actionType = "REVIEW";
        suggestedAction = "Review manually — verify intent before consolidating";
        recShort = "Possible overlap — needs a human check";
        recLong = `${sorted.length} URL variants with similar targets across ${sections.join(" + ")}. Primary by GSC data: ${primaryPath}. Confidence is ${confidence} — review whether these serve different intents before any redirect.`;
      }
      const recommendation = recLong || suggestedAction;

      const pageActions = sorted.map((p) => {
        if (p.url === primary.url) return { ...p, action: "KEEP" };
        const isDePrioritized = p.clicks === 0 && p.impressions <= 10 && p.position > 30;
        if (isDePrioritized) return { ...p, action: "IGNORE" };
        if (actionType === "ARCHITECTURE") return { ...p, action: "ARCHITECTURE" };
        if (actionType === "MERGE") return { ...p, action: "MERGE" };
        if (actionType === "REDIRECT") return { ...p, action: "REDIRECT" };
        return { ...p, action: "REVIEW" };
      });


      return {
        label, service, geo, pages: pageActions, pageCount: sorted.length,
        totalClicks, totalImpressions, sections, winner: primary, risk, score, reasons, recommendation,
        confidence, confidenceLabel, isLikelyArchitecture,
        loser: secondary, actionType, suggestedAction, recShort, recLong,
        splitPct, splitStrength, splitEmoji,
        impact, impactReason, positionConflict,
        isTechnical: false,
      };
    })
    .sort((a, b) => {
      const ro = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (ro[a.risk] !== ro[b.risk]) return ro[a.risk] - ro[b.risk];
      return b.score - a.score;
    });

  return {
    conflicts: [...conflicts, ...trailingSlashDupes],
    ignoredCounts,
    totalPages: allPages.length,
    resolvedClusters,
  };
}

export { analyzePages, classifyURL, getPathname, getSection, toPages };
