// ─── FILE DETECTION ───
// Every uploaded CSV is recognised by its columns, not by its file name.

const norm = (h) => String(h || "").trim().toLowerCase().replace(/\s+/g, " ");

function findCol(headers, names) {
  const hs = headers.map(norm);
  for (const n of names) {
    const i = hs.indexOf(n);
    if (i >= 0) return headers[i];
  }
  return null;
}

const QUERY_COLS = ["query", "queries", "top queries", "search query"];
const PAGE_COLS = ["page", "top pages", "landing page", "url", "address", "pages"];
const IMPR_COLS = ["impressions", "impr", "impr."];
const CLICK_COLS = ["clicks", "url clicks"];
const POS_COLS = ["position", "average position", "avg. position", "avg position"];
const STATUS_COLS = ["status code", "status", "http status", "http status code", "response code"];
const TARGET_COLS = ["redirect url", "redirect uri", "location", "final url", "redirect target"];

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, "").replace("%", ""));
  return Number.isFinite(n) ? n : 0;
};

// Tracking parameters and #anchors don't make a different page. GSC reports
// "/?utm_source=gbp" (the Business Profile link) and "/#about" as separate URLs.
const TRACKING = /^(utm_|gclid$|gbraid$|wbraid$|fbclid$|msclkid$|srsltid$|mc_|_ga$|_gl$|ref$)/i;
function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    u.hash = "";
    [...u.searchParams.keys()].forEach(k => { if (TRACKING.test(k)) u.searchParams.delete(k); });
    return u.toString();
  } catch {
    return String(url || "").trim();
  }
}

// Merge rows that point to the same page after normalization: sum clicks and
// impressions, average position weighted by impressions.
function mergeRows(rows, keyOf) {
  const m = new Map();
  rows.forEach(r => {
    const k = keyOf(r);
    const x = m.get(k);
    if (!x) { m.set(k, { ...r, _pw: r.position * r.impressions }); return; }
    x.clicks += r.clicks; x.impressions += r.impressions; x._pw += r.position * r.impressions;
  });
  return [...m.values()].map(({ _pw, ...r }) => ({ ...r, position: r.impressions ? _pw / r.impressions : r.position }));
}

// Returns { kind, ... } for one parsed CSV.
// kind: "pages" | "queries" | "status" | "meta" | "unknown"
function detectFile(rows, fields) {
  const headers = fields && fields.length ? fields : Object.keys(rows[0] || {});
  const q = findCol(headers, QUERY_COLS);
  const p = findCol(headers, PAGE_COLS);
  const im = findCol(headers, IMPR_COLS);

  if (q && p && im) {
    const c = findCol(headers, CLICK_COLS);
    const pos = findCol(headers, POS_COLS);
    const raw = rows.map(r => ({
      query: String(r[q] || "").trim(),
      page: normalizeUrl(r[p]),
      clicks: c ? num(r[c]) : 0,
      impressions: num(r[im]),
      position: pos ? num(r[pos]) : 0,
    })).filter(r => r.query && r.page);
    const merged = mergeRows(raw, r => r.query + "\n" + r.page);
    return { kind: "queries", rows: merged, mergedVariants: raw.length - merged.length };
  }

  if (p && im && !q) {
    // Pages.csv from GSC uses "Top pages"; map other exports onto the same shape.
    const c = findCol(headers, CLICK_COLS);
    const pos = findCol(headers, POS_COLS);
    const ctr = findCol(headers, ["ctr"]);
    const raw = rows.map(r => ({
      page: normalizeUrl(r[p]),
      clicks: c ? num(r[c]) : 0,
      impressions: num(r[im]),
      position: pos ? num(r[pos]) : 0,
    })).filter(r => r.page);
    const merged = mergeRows(raw, r => r.page);
    return {
      kind: "pages",
      rows: merged.map(r => ({
        "Top pages": r.page,
        Clicks: r.clicks,
        Impressions: r.impressions,
        CTR: r.impressions ? (100 * r.clicks / r.impressions).toFixed(2) + "%" : "0%",
        Position: r.position.toFixed(1),
      })),
      mergedVariants: raw.length - merged.length,
    };
  }

  // GSC indexing drill-down export ships Metadata.csv next to Table.csv.
  if (findCol(headers, ["property"]) && findCol(headers, ["value"])) {
    const prop = findCol(headers, ["property"]);
    const val = findCol(headers, ["value"]);
    const issue = rows.find(r => norm(r[prop]) === "issue");
    return { kind: "meta", issue: issue ? String(issue[val]) : null };
  }

  if (p) {
    const st = findCol(headers, STATUS_COLS);
    const tg = findCol(headers, TARGET_COLS);
    return {
      kind: "status",
      rows: rows.map(r => ({
        url: normalizeUrl(r[p]),
        status: st ? parseInt(r[st], 10) || null : null,
        target: tg ? String(r[tg] || "").trim() || null : null,
      })).filter(r => /^https?:\/\//i.test(r.url)),
      hasStatus: !!st,
    };
  }

  return { kind: "unknown" };
}

// Issues from the GSC "Pages" (indexing) report that mean "this URL is not a live page".
// Canonical/duplicate issues are left out on purpose: those pages are live and
// are often the cannibalization itself.
const DEAD_ISSUE = /redirect|not found|404/i;

// Build a lookup of URLs that should not be treated as live pages.
// A list without a status column (GSC "Page with redirect" / "Not found (404)")
// counts as dead in full; a crawler export only marks non-2xx rows.
function buildDeadIndex(statusFiles) {
  const dead = new Map();
  statusFiles.forEach(f => {
    f.rows.forEach(r => {
      const isDead = f.hasStatus ? (r.status != null && (r.status < 200 || r.status >= 300)) : true;
      if (isDead) dead.set(r.url, { status: r.status, target: r.target, source: f.label || null });
    });
  });
  const isDead = (url) => dead.has(url);
  return { dead, isDead };
}

export { detectFile, buildDeadIndex, normalizeUrl, DEAD_ISSUE };
