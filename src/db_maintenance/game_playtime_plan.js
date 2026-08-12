/**
 * @file Decides which games get a playtime from IGDB and which are left
 * exactly as they are.
 *
 * Pure and dependency-free on purpose: this is the part of the playtime
 * backfill that can silently damage the database, so it is unit tested
 * (./game_playtime_plan.test.js) without needing a DB or credentials.
 *
 * The one rule that matters: **gaps only**. A game that already has a
 * playtime keeps it, whatever IGDB says. IGDB's times come from a median of
 * three submissions, the stored ones from far larger HowLongToBeat samples,
 * and overwriting them would move numbers people already read on the site,
 * for the worse.
 */
const { parseApiRef, findApiRef, isEmptyValue } = require("./work_collections");
const {
  toPlaytime,
} = require("../api/utils/external_api_adapters/games/time_to_beat");

/**
 * Whether there is a playtime here worth protecting.
 *
 * A stored `0` is not one. The playtime column renders it as `-`, exactly as
 * it renders a missing one, so filling it in takes nothing away from anyone —
 * and 23 games are in that state, left by a lookup that returned nothing and
 * stored the nothing.
 * @type {(work: any) => boolean}
 */
const hasStoredPlaytime = (work) =>
  !isEmptyValue(work?.duration) &&
  typeof work.duration === "number" &&
  work.duration > 0;

/**
 * The IGDB game id a work is cached under, as a number, or undefined when it
 * hasn't got a usable one. `parseApiRef` rejects the placeholders (`hltb__N/A`
 * and friends) so a placeholder can't be mistaken for an id.
 * @type {(work: any) => number | undefined}
 */
const igdbGameId = (work) => {
  const ref = findApiRef(work?.apiRefs, "igdb");
  return ref !== undefined && /^\d+$/.test(ref) ? Number(ref) : undefined;
};

/** Every distinct IGDB id worth asking about, so ids are fetched once. */
/** @type {(works: any[]) => number[]} */
const gameIdsToLookUp = (works) => [
  ...new Set(
    (Array.isArray(works) ? works : [])
      .filter((work) => !hasStoredPlaytime(work))
      .map(igdbGameId)
      .filter((id) => id !== undefined)
  ),
];

/**
 * Sorts every game into exactly one bucket.
 *
 *   fill          gets `duration` and `durationSource` written
 *   hasDuration   already has a playtime, so it is left alone
 *   noIgdbRef     nothing to look up with
 *   noIgdbTime    looked up, IGDB has no time to beat for it
 *
 * The playtime is keyed on the IGDB game id, so two documents sharing one id
 * are given the same number. That is sound *here* — it is a claim about the
 * IGDB game, not about the documents being the same work — and unlike a merge
 * it is reversible, but it is the reason this file never uses an apiRef for
 * anything else.
 *
 * @type {(works: any[], timesByGameId: Map<number, any>) => {
 *   fill: { id: any, title: string, gameId: number, updates: any, submissions: number }[],
 *   hasDuration: any[], noIgdbRef: any[], noIgdbTime: any[],
 * }}
 */
const planPlaytimeBackfill = (works, timesByGameId) => {
  const plan = { fill: [], hasDuration: [], noIgdbRef: [], noIgdbTime: [] };

  for (const work of Array.isArray(works) ? works : []) {
    const described = describe(work);

    if (hasStoredPlaytime(work)) {
      plan.hasDuration.push(described);
      continue;
    }

    const gameId = igdbGameId(work);
    if (gameId === undefined) {
      plan.noIgdbRef.push(described);
      continue;
    }

    const timeToBeat = timesByGameId?.get(gameId);
    const updates = toPlaytime(timeToBeat);
    if (!updates) {
      plan.noIgdbTime.push({ ...described, gameId });
      continue;
    }

    plan.fill.push({
      ...described,
      gameId,
      updates,
      submissions: Number(timeToBeat.count) || 0,
    });
  }

  return plan;
};

/**
 * What the run will have changed, in the terms the requirement is written in:
 * how many games have a playtime before and after.
 * @type {(works: any[], plan: any) => any}
 */
const summarize = (works, plan) => {
  const total = (Array.isArray(works) ? works : []).length;
  return {
    games: total,
    withPlaytimeBefore: plan.hasDuration.length,
    withPlaytimeAfter: plan.hasDuration.length + plan.fill.length,
    withoutPlaytimeBefore: total - plan.hasDuration.length,
    withoutPlaytimeAfter: plan.noIgdbRef.length + plan.noIgdbTime.length,
    filled: plan.fill.length,
    overwritten: 0,
    unfillableNoIgdbRef: plan.noIgdbRef.length,
    unfillableNoIgdbTime: plan.noIgdbTime.length,
  };
};

module.exports = {
  hasStoredPlaytime,
  igdbGameId,
  gameIdsToLookUp,
  planPlaytimeBackfill,
  summarize,
};

///////////////////////////////////////////////////////////////////////////////

const describe = (work) => ({
  id: work?._id,
  title:
    work?.englishTranslatedTitle ?? work?.originalTitle ?? String(work?._id),
  apiRefs: (Array.isArray(work?.apiRefs) ? work.apiRefs : [])
    .map(parseApiRef)
    .filter((ref) => ref)
    .map(({ name, ref }) => `${name}__${ref}`),
});
