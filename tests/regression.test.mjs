// Regression cases taken from a real multi-location audit, rebuilt on example.com.
// Run: npm test
import assert from "node:assert/strict";
import { analyzePages } from "../src/lib/analyze.js";
import { analyzeQueries } from "../src/lib/queries.js";
import { detectFile, buildDeadIndex } from "../src/lib/files.js";
import { judgeCluster, withLive } from "../src/lib/live.js";
import { dropCovered } from "../src/lib/queries.js";

const S = "https://example.com";
const page = (path, impressions = 100, clicks = 1, position = 10) =>
  ({ "Top pages": S + path, Clicks: clicks, Impressions: impressions, CTR: "1%", Position: position });

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
};
const urlsOf = (c) => c.pages.map(p => p.url.replace(S, "")).sort();
const findCluster = (res, a, b) => res.conflicts.find(c => {
  const u = urlsOf(c);
  return u.includes(a) && u.includes(b);
});

// ── slug mode ──

test("Dallas GA vs a stateless Dallas page is never auto-redirected", () => {
  const res = analyzePages([
    page("/service-area/icemaker-repair-dallas/", 1500, 3, 20),
    page("/locations/atlanta/icemaker-repair-dallas-ga/", 300, 1, 12),
  ]);
  const c = findCluster(res, "/service-area/icemaker-repair-dallas/", "/locations/atlanta/icemaker-repair-dallas-ga/");
  assert.ok(c, "pair should still be shown for a human check");
  assert.equal(c.actionType, "REVIEW");
  assert.equal(c.confidence, "LOW");
  assert.equal(c.risk, "LOW", "a geography guess must not land in 'fix first'");
});

test("dallas-ga and dallas-tx never share a cluster", () => {
  const res = analyzePages([
    page("/washer-repair-dallas-ga/"),
    page("/washer-repair-dallas-tx/"),
  ]);
  assert.equal(res.conflicts.filter(c => !c.isTechnical).length, 0);
});

test("miami-city matches miami, but only as a manual review", () => {
  const res = analyzePages([
    page("/locations/miami/dryer-repair-miami-city-fl/", 20),
    page("/service-area/dryer-repair-in-miami-fl/", 300),
  ]);
  const c = findCluster(res, "/locations/miami/dryer-repair-miami-city-fl/", "/service-area/dryer-repair-in-miami-fl/");
  assert.ok(c, "loose geo match should be found");
  assert.equal(c.actionType, "REVIEW");
});

test("trailing-slash duplicate of a service page is technical, not an intent conflict", () => {
  const res = analyzePages([
    page("/service-area/cooktop-repair-in-jacksonville-fl/", 200),
    page("/service-area/cooktop-repair-in-jacksonville-fl", 5),
  ]);
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].isTechnical, true);
});

test("URLs on the redirect list are left out and counted as resolved", () => {
  const rows = [
    page("/appliance-repair/", 900, 20, 6),
    page("/service-area/appliance-repair/", 400, 5, 3),
  ];
  assert.ok(analyzePages(rows).conflicts.length >= 1, "without the list the pair is flagged");
  const { isDead } = buildDeadIndex([{ hasStatus: false, rows: [{ url: S + "/appliance-repair/" }] }]);
  const res = analyzePages(rows, { isDead });
  assert.equal(res.conflicts.length, 0);
  assert.equal(res.resolvedClusters, 1);
  assert.equal(res.ignoredCounts.dead, 1);
});

test("city in a folder: same service in two cities is not a duplicate", () => {
  const res = analyzePages([
    page("/locations/ga/atlanta/appliance-repair/", 500, 5, 4),
    page("/locations/ga/marietta/appliance-repair/", 300, 3, 6),
    page("/locations/tx/dallas/appliance-repair/", 200, 2, 8),
  ]);
  assert.equal(res.conflicts.filter(c => !c.isTechnical).length, 0);
});

test("city in a folder still matches the same city named in a slug", () => {
  const res = analyzePages([
    page("/locations/ga/atlanta/dryer-repair/", 500, 5, 4),
    page("/dryer-repair-atlanta-ga/", 400, 4, 5),
  ]);
  assert.ok(findCluster(res, "/locations/ga/atlanta/dryer-repair/", "/dryer-repair-atlanta-ga/"));
});

test("same city in folders of two states never share a cluster", () => {
  const res = analyzePages([
    page("/locations/ga/columbus/washer-repair/"),
    page("/locations/oh/columbus/washer-repair/"),
  ]);
  assert.equal(res.conflicts.filter(c => !c.isTechnical).length, 0);
});

test("a plain category folder is not read as a city", () => {
  const res = analyzePages([
    page("/appliances/oven-repair/", 500, 5, 4),
    page("/services/oven-repair/", 400, 4, 5),
  ]);
  assert.ok(findCluster(res, "/appliances/oven-repair/", "/services/oven-repair/"));
});

test("informational pages are counted as informational", () => {
  const res = analyzePages([page("/about-us/"), page("/contact-us/")]);
  assert.equal(res.ignoredCounts.informational, 2);
});

// ── file detection ──

test("crawler export only marks non-2xx rows as dead", () => {
  const f = detectFile(
    [{ Address: S + "/a/", "Status Code": "301", "Redirect URL": S + "/b/" }, { Address: S + "/b/", "Status Code": "200" }],
    ["Address", "Status Code", "Redirect URL"],
  );
  assert.equal(f.kind, "status");
  const { isDead } = buildDeadIndex([f]);
  assert.equal(isDead(S + "/a/"), true);
  assert.equal(isDead(S + "/b/"), false);
});

test("query + page CSV is detected", () => {
  const f = detectFile([{ query: "x", page: S + "/", clicks: "1", impressions: "10", position: "3" }], ["query", "page", "clicks", "impressions", "position"]);
  assert.equal(f.kind, "queries");
});

// ── query mode ──

const q = (query, path, impressions, position = 10, clicks = 0) => ({ query, page: S + path, impressions, position, clicks });
const qRows = [
  // real overlap: two pages for the same city and service
  q("refrigerator repair tampa", "/refrigerator-repair-tampa-bay/", 57, 9),
  q("refrigerator repair tampa", "/service-area/refrigerator-repair-in-tampa-fl/", 89, 7),
  q("fridge repair tampa", "/refrigerator-repair-tampa-bay/", 57, 8),
  q("fridge repair tampa", "/service-area/refrigerator-repair-in-tampa-fl/", 29, 12),
  q("freezer repair tampa", "/refrigerator-repair-tampa-bay/", 65, 9),
  q("freezer repair tampa", "/service-area/refrigerator-repair-in-tampa-fl/", 56, 10),
  // generic query, pages for different cities: Google localizes, not cannibalization
  q("ice maker repair", "/service-area/icemaker-repair-houston/", 490, 38),
  q("ice maker repair", "/service-area/icemaker-repair-in-atlanta-ga/", 400, 30),
  q("ice machine repair", "/service-area/icemaker-repair-houston/", 300, 35),
  q("ice machine repair", "/service-area/icemaker-repair-in-atlanta-ga/", 280, 33),
  // ...while each city page is mostly found by its own city
  q("ice maker repair houston", "/service-area/icemaker-repair-houston/", 900, 6),
  q("ice maker repair atlanta", "/service-area/icemaker-repair-in-atlanta-ga/", 800, 5),
  // two posts about one product with different wording: real overlap, not localization
  q("jolana d bass", "/blog/jolana-d-bass-guitar-review/", 255, 6.4),
  q("jolana d bass", "/blog/jolana-d-bass-why-this-socialist-era-guitar-still-holds-up/", 162, 6.7),
  q("jolana d-bass", "/blog/jolana-d-bass-guitar-review/", 45, 5.2),
  q("jolana d-bass", "/blog/jolana-d-bass-why-this-socialist-era-guitar-still-holds-up/", 37, 7.5),
  // brand query on many pages
  q("examplefix reviews", "/service-area/icemaker-repair-houston/", 200, 2),
  q("examplefix reviews", "/service-area/icemaker-repair-in-atlanta-ga/", 200, 2),
  q("example fix", "/service-area/icemaker-repair-houston/", 200, 2),
  q("example fix", "/service-area/icemaker-repair-in-atlanta-ga/", 200, 2),
];

test("query mode finds two pages competing for the same city searches", () => {
  const res = analyzeQueries(qRows, { brands: ["examplefix", "example fix"] });
  const c = findCluster(res, "/refrigerator-repair-tampa-bay/", "/service-area/refrigerator-repair-in-tampa-fl/");
  assert.ok(c, "Tampa pair should be found");
  assert.equal(c.sharedQueries, 3);
});

test("query mode ignores generic searches split between different cities", () => {
  const res = analyzeQueries(qRows, { brands: ["examplefix", "example fix"] });
  assert.ok(!findCluster(res, "/service-area/icemaker-repair-houston/", "/service-area/icemaker-repair-in-atlanta-ga/"));
  assert.ok(res.stats.localizedSkips >= 2);
});

test("query mode flags two posts about the same product despite different wording", () => {
  const res = analyzeQueries(qRows, { brands: ["examplefix", "example fix"] });
  assert.ok(findCluster(res, "/blog/jolana-d-bass-guitar-review/", "/blog/jolana-d-bass-why-this-socialist-era-guitar-still-holds-up/"));
});

test("query mode ignores brand searches", () => {
  const res = analyzeQueries(qRows, { brands: ["examplefix", "example fix"] });
  assert.equal(res.stats.brandQueries, 2);
});

test("query mode drops URLs on the redirect list", () => {
  const { isDead } = buildDeadIndex([{ hasStatus: false, rows: [{ url: S + "/refrigerator-repair-tampa-bay/" }] }]);
  const res = analyzeQueries(qRows, { isDead, brands: ["examplefix"] });
  assert.ok(!findCluster(res, "/refrigerator-repair-tampa-bay/", "/service-area/refrigerator-repair-in-tampa-fl/"));
});

test("tracking tags and #anchors count as the same page", () => {
  const f = detectFile([
    { "Top pages": S + "/", Clicks: "10", Impressions: "1000", CTR: "1%", Position: "10" },
    { "Top pages": S + "/?utm_source=gbp&utm_medium=referral", Clicks: "5", Impressions: "250", CTR: "2%", Position: "4" },
    { "Top pages": S + "/#about", Clicks: "0", Impressions: "8", CTR: "0%", Position: "11" },
  ], ["Top pages", "Clicks", "Impressions", "CTR", "Position"]);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].Impressions, 1258);
  assert.equal(f.mergedVariants, 2);
});

const q2 = [
  // a city hub and an office-cleaning page in another city, generic search: localized
  q("office cleaning service", "/cleaning-service-san-marcos-tx/", 43, 9),
  q("office cleaning service", "/services/office-cleaning-killeen-tx/", 11, 13),
  q("commercial cleaning services", "/cleaning-service-san-marcos-tx/", 21, 15),
  q("commercial cleaning services", "/services/office-cleaning-killeen-tx/", 15, 8),
  // a city hub outranking that city's dedicated service page: real overlap
  q("post construction cleaning austin", "/cleaning-service-austin-tx/", 17, 9),
  q("post construction cleaning austin", "/services/post-construction-cleaning-austin-tx/", 27, 37),
  q("construction site cleaning austin tx", "/cleaning-service-austin-tx/", 21, 8),
  q("construction site cleaning austin tx", "/services/post-construction-cleaning-austin-tx/", 83, 52),
  // two price posts sharing a long common prefix: not a template, real overlap
  q("san antonio house cleaning prices", "/blog/house-cleaning-cost-san-antonio-austin.html", 13, 21),
  q("san antonio house cleaning prices", "/blog/house-cleaning-prices-central-texas-2026.html", 37, 11),
  q("how much to pay for house cleaning in san antonio", "/blog/house-cleaning-cost-san-antonio-austin.html", 16, 5),
  q("how much to pay for house cleaning in san antonio", "/blog/house-cleaning-prices-central-texas-2026.html", 17, 3),
];

test("pages for different places on different URL templates are not paired on generic searches", () => {
  const res = analyzeQueries(q2);
  assert.ok(!findCluster(res, "/cleaning-service-san-marcos-tx/", "/services/office-cleaning-killeen-tx/"));
});

test("a city hub competing with its own city's service page is reported", () => {
  const res = analyzeQueries(q2);
  assert.ok(findCluster(res, "/cleaning-service-austin-tx/", "/services/post-construction-cleaning-austin-tx/"));
});

test("posts that only share a prefix are not treated as a URL template", () => {
  const res = analyzeQueries(q2);
  assert.ok(findCluster(res, "/blog/house-cleaning-cost-san-antonio-austin.html", "/blog/house-cleaning-prices-central-texas-2026.html"));
});

// ── live check verdicts ──

const A = S + "/refrigerator-repair-tampa/", B = S + "/service-area/refrigerator-repair-in-tampa-fl/";
const cl = { pages: [{ url: A, clicks: 3, impressions: 300 }, { url: B, clicks: 9, impressions: 600 }] };
const ok = (url) => ({ url, status: 200, finalUrl: url, finalStatus: 200, hops: 0, canonical: url, noindex: false });
const judge = (ra, rb) => judgeCluster(cl, new Map([[A, ra], [B, rb]]));

test("both pages live and self-canonical → real problem", () => {
  assert.equal(judge(ok(A), ok(B)).verdict, "real");
});
test("one page 301s to the other → already fixed", () => {
  assert.equal(judge({ url: A, status: 301, finalUrl: B, finalStatus: 200, hops: 1 }, ok(B)).verdict, "fixed");
});
test("canonical to the other page → already fixed", () => {
  assert.equal(judge({ ...ok(A), canonical: B }, ok(B)).verdict, "fixed");
});
test("noindex on one page → already fixed", () => {
  assert.equal(judge({ ...ok(A), noindex: true }, ok(B)).verdict, "fixed");
});
test("404 on a page that had clicks → fixed with a mistake", () => {
  const v = judge({ url: A, status: 404, finalUrl: A, finalStatus: 404, hops: 0 }, ok(B));
  assert.equal(v.verdict, "broken");
  assert.match(v.problems[0], /301/);
});
test("redirect chain → fixed with a mistake", () => {
  assert.equal(judge({ url: A, status: 301, finalUrl: B, finalStatus: 200, hops: 3 }, ok(B)).verdict, "broken");
});
test("temporary 302 → fixed with a mistake", () => {
  assert.equal(judge({ url: A, status: 302, finalUrl: B, finalStatus: 200, hops: 1 }, ok(B)).verdict, "broken");
});
test("check failed for one page → not checked, stays in the main list", () => {
  assert.equal(judge({ url: A, error: "timeout" }, ok(B)).verdict, "unchecked");
});
test("trailing slash only differs in canonical → still self-canonical", () => {
  assert.equal(judge({ ...ok(A), canonical: A.replace(/\/$/, "") }, ok(B)).verdict, "real");
});

test("a broad hub outranking the dedicated service page is never told to merge it", () => {
  const rows = [
    q("dryer repair austin", "/appliance-repair-austin-tx/", 140, 6.2, 2),
    q("dryer repair austin", "/services/dryer-repair-austin-tx/", 90, 21.5),
    q("dryer not heating repair austin tx", "/appliance-repair-austin-tx/", 60, 7.4),
    q("dryer not heating repair austin tx", "/services/dryer-repair-austin-tx/", 55, 18.0),
  ];
  const c = analyzeQueries(rows).conflicts[0];
  assert.ok(c);
  assert.notEqual(c.actionType, "MERGE");
  assert.equal(c.winner.url, S + "/services/dryer-repair-austin-tx/");
});

test("a URL-pattern cluster already reported by query data is not shown twice", () => {
  const qc = [{ pages: [{ url: A }, { url: B }] }];
  const sc = [{ pages: [{ url: A }, { url: B }] }, { pages: [{ url: S + "/x/" }, { url: S + "/y/" }] }];
  assert.equal(dropCovered(qc, sc).kept.length, 1);
});

test("in an already-fixed pair the live page is the one marked KEEP", () => {
  const c = { actionType: "MERGE", winner: { url: A }, pages: [{ url: A, action: "KEEP", clicks: 3 }, { url: B, action: "MERGE", clicks: 9 }] };
  const r = withLive(c, new Map([[A, { url: A, status: 301, finalUrl: B, finalStatus: 200, hops: 1 }], [B, ok(B)]]));
  assert.equal(r.live.verdict, "fixed");
  assert.equal(r.winner.url, B);
  assert.equal(r.pages.find(p => p.url === B).action, "KEEP");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
