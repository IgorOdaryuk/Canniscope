// ─── SIGN IN WITH GOOGLE → SEARCH CONSOLE ───
// Everything runs in the browser: Google's token client gives a short-lived
// read-only token, and the Search Console API is called directly from here.
// The token is kept in memory only.

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://searchconsole.googleapis.com/webmasters/v3";
const MAX_ROWS = 100000; // per dimension set, enough for sites with tens of thousands of pages

let gisLoading = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisLoading = null; reject(new Error("Couldn't load Google sign-in")); };
    document.head.appendChild(s);
  });
  return gisLoading;
}

// Opens Google's consent popup; resolves with an access token.
async function signIn(clientId) {
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => (r.error ? reject(new Error(r.error_description || r.error)) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e?.message || e?.type || "Sign-in was cancelled")),
    });
    client.requestAccessToken();
  });
}

async function api(token, path, body) {
  const r = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `Search Console API error ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function listSites(token) {
  const j = await api(token, "/sites");
  return (j.siteEntry || [])
    .filter(s => s.permissionLevel !== "siteUnverifiedUser")
    .map(s => s.siteUrl)
    .sort();
}

const iso = (d) => d.toISOString().slice(0, 10);

// Last 90 days of final data (GSC lags ~3 days).
function defaultRange() {
  const end = new Date(Date.now() - 3 * 86400000);
  const start = new Date(end.getTime() - 89 * 86400000);
  return { startDate: iso(start), endDate: iso(end) };
}

async function fetchRows(token, siteUrl, dimensions, onProgress) {
  const { startDate, endDate } = defaultRange();
  const rows = [];
  for (let startRow = 0; startRow < MAX_ROWS; startRow += 25000) {
    const j = await api(token, `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      startDate, endDate, dimensions, rowLimit: 25000, startRow, dataState: "final",
    });
    const got = j.rows || [];
    rows.push(...got);
    onProgress && onProgress(rows.length);
    if (got.length < 25000) break;
  }
  return { rows, startDate, endDate };
}

// Returns rows shaped like the CSV files the scan already understands.
async function loadSite(token, siteUrl, onProgress) {
  const pages = await fetchRows(token, siteUrl, ["page"], (n) => onProgress && onProgress(`pages: ${n.toLocaleString()} rows`));
  const qp = await fetchRows(token, siteUrl, ["query", "page"], (n) => onProgress && onProgress(`queries: ${n.toLocaleString()} rows`));
  return {
    range: `${pages.startDate} – ${pages.endDate}`,
    pageRows: pages.rows.map(r => ({ "Top pages": r.keys[0], Clicks: r.clicks, Impressions: r.impressions, CTR: (r.ctr * 100).toFixed(2) + "%", Position: r.position })),
    queryRows: qp.rows.map(r => ({ query: r.keys[0], page: r.keys[1], clicks: r.clicks, impressions: r.impressions, position: r.position })),
  };
}

function revoke(token) {
  try { window.google?.accounts?.oauth2?.revoke(token, () => {}); } catch {}
}

export { signIn, listSites, loadSite, revoke };
