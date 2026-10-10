#!/usr/bin/env node
// Run the CanniScope analysis from the command line and print JSON.
//
//   node scripts/report.mjs <export.csv> [more.csv ...] [--brand "Name,Alias"] > out.json
//
// Takes the same files the web app does: a Search Console Pages export, a
// query+page CSV (Search Console API, Looker Studio), a crawler export with
// status codes, or a redirect/404 list. Output is the list of plain-English
// cards the app shows, so another report can embed them.

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { analyzePages } from "../src/lib/analyze.js";
import { analyzeQueries, pagesFromQueries, dropCovered } from "../src/lib/queries.js";
import { detectFile, buildDeadIndex } from "../src/lib/files.js";
import { explain, summarize } from "../src/lib/plain.js";

const args = process.argv.slice(2);
const brands = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--brand") brands.push(...String(args[++i] || "").split(","));
  else files.push(args[i]);
}
if (!files.length) {
  console.error("usage: node scripts/report.mjs <export.csv> [...] [--brand Name,Alias]");
  process.exit(1);
}

const parsed = files.map((f) => {
  const text = readFileSync(f, "utf8");
  const res = Papa.parse(text, { header: true, skipEmptyLines: true });
  return { file: f, ...detectFile(res.data, res.meta.fields) };
});

const pagesFile = parsed.find((p) => p.kind === "pages");
const queryFile = parsed.find((p) => p.kind === "queries");
const statusFiles = parsed.filter((p) => p.kind === "status");
if (!pagesFile && !queryFile) {
  console.error("no Search Console data recognised in: " + files.join(", "));
  process.exit(2);
}

const { isDead } = buildDeadIndex(statusFiles);
const pageRows = pagesFile ? pagesFile.rows : pagesFromQueries(queryFile.rows);
const slug = analyzePages(pageRows, { isDead });
const q = queryFile ? analyzeQueries(queryFile.rows, { isDead, brands }) : null;
const conflicts = q ? [...q.conflicts, ...dropCovered(q.conflicts, slug.conflicts).kept] : slug.conflicts;

const { todo, fixed } = summarize(conflicts);
const order = { broken: 0, fight: 1, steal: 2, choose: 3, tech: 4, maybe: 5 };
const cards = [...todo]
  .sort((a, b) => (order[explain(a).kind] - order[explain(b).kind]) || ((b.contested || b.totalImpressions || 0) - (a.contested || a.totalImpressions || 0)))
  .map((c) => {
    const e = explain(c);
    return {
      kind: e.kind,
      title: e.title,
      pages: e.pages,
      what: e.what,
      why: e.why,
      ifLeft: e.ifLeft,
      todo: e.todo,
      devNote: e.devNote,
      impressions: c.contested || c.totalImpressions || 0,
    };
  });

process.stdout.write(JSON.stringify({
  hasQueries: !!queryFile,
  pages: pageRows.length,
  toFix: cards.length,
  alreadyFixed: fixed.length,
  cards,
}, null, 1));
