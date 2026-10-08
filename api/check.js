// Live URL check for flagged pairs.
// Receives only page addresses (never GSC metrics), opens each one on the live
// site and reports status, redirect chain, canonical and noindex.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_URLS = 300;
const MAX_HOPS = 5;
const TIMEOUT_MS = 8000;
const CONCURRENCY = 4;
const UA = "Mozilla/5.0 (compatible; CanniScopeBot/1.0; +https://canniscope.vercel.app)";

// Block requests to private networks (SSRF): only public hosts may be checked.
function isPrivateIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") ||
    v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") ||
    v.startsWith("::ffff:192.168.");
}

const hostOk = new Map();
async function publicHost(hostname) {
  if (hostOk.has(hostname)) return hostOk.get(hostname);
  let ok = false;
  try {
    const addrs = await lookup(hostname, { all: true });
    ok = addrs.length > 0 && addrs.every(a => !isPrivateIp(a.address));
  } catch { ok = false; }
  hostOk.set(hostname, ok);
  return ok;
}

function readMeta(html, headers) {
  const head = html.slice(0, 200000);
  const canon = head.match(/<link[^>]+rel=["']?canonical["']?[^>]*>/i);
  const href = canon && canon[0].match(/href=["']([^"']+)["']/i);
  const robots = head.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i)
    || head.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']robots["']/i);
  const xRobots = headers.get("x-robots-tag") || "";
  const noindex = /noindex/i.test((robots && robots[1]) || "") || /noindex/i.test(xRobots);
  return { canonical: href ? href[1] : null, noindex };
}

async function fetchOnce(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html" } });
    const location = r.headers.get("location");
    let meta = { canonical: null, noindex: false };
    if (r.status >= 200 && r.status < 300 && /html/i.test(r.headers.get("content-type") || "")) {
      meta = readMeta(await r.text(), r.headers);
    } else {
      try { await r.body?.cancel(); } catch {}
    }
    return { status: r.status, location: location ? new URL(location, url).toString() : null, ...meta };
  } finally {
    clearTimeout(t);
  }
}

async function checkUrl(url) {
  const chain = [];
  let cur = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const u = new URL(cur);
    if (!/^https?:$/.test(u.protocol) || !(await publicHost(u.hostname))) {
      return { url, error: "blocked host", chain };
    }
    let r;
    try { r = await fetchOnce(cur); }
    catch (e) { return { url, error: e.name === "AbortError" ? "timeout" : "fetch failed", chain }; }
    chain.push({ url: cur, status: r.status });
    if (r.status >= 300 && r.status < 400 && r.location) {
      if (chain.some(c => c.url === r.location)) return { url, error: "redirect loop", chain };
      cur = r.location;
      continue;
    }
    return {
      url,
      status: chain[0].status,
      finalUrl: cur,
      finalStatus: r.status,
      hops: chain.length - 1,
      canonical: r.canonical ? new URL(r.canonical, cur).toString() : null,
      noindex: r.noindex,
      chain,
    };
  }
  return { url, error: "too many redirects", chain };
}

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const urls = Array.isArray(body?.urls) ? [...new Set(body.urls.filter(u => typeof u === "string"))] : [];
  if (!urls.length) { res.status(400).json({ error: "no urls" }); return; }
  if (urls.length > MAX_URLS) { res.status(400).json({ error: `at most ${MAX_URLS} urls per check` }); return; }

  // All addresses must belong to one site: this checks your pages, it is not a general crawler.
  let host;
  try {
    // Same registrable domain (www., blog. etc. allowed): last two labels of the host.
    const hosts = new Set(urls.map(u => new URL(u).hostname.split(".").slice(-2).join(".")));
    if (hosts.size !== 1) { res.status(400).json({ error: "all urls must be on one site" }); return; }
    host = [...hosts][0];
  } catch { res.status(400).json({ error: "bad url" }); return; }

  const results = new Array(urls.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await checkUrl(urls[i]);
    }
  }));
  res.status(200).json({ host, results });
}
