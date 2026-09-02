/**
 * @file What to take off a work that is filed under another work's id, and
 * what has to come off with it.
 *
 * ./shared_ref_check.js finds the collisions and `--verify-shared-refs` asks
 * each API which work the shared id really names. This is the other half:
 * given those answers, which documents are wrong and what a repair leaves
 * behind. scripts/repair_shared_refs.js does the reads, the API calls and the
 * writes; everything that decides what gets written is here, so it is covered
 * by the no-install suite (./shared_ref_repair_plan.test.js).
 *
 * **The input is the audit's `identityChecks`, verbatim.** Not a list of ids
 * pasted out of a terminal: a list would be a second source of truth about
 * which side of a pair is wrong, it would be stale the first time somebody
 * adds an entry, and it would be wrong in the one direction that matters —
 * naming a work the API never accused. The verdicts come from the API, this
 * decides what to do about them, and neither knows the other's contents.
 *
 * Two answers come back, and they want the same treatment for different
 * reasons. Fifteen groups have a **confirmed owner**: the id names one of the
 * works — always the sequel, the remake or the follow-up — and the other is
 * wearing it. Ten name a **third work entirely**: a bundle, a re-release, a
 * foreign-language edition. `igdb__134258` is *New Play Control! Metroid Prime
 * 2*, which is neither `Metroid` nor `Metroid Prime`; `9782709637411` is
 * *Anges et démons*, which is neither Dostoevsky's `Demons` nor `The Da Vinci
 * Code`. There is no side to pick, so every work in those groups is wrong.
 * Either way the work loses the id, and a confirmed owner is never touched.
 *
 * ## Which ids come off
 *
 * The verified one, and **anything else the group holds in common**. A group
 * is works the API has just told us are not the same work, and one external id
 * names one work, so an id two of them carry can be right about at most one —
 * and the document the API called misfiled is not the one to give the benefit
 * of the doubt to. That rule is what takes `hltb__13157` off `Kingdom Hearts`:
 * it is Kingdom Hearts III's HowLongToBeat page, sitting on both documents
 * because the retrieve that wrote one wrote the other. An `hltb` ref is not an
 * identity ref and the grouping never looked at it, so nothing but this would
 * have found it.
 *
 * An id only one work in the group carries is left alone. Nothing says it came
 * from the bad retrieve, and this is not the script that guesses.
 *
 * ## Which fields come off
 *
 * Everything an adapter fills: `expectedFields` and the descriptor's number
 * fields, plus `externalUrls`, `durationSource` and `metadataUpdatedDate`. Not
 * only the year, the duration, the image and the links #290 names — those are
 * what a reader *notices*, and the list of what is wrong is longer than the
 * list of what is conspicuous. `authors: ["Dan Brown"]` on Dostoevsky's
 * `Demons` is exactly as wrong as its 600 pages, and `platforms: ["PS4"]` on
 * the PS2 `Kingdom Hearts` is wrong the same way its 2019 is.
 *
 * The reason it is every such field, rather than the ones that can be shown to
 * differ from the owner's, is that **nothing on these documents can be
 * dated.** The merge that did the damage ran with `missingOnly`, so it wrote
 * whichever fields happened to be empty at the time, and nothing records which
 * those were. Comparing against the owner cannot settle it either: two games
 * in a series share a studio and a genre honestly, and the owner may have been
 * refreshed since. So a value on a misfiled document is a value of unknown
 * provenance under an id that names something else, and the honest thing to do
 * with it is what scripts/clear_unusable_work_fields.js does with a corrupt
 * one — `$unset`, because a missing field is what `isEmptyValue` recognises,
 * so a backfill can fill it in if a correct ref is ever found.
 *
 * That last clause is the cost, and it is real: with the id gone there is
 * nothing to refresh from, so these works join the audit's "cannot be
 * refreshed" line and stay there until a human supplies the right id. The plan
 * counts them rather than leaving it to be discovered. An honest gap beats a
 * confident wrong answer, and it is the only state a backfill can ever do the
 * right thing from.
 *
 * `KEPT_FIELDS` is what survives, and why each one does.
 */
const {
  parseApiRef,
  findApiRef,
  isEmptyValue,
  displayTitle,
} = require("./work_collections");
const { expectedFields } = require("./work_metadata_merge");
const { sharedRefReason } = require("./shared_ref_check");

/**
 * What a repair never touches, and why. Every one of these is a field an
 * adapter response also carries, so none of them is here by omission.
 */
const KEPT_FIELDS = {
  englishTranslatedTitle:
    "the one field the wrong id demonstrably did not write — a missingOnly " +
    "merge only fills what is empty, and the surviving title is why the " +
    "collision was findable at all. It is also what a human needs in order to " +
    "look the right id up",
  originalTitle:
    "the same, and the other half of what titlesAgree compares: clearing it " +
    "would make the documents in a group harder to tell apart, which is the " +
    "unrecoverable state #290 is about",
  entryType:
    "a constant of the collection the document sits in, not something an API " +
    "said. The audit reports a wrong one and the backfill writes the right one",
  apiRefs:
    "narrowed rather than unset: the ids the group shares come off and the " +
    "rest of the array stays. An absent apiRefs is what corruptFieldsOf calls " +
    "corrupt; an empty one honestly says we know of no id for this work",
};

/**
 * Every field of a work whose stored value can only have come from an adapter,
 * and so from whatever the wrong id named.
 *
 * Read out of the collection descriptor rather than listed, so a type that
 * grows a metadata field is covered without anyone remembering to come back
 * here. `metadataUpdatedDate` is the one addition that is not adapter data: it
 * records when an adapter last had something to say about this work, and once
 * the id that produced it is gone the true answer is never.
 *
 * @type {(collection: any) => string[]}
 */
const poisonedFields = (collection) => [
  ...new Set([
    ...expectedFields(collection),
    ...(collection?.numberFields ?? []),
    "externalUrls",
    "durationSource",
    "metadataUpdatedDate",
  ]),
].filter((field) => !(field in KEPT_FIELDS));

/**
 * What to write to one collection, from the answers `--verify-shared-refs`
 * got for it.
 *
 * `blocked` means what it means in ./orphan_review_plan.js and
 * ./unusable_field_plan.js: a condition under which planning at all would be a
 * mistake, and the caller is expected to stop rather than write a subset.
 *
 * A group that could not be asked about is **skipped, not guessed at** — "the
 * API would not answer" and "the API says neither of these" are different
 * answers and only the second is a finding. So is a check naming a work the
 * collection no longer holds.
 *
 * @typedef {{ field: string, value: unknown }} ClearedField
 * @typedef {{
 *   _id: any,
 *   title: string,
 *   apiRef: string,
 *   ref: string | undefined,
 *   apiTitle: string,
 *   owner: string | null,
 *   removedRefs: unknown[],
 *   apiRefs: unknown[],
 *   unset: ClearedField[],
 *   remainingIdentityRef: string | undefined,
 *   unrefreshable: boolean,
 * }} Repair
 * @type {(collection: any, works: any[], identityChecks: any[]) => {
 *   blocked: string | undefined,
 *   repairs: Repair[],
 *   untouched: Array<{ _id: any, title: string, apiRef: string }>,
 *   skipped: Array<{ apiRef: string, reason: string }>,
 *   totals: {
 *     works: number,
 *     groups: number,
 *     ownerConfirmed: number,
 *     thirdWork: number,
 *     repaired: number,
 *     refs: number,
 *     values: number,
 *     unrefreshableBefore: number,
 *     unrefreshableAfter: number,
 *   },
 * }}
 */
const planSharedRefRepair = (collection, works, identityChecks) => {
  const blocked = refuse(collection, works, identityChecks);
  if (blocked) return { ...emptyPlan(), blocked };

  const fields = poisonedFields(collection);
  const byId = new Map(works.map((work) => [String(work._id), work]));

  const plan = emptyPlan();
  plan.totals.works = works.length;

  const repairedIds = new Map();

  for (const check of identityChecks) {
    plan.totals.groups += 1;

    // Before the two counts below, so a group nobody could ask about is
    // neither "the id has an owner" nor "the id names a third work". It is not
    // an answer at all.
    const unusable = unusableCheck(check);
    if (unusable) {
      plan.skipped.push({ apiRef: check.apiRef, reason: unusable });
      continue;
    }

    const matches = check.matches ?? [];
    const mismatches = check.mismatches ?? [];

    if (matches.length > 0) plan.totals.ownerConfirmed += 1;
    else plan.totals.thirdWork += 1;

    for (const owner of matches) {
      plan.untouched.push({
        _id: owner.id,
        title: owner.title,
        apiRef: check.apiRef,
      });
    }

    // Ids more than one member of the group carries. The group is works an API
    // has just said are not the same work, so a shared id is right about at
    // most one of them, and the misfiled document is not that one.
    const shared = sharedRefKeys([...matches, ...mismatches]);
    const owners = new Set(matches.map((work) => String(work.id)));

    for (const mismatch of mismatches) {
      const id = String(mismatch.id);

      // A check that calls one document both the work the id names and a work
      // it does not is a contradiction, and acting on half of it would be a
      // write to a confirmed owner. There is no safe subset.
      if (owners.has(id)) {
        return {
          ...emptyPlan(),
          blocked:
            `${check.apiRef} lists ${id} as both the work the id names and a ` +
            `work it does not`,
        };
      }
      if (repairedIds.has(id)) {
        return {
          ...emptyPlan(),
          blocked:
            `${id} is in two groups (${repairedIds.get(id)} and ` +
            `${check.apiRef}), so one repair would undo the other's reading`,
        };
      }

      const work = byId.get(id);
      if (!work) {
        plan.skipped.push({
          apiRef: check.apiRef,
          reason: `${mismatch.title} (${id}) is not in ${collection.works} any more`,
        });
        continue;
      }

      const repair = repairOf(collection, work, check, shared, fields);
      if (repair.removedRefs.length === 0) {
        plan.skipped.push({
          apiRef: check.apiRef,
          reason: `${repair.title} (${id}) no longer carries ${check.apiRef}`,
        });
        continue;
      }

      repairedIds.set(id, check.apiRef);
      plan.repairs.push(repair);
      plan.totals.repaired += 1;
      plan.totals.refs += repair.removedRefs.length;
      plan.totals.values += repair.unset.length;
    }
  }

  // Asked of the works themselves rather than added up from the repairs, so it
  // is the same count the audit's "no <prefix>__ ref" line prints — and so a
  // work that was already unrefreshable is not counted twice.
  const after = new Map(plan.repairs.map((repair) => [String(repair._id), repair]));
  plan.totals.unrefreshableBefore = works.filter(
    (work) => !findApiRef(work.apiRefs, collection.retrievePrefix)
  ).length;
  plan.totals.unrefreshableAfter = works.filter(
    (work) =>
      !findApiRef(
        after.get(String(work._id))?.apiRefs ?? work.apiRefs,
        collection.retrievePrefix
      )
  ).length;

  return plan;
};

module.exports = {
  KEPT_FIELDS,
  poisonedFields,
  planSharedRefRepair,
};

///////////////////////////////////////////////////////////////////////////////

/** Why planning this collection at all would be a mistake, or undefined. */
const refuse = (collection, works, identityChecks) => {
  if (
    !Array.isArray(collection?.identityPrefixes) ||
    !Array.isArray(collection?.stringArrayFields) ||
    !Array.isArray(collection?.numberFields) ||
    typeof collection?.retrievePrefix !== "string"
  ) {
    return (
      "the collection descriptor must carry identityPrefixes, retrievePrefix, " +
      "stringArrayFields and numberFields — they are what says which ids name " +
      "the work and which fields an adapter wrote"
    );
  }
  if (!Array.isArray(works)) return "works must be an array";
  if (!Array.isArray(identityChecks)) {
    return "identityChecks must be an array — the audit's --json key of that name";
  }

  // Nineteen tv groups share a show id because the site tracks seasons as
  // separate works, and classifySharedRefs never calls one a collision. A
  // check for a type that shares ids by design did not come from there, and
  // repairing it would delete a ref the site depends on.
  const byDesign = sharedRefReason(collection);
  if (byDesign && identityChecks.length > 0) {
    return (
      `${collection.type} shares ids by design (${byDesign}), so a shared id ` +
      `there is not a collision to repair`
    );
  }
  return undefined;
};

/** Why this group cannot be acted on, or undefined. */
const unusableCheck = (check) => {
  if (check.error) return `the API could not be asked (${check.error})`;
  if (!check.ref) {
    return "no identity id to check against — every ref in the group is a placeholder";
  }
  if ((check.mismatches ?? []).length === 0) {
    return "the API names every work in the group, so nothing here is misfiled";
  }
  return undefined;
};

/** One misfiled document: which ids come off it, and which values with them. */
const repairOf = (collection, work, check, shared, fields) => {
  const apiRefs = Array.isArray(work.apiRefs) ? work.apiRefs : [];

  const removedRefs = apiRefs.filter((ref) =>
    isPoisonedRef(collection, ref, check.ref, shared)
  );
  const kept = apiRefs.filter((ref) => !removedRefs.includes(ref));

  const unset = fields
    .filter((field) => !isEmptyValue(work[field]))
    .map((field) => ({ field, value: work[field] }));

  const remainingIdentityRef = findApiRef(kept, collection.retrievePrefix);

  return {
    _id: work._id,
    title: displayTitle(work),
    apiRef: check.apiRef,
    ref: check.ref,
    apiTitle: check.apiTitle,
    owner: (check.matches ?? [])[0]?.title ?? null,
    removedRefs,
    apiRefs: kept,
    unset,
    remainingIdentityRef,
    unrefreshable: remainingIdentityRef === undefined,
  };
};

/**
 * Whether one stored apiRef is one the wrong id brought with it: the verified
 * id itself under any prefix that names the work — books carry the same ISBN
 * as both `ISBN__` and `google__` — or any id another member of the group also
 * holds.
 */
const isPoisonedRef = (collection, apiRef, verifiedRef, shared) => {
  const parsed = parseApiRef(apiRef);
  if (!parsed) return false;
  if (
    collection.identityPrefixes.includes(parsed.name) &&
    parsed.ref === verifiedRef
  ) {
    return true;
  }
  return shared.has(refKey(parsed));
};

/**
 * The ids carried by more than one work in a group, as `<name>__<ref>`, which
 * is the spelling both apiRef shapes reduce to. A placeholder parses to
 * nothing and so can never be shared: 27 games carry `hltb__N/A` and it names
 * no page at all.
 */
const sharedRefKeys = (group) => {
  const counts = new Map();
  for (const work of group) {
    const keys = new Set(
      (Array.isArray(work.apiRefs) ? work.apiRefs : [])
        .map(parseApiRef)
        .filter((parsed) => parsed)
        .map(refKey)
    );
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key)
  );
};

const refKey = ({ name, ref }) => `${name}__${ref}`;

const emptyPlan = () => ({
  blocked: undefined,
  repairs: [],
  untouched: [],
  skipped: [],
  totals: {
    works: 0,
    groups: 0,
    ownerConfirmed: 0,
    thirdWork: 0,
    repaired: 0,
    refs: 0,
    values: 0,
    unrefreshableBefore: 0,
    unrefreshableAfter: 0,
  },
});
