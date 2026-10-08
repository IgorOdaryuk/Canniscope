// ─── PLAIN-LANGUAGE VIEW ───
// The same findings, written for someone who doesn't do SEO:
// what's happening, why it matters, what happens if it's left alone, what to do,
// and a ready-to-send note for whoever runs the website.

import { getPathname } from "./analyze.js";

const path = (u) => getPathname(u);

// "on page 1 of Google (around #6)"
const where = (n) => {
  if (!n) return "somewhere in Google";
  const r = Math.round(n);
  return `on page ${Math.max(1, Math.ceil(r / 10))} of Google (around #${r})`;
};

// Card shape: { kind, title, pages: [{label, path}], what, why, ifLeft, todo, devNote }
function explain(c) {
  const keep = c.pages.find(p => p.action === "KEEP") || c.winner;
  const other = c.pages.find(p => p.url !== keep.url) || c.loser;
  const K = path(keep.url), O = other ? path(other.url) : "";
  const top = c.topQueries && c.topQueries[0];
  const more = c.sharedQueries > 1 ? ` The same happens for ${c.sharedQueries - 1} more search${c.sharedQueries - 1 === 1 ? "" : "es"}.` : "";
  const AB = [{ label: "Page A", path: K }, ...(O ? [{ label: "Page B", path: O }] : [])];

  // Something that was already "fixed", but the fix itself is wrong.
  if (c.live && c.live.verdict === "broken") {
    const i = (c.live.issues || [])[0] || {};
    const U = i.url ? path(i.url) : "";
    const T = i.target ? path(i.target) : "";
    const devNote = c.live.problems.map((x, n) => `${n + 1}. ${x}`).join("\n");
    if (i.type === "deleted") return {
      kind: "broken",
      title: "A page you deleted still gets visitors",
      pages: [{ label: "Deleted page", path: U }, ...(i.keep ? [{ label: "Send them here", path: path(i.keep) }] : [])],
      what: `This page was removed, but Google still sends people to it: ${i.clicks} visit${i.clicks === 1 ? "" : "s"} in the last 3 months. They see “page not found”.`,
      why: "Those are people who were looking for you and found you. Right now they hit a dead end.",
      ifLeft: "Visitors keep leaving from an error page, and after a while Google drops the page together with everything it had earned in search.",
      todo: `Ask your web person to forward the deleted page to ${i.keep ? "the page listed above" : "the closest page that still exists"}. It takes a few minutes.`,
      devNote: `Add a 301 redirect: ${U} → ${i.keep ? path(i.keep) : "(closest live page)"}. The page returns 404 now but still gets clicks from Google.`,
    };
    if (i.type === "chain") return {
      kind: "broken",
      title: "An old address takes a long detour",
      pages: [{ label: "Old address", path: U }, { label: "Where it ends up", path: T }],
      what: `When someone opens the old address, the site forwards them ${i.hops} times before they reach the right page.`,
      why: "Every extra jump is slower for visitors, and Google may stop following the chain.",
      ifLeft: "The right page slowly loses the credit the old address had built up.",
      todo: "Ask your web person to make the old address go straight to the right page, in one step.",
      devNote,
    };
    if (i.type === "temporary") return {
      kind: "broken",
      title: "An old page is forwarded, but Google is told it's temporary",
      pages: [{ label: "Old page", path: U }, { label: "New page", path: T }],
      what: "Visitors are sent from the old page to the new one, but the site tells Google this is only for now.",
      why: "Google waits for the old page to come back and doesn't give the new page full credit.",
      ifLeft: "The new page ranks lower than it could, and the old address can linger in Google.",
      todo: "Ask your web person to make the forward permanent.",
      devNote,
    };
    return {
      kind: "broken",
      title: "An old page forwards to a page that doesn't exist",
      pages: [{ label: "Old page", path: U }, { label: "Missing page", path: T }],
      what: "People who open the old page are sent to a page that's gone.",
      why: "They end up on an error screen.",
      ifLeft: "You keep losing those visitors, and Google stops showing the old page.",
      todo: "Ask your web person to point the old page to a page that exists.",
      devNote,
    };
  }

  if (c.isTechnical) {
    return {
      kind: "tech",
      title: "The same page opens at two addresses",
      pages: [{ label: "Address", path: K }, ...(O ? [{ label: "Also opens at", path: O }] : [])],
      what: "One page can be opened with and without the slash at the end.",
      why: "Google can see this as two copies of the same page.",
      ifLeft: "Usually a small loss, but over time the two copies can split the page's strength.",
      todo: "Ask your web person for one site-wide rule that always uses the same address.",
      devNote: `Add a 301 redirect so ${O || K} always goes to ${K} (one trailing-slash rule for the whole site).`,
    };
  }

  const search = (a, b) => top
    ? `People search “${top.query}”. Google shows ${a} ${where(top.keep.position)} and ${b} ${where(top.other.position)}.${more}`
    : "Both pages are made for the same thing, so Google has to guess which one to show.";

  if (c.actionType === "MERGE") {
    return {
      kind: "fight",
      title: "Two of your pages compete for the same search",
      pages: AB,
      what: search("Page A", "Page B"),
      why: "Google can't tell which page is the right answer, so it splits its attention between them. Two half-strong pages rank lower than one strong page.",
      ifLeft: "Both pages stay lower than they could be, and fewer people find you for this search.",
      todo: "Keep Page A. Move anything useful from Page B into it, then have Page B forward visitors to Page A.",
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
      title: "Two of your pages compete for the same search",
      pages: AB,
      what: search("Page A", "Page B"),
      why: "Both pages are useful, but right now they do the same job. Google splits its attention between them.",
      ifLeft: "Neither page ranks as well as it could for this search.",
      todo: `Keep both, but give them different jobs. Page A stays about “${top ? top.query : "this search"}”. Page B should be about ${own ? `“${own}”` : "something else"} and link to Page A.`,
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
      title: "A general page shows up instead of the right one",
      pages: [{ label: "Right page", path: K }, ...(O ? [{ label: "General page", path: O }] : [])],
      what: search("the right page", "the general page"),
      why: "The right page was made exactly for this search, but Google often picks the general page instead.",
      ifLeft: "People land on a page that's only partly about what they need, have to look further, and many leave.",
      todo: "Keep both. On the general page, add a short line that sends people to the right page, and stop the general page from describing this service in detail.",
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
      title: "Google picks a page you probably didn't mean",
      pages: AB,
      what: search("Page A", "Page B"),
      why: "The page Google ranks higher isn't the one that gets most of the attention. It's unclear which page should answer this search.",
      ifLeft: "Visitors may land on the page that's worse at turning them into customers.",
      todo: "Decide which page you want people to land on for this search. Then give the other page a different topic and link it to the chosen one.",
      devNote: `Pages: ${K} and ${O}. Decide the owner by intent (which page converts), then rewrite the other page's title and H1 around a different search and link it to the owner.`,
    };
  }

  // URL-pattern match without search data.
  return {
    kind: "maybe",
    title: "Two pages look like they're made for the same thing",
    pages: AB,
    what: "Their addresses are almost the same. We don't have search data to confirm they really compete.",
    why: c.confidence === "LOW" ? "It may also be a coincidence, for example two different cities with the same name." : "If they say the same thing, Google will split its attention between them.",
    ifLeft: "If they're real duplicates, both rank lower than one page would. If they're different, nothing happens.",
    todo: "Open both pages. If they say the same thing, keep one. If they're for different places or services, leave them.",
    devNote: `Compare ${K} and ${O}. If they target the same service and city, merge into one and 301 the other.`,
  };
}

// Headline numbers for the top of the simple view.
function summarize(conflicts) {
  const todo = conflicts.filter(c => !c.live || c.live.verdict === "real" || c.live.verdict === "unchecked" || c.live.verdict === "broken");
  const fixed = conflicts.filter(c => c.live && c.live.verdict === "fixed");
  return { todo, fixed };
}

export { explain, summarize };
