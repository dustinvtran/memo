/**
 * @file Whether an entry may be attached to a work, and what that write is.
 *
 * The other half of ./work_ref_repair.js. That one fills in a work's missing
 * identity; this one is for the entries that have no work to fill in, and for
 * the works that should never have existed as works at all.
 *
 * **Three shapes, one question.** #343's backfill turned up all of them:
 *
 *   - **An entry with no `workRef`.** Written deliberately — something the
 *     databases did not have when it was added, so the title, year and genres
 *     live in `entry.overrides` and nothing refreshes. Once the API knows the
 *     work, the entry wants to be on it. `Avatar: Fire and Ash` is 23 of these.
 *   - **A work that is really a sub-work.** `Portal 2: Coop`, `Dragon Age 2:
 *     DLCs`, `Curb Your Enthusiasm Season 9` — a DLC pack, a season or a
 *     second run, filed as its own work document with no id of its own. It can
 *     never refresh, because the API has no such thing to refresh it from. The
 *     repair is not to give it an id: the base game's id is already on another
 *     work, and handing it out twice is the #290 collision on purpose. The
 *     entry moves onto the work that already answers, and carries the name as
 *     an override, which is how every other season in this database is stored.
 *   - **A work that is simply a duplicate.** `Red Cliff: Part One` beside a
 *     `Red Cliff` its owner had already watched.
 *
 * **This is the folder's one written exception to "never write to `*Entries`",
 * and it is narrow on purpose.** That rule exists because `entry.overrides`
 * holds text a person wrote and a population script cannot know what it means.
 * Nothing here is a population: every operation names one entry by id, and the
 * `entryTitle` it writes came from the same person, for that row, by hand. The
 * scripts that sweep are still forbidden.
 *
 * Pure and dependency-free: the reads, the retrieve and the writes live in
 * scripts/link_entry.js and the verdicts live here.
 */
const { parseApiRef, findApiRef, displayTitle, titlesAgree } = require("./work_collections");
const { filedAs } = require("../api/utils/entry_state");

/**
 * Why this entry cannot be attached here, or `undefined` if it can.
 *
 * Checked cheapest first, like `refusalReason` in ./work_ref_repair.js, and
 * for the same reason: the last two are the ones that cost a round trip.
 *
 * The one worth explaining is `siblings`. An entry is identified by its work
 * *and* the name it is filed under, so two entries on one work must differ in
 * their title override — that is what lets `Succession: Season 1` sit beside
 * `Season 2`, and what the partial unique index added in #362 enforces. A move
 * that lands a second untitled entry on a work would be refused by the index
 * at write time; refusing here means the batch says which row it was.
 *
 * @type {(args: {
 *   entry: any, work: any, ref?: string, collection: any, entryTitle?: string,
 *   siblings?: any[], holders?: any[],
 * }) => string | undefined}
 */
const linkRefusalReason = ({ entry, work, ref, collection, entryTitle, siblings, holders }) => {
  if (!entry) return "no entry with that id";

  if (ref !== undefined) {
    const parsed = parseApiRef(ref);
    if (!parsed) {
      return `"${ref}" is not a usable ref — it must read <prefix>__<id>, and a placeholder is not an id`;
    }
    if (parsed.name !== collection.retrievePrefix) {
      return `a ${collection.type} work is retrieved by ${collection.retrievePrefix}__, not ${parsed.name}__`;
    }
    // More than one work already under this id is #290 unrepaired, and picking
    // one of them here would be guessing which half is the misfiled one. Only
    // when the target is being *derived* from the ref, though: an operation
    // that names its `toWork` outright has had that choice made by a person,
    // and Curb Your Enthusiasm really does have two works under one id with a
    // season on each. Refusing there would refuse the repair for the sake of
    // a collision it is not touching.
    if (!work && holders && holders.length > 1) {
      return `${ref} already names ${holders.map(displayTitle).join(" and ")} — say which with toWork, or resolve the two first`;
    }
  }

  if (work) {
    if (!findApiRef(work.apiRefs, collection.retrievePrefix)) {
      return `work ${work._id} "${displayTitle(work)}" has no ${collection.retrievePrefix}__ ref of its own, so moving onto it fixes nothing`;
    }
    const name = nameAfter(entry, entryTitle);
    const clash = (siblings ?? []).find(
      (other) => String(other._id) !== String(entry._id) && filedAs(other) === name
    );
    if (clash) {
      return `${displayTitle(work)} already has an entry filed as ${name === null ? "the work's own title" : `"${name}"`} (${clash._id}) — give this one a different entryTitle, or merge the two`;
    }
  }

  return undefined;
};

/**
 * Why this entry and its work cannot be deleted, or `undefined` if they can.
 *
 * Deliberately thin. A delete here is only ever reached because a person read
 * both rows and said which one survives, so the checks are about the thing
 * they could not see: a note attached to the row they are dropping. `reviews`
 * does not refuse — the #342 rule is that the superseding note wins and the
 * older one goes — but an unread note is the one thing worth making loud, so
 * the caller is handed the count and prints the text before it writes.
 *
 * An entry with no work at all passes with an empty `otherEntries`, because
 * there is no work for anything else to be on. The caller is what knows not to
 * go looking for one.
 *
 * @type {(args: { entry: any, otherEntries?: any[] }) => string | undefined}
 */
const deleteRefusalReason = ({ entry, otherEntries }) => {
  if (!entry) return "no entry with that id";
  if (otherEntries?.length) {
    return `its work still has ${otherEntries.length} other entr${otherEntries.length === 1 ? "y" : "ies"} — this deletes a work only when the entry being deleted is its last`;
  }
  return undefined;
};

/**
 * What to write, once `linkRefusalReason` has said nothing.
 *
 * `overrides` is merged rather than replaced, because everything else in it —
 * a year, a director, the genres somebody typed — is theirs and none of it is
 * what this is changing.
 *
 * **`entryTitle` has three values, and the difference between two of them is
 * the whole reason this is written out.** A string sets the override. An empty
 * string removes it. *Leaving the field out* changes nothing — and that is the
 * default, because an entry with no work carries what was typed in exactly
 * this field, so treating "no instruction" as "clear it" would delete the
 * title of every entry it linked and report having attached them. Clearing a
 * field nobody asked about is the thing #359 refused to do on the server, for
 * the same reason: a tidy-up you did not ask for is data loss when you find it
 * six months later.
 *
 * @type {(args: { entry: any, workId: string, entryTitle?: string }) => {
 *   set: object, unset: object,
 * }}
 */
const linkUpdate = ({ entry, workId, entryTitle }) => {
  const set = { workRef: String(workId) };
  if (entryTitle === undefined) return { set, unset: {} };

  const title = normalise(entryTitle);
  if (title !== null) set["overrides.englishTranslatedTitle"] = title;
  return {
    set,
    // An unset rather than an empty string, so `filedAs` and the unique index
    // see the same absence they see on every other untitled entry.
    unset: title === null && filedAs(entry) !== null
      ? { "overrides.englishTranslatedTitle": "" }
      : {},
  };
};

/** The name the entry would be filed under after this write. */
const nameAfter = (entry, entryTitle) =>
  entryTitle === undefined ? filedAs(entry) : normalise(entryTitle);

/**
 * Whether the entry's own title is now saying what the work says.
 *
 * Not a refusal and not a write — something for the dry run to point out. An
 * entry that predates its work holds the title in `overrides`, and once it is
 * on a work that says the same thing that override has stopped being a name of
 * its own and started being a copy that no refresh will ever correct.
 * @type {(entry: any, work: any) => boolean}
 */
const overrideIsRedundant = (entry, work) => {
  const name = filedAs(entry);
  return name !== null && titlesAgree({ englishTranslatedTitle: name }, work) !== false;
};

/**
 * Why this work cannot be given the API's own title, or `undefined` if it can.
 *
 * **The rule this serves: a work is the database's copy of what an API says,
 * and a person's own name for it belongs on their entry, where it overlays
 * whatever the work later becomes.** Where that is not how a row is stored,
 * the work is frozen — `mergeWork`'s title guard (#290) refuses a response
 * whose title disagrees with the stored one, so a work called `Ozark: Season
 * 4` under Ozark's id, or `House M.D.` under *House*'s, never refreshes again.
 * 93 works are in that state and none of them is damaged; they are simply
 * named by their owner rather than by TMDB. #381.
 *
 * Renaming the work is only half the repair and the dangerous half on its own,
 * because the owner's name is then written down nowhere. So this never travels
 * alone: the op carrying it also files the entry under `entryTitle`, and the
 * two are one write.
 *
 * `workTitle` is checked against the retrieve for the same reason
 * `retitleWorkTo` is in ../work_ref_repair.js — naming the API's own title is
 * something you can only do having read it, and it is what tells "right id,
 * my own name for it" from a genuinely misfiled id. A guess is refused.
 *
 * @type {(args: {
 *   work: any, workTitle: string, entryTitle?: string,
 *   retrieved?: any, retrieveError?: string,
 * }) => string | undefined}
 */
const workTitleRefusalReason = ({ work, workTitle, entryTitle, retrieved, retrieveError }) => {
  if (!work) return "no work to rename";
  if (normalise(workTitle) === null) return "workTitle is empty — to leave the work's title alone, leave it out";

  // The half-repair guard. Without a name on the entry the owner's title
  // survives nowhere, and a refresh would be bought by losing it.
  //
  // `entryTitle` is three-valued here as everywhere else in this file, and the
  // difference between two of those values is the whole guard: **absent** means
  // nobody considered the old name, which is refused, while **empty** means
  // somebody looked at it and said to drop it, which is theirs to say. A work
  // filed as `The Witcher` under The Witcher IV's id is the case — the id is
  // right, the name is simply stale, and there is nothing worth keeping.
  if (entryTitle === undefined && displayTitle(work) !== workTitle) {
    return `renaming this work to "${workTitle}" would leave "${displayTitle(work)}" written down nowhere — give the entry that name with entryTitle, or pass "" to drop it`;
  }

  if (retrieveError) return `the API would not answer, so "${workTitle}" is unchecked: ${retrieveError}`;
  if (!retrieved) return `nothing answered, so "${workTitle}" is unchecked`;
  if (titlesAgree({ englishTranslatedTitle: workTitle }, retrieved) === false) {
    return `workTitle "${workTitle}" is not what the API answers with ("${displayTitle(retrieved)}") — give its own title, which is how this says you read it`;
  }
  return undefined;
};

/**
 * What to write to the work, once `workTitleRefusalReason` has said nothing.
 *
 * `metadataUpdatedDate` is dropped so the next refresh treats the work as
 * never checked — which is the whole point, since the work has been frozen by
 * the title guard for as long as it has been named this way, and everything
 * the API has learned about it since is still missing.
 *
 * The API's spelling rather than the one that was typed, exactly as
 * `refUpdate` does it: the two agree by now, and the API's is what every later
 * refresh compares against. `originalTitle` is left alone, because it is
 * fill-only and the refresh this unblocks is what fills it.
 * @type {(retrieved: any) => { set: object, unset: object }}
 */
const workTitleUpdate = (retrieved) => ({
  set: { englishTranslatedTitle: displayTitle(retrieved) },
  unset: { metadataUpdatedDate: "" },
});

module.exports = {
  linkRefusalReason,
  workTitleRefusalReason,
  workTitleUpdate,
  deleteRefusalReason,
  linkUpdate,
  nameAfter,
  overrideIsRedundant,
};

///////////////////////////////////////////////////////////////////////////////

/** A blank override is no override: see `filedAs`. */
const normalise = (title) =>
  typeof title === "string" && title.trim() !== "" ? title.trim() : null;
