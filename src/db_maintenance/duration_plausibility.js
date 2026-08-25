/**
 * @file Whether a stored `duration` can be true, and what to do about one that
 * cannot.
 *
 * `isCorruptNumber` in ./work_collections.js asks only whether a value is a
 * number that isn't NaN. `2939328000000000` passes that test perfectly, and
 * did, for as long as it has been in the games collection: 5.6 billion hours
 * of Dying Light, rendered by the playtime column as a link like any other. A
 * field can be the right *type* and still be impossible, and nothing here was
 * checking the second thing.
 *
 * Pure and dependency-free on purpose, like its neighbours: this decides what
 * a repair script writes over real playtimes, so it is unit tested
 * (./duration_plausibility.test.js) rather than argued about in front of a
 * terminal. The database reads live in scripts/repair_durations.js.
 *
 * **`duration` is not one unit.** It is minutes for a film, minutes for *one
 * episode* of a show, minutes for a game, and **pages** for a book. A single
 * threshold across the four would be meaningless, so each type carries its own
 * band and its own noun for what the number counts.
 */
const { isEmptyValue } = require("./work_collections");

/**
 * What a `duration` means per type, and the largest value that can still be
 * true. The ceilings clear the real record holders with room to spare, because
 * a false positive here costs someone an afternoon confirming that yes, Out 1
 * really is thirteen hours.
 *
 *   films  Sátántangó is 439 minutes and Out 1 is 773.
 *   tv     one episode, so the shape to clear is a feature-length finale, not
 *          a season. The longest plausible one in the database is 92.
 *   games  an MMO is a lifetime: RuneScape is stored at 127,680 minutes
 *          (2,128 hours) and that is a real HowLongToBeat number, not damage.
 *          This is the one ceiling that has to be generous.
 *   books  pages. The longest here is a 1,572-page SAT book.
 *
 * A ceiling is a claim about what is *possible*, not about what is typical.
 * Tightening one to catch more is how RuneScape becomes a bug report.
 */
const DURATION_BANDS = {
  films: { unit: "minutes", max: 900 },
  tv: { unit: "minutes per episode", max: 240 },
  games: { unit: "minutes", max: 200000 },
  books: { unit: "pages", max: 5000 },
};

/** @type {(collection: any) => { unit: string, max: number } | undefined} */
const bandFor = (collection) => DURATION_BANDS[collection?.type];

/**
 * Why this work's `duration` cannot be true, or undefined when it can.
 *
 * A missing duration is not implausible, and neither is a stored `0` — that
 * one renders as `-` exactly as a missing one does, is already documented as
 * "not a duration", and game_playtime_plan.js is already the thing that fills
 * it. Reporting it here as damage would be a second, louder opinion about a
 * state two other modules have already agreed to treat as empty.
 *
 * @type {(collection: any, work: any) => string | undefined}
 */
const implausibleDuration = (collection, work) => {
  const band = bandFor(collection);
  const duration = work?.duration;
  if (!band || isEmptyValue(duration) || duration === 0) return undefined;
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return `duration is ${JSON.stringify(duration)}, which is not a number`;
  }
  if (duration < 0) return `duration is negative (${duration})`;
  if (duration > band.max) {
    return (
      `duration is ${duration} ${band.unit}, above the ${band.max} a ` +
      `${collection.type} entry can plausibly be`
    );
  }
  return undefined;
};

/**
 * Every value this one could be an over-multiplied form of, largest first.
 *
 * The Dying Light number is not random junk and not a millisecond timestamp,
 * which is what it looks like until you divide it: 2939328000000000 is exactly
 * 1050 × 60^7. Something applied a units conversion to a value that was
 * already in the right units, and then did it again, and the stored playtime
 * is the original with a tail of sixties on it. Undoing them one at a time
 * gives the ladder of values it could have been.
 *
 * Division has to be exact at every rung. A number not divisible by 60 was not
 * multiplied by 60, and the ladder stops there rather than rounding its way to
 * a plausible-looking answer.
 *
 * @type {(duration: number) => number[]}
 */
const descaleLadder = (duration) => {
  const rungs = [];
  let value = duration;
  while (Number.isInteger(value) && value >= 60 && value % 60 === 0) {
    value /= 60;
    rungs.push(value);
  }
  return rungs;
};

/**
 * The repair for one implausible duration, or the reason there isn't one.
 *
 * **The ladder alone is not something to pick a value from.** Dying Light's
 * runs [48988800000000 … 63000, 1050], and 63000 minutes — 1,050 hours — is
 * inside the games band. "Divide until it looks plausible" would stop there
 * and write a number sixty times too big, having satisfied every check we own.
 * A band says which values are impossible; it cannot say which of the possible
 * ones is true.
 *
 * So the value comes from outside: the `overrides.duration` that users put on
 * their own entries. Four of the six Dying Light entries carry exactly 1050,
 * typed by people who could see the column was wrong and corrected it for
 * themselves. That is an independent measurement of the same quantity, and
 * when it lands on a rung of the ladder the two agree about what happened.
 *
 * Overrides are read here and never written — they are user data, and
 * CLAUDE.md's rule that a maintenance script touches only the work collections
 * is what keeps this a repair rather than a rewrite of what people typed.
 *
 * With no corroboration there is no repair: the finding is reported with its
 * ladder attached and a human names the value. Guessing is how a wrong
 * playtime becomes a wrong playtime nobody can spot any more.
 *
 * @type {(collection: any, work: any, overrides: number[]) => object | undefined}
 */
const planDurationRepair = (collection, work, overrides) => {
  const reason = implausibleDuration(collection, work);
  if (!reason) return undefined;

  const band = bandFor(collection);
  const ladder =
    typeof work.duration === "number" && Number.isFinite(work.duration)
      ? descaleLadder(work.duration)
      : [];
  const usableOverrides = (Array.isArray(overrides) ? overrides : []).filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0
  );

  const finding = {
    id: work._id,
    title: work.englishTranslatedTitle ?? work.originalTitle ?? "(untitled)",
    reason,
    current: work.duration,
    ladder,
    overrides: usableOverrides,
  };

  const corroborated = ladder.filter(
    (rung) => rung <= band.max && usableOverrides.includes(rung)
  );

  if (corroborated.length === 0) {
    return {
      ...finding,
      blocked:
        ladder.length === 0
          ? "not a multiple of 60, so nothing over-multiplied it — needs a human"
          : "no entry override matches a rung of the ladder — needs a human",
    };
  }

  // Largest first, so the fewest undone multiplications win. Two rungs can
  // only both be corroborated if the overrides disagree by a factor of sixty,
  // and then the one nearer what is stored is the safer claim.
  const duration = Math.max(...corroborated);
  const agreeing = usableOverrides.filter((value) => value === duration).length;
  return {
    ...finding,
    duration,
    evidence:
      `${work.duration} = ${duration} × 60^${ladder.indexOf(duration) + 1}, ` +
      `and ${agreeing} of ${usableOverrides.length} entry override(s) ` +
      `already say ${duration}`,
  };
};

/**
 * Every implausible duration in a collection, split into the ones with a
 * corroborated repair and the ones a human has to look at.
 *
 * `overridesByWorkRef` maps a work's `_id` to the `overrides.duration` values
 * of the entries pointing at it. The caller builds it — this module never sees
 * an entry document.
 *
 * @type {(collection: any, works: any[], overridesByWorkRef: Map<any, number[]>) => {
 *   repair: object[], needsHuman: object[], checked: number,
 * }}
 */
const planDurationRepairs = (collection, works, overridesByWorkRef) => {
  const list = Array.isArray(works) ? works : [];
  const findings = list
    .map((work) =>
      planDurationRepair(collection, work, overridesByWorkRef?.get(work?._id))
    )
    .filter((finding) => finding);

  return {
    repair: findings.filter((finding) => finding.duration !== undefined),
    needsHuman: findings.filter((finding) => finding.duration === undefined),
    checked: list.length,
  };
};

/**
 * The `overrides.duration` of every entry, keyed by the work it points at.
 * Kept here beside its only consumer, and pure — it takes entry documents and
 * returns numbers, so the repair script hands it an array and never has to
 * remember which field the override lives under.
 * @type {(entries: any[]) => Map<any, number[]>}
 */
const durationOverridesByWorkRef = (entries) => {
  const byWorkRef = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = entry?.overrides?.duration;
    if (!entry?.workRef || typeof value !== "number") continue;
    byWorkRef.set(entry.workRef, [...(byWorkRef.get(entry.workRef) ?? []), value]);
  }
  return byWorkRef;
};

module.exports = {
  DURATION_BANDS,
  bandFor,
  implausibleDuration,
  descaleLadder,
  planDurationRepair,
  planDurationRepairs,
  durationOverridesByWorkRef,
};
