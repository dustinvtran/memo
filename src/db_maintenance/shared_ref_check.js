/**
 * @file What it means when two work documents carry the same identity ref,
 * and what an adapter's answer says about which of them the ref really names.
 *
 * `scripts/audit_database.js` reported every such group as "duplicate works
 * sharing an apiRef", and 44 of them under one number was a number nobody
 * could act on. Three quite different things were in it:
 *
 *   - **Duplicates.** The same work cached twice, which `planDedupe` in
 *     ./work_dedupe_plan.js collapses. The titles agree.
 *   - **Separate works, by design.** TMDB has one id per *show* and the site
 *     tracks a season as its own work, so nineteen tv groups are correct and
 *     always will be. Counting them as damage is what made the headline
 *     unreadable — they can never go to zero.
 *   - **Collisions.** One id, two works that are not the same work, outside a
 *     type where that is expected: `Among Us` under The Wolf Among Us's IGDB
 *     id, Dostoevsky's `Demons` under The Da Vinci Code's ISBN. One IGDB id
 *     is one game and one ISBN is one edition, so exactly one of the pair is
 *     filed under an id that belongs to the other — and a `--missing-only`
 *     backfill has already copied that other work's year, playtime, image and
 *     links onto it. #290, and #55 is the first sighting of a symptom.
 *
 * Which side is wrong cannot be worked out from the database, because both
 * documents look equally plausible. It can be *asked*: retrieve the ref and
 * see which title comes back. That is one API call per collision group, and
 * `resolveIdentity` is what turns the answer into a verdict.
 *
 * Pure and dependency-free on purpose, like its neighbours — the reads and
 * the API calls live in scripts/audit_database.js — so the classification is
 * covered by the no-install suite (./shared_ref_check.test.js).
 */
const {
  parseApiRef,
  displayTitle,
  titlesAgree,
} = require("./work_collections");
const { groupWorksByApiRef, groupTitlesAgree } = require("./work_dedupe_plan");

/**
 * The types where more than one work under one identity ref is expected, and
 * why — a reason rather than a boolean, because this list only ever grows by
 * someone being able to write the next sentence.
 *
 * Not a blanket exemption for the type: a tv group whose works *agree* on a
 * title is still two copies of one season, and is still reported as a
 * duplicate. What this excuses is the disagreement, not the sharing.
 */
const SHARED_IDENTITY_REF_BY_DESIGN = {
  tv: "TMDB has one id per show, and the site tracks each season as its own work",
};

/** @type {(collection: any) => string | undefined} */
const sharedRefReason = (collection) =>
  SHARED_IDENTITY_REF_BY_DESIGN[collection?.type];

/**
 * Every group of works sharing an identity ref, split into the three things a
 * group can be. A group of one is not a group and never appears.
 *
 * `ref` is the bare id to hand an adapter's `retrieve`, taken from the works
 * themselves rather than parsed back out of the group key — books are keyed
 * on the bare ISBN and everything else on `<prefix>__<id>`, and one of those
 * two shapes would have to be un-picked either way.
 *
 * @type {(collection: any, works: any[]) => {
 *   duplicates: Array<{ key: string, ref: string | undefined, works: any[] }>,
 *   expected: Array<{ key: string, ref: string | undefined, works: any[] }>,
 *   collisions: Array<{ key: string, ref: string | undefined, works: any[] }>,
 * }}
 */
const classifySharedRefs = (collection, works) => {
  const byDesign = sharedRefReason(collection) !== undefined;
  const result = { duplicates: [], expected: [], collisions: [] };

  for (const [key, group] of groupWorksByApiRef(collection, works)) {
    if (group.length < 2) continue;

    const entry = { key, ref: identityRefOf(collection, group), works: group };
    const bucket = groupTitlesAgree(group)
      ? "duplicates"
      : byDesign
        ? "expected"
        : "collisions";
    result[bucket].push(entry);
  }

  return result;
};

/**
 * The identity id shared by a group, as `retrieve` wants it: bare, with no
 * `<prefix>__` in front.
 *
 * `identityPrefixes` in order, so the prefix a type is retrieved by wins —
 * it is first in all four rows. Books are the reason the list is walked at
 * all: both `ISBN__` and `google__` name the same ISBN, and some documents
 * carry only the second.
 * @type {(collection: any, works: any[]) => string | undefined}
 */
const identityRefOf = (collection, works) => {
  const refs = works.flatMap((work) =>
    (Array.isArray(work?.apiRefs) ? work.apiRefs : [])
      .map(parseApiRef)
      .filter((ref) => ref)
  );

  for (const prefix of collection?.identityPrefixes ?? []) {
    const match = refs.find((ref) => ref.name === prefix);
    if (match) return match.ref;
  }
  return undefined;
};

/**
 * What the API's answer says about one collision group: which of its works the
 * ref actually names, and which are filed under an id belonging to something
 * else.
 *
 * A work matches on any of its titles matching any of the response's — see
 * `titlesAgree`. A work with no stored title cannot match and lands in
 * `mismatches`, which is the right place for it: the ref is not evidence that
 * an untitled document is this work either.
 *
 * `matches` being empty is a real answer and not an error. It means the ref
 * names a third work neither of these is, and the group needs a human rather
 * than a rule.
 *
 * @type {(group: { key: string, ref?: string, works: any[] }, fresh: any) => {
 *   key: string,
 *   ref: string | undefined,
 *   apiTitle: string,
 *   matches: any[],
 *   mismatches: any[],
 * }}
 */
const resolveIdentity = (group, fresh) => {
  const matches = group.works.filter((work) => titlesAgree(work, fresh) === true);

  return {
    key: group.key,
    ref: group.ref,
    apiTitle: displayTitle(fresh),
    matches,
    mismatches: group.works.filter((work) => !matches.includes(work)),
  };
};

/**
 * How a report names one work. Shared so that the audit's findings and the
 * `identityChecks` a repair reads back are the same shape rather than two
 * spellings of it — scripts/repair_shared_refs.js joins on the `id` this
 * writes.
 * @type {(work: any) => { id: any, title: string, apiRefs: unknown }}
 */
const describeWork = (work) => ({
  id: work._id,
  title: displayTitle(work),
  apiRefs: work.apiRefs,
});

module.exports = {
  SHARED_IDENTITY_REF_BY_DESIGN,
  sharedRefReason,
  classifySharedRefs,
  identityRefOf,
  resolveIdentity,
  describeWork,
};
