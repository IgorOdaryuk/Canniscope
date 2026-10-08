// Regression cases taken from a real multi-location audit, rebuilt on example.com.
// Run: npm test
import assert from "node:assert/strict";
import { analyzePages } from "../src/lib/analyze.js";
import { analyzeQueries } from "../src/lib/queries.js";
import { detectFile, buildDeadIndex } from "../src/lib/files.js";

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

test("query mode ignores brand searches", () => {
  const res = analyzeQueries(qRows, { brands: ["examplefix", "example fix"] });
  assert.equal(res.stats.brandQueries, 2);
});

test("query mode drops URLs on the redirect list", () => {
  const { isDead } = buildDeadIndex([{ hasStatus: false, rows: [{ url: S + "/refrigerator-repair-tampa-bay/" }] }]);
  const res = analyzeQueries(qRows, { isDead, brands: ["examplefix"] });
  assert.ok(!findCluster(res, "/refrigerator-repair-tampa-bay/", "/service-area/refrigerator-repair-in-tampa-fl/"));
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
