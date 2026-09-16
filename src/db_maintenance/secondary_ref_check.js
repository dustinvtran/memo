/**
 * @file Two works carrying one *secondary* ref, which nothing else here looks
 * at.
 *
 * ./shared_ref_check.js reads identity refs — the `tmdb__`, `igdb__`, `ISBN__`
 * a work is retrieved by — and ./work_dedupe_plan.js groups on them and only
 * them, for a reason its `groupKey` states plainly: an hltb id names a
 * HowLongToBeat page rather than a game, and grouping on one would present
 * unrelated games as copies of one another. That is correct for a *dedupe*,
 * which merges what it groups. It is why nothing reports these either.
 *
 * And they are worth reporting, because the failure is quieter than the
 * identity one and therefore lasts longer. A shared identity ref means one of
 * the two works is filed under the other's id, which the title check and the
 * refresh both eventually notice. A shared secondary ref means a *playtime or
 * a link* is attached to the wrong work — the documents are otherwise correct,
 * they refresh cleanly, and the audit says nothing.
 *
 * Nine such groups were found by hand in 2026-09 and every one was a remake
 * beside its original: `hltb__9547` on System Shock 1994 *and* 2023,
 * `hltb__82153` on both Demon's Souls, `hltb__8024` on RuneScape and Old
 * School RuneScape. In six of the nine both works carried the *identical*
 * duration, which is what a shared id does — one number copied onto two games.
 * `hltb__69743` held Dragon Age 4 and Dragon Quest V, which no reading makes
 * the same game, and the audit reported `0 duplicate works sharing an apiRef`
 * throughout.
 *
 * Pure and dependency-free like its neighbours, so the classification is
 * covered by the no-install suite.
 */
const { parseApiRef, displayTitle } = require("./work_collections");

/**
 * Every group of two or more works sharing a ref that is not an identity one.
 *
 * `parseApiRef` does the work that matters and is the reason this is short: it
 * rejects the placeholders. 22 games carry `hltb__N/A` and 13 films carry
 * `undefined__undefined`, and a check that grouped on those would open with 35
 * works under two "shared" refs that identify nothing at all — the loudest
 * finding in the report and the least real.
 *
 * Sorted by ref so a run's output can be diffed against the last one.
 *
 * @type {(collection: any, works: any[]) => Array<{ ref: string, works: any[] }>}
 */
const sharedSecondaryRefs = (collection, works) => {
  const identity = new Set(collection?.identityPrefixes ?? []);
  const groups = new Map();

  for (const work of Array.isArray(works) ? works : []) {
    const refs = Array.isArray(work?.apiRefs) ? work.apiRefs : [];
    // A work carrying the same secondary ref twice is one holder of it, not
    // two — otherwise a duplicated entry in one document reads as a collision.
    for (const key of new Set(refs.map(toSecondaryKey(identity)).filter(Boolean))) {
      groups.set(key, [...(groups.get(key) ?? []), work]);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([ref, group]) => ({ ref, works: group }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
};

/**
 * One line per group, for the report.
 *
 * The titles are the whole value of the line: `hltb__9547: System Shock (1994),
 * System Shock (2023)` is a sentence somebody can act on, where a count is not.
 * @type {(group: { ref: string, works: any[] }) => string}
 */
const describeSharedSecondaryRef = ({ ref, works }) =>
  `${ref}: ${works
    .map((work) => `${displayTitle(work)}${work?.releaseYear ? ` (${work.releaseYear})` : ""}`)
    .join(", ")}`;

module.exports = { sharedSecondaryRefs, describeSharedSecondaryRef };

///////////////////////////////////////////////////////////////////////////////

/** `<prefix>__<id>` when the prefix is not one this type is retrieved by. */
const toSecondaryKey = (identity) => (value) => {
  const parsed = parseApiRef(value);
  if (!parsed || identity.has(parsed.name)) return undefined;
  return `${parsed.name}__${parsed.ref}`;
};
