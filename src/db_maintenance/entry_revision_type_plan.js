/**
 * @file Decides which `entryRevisions` documents carry the url spelling of
 * their type, and what the document spelling of each one should be.
 *
 * `entryType` names two different values in this codebase, and both were
 * live: work documents carry `'Film'` — the spelling ../api/utils/parsers/works.js
 * enforces on every one of the four works collections — while
 * `entryRevisions` documents were written with `'films'`, the `:type` segment
 * a url starts with. `toEntryType` in ../api/controllers/utils.js returned the
 * url one under the other one's name, and its two callers stored the result in
 * a field they also called `entryType`; the revisions parser was then written
 * around the value it was being handed, so nothing ever objected. See #220.
 *
 * The API now writes the document spelling. This plans the backfill for the
 * documents written before it did.
 *
 * The mapping is read out of ../api/utils/work_types.js, which is the one
 * table that holds both spellings, so this cannot disagree with the code that
 * produced the values it is correcting.
 *
 * Pure and dependency-free: scripts/retype_entry_revisions.js writes based on
 * what this returns, so the decision is unit tested
 * (./entry_revision_type_plan.test.js) rather than discovered in production.
 */

const { WORK_TYPES } = require("../api/utils/work_types");

/** url spelling -> document spelling, e.g. `films` -> `Film`. */
const RETYPE = Object.fromEntries(
  WORK_TYPES.map((workType) => [workType.type, workType.entryType])
);

/** The values that are already right, and so are left alone. */
const DOCUMENT_TYPES = new Set(Object.values(RETYPE));

/**
 * What to rewrite, grouped by the value to write, and what to leave alone.
 *
 * `blocked` means the same thing as in ./orphan_review_plan.js: a condition
 * under which planning at all would be a mistake, and the caller is expected
 * to stop. Here it is the mapping itself being unusable — if a url spelling
 * were ever also a document spelling, "already correct" and "needs rewriting"
 * would be the same test, and a re-run could rewrite a value that was right.
 * The two sets are disjoint today and ../api/utils/work_types.test.js keeps
 * them that way; this refuses rather than trusting that from a distance.
 *
 * A document carrying neither spelling — including one carrying no
 * `entryType` at all — is reported and left alone. There is nothing to map it
 * from, and its type is recoverable from the entry it belongs to by hand,
 * which is a better answer than a guess written to production.
 *
 * @typedef {{ _id: any, entryType: unknown, kind: unknown }} Unrecognised
 * @type {(revisions: any[]) => {
 *   blocked: string | undefined,
 *   updates: { from: string, to: string, ids: any[], drafts: number }[],
 *   unrecognised: Unrecognised[],
 *   totals: {
 *     revisions: number,
 *     alreadyCorrect: number,
 *     toRewrite: number,
 *     unrecognised: number,
 *   },
 * }}
 */
const planEntryRevisionRetype = (revisions) => {
  const overlap = Object.keys(RETYPE).filter((urlType) =>
    DOCUMENT_TYPES.has(urlType)
  );
  if (overlap.length > 0) {
    return {
      ...emptyPlan(),
      blocked:
        `${overlap.join(", ")} is both a url spelling and a document ` +
        `spelling, so a rewritten document cannot be told from one still ` +
        `waiting to be rewritten. Fix work_types.js before running this.`,
    };
  }

  if (!Array.isArray(revisions)) {
    return { ...emptyPlan(), blocked: "revisions must be an array" };
  }

  const plan = emptyPlan();
  plan.totals.revisions = revisions.length;

  const byTarget = new Map();

  for (const revision of revisions) {
    const entryType = revision?.entryType;

    if (DOCUMENT_TYPES.has(entryType)) {
      plan.totals.alreadyCorrect += 1;
      continue;
    }

    const target = typeof entryType === "string" ? RETYPE[entryType] : undefined;
    if (target === undefined) {
      plan.unrecognised.push({
        _id: revision?._id,
        entryType,
        kind: revision?.kind,
      });
      plan.totals.unrecognised += 1;
      continue;
    }

    const update =
      byTarget.get(entryType) ??
      { from: entryType, to: target, ids: [], drafts: 0 };
    update.ids.push(revision._id);
    if (revision.kind === "draft") update.drafts += 1;
    byTarget.set(entryType, update);
    plan.totals.toRewrite += 1;
  }

  // In the table's order, so the report reads the way the site presents the
  // types rather than the way the driver happened to return the documents.
  plan.updates = Object.keys(RETYPE)
    .map((urlType) => byTarget.get(urlType))
    .filter((update) => update !== undefined);

  return plan;
};

module.exports = {
  RETYPE,
  DOCUMENT_TYPES,
  planEntryRevisionRetype,
};

///////////////////////////////////////////////////////////////////////////////

const emptyPlan = () => ({
  blocked: undefined,
  updates: [],
  unrecognised: [],
  totals: {
    revisions: 0,
    alreadyCorrect: 0,
    toRewrite: 0,
    unrecognised: 0,
  },
});
