/**
 * @file Getting hold of the adapter a collection is refreshed by.
 *
 * The one module up here that is not pure: it `require`s the real adapters,
 * so it is not part of the no-install suite. It sits beside them rather than
 * in `scripts/` because three scripts now need it —
 * `scripts/backfill_work_metadata.js`, which has always had it, and
 * `scripts/audit_database.js` and `scripts/repair_shared_refs.js`, which ask
 * an adapter what a shared id really names (#290). A second copy of the
 * reasoning below is exactly the thing that would rot.
 *
 * `verifyIdentities` is here for the same reason and not a better one: the
 * audit asks the question and the repair has to ask it again, live, at the
 * moment it writes. A saved answer would be a second source of truth about
 * which side of a collision is misfiled, and the wrong half of it would be a
 * write to a work no API ever accused.
 */
const { sleep } = require("./work_collections");
const { resolveIdentity, describeWork } = require("./shared_ref_check");

/**
 * Lazily required, so a films-only run never loads the other three. That used
 * to be about credentials as well — the games adapter built its IGDB client
 * while it was being read and threw without Twitch keys. All four build their
 * clients on first use now, which is what lets work_collections.test.js
 * require every one of them with nothing configured.
 *
 * The catch is narrow on purpose. Skipping a collection is the right answer to
 * "this run has no Twitch credentials" and the wrong answer to "the path in
 * the descriptor is wrong" — the second silently turns every run into a no-op
 * that reports nothing amiss, which is what it did until work_collections.js
 * started resolving these paths itself. That resolution means the adapter's
 * own module can no longer be the thing that isn't found, so if it is,
 * something is wrong with the wiring: say so and stop.
 *
 * The shape is checked here for the same reason, and outside the try. A module
 * that loads but has no `retrieve` is a wiring fault, not a missing key, and
 * it used to be found by the TypeError it threw halfway down the first
 * collection — #252, where an adapter ending in `export default` arrived
 * across the CommonJS boundary as `{ __esModule, default }` and sailed past
 * the truthiness check at the call site.
 *
 * @type {(collection: any) => { retrieve: Function, search?: Function } | undefined}
 */
const loadAdapter = (collection) => {
  let adapter;
  try {
    adapter = require(collection.adapterModule);
  } catch (e) {
    if (e?.code === "MODULE_NOT_FOUND" && e.requireStack?.[0] === __filename) {
      throw e;
    }
    console.log(
      `  skipping ${collection.works}: ${collection.adapterModule} failed to ` +
        `load (${e?.message ?? e})`
    );
    return undefined;
  }

  if (typeof adapter?.retrieve !== "function") {
    throw new Error(
      `${collection.adapterModule} exports no retrieve (it has ` +
        `${Object.keys(adapter ?? {}).join(", ") || "nothing"}), so nothing ` +
        `here can refresh a ${collection.type}`
    );
  }

  return adapter;
};

/**
 * Asks the adapter, once per collision group, what the shared id names.
 *
 * The pause between calls is the same one the backfill uses, out of the same
 * descriptor: IGDB caps at four requests a second and a retrieve costs three
 * of them. A group whose retrieve fails is recorded with its error rather than
 * dropped — "IGDB would not say" and "IGDB says neither of these" are
 * different answers, and only the second is a finding.
 *
 * The array it returns is the audit's `identityChecks`, and
 * ./shared_ref_repair_plan.js takes exactly that shape, so a repair can be
 * planned from a live run or read back out of an audit's `--json` report
 * without either side knowing which it got.
 *
 * @type {(collection: any, groups: any[]) => Promise<object[]>}
 */
const verifyIdentities = async (collection, groups) => {
  if (groups.length === 0) return [];

  const adapter = loadAdapter(collection);
  if (!adapter) return [];

  const delayMs = collection.defaultDelayMs;
  const checks = [];

  for (const [index, group] of groups.entries()) {
    if (index > 0) await sleep(delayMs);

    const result = await adapter.retrieve(group.ref);
    if (result.isErr()) {
      checks.push({
        apiRef: group.key,
        ref: group.ref,
        error: describeError(result.error),
        works: group.works.map(describeWork),
      });
      continue;
    }

    const { apiTitle, matches, mismatches } = resolveIdentity(group, result.value);
    checks.push({
      apiRef: group.key,
      ref: group.ref,
      apiTitle,
      matches: matches.map(describeWork),
      mismatches: mismatches.map(describeWork),
    });
  }

  return checks;
};

/** What went wrong, as a line to print, whatever shape the adapter threw. */
const describeError = (error) =>
  typeof error === "string" ? error : (error?.message ?? JSON.stringify(error));

module.exports = {
  loadAdapter,
  verifyIdentities,
  describeError,
};
