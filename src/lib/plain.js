// ─── PLAIN-LANGUAGE VIEW ───
// The same findings, explained for a marketer or a business owner:
// what's wrong, what to do, and a ready-to-send note for whoever runs the site.

import { getPathname } from "./analyze.js";

const path = (u) => getPathname(u);
// "around position 28 (page 3 of Google)"
const pos = (n) => {
  if (!n) return "an unknown position";
  const r = Math.round(n);
  return `around position ${r} (page ${Math.max(1, Math.ceil(r / 10))} of Google)`;
};

// One card per cluster: { kind, title, story, todo, devNote, keep, other }
function explain(c) {
  const keep = c.pages.find(p => p.action === "KEEP") || c.winner;
  const other = c.pages.find(p => p.url !== keep.url) || c.loser;
  const K = path(keep.url), O = other ? path(other.url) : "";
  const top = c.topQueries && c.topQueries[0];

  // A fix that went wrong on the live site comes first: it's the most concrete.
  if (c.live && c.live.verdict === "broken") {
    const i = (c.live.issues || [])[0] || {};
    const U = i.url ? path(i.url) : "";
    const T = i.target ? path(i.target) : "";
    const devNote = c.live.problems.map((x, n) => `${n + 1}. ${x}`).join("\n");
    if (i.type === "deleted") return {
      kind: "broken",
      title: "A page you deleted still gets visitors from Google",
      story: `${U} was removed, but Google still sends people to it — ${i.clicks} visit${i.clicks === 1 ? "" : "s"} in the last 3 months. They land on a “page not found” screen and leave.`,
      todo: `Make ${U} forward visitors to ${i.keep ? path(i.keep) : "the closest page that still exists"}.`,
      devNote: `Add a 301 redirect: ${U} → ${i.keep ? path(i.keep) : "(closest live page)"}. The page returns 404 now but still gets clicks from Google.`,
    };
    if (i.type === "chain") return {
      kind: "broken",
      title: "An old address takes a long detour",
      story: `${U} jumps through ${i.hops} forwards before it reaches ${T}. Google may give up halfway and the page loses strength.`,
      todo: `Make ${U} forward straight to ${T}, in one step.`,
      devNote,
    };
    if (i.type === "temporary") return {
      kind: "broken",
      title: "An old page forwards visitors, but Google is told it's temporary",
      story: `${U} forwards to ${T} with a “temporary” redirect. Google keeps treating the old page as the real one.`,
      todo: `Change it to a permanent (301) redirect.`,
      devNote,
    };
    return {
      kind: "broken",
      title: "An old page forwards to a page that doesn't exist",
      story: `${U} forwards visitors to ${T}, and that page is gone.`,
      todo: `Point ${U} to a page that exists.`,
      devNote,
    };
  }

  if (c.isTechnical) {
    return {
      kind: "tech",
      title: "The same page opens at two addresses",
      story: `${K} also opens without the slash at the end. Google can count it as two pages.`,
      todo: "A small server setting fixes it. Send the note to your developer.",
      devNote: `Add a 301 redirect so ${O || K} always goes to ${K} (one trailing-slash rule for the whole site).`,
    };
  }

  const searchLine = top
    ? `People search “${top.query}”. Google shows ${K} ${pos(top.keep.position)} and ${O} ${pos(top.other.position)}${c.sharedQueries > 1 ? `, and it's the same for ${c.sharedQueries - 1} more search${c.sharedQueries - 1 === 1 ? "" : "es"}` : ""}.`
    : `Both pages are built for the same thing, so Google has to guess which one to show.`;

  if (c.actionType === "MERGE") {
    return {
      kind: "fight",
      title: "Two of your pages fight for the same Google search",
      story: `${searchLine} Google can't decide between them, so neither ranks as high as one strong page would.`,
      todo: `Keep ${K}. Move anything useful from ${O} into it, then have ${O} forward visitors to ${K}.`,
      devNote: [
        `1. Copy any unique content from ${O} into ${K}.`,
        `2. Add a 301 redirect: ${O} → ${K}.`,
        `3. Change internal links that point to ${O} so they point to ${K}.`,
        `4. Remove ${O} from the sitemap.`,
      ].join("\n"),
    };
  }

  if (c.actionType === "RETARGET") {
    const own = c.otherOwnQuery;
    return {
      kind: "fight",
      title: "Two of your pages fight for the same Google search",
      story: `${searchLine} Both pages are useful, they just need different jobs.`,
      todo: `Keep both. Let ${K} own “${top ? top.query : "this search"}”${own ? ` and give ${O} its own topic: “${own}”` : ` and give ${O} a different topic`}.`,
      devNote: [
        `1. ${O}: rewrite the title, H1 and first paragraph around ${own ? `“${own}”` : "its own topic"}; remove the phrase “${top ? top.query : ""}” from them.`,
        `2. ${O}: add one sentence linking to ${K} with the anchor “${top ? top.query : ""}”.`,
        `3. Don't redirect either page.`,
      ].join("\n"),
    };
  }

  if (c.actionType === "ARCHITECTURE") {
    return {
      kind: "steal",
      title: "A general page is taking searches from a more specific one",
      story: `${searchLine} ${K} is the page made for this, but ${O} keeps showing up instead.`,
      todo: `Keep both. Make ${O} point people to ${K} instead of competing with it.`,
      devNote: [
        `1. ${O}: remove this service's phrasing from the title, H1 and intro.`,
        `2. ${O}: add a short line linking to ${K} with the anchor “${top ? top.query : "the service name"}”.`,
        `3. ${K}: link back to ${O}.`,
        `4. Don't redirect ${K} — it's the page that should rank.`,
      ].join("\n"),
    };
  }

  if (c.actionType === "REVIEW" && c.isQuery) {
    return {
      kind: "choose",
      title: "Google prefers the page you probably didn't mean to rank",
      story: `${searchLine} The page with fewer views ranks higher. Someone needs to decide which page should own these searches.`,
      todo: `Pick the page you want customers to land on. Then give the other page a different topic.`,
      devNote: `Pages: ${K} and ${O}. Decide the owner by intent (which page converts), then rewrite the other page's title and H1 around a different search and link it to the owner.`,
    };
  }

  // URL-pattern match without search data.
  return {
    kind: "maybe",
    title: "Two pages look like they're built for the same thing",
    story: `${K} and ${O} have nearly the same address. Without search data we can't tell if they really compete${c.confidence === "LOW" ? ", and the match may be a coincidence (e.g. two different cities with the same name)" : ""}.`,
    todo: "Open both pages. If they say the same thing, keep one. If they're for different places or services, leave them.",
    devNote: `Compare ${K} and ${O}. If they target the same service and city, merge into one and 301 the other.`,
  };
}

// Headline numbers for the top of the simple view.
function summarize(conflicts) {
  const todo = conflicts.filter(c => !c.live || c.live.verdict === "real" || c.live.verdict === "unchecked" || c.live.verdict === "broken");
  const fixed = conflicts.filter(c => c.live && c.live.verdict === "fixed");
  const withTraffic = todo.filter(c => (c.contested || c.totalImpressions || 0) >= 100).length;
  return { todo, fixed, withTraffic };
}

export { explain, summarize };
