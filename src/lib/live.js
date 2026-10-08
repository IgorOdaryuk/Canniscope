// ─── LIVE CHECK VERDICTS ───
// Turns per-URL live checks into one verdict per cluster:
//   "real"    — 2+ pages are live, indexable and canonical to themselves
//   "fixed"   — the others already redirect / canonicalize / noindex onto the kept page
//   "broken"  — the fix itself has a problem (404 on a page with clicks, chain, loop…)
//   "unchecked" — the live check didn't answer for enough pages

// Same page for comparison: ignore protocol, www, trailing slash and #hash.
function samePage(a, b) {
  if (!a || !b) return false;
  const k = (u) => {
    try {
      const x = new URL(u);
      return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + x.search;
    } catch { return String(u); }
  };
  return k(a) === k(b);
}

// State of one URL from its check result.
function pageState(r) {
  if (!r || r.error) return { kind: "unknown", why: r?.error || "not checked" };
  if (r.hops > 0) {
    if (r.finalStatus >= 400) return { kind: "redirect-dead", target: r.finalUrl, hops: r.hops, why: `redirects to a ${r.finalStatus} page` };
    return { kind: "redirect", target: r.finalUrl, hops: r.hops, permanent: r.status === 301 || r.status === 308, status: r.status };
  }
  if (r.finalStatus === 404 || r.finalStatus === 410) return { kind: "gone", status: r.finalStatus };
  if (r.finalStatus >= 400) return { kind: "unknown", why: `HTTP ${r.finalStatus}` };
  if (r.noindex) return { kind: "noindex" };
  if (r.canonical && !samePage(r.canonical, r.url)) return { kind: "canonical", target: r.canonical };
  return { kind: "live" };
}

function stateLabel(s) {
  switch (s.kind) {
    case "live": return "Live, indexable";
    case "redirect": return `${s.permanent ? s.status : `${s.status} (temporary)`} → ${shortPath(s.target)}${s.hops > 1 ? ` · ${s.hops}-hop chain` : ""}`;
    case "redirect-dead": return `Redirects to a dead page (${shortPath(s.target)})`;
    case "gone": return `${s.status} — removed`;
    case "noindex": return "noindex";
    case "canonical": return `canonical → ${shortPath(s.target)}`;
    default: return `Not checked (${s.why})`;
  }
}

function shortPath(u) {
  try { const x = new URL(u); return x.pathname + x.search; } catch { return u; }
}

// conflict: { pages: [{url, clicks, impressions, ...}], winner }
// results: Map(url → check result)
function judgeCluster(conflict, results) {
  const pages = conflict.pages.map(p => ({ ...p, live: pageState(results.get(p.url)) }));
  const liveOnes = pages.filter(p => p.live.kind === "live");
  const unknown = pages.filter(p => p.live.kind === "unknown");
  const problems = [];
  const done = [];

  pages.forEach(p => {
    const s = p.live;
    const path = shortPath(p.url);
    if (s.kind === "redirect") {
      const intoCluster = pages.some(o => o.url !== p.url && samePage(o.url, s.target));
      if (!s.permanent) problems.push(`${path} uses a temporary ${s.status} redirect — switch to 301 so Google moves its signals`);
      else if (s.hops > 1) problems.push(`${path} reaches its target through ${s.hops} redirects — point it straight to ${shortPath(s.target)}`);
      else done.push(`${path} → 301 to ${intoCluster ? "the kept page" : shortPath(s.target)}`);
    } else if (s.kind === "redirect-dead") {
      problems.push(`${path} redirects to a page that is gone (${shortPath(s.target)})`);
    } else if (s.kind === "gone") {
      if (p.clicks > 0) problems.push(`${path} returns ${s.status} but still got ${p.clicks} clicks in your data — 301 it to the kept page instead of deleting`);
      else done.push(`${path} removed (${s.status}), no clicks lost`);
    } else if (s.kind === "canonical") {
      done.push(`${path} has canonical → ${shortPath(s.target)}`);
    } else if (s.kind === "noindex") {
      done.push(`${path} is noindex`);
    }
  });

  let verdict;
  if (liveOnes.length >= 2) verdict = "real";
  else if (unknown.length && liveOnes.length + unknown.length >= 2) verdict = "unchecked";
  else if (problems.length) verdict = "broken";
  else verdict = "fixed";

  // Nothing live at all but no errors: everything points elsewhere — fixed.
  return {
    verdict,
    pages: pages.map(p => ({ url: p.url, state: p.live, label: stateLabel(p.live) })),
    problems,
    done,
  };
}

// Pick which URLs to send: every page of every cluster, riskiest clusters first.
function urlsToCheck(conflicts, max = 300) {
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const out = [];
  const seen = new Set();
  [...conflicts].sort((a, b) => (order[a.risk] ?? 3) - (order[b.risk] ?? 3)).forEach(c => {
    c.pages.forEach(p => { if (!seen.has(p.url) && out.length < max) { seen.add(p.url); out.push(p.url); } });
  });
  return out;
}

export { judgeCluster, urlsToCheck, pageState, samePage };
