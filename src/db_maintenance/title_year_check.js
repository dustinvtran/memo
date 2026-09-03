/**
 * @file What it means when two work documents claim the same title and the
 * same release year, and what an adapter's answers say about whether they are
 * one work or several.
 *
 * `groupWorksByApiRef` in ./work_dedupe_plan.js groups on the identity ref, so
 * everything built on it — the dedupe, and ./shared_ref_check.js — can only
 * see one work filed twice **under one id**. The opposite case, one work filed
 * twice under **two different ids**, shares no key with itself and nothing
 * looked for it. `system shock` and `demon's souls` each have two IGDB ids,
 * one entry apiece, and so appear twice on `/games/nil` today. #319.
 *
 * Title and year is a much weaker key than an id, and this module exists to be
 * honest about that rather than to act on it. CLAUDE.md's warning that a
 * shared apiRef is not proof two documents are the same work applies with more
 * force to a shared name: `mother|2009` is three different films, and
 * `stalker|1979` is 83 minutes under one tmdb id and 162 under another —
 * Tarkovsky's is the 162. So a group is split by what actually discriminates,
 * and none of the three buckets is a licence to merge:
 *
 *   - **Duplicates.** Two ids, but an independent source gave both documents
 *     the same secondary id, or both hold the same duration. `system shock`
 *     and `demon's souls` carry one hltb id across two igdb ids.
 *   - **Unidentified.** One side carries no identity ref at all, so it can
 *     never be refreshed, and the title is the only thing connecting it to the
 *     document that can be. #308 made two of these by taking a misfiled id
 *     back off a work, which is the good outcome — the pair is only findable
 *     from here.
 *   - **Undecided.** Nothing but the title and the year agree. Most of the
 *     films are here and always will be, so this is a note in the audit rather
 *     than damage.
 *
 * Which of those a group really is can be *asked*, the same way #290 and #299
 * ask about a shared id: retrieve each of the ids and see whether the answers
 * describe one work. `resolveTitleYear` turns the answers into a verdict, and
 * `scripts/audit_database.js --verify-title-years` is what spends the calls.
 *
 * **What the answers are about is the ids, and not the documents**, which the
 * first verified run made unmissable. Fifteen of the nineteen groups hold two
 * documents that agree on a title, a year and often a duration, and two ids
 * that name different things: `tmdb__336843` is Maze Runner: The Death Cure
 * and the document wearing it is called Cure, `igdb__15103` is Flight Control
 * under a document called Control, `igdb__132640` is a fan game called Super
 * Mario Odyssey 64. That is #290's damage — a work filed under an id belonging
 * to something else — reached from the side a shared id cannot be seen from,
 * and it is emphatically not a licence to collapse the pair: the surviving
 * document would need the right id, which is a decision and not a rule. Hence
 * detect and classify, and `scripts/dedupe_works.js` left alone.
 *
 * A work with no title, or with no numeric release year, has no key here and
 * is skipped — 154 of the 3914 works today. They are already reported, by
 * name, as missing metadata fields, and a group keyed on a blank would put
 * unrelated works in one another's company for the sake of a bigger number.
 *
 * Pure and dependency-free like its neighbours — the reads and the API calls
 * live in scripts/audit_database.js and ./load_adapter.js — so the grouping
 * and the classification are covered by the no-install suite
 * (./title_year_check.test.js).
 */
const {
  parseApiRef,
  normalizeTitle,
  displayTitle,
  titlesOf,
  titlesAgree,
} = require("./work_collections");
const { groupKey } = require("./work_dedupe_plan");
const { describeWork } = require("./shared_ref_check");

/**
 * The key two documents have to agree on to be looked at at all:
 * `<normalised title>|<year>`.
 *
 * `normalizeTitle` rather than a bare lowercase, so the comparison is the one
 * the rest of these modules already make — "Squidgame" and "Squid Game" are
 * the same name, and that pair is real. `displayTitle` rather than every title
 * a work carries, so a work lands in exactly one group; matching on either
 * title would put some works in two, and "this group is a duplicate" would
 * become a claim about a group overlapping another.
 *
 * Undefined — no key, so no group — for a work with no title of any kind, and
 * for one whose `releaseYear` is not a number. `displayTitle` answers
 * "(untitled)" for the first, which would otherwise be a perfectly good key
 * that several unrelated works share.
 * @type {(work: any) => string | undefined}
 */
const titleYearKey = (work) => {
  if (titlesOf(work).length === 0) return undefined;
  const year = work?.releaseYear;
  if (typeof year !== "number" || !Number.isFinite(year)) return undefined;
  return `${normalizeTitle(displayTitle(work))}|${year}`;
};

/** @type {(works: any[]) => Map<string, any[]>} */
const groupWorksByTitleYear = (works) => {
  const groups = new Map();
  for (const work of works) {
    const key = titleYearKey(work);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), work]);
  }
  return groups;
};

/**
 * Every title-and-year group worth reporting, split into the three things a
 * group can be. A group of one is not a group and never appears.
 *
 * A group whose works all sit under **one** identity ref is left out entirely:
 * that is the finding ./shared_ref_check.js already reports, and the point of
 * this check is the case it cannot see. A group where two of three share an id
 * and the third does not is still returned in full — the third is what makes
 * it a finding.
 *
 * @type {(collection: any, works: any[], entries?: any[]) => {
 *   duplicates: object[],
 *   unidentified: object[],
 *   undecided: object[],
 * }}
 */
const classifyTitleYearGroups = (collection, works, entries = []) => {
  const entryCounts = countEntriesByWorkRef(entries);
  const result = { duplicates: [], unidentified: [], undecided: [] };

  for (const [key, group] of groupWorksByTitleYear(works)) {
    if (group.length < 2) continue;

    const identityKeys = group.map((work) => groupKey(collection, work));
    if (identityKeys.every((k) => k !== undefined && k === identityKeys[0])) {
      continue;
    }

    const described = describeTitleYearGroup(collection, key, group, entryCounts);
    // `reason` on the group rather than only on the printed line, so a
    // `--json` report says why it put a pair where it did.
    result[bucketOf(described)].push({
      ...described,
      reason: reasonFor(described),
    });
  }

  return result;
};

/**
 * One group as the report holds it: the works with the three signals that
 * discriminate attached to each, the distinct ids to ask about, and a sentence
 * saying which signal put it in its bucket.
 *
 * The signals are per-work rather than summarised away, because a reader
 * settles most of these without an API call and only can if the numbers are
 * next to the titles: 83 against 162 is two films, 780 against 780 is one
 * game, and "1 entry, 1 entry" is a game a reader is looking at twice.
 * @type {(collection: any, key: string, works: any[], entryCounts: Map<any, number>) => object}
 */
const describeTitleYearGroup = (collection, key, works, entryCounts) => {
  const described = works.map((work) => ({
    ...describeWork(work),
    identityRef: identityRefOfWork(collection, work)?.apiRef ?? null,
    duration: usableDuration(work),
    entries: entryCounts.get(work._id) ?? 0,
  }));

  const durations = described.map((work) => work.duration);

  return {
    key,
    title: displayTitle(works[0]),
    releaseYear: works[0].releaseYear,
    works: described,
    refs: distinctIdentityRefs(collection, works),
    signals: {
      sharedRefs: sharedSecondaryRefs(collection, works),
      sameDuration:
        durations.every((d) => d !== undefined) &&
        new Set(durations).size === 1,
      withoutIdentityRef: described.filter((w) => w.identityRef === null).length,
      // Two documents both with entries is the one signal a reader can see
      // without this script: the work is listed twice on the site today.
      listedTwice: described.filter((w) => w.entries > 0).length > 1,
    },
  };
};

/**
 * Which bucket a described group belongs in, most specific first.
 *
 * "One of them has no id" wins over the duration signal because it is a
 * different problem with a different repair: nothing can refresh that document
 * whatever it turns out to be, and the pair is invisible to every other check
 * here. A shared *secondary* ref counts and a shared identity ref cannot,
 * since a group that agreed on an identity ref never got this far.
 * @type {(group: any) => "duplicates" | "unidentified" | "undecided"}
 */
const bucketOf = (group) => {
  const { withoutIdentityRef, sharedRefs, sameDuration } = group.signals;
  if (withoutIdentityRef > 0 && withoutIdentityRef < group.works.length) {
    return "unidentified";
  }
  if (sharedRefs.length > 0 || sameDuration) return "duplicates";
  return "undecided";
};

/**
 * Why the group is where it is, as a line to print beside it. One sentence,
 * built here rather than in the script, so the reasoning is asserted in
 * ./title_year_check.test.js along with the bucket it explains.
 * @type {(group: any) => string}
 */
const reasonFor = (group) => {
  const { sharedRefs, sameDuration, withoutIdentityRef, listedTwice } =
    group.signals;
  const seen = listedTwice ? "; both are listed on the site today" : "";

  if (withoutIdentityRef > 0 && withoutIdentityRef < group.works.length) {
    return (
      `${withoutIdentityRef} of ${group.works.length} carry no identity ref, ` +
      `so only the title connects them${seen}`
    );
  }
  if (sharedRefs.length > 0) {
    return `filed under one ${sharedRefs.join(", ")} across ${
      group.refs.length
    } identity refs${seen}`;
  }
  if (sameDuration) {
    return `identical duration (${group.works[0].duration} min)${seen}`;
  }
  return `only the title and the year agree (durations ${group.works
    .map((work) => work.duration ?? "none")
    .join(" / ")})${seen}`;
};

/**
 * The identity ref a work is filed under: the display spelling and the bare id
 * `retrieve` wants, in `identityPrefixes` order so the prefix the type is
 * retrieved by wins. Books are the reason the list is walked — `ISBN__` and
 * `google__` name the same ISBN, and some documents carry only the second.
 * @type {(collection: any, work: any) => { apiRef: string, ref: string } | undefined}
 */
const identityRefOfWork = (collection, work) => {
  const refs = (Array.isArray(work?.apiRefs) ? work.apiRefs : [])
    .map(parseApiRef)
    .filter((ref) => ref);

  for (const prefix of collection?.identityPrefixes ?? []) {
    const match = refs.find((ref) => ref.name === prefix);
    if (match) return { apiRef: `${match.name}__${match.ref}`, ref: match.ref };
  }
  return undefined;
};

/**
 * The ids to ask the adapter about, deduplicated: a group of three where two
 * agree is two questions, not three.
 * @type {(collection: any, works: any[]) => Array<{ apiRef: string, ref: string }>}
 */
const distinctIdentityRefs = (collection, works) => {
  const byRef = new Map();
  for (const work of works) {
    const identity = identityRefOfWork(collection, work);
    if (identity && !byRef.has(identity.apiRef)) {
      byRef.set(identity.apiRef, identity);
    }
  }
  return [...byRef.values()];
};

/**
 * Refs more than one work in the group carries under a prefix that does *not*
 * establish identity — in practice `hltb__`, the legacy HowLongToBeat id 775
 * games still hold.
 *
 * It is the strongest signal here precisely because it comes from somewhere
 * else: two documents under two IGDB ids that a third party gave the same id
 * are one game. Only games have such a prefix; for films, tv and books
 * `apiRefPrefixes` and `identityPrefixes` are the same list, so this is always
 * empty and the duration is all there is.
 *
 * `parseApiRef` drops the placeholders, which matters more here than anywhere:
 * 27 games carry `hltb__N/A`, and counting that as a shared ref would call
 * every one of them a duplicate of every other.
 * @type {(collection: any, works: any[]) => string[]}
 */
const sharedSecondaryRefs = (collection, works) => {
  const identity = new Set(collection?.identityPrefixes ?? []);
  const counts = new Map();

  for (const work of works) {
    const refs = new Set(
      (Array.isArray(work?.apiRefs) ? work.apiRefs : [])
        .map(parseApiRef)
        .filter((ref) => ref && !identity.has(ref.name))
        .map((ref) => `${ref.name}__${ref.ref}`)
    );
    for (const ref of refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([ref]) => ref);
};

/**
 * A duration only when there is one. CLAUDE.md: a stored `duration` of 0 is
 * not a duration — it renders as `-` exactly as a missing one does — and two
 * works agreeing on it is two works with no playtime, which is not evidence of
 * anything.
 * @type {(work: any) => number | undefined}
 */
const usableDuration = (work) => {
  const duration = work?.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return undefined;
  }
  return duration === 0 ? undefined : duration;
};

/**
 * What the adapters' answers say about one group: what each id names, and
 * whether those answers describe one work or several.
 *
 * `answers` is one entry per `group.refs`, each either `{ apiRef, ref, fresh }`
 * or `{ apiRef, ref, error }` — an id that could not be asked is reported
 * rather than dropped, because "IGDB would not say" and "IGDB says these are
 * two games" are different answers and only the second decides anything.
 *
 * `sameWork` is true when every pair of answers agrees, false when any pair
 * disagrees, and undefined when fewer than two ids answered — nothing was
 * compared, so there is nothing to conclude. It is a statement about the
 * **ids**: false on a group the signals called a duplicate does not mean the
 * documents describe two works, it means one of them is filed under an id
 * that belongs to something else.
 *
 * @type {(group: any, answers: object[]) => {
 *   key: string,
 *   title: string,
 *   releaseYear: unknown,
 *   names: object[],
 *   sameWork: boolean | undefined,
 * }}
 */
const resolveTitleYear = (group, answers) => {
  const names = answers.map((answer) =>
    answer.error !== undefined
      ? { apiRef: answer.apiRef, ref: answer.ref, error: answer.error }
      : {
          apiRef: answer.apiRef,
          ref: answer.ref,
          apiTitle: displayTitle(answer.fresh),
          releaseYear: answer.fresh?.releaseYear,
          duration: answer.fresh?.duration,
        }
  );

  const fresh = answers
    .filter((answer) => answer.error === undefined)
    .map((answer) => answer.fresh);

  return {
    key: group.key,
    title: group.title,
    releaseYear: group.releaseYear,
    names,
    sameWork: allAgree(fresh),
  };
};

/**
 * Whether two adapter responses describe the same work.
 *
 * The title and the release year, and not the duration. Both are the API's own
 * claim about identity, and the year is what settles `stalker|1979` — TMDB has
 * two films called Stalker and only one of them is from 1979. A duration is a
 * hint rather than a claim: two records of one game can honestly report
 * different times to beat, so it is printed beside the answer and left to a
 * reader.
 *
 * Undefined when nothing was comparable — neither response carries a title —
 * for the same reason `titlesAgree` answers undefined: "don't know" is not
 * "they differ".
 * @type {(a: unknown, b: unknown) => boolean | undefined}
 */
const freshWorksAgree = (a, b) => {
  if (yearsDiffer(a, b)) return false;
  return titlesAgree(a, b);
};

module.exports = {
  titleYearKey,
  groupWorksByTitleYear,
  classifyTitleYearGroups,
  describeTitleYearGroup,
  bucketOf,
  reasonFor,
  identityRefOfWork,
  distinctIdentityRefs,
  sharedSecondaryRefs,
  usableDuration,
  resolveTitleYear,
  freshWorksAgree,
};

///////////////////////////////////////////////////////////////////////////////

const countEntriesByWorkRef = (entries) => {
  const counts = new Map();
  for (const entry of entries ?? []) {
    if (!entry?.workRef) continue;
    counts.set(entry.workRef, (counts.get(entry.workRef) ?? 0) + 1);
  }
  return counts;
};

const yearsDiffer = (a, b) => {
  const ours = a?.releaseYear;
  const theirs = b?.releaseYear;
  return (
    typeof ours === "number" &&
    typeof theirs === "number" &&
    Number.isFinite(ours) &&
    Number.isFinite(theirs) &&
    ours !== theirs
  );
};

/**
 * False as soon as one pair contradicts another, undefined while nothing has
 * been compared, true only once at least one pair has agreed — so a single
 * answer, or two untitled ones, cannot be read as a confirmation.
 */
const allAgree = (fresh) => {
  let verdict;
  for (let i = 0; i < fresh.length; i += 1) {
    for (let j = i + 1; j < fresh.length; j += 1) {
      const agree = freshWorksAgree(fresh[i], fresh[j]);
      if (agree === false) return false;
      if (agree === true) verdict = true;
    }
  }
  return verdict;
};
