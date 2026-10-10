// ─── QUERY OVERLAP MODE ───
// Real cannibalization = two of your pages getting impressions for the same search.
// Input: query + page rows (Search Console API or any CSV with query and page columns).

import { getPathname, getSection } from "./analyze.js";

const MIN_PAGE_IMPR = 3;      // a page must get at least this many impressions on the query
const MIN_PAGE_SHARE = 0.05;  // ...and at least this share of the query's impressions
const MIN_CONTESTED = 20;     // pair is reported when contested impressions reach this
const MIN_SHARED_QUERIES = 2; // ...across at least this many queries
const MAX_SLOT = 3;           // URL template slot: at most this many words differ

const STOP = new Set(["in", "the", "and", "for", "of", "a", "to", "near", "me", "my", "your", "with", "on", "at"]);
// State codes say little: "tampa-fl" vs "tampa-bay" should still match on "tampa".
const STATES = new Set(("al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc").split(" "));

const tokenize = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !STOP.has(t));
// Identity comes from the last path segment only: folders like /locations/atlanta/
// repeat on hundreds of URLs and would make the city look like common vocabulary.
const slugTokens = (url) => {
  const parts = getPathname(url).split("/").filter(Boolean);
  return new Set(tokenize(parts[parts.length - 1] || ""));
};

function isHome(url) {
  const p = getPathname(url).replace(/\/+$/, "");
  return p === "";
}

// One page is the parent folder of the other: a hub and its own child page.
function isParentChild(a, b) {
  const pa = getPathname(a).replace(/\/+$/, "") + "/";
  const pb = getPathname(b).replace(/\/+$/, "") + "/";
  return pa !== "/" && pb !== "/" && (pa.startsWith(pb) || pb.startsWith(pa));
}

function brandMatcher(brands) {
  const list = brands.map(b => b.trim().toLowerCase()).filter(b => b.length >= 3);
  if (!list.length) return () => false;
  const squash = (s) => s.replace(/[^a-z0-9]/g, "");
  const sq = list.map(squash);
  return (q) => {
    const s = squash(q.toLowerCase());
    return sq.some(b => s.includes(b));
  };
}

// opts: { isDead(url), brands: [] }
function analyzeQueries(rows, opts = {}) {
  const isDead = opts.isDead || (() => false);
  const domainBrands = [];
  try {
    const host = new URL(rows[0].page).hostname.replace(/^www\./, "");
    domainBrands.push(host.split(".")[0]);
  } catch {}
  const isBrand = brandMatcher([...(opts.brands || []), ...domainBrands]);

  const stats = { queries: 0, brandQueries: 0, deadRows: 0, homepagePairs: 0, localizedSkips: 0, parentChildPairs: 0 };

  // Page totals across all their queries (for "does it have a life of its own").
  const pageTotal = new Map();
  const live = rows.filter(r => {
    if (isDead(r.page)) { stats.deadRows++; return false; }
    return true;
  });
  live.forEach(r => pageTotal.set(r.page, (pageTotal.get(r.page) || 0) + r.impressions));
  // Each page's queries, for "what this page is already found by".
  const pageQueries = new Map();
  live.forEach(r => { if (!pageQueries.has(r.page)) pageQueries.set(r.page, []); pageQueries.get(r.page).push(r); });

  // What each page is about: its slug words minus state codes. Words both pages
  // share cancel out below, so there is no need for a site-wide stop list.
  const pages = [...pageTotal.keys()];
  const identity = new Map(pages.map(u => [u, new Set([...slugTokens(u)].filter(t => !STATES.has(t)))]));

  // Slug words in order, without stop words and state codes.
  const slugWords = (u) => {
    const parts = getPathname(u).split("/").filter(Boolean);
    return tokenize(parts[parts.length - 1] || "").filter(t => !STATES.has(t));
  };
  // Replace the words only this page has with a slot: "icemaker-repair-*".
  // Place names, learned from the site's own URLs: the one or two words right
  // before a state code ("-austin-tx", "-san-marcos-tx", "-in-atlanta-ga").
  const geoWords = new Set();
  pages.forEach(u => {
    const parts = getPathname(u).split("/").filter(Boolean);
    const w = tokenize(parts[parts.length - 1] || "");
    w.forEach((t, i) => { if (STATES.has(t) && i > 0 && i === w.length - 1) { geoWords.add(w[i - 1]); if (i > 1) geoWords.add(w[i - 2] + " " + w[i - 1]); } });
  });
  // A page's own place: a geo word (or two-word place) in its slug.
  const placeOf = (words) => words.filter((t, i) => geoWords.has(t) || (i > 0 && geoWords.has(words[i - 1] + " " + t)));

  const pattern = (u, own) => slugWords(u).map(t => (own.has(t) ? "*" : t)).join("-").replace(/(\*-)+\*/g, "*");

  const byQuery = new Map();
  live.forEach(r => {
    if (!byQuery.has(r.query)) byQuery.set(r.query, []);
    byQuery.get(r.query).push(r);
  });

  const pairs = new Map();
  byQuery.forEach((ps, query) => {
    stats.queries++;
    if (isBrand(query)) { stats.brandQueries++; return; }
    const total = ps.reduce((s, r) => s + r.impressions, 0);
    const cands = ps.filter(r => r.impressions >= MIN_PAGE_IMPR && r.impressions >= MIN_PAGE_SHARE * total);
    if (cands.length < 2) return;
    const qt = new Set(tokenize(query));

    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const [A, B] = [cands[i], cands[j]].sort((x, y) => (x.page < y.page ? -1 : 1));
        const idA = identity.get(A.page), idB = identity.get(B.page);
        // What each page is about that the other is not, minus what the query asks for.
        const ownA = new Set([...idA].filter(t => !idB.has(t)));
        const ownB = new Set([...idB].filter(t => !idA.has(t)));
        const restA = [...ownA].filter(t => !qt.has(t));
        const restB = [...ownB].filter(t => !qt.has(t));
        // Each page aims at its own value the query doesn't name: Google is localizing a
        // generic search, not confused. "Its own value" = same URL template with a
        // different slot ("icemaker-repair-dallas" vs "icemaker-repair-houston"), or
        // a different place (a San Marcos hub vs a Killeen office-cleaning page).
        // Two posts about one product with different wording pass neither test.
        // A slot is a short value (a city, a model); if half the slug differs, it's not a template.
        const sameTemplate = ownA.size <= MAX_SLOT && ownB.size <= MAX_SLOT &&
          pattern(A.page, ownA) === pattern(B.page, ownB);
        const differentPlaces = placeOf(restA).length > 0 && placeOf(restB).length > 0;
        if (restA.length && restB.length && (sameTemplate || differentPlaces)) {
          stats.localizedSkips++;
          continue;
        }
        const key = A.page + "\n" + B.page;
        if (!pairs.has(key)) pairs.set(key, { a: A.page, b: B.page, qs: [] });
        pairs.get(key).qs.push({ query, a: A, b: B });
      }
    }
  });

  const conflicts = [];
  pairs.forEach(pr => {
    const contested = pr.qs.reduce((s, x) => s + Math.min(x.a.impressions, x.b.impressions), 0);
    if (contested < MIN_CONTESTED || pr.qs.length < MIN_SHARED_QUERIES) return;
    if (isHome(pr.a) || isHome(pr.b)) { stats.homepagePairs++; return; }

    const side = (key) => {
      const rowsFor = pr.qs.map(x => x[key]);
      const impr = rowsFor.reduce((s, r) => s + r.impressions, 0);
      const clicks = rowsFor.reduce((s, r) => s + r.clicks, 0);
      const pos = impr ? rowsFor.reduce((s, r) => s + r.position * r.impressions, 0) / impr : 0;
      return { impr, clicks, pos };
    };
    const sa = side("a"), sb = side("b");
    let [P, S, sp, ss] = sa.impr >= sb.impr ? [pr.a, pr.b, sa, sb] : [pr.b, pr.a, sb, sa];

    // Which page do the searches actually describe? Share of shared impressions whose
    // query names a word only that page has ("dryer" on a dryer page vs an
    // appliance-repair hub). The dedicated page should own them even if the broad
    // page gets more impressions today.
    const idP = identity.get(P), idS = identity.get(S);
    const own = (id, other) => [...id].filter(t => !other.has(t));
    const describes = (ownWords, key) => {
      let hit = 0, all = 0;
      pr.qs.forEach(x => {
        const r = x.a.page === (key === "P" ? P : S) ? x.a : x.b;
        const qt = new Set(tokenize(x.query));
        all += r.impressions;
        if (ownWords.some(t => qt.has(t))) hit += r.impressions;
      });
      return all ? hit / all : 0;
    };
    const specP = describes(own(idP, idS), "P"), specS = describes(own(idS, idP), "S");
    const dedicatedLoses = specS >= 0.5 && specP < 0.2;
    if (dedicatedLoses) [P, S, sp, ss] = [S, P, ss, sp];
    const page = (url, s) => ({
      url, clicks: s.clicks, impressions: s.impr, position: s.pos,
      ctr: s.impr ? +(100 * s.clicks / s.impr).toFixed(2) : 0,
      section: getSection(url), totalImpressions: pageTotal.get(url) || 0,
    });
    const primary = page(P, sp), secondary = page(S, ss);

    const totalShared = sp.impr + ss.impr;
    const splitPct = totalShared ? Math.round(100 * ss.impr / totalShared) : 0;
    const secOwnShare = secondary.totalImpressions ? ss.impr / secondary.totalImpressions : 1;
    const positionConflict = ss.pos > 0 && sp.pos - ss.pos >= 2;
    const close = Math.abs(sp.pos - ss.pos) <= 5;
    const hubChild = isParentChild(P, S);
    if (hubChild) stats.parentChildPairs++;

    const reasons = [
      `${pr.qs.length} shared queries, ${contested.toLocaleString()} contested impressions`,
      `Secondary gets ${splitPct}% of the shared impressions (pos ${ss.pos.toFixed(1)} vs ${sp.pos.toFixed(1)})`,
      `${Math.round(secOwnShare * 100)}% of the secondary page's impressions come from these shared queries`,
    ];
    const topQs = [...pr.qs].sort((x, y) => Math.min(y.a.impressions, y.b.impressions) - Math.min(x.a.impressions, x.b.impressions)).slice(0, 5);
    topQs.forEach(x => reasons.push(`“${x.query}” — ${x.a.impressions} / ${x.b.impressions} impr`));

    let score = 0;
    if (contested >= 300) score += 40; else if (contested >= 100) score += 25; else score += 10;
    if (close) score += 20;
    if (splitPct >= 30) score += 20; else if (splitPct >= 10) score += 10;
    if (pr.qs.length >= 5) score += 10;
    if (primary.clicks > 0 && secondary.clicks > 0) score += 10;
    const risk = score >= 60 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW";
    const confidence = contested >= 100 && pr.qs.length >= 3 ? "HIGH" : contested >= 50 ? "MEDIUM" : "LOW";
    const confidenceLabel = { HIGH: "Confirmed by query data", MEDIUM: "Likely competing", LOW: "Light overlap" }[confidence];

    const pp = getPathname(P), sp_ = getPathname(S);
    let actionType, suggestedAction, recLong;
    if (dedicatedLoses) {
      actionType = "ARCHITECTURE";
      suggestedAction = "A broader page is taking searches that belong to the dedicated page — don't merge, point the broad page at it";
      recLong = `The shared searches name what ${pp} is about, so ${pp} should own them. Keep both pages: take that service's phrasing out of ${sp_}'s title, H1 and intro, add a short line there linking to ${pp} with the exact phrase as anchor, and link back from ${pp} to ${sp_}. Never 301 the dedicated page into the broad one.`;
    } else if (hubChild) {
      actionType = "ARCHITECTURE";
      suggestedAction = "Hub and its own child page share searches — sharpen roles, don't redirect";
      recLong = `${pp} and ${sp_} sit in the same folder branch. A hub should rank for the broad term and link down; the child should own the narrower term. Make the child's title, H1 and intro specific, and link hub → child with that exact anchor.`;
    } else if (positionConflict && !dedicatedLoses) {
      actionType = "REVIEW";
      suggestedAction = "The page with fewer impressions ranks better — decide which one should own these searches";
      recLong = `${pp} gets more impressions on the shared searches, but ${sp_} ranks higher (pos ${ss.pos.toFixed(1)} vs ${sp.pos.toFixed(1)}). Pick the owner by intent and business value, not by today's traffic, then retarget the other page.`;
    } else if (secOwnShare >= 0.7 && splitPct < 50) {
      actionType = "MERGE";
      suggestedAction = "Merge the secondary into the primary, then 301";
      recLong = `${Math.round(secOwnShare * 100)}% of ${sp_}'s impressions are the searches ${pp} already wins. It has almost no traffic of its own, so keeping it only splits signals. Move anything unique into ${pp} and 301 ${sp_} to it.`;
    } else {
      actionType = "RETARGET";
      suggestedAction = "Keep both, move the secondary onto its own query";
      recLong = `${sp_} has traffic of its own beyond these searches, so a redirect would throw it away. Pick the query it already ranks best for, put that in its title and H1, remove the contested phrasing, and link it to ${pp} with the contested phrase as anchor.`;
    }

    conflicts.push({
      label: `${pp} ↔ ${sp_}`,
      service: pp, geo: "query-overlap",
      pages: [{ ...primary, action: "KEEP" }, { ...secondary, action: actionType }],
      pageCount: 2,
      totalClicks: primary.clicks + secondary.clicks,
      totalImpressions: totalShared,
      sections: [...new Set([primary.section, secondary.section])],
      winner: primary, loser: secondary,
      risk, score, reasons, confidence, confidenceLabel,
      actionType, suggestedAction, recShort: suggestedAction, recLong, recommendation: recLong,
      splitPct,
      splitStrength: splitPct >= 30 ? "Strong cannibalization" : splitPct >= 10 ? "Moderate cannibalization" : "Weak cannibalization",
      splitEmoji: splitPct >= 30 ? "🔥" : splitPct >= 10 ? "🟡" : "🟢",
      impact: splitPct >= 30 ? "High" : splitPct >= 10 ? "Medium" : "Low",
      impactReason: `${contested.toLocaleString()} impressions contested across ${pr.qs.length} queries`,
      positionConflict,
      isTechnical: false, isQuery: true,
      sharedQueries: pr.qs.length, contested,
      // Plain-language view needs the raw numbers, keyed by keep/other page.
      topQueries: topQs.map(x => {
        const k = x.a.page === P ? x.a : x.b, o = x.a.page === P ? x.b : x.a;
        return { query: x.query, keep: { impressions: k.impressions, position: k.position }, other: { impressions: o.impressions, position: o.position } };
      }),
      otherOwnQuery: (() => {
        const shared = new Set(pr.qs.map(x => x.query));
        const best = (pageQueries.get(S) || []).filter(r => !shared.has(r.query) && !isBrand(r.query)).sort((x, y) => y.impressions - x.impressions)[0];
        return best ? best.query : null;
      })(),
    });
  });

  conflicts.sort((a, b) => {
    const ro = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    return ro[a.risk] - ro[b.risk] || b.contested - a.contested;
  });

  return { conflicts, stats, pageCount: pages.length };
}

// Page-level rows (Pages.csv shape) rebuilt from query rows, so slug mode can run
// when only a query+page file was uploaded. Totals undercount: GSC hides rare queries.
function pagesFromQueries(rows) {
  const m = new Map();
  rows.forEach(r => {
    const x = m.get(r.page) || { c: 0, i: 0, pw: 0 };
    x.c += r.clicks; x.i += r.impressions; x.pw += r.position * r.impressions;
    m.set(r.page, x);
  });
  return [...m.entries()].map(([u, x]) => ({
    "Top pages": u, Clicks: x.c, Impressions: x.i,
    CTR: x.i ? (100 * x.c / x.i).toFixed(2) + "%" : "0%",
    Position: x.i ? (x.pw / x.i).toFixed(1) : 0,
  }));
}

// Drop URL-pattern clusters whose pages are already reported by query data:
// the query pair says the same thing with real numbers behind it.
function dropCovered(queryConflicts, slugConflicts) {
  const pairs = queryConflicts.map(c => new Set(c.pages.map(p => p.url)));
  const covered = (c) => c.pages.length >= 2 && pairs.some(set => c.pages.filter(p => set.has(p.url)).length >= 2);
  const kept = slugConflicts.filter(c => c.isTechnical || !covered(c));
  return { kept, dropped: slugConflicts.length - kept.length };
}

export { analyzeQueries, pagesFromQueries, dropCovered };
