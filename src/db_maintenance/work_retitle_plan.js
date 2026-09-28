/**
 * @file Whether a work may be renamed to the title its own id answers with,
 * and what that write looks like.
 *
 * Pure and dependency-free, like ./work_ref_repair.js beside it: the decision
 * is here where the suite can reach it with no database and no API keys, and
 * scripts/retitle_work.js does the reads, the retrieve and the write.
 *
 * **Why this exists at all**, given that ./work_ref_repair.js already renames
 * a work. That one renames only as part of changing an id, and refuses a row
 * whose id is not changing — `already has <ref>; this fills a work that has
 * none`, and `<ref> is already this work's ref; there is nothing to replace`.
 * Both refusals are right for what that script is for. They leave a real
 * population with no tool: a work whose id is correct and whose *stored title*
 * is not, which the title guard then refuses for ever. #448 counted 126 of
 * those across films and games, and the largest group needs nothing but the
 * rename.
 *
 * **What keeps this from being a way to write anything you like into a work.**
 * The new title must be, character for character, what the work's own
 * identity ref answers with. Not a title that merely agrees with it under
 * `comparableTitle` — the same string. So the text is never invented and
 * never typed: it is transcribed from the API, and a row that gets it wrong
 * is refused exactly as a wrong id is. That is the same standard
 * `retitleWorkTo` is held to in ./work_ref_repair.js, tightened from "agrees"
 * to "is" because here there is no id change to justify the looser test.
 *
 * It follows that this can only ever move a work *towards* what the API says,
 * which is the one direction that unfreezes it. A person's own name for a
 * work lives on their entry and is not reachable from here — see
 * ../../docs/works_and_entries.md, and `link_entry.js` for the script that
 * does write entry text, and why it is allowed to.
 */
const { findApiRef, displayTitle, titlesAgree } = require("./work_collections");

/**
 * Why this work may not be renamed, or `undefined` if it may.
 *
 * The order matters: everything that can be decided without the API is
 * decided first, so a run does not spend a call to find out that a row was
 * unusable on its face.
 * @type {(args: {
 *   collection: any, work: any, retitleTo?: string,
 *   retrieved?: any, retrieveError?: string,
 * }) => string | undefined}
 */
const retitleRefusalReason = ({ collection, work, retitleTo, retrieved, retrieveError }) => {
  const wanted = typeof retitleTo === "string" ? retitleTo.trim() : "";
  if (wanted === "") return "no retitleTo given; this writes the API's own title and nothing else";

  // Without an identity ref there is nothing to check the new title against,
  // and checking it is the only thing standing between this and a free-text
  // write. A work in that state wants scripts/set_work_ref.js first.
  const prefix = collection?.retrievePrefix;
  const found = findApiRef(work?.apiRefs, prefix);
  if (!found) {
    return `no ${prefix}__ ref to check a new title against — give it one with set_work_ref.js first`;
  }
  const ref = `${prefix}__${found}`;

  if (retrieveError) return `${ref} could not be asked what it names (${retrieveError})`;
  if (!retrieved || displayTitle(retrieved) === "(untitled)") {
    return `${ref} answered with no title, so there is nothing to transcribe`;
  }

  // The guard. Character for character, not `titlesAgree`: a rename that only
  // *agrees* with the answer would let `Portal 2: Coop` through under
  // `Portal 2`, which is the shape ./work_ref_repair.js's comment calls out
  // and the reason a work's name is not a free-text field here.
  const answered = displayTitle(retrieved).trim();
  if (wanted !== answered) {
    return `retitleTo "${wanted}" is not what ${ref} names ("${answered}") — this writes the API's own title, which is how a row says it was read`;
  }

  // Nothing to do rather than something to refuse. A caller reports these
  // apart from the writes, the way "already current" is reported apart from
  // an update everywhere else in this folder.
  if (String(displayTitle(work)).trim() === answered) {
    return `already named "${answered}"`;
  }

  return undefined;
};

/**
 * What to write, once `retitleRefusalReason` has said nothing.
 *
 * One field. `originalTitle` is deliberately untouched: it is fill-only for
 * the reason ../../CLAUDE.md gives — overwriting a work's Japanese title with
 * a romaji one to get a playtime is a trade this folder has already made once
 * — and the adapters that answer here have never written it.
 *
 * `metadataUpdatedDate` is cleared so the work sorts to the head of the
 * refresh queue. It has just stopped being refused, and the whole point of
 * the rename is the refresh it now allows; leaving the stamp would hold it
 * back for up to the full `--max-age-days` window.
 * @type {(work: any, retitleTo: string) => { set: any, unset: any }}
 */
const retitleUpdate = (work, retitleTo) => ({
  set: { englishTranslatedTitle: String(retitleTo).trim() },
  unset: { metadataUpdatedDate: "" },
});

module.exports = { retitleRefusalReason, retitleUpdate };
