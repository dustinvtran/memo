#!/usr/bin/env node
/**
 * @file Gives one work the identity ref it has none of, having first asked the
 * API whether that id really names it.
 *
 * 168 works carry no ref their type can be retrieved by, and every one is on
 * somebody's list — the unreferenced ones were pruned. Until now nothing here
 * could put one right: every other script operates on a population, and this
 * repair is inherently per-work, because a human has to look the id up.
 *
 * **A human looking an id up is exactly where #290 came from** — `Kingdom
 * Hearts` under Kingdom Hearts III's id, `Demons` under a French *Angels &
 * Demons* ISBN. So the id is retrieved and the title compared against the
 * stored one before anything is written, and a disagreement is refused. The
 * verdict lives in ../work_ref_repair.js, tested with no install and no
 * network; this file does the reads, the retrieve and the write.
 *
 * Usage:
 *   node scripts/set_work_ref.js --list
 *   node scripts/set_work_ref.js --list --only=games
 *   node scripts/set_work_ref.js --work=<id> --ref=igdb__1234
 *   node scripts/set_work_ref.js --work=<id> --ref=igdb__1234 --apply
 *   node scripts/set_work_ref.js --from=refs.json --apply
 *   node scripts/set_work_ref.js --from=work_refs.json --apply
 *   node scripts/set_work_ref.js --work=<id> --unlink=tmdb__62128 --apply
 *
 * `--from` takes `[{ "work": "<id>", "ref": "igdb__1234" }, ...]`, which is
 * what makes a backfill of 168 tractable: assemble the pairs however you like,
 * and every one still gets asked the same question before it is written. A
 * refusal in a batch skips that row and the rest carry on, because one bad id
 * in a list of a hundred should not cost the other ninety-nine.
 *
 * **A row may carry `"alternates"`, and that is #388.** One refused id used to
 * skip the work, and the second-ranked candidate — already scored by
 * scripts/propose_work_refs.js, and quite possibly the right one — sat in the
 * file untried while a person looked the id up by hand, which is the work that
 * script exists to avoid. The refusal is expected rather than exceptional: the
 * proposal's own header says the score orders rather than decides, and TMDB
 * answers `Hero` with `THE RIBBON HERO` before `Big Hero 6`. So the ids on a
 * row are a queue, tried in order until one passes, and the run says which was
 * taken and why each earlier one was not:
 *
 *     { "work": "<id>", "ref": "tmdb__1", "alternates": ["tmdb__2", "tmdb__3"] }
 *
 * **Nothing about the guard is softened by that.** Each id in the queue is
 * retrieved and compared exactly as a lone `--ref` is, and an alternate that
 * disagrees on its title is refused in the same words. The one thing that does
 * not travel down a queue is `retitleWorkTo`, because it is evidence about one
 * id rather than about the row — an alternate that needs one gives its own,
 * `{ "ref": "igdb__73", "retitleWorkTo": "Portal 2" }`. See ../work_ref_repair.js.
 *
 * **`--from` also reads scripts/propose_work_refs.js's own file**, so there is
 * no flattening step between the two: fill `ref` on the rows you have
 * confirmed, add `alternates` where the second candidate is worth a try, and
 * hand the file over. A row with nothing filled in is passed over rather than
 * refused, and an `entry` row is passed over too — that one is
 * scripts/link_entry.js's. The `candidates` array the search wrote is never
 * read, which is the point: those are what was found, `ref` and `alternates`
 * are what a person chose, and a search's first hit is still not an answer.
 *
 * A pair carrying `"unlink"` does the third thing that can be wrong with a
 * ref, after missing and wrong: the id was real and the API has since dropped
 * it. #378 unlinked eight that way, and they were believed only after being
 * asked twice, because #375 had just established that one empty answer proves
 * nothing. The guard is the inverse of the one below — a ref that still
 * answers is not dead, so it is refused, and the refusal says which of the
 * other two repairs was wanted instead. `"becauseItNames"` is the way past
 * that for a ref that answers with something else and has no replacement to
 * point at, and it is checked against the retrieve like every other claim here.
 *
 * A pair may also carry `"replacesRef"`, for the other half of the population:
 * a work whose stored id is not missing but wrong. #378 found twenty of them —
 * `Her Story` under `The Sych Story: Ded's Story`, `Until Dawn` under
 * `Dawn of War II` — ids that retrieve perfectly and name something else, so
 * nothing here would touch them and the next refresh would overwrite the work
 * with the other thing's metadata. Naming the ref you are taking off is the
 * same evidence `retitleWorkTo` asks for: you can only write it having looked
 * at the work, and it is checked against what the work actually carries, so a
 * stale worklist refuses rather than writing. The wrong ref is dropped rather
 * than kept beside the new one — see `refUpdate`.
 *
 * A pair may also carry `"retitleWorkTo"`, which is the answer to the case the
 * guard cannot judge: a right id under a name of your own. `Doom mod: Sigil`
 * is IGDB's `Sigil` and `Portal 2: Coop` is `Portal 2`, and both look exactly
 * like a wrong id from here. Naming the API's own title says you read it, and
 * is checked against the retrieve rather than taken on trust — see
 * ../work_ref_repair.js. The work is renamed to it as the ref goes on, because
 * a title is fill-only and no refresh would ever correct it.
 *
 * Flags:
 *   --list          print the works with no identity ref and exit
 *   --only=a,b      restrict to these collections
 *   --work=<id>     the work to repair
 *   --ref=<ref>     the ref to give it, as <prefix>__<id>
 *   --alternates=<ref>,<ref>  ids to fall back to, tried in order, each
 *                   getting the same guard and none inheriting a retitle
 *   --retitleWorkTo=<title>  the API's own title, for a right id under a name
 *                   of your own, which is how this says you read the answer
 *   --replacesRef=<ref>  the wrong ref to take off, for a work that has one
 *   --unlink=<ref>  take this ref off and give none, for an id the API dropped
 *   --becauseItNames=<title>  what a still-answering ref answers with, which
 *                   is how an unlink of one says it was read rather than guessed
 *   --from=<file>   a JSON array of { work, ref, alternates? } rows, or
 *                   propose_work_refs.js's own file with the refs filled in
 *   --apply         actually write (without it, nothing is written)
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  selectCollections,
  parseArgs,
  findApiRef,
  displayTitle,
  parseApiRef,
  titlesAgree,
  comparableTitle,
  sleep,
} = require("../work_collections");
const { loadAdapter, describeError } = require("../load_adapter");
const {
  refCandidates,
  chooseRef,
  refusalReason,
  refUpdate,
  unlinkRefusalReason,
  unlinkUpdate,
} = require("../work_ref_repair");
const { filedAs } = require("../../api/utils/entry_state");

const main = async () => {
  const args = parseArgs(process.argv);
  const apply = args.apply === true;
  const collections = selectCollections(
    args.only === undefined || args.only === true ? undefined : String(args.only).split(",")
  );

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecateErrors: true },
  });
  await client.connect();
  const db = client.db("memo");

  try {
    if (args.list === true || (!args.work && !args.from)) {
      await listUnrefreshable(db, collections);
      if (!args.work && !args.from && args.list !== true) {
        console.log("\nNothing to do: pass --work and --ref, or --from=<file>.");
      }
      return;
    }

    const pairs = args.from
      ? JSON.parse(fs.readFileSync(String(args.from), "utf8"))
      : [{
          work: String(args.work),
          ref: String(args.ref ?? ""),
          alternates:
            args.alternates === undefined || args.alternates === true
              ? []
              : String(args.alternates).split(","),
          retitleWorkTo: args.retitleWorkTo,
          replacesRef: args.replacesRef,
          unlink: args.unlink,
          becauseItNames: args.becauseItNames,
        }];

    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${pairs.length} row(s)\n`);
    let done = 0;
    let refused = 0;
    let unchosen = 0;

    for (const pair of pairs) {
      if (pair.unlink) {
        (await unlinkOne(db, pair, apply)) ? done++ : refused++;
        continue;
      }
      // A row with no id filled in is passed over rather than refused, which
      // is what lets propose_work_refs.js's own file be handed straight to
      // `--from`: it writes `"ref": ""` on every row, and its entry rows are
      // scripts/link_entry.js's work rather than this script's.
      if (!pair.work || refCandidates(pair).length === 0) {
        unchosen++;
        continue;
      }
      (await repairOne(db, pair, apply)) ? done++ : refused++;
    }

    console.log(
      `\n${apply ? "written" : "would write"}: ${done}, refused: ${refused}` +
        (unchosen > 0 ? `, no ref chosen: ${unchosen}` : "")
    );
    if (!apply && done > 0) console.log("Nothing was written. Re-run with --apply.");
  } finally {
    await client.close();
  }
};

/** The worklist: every work no adapter can be asked about, with its entries. */
const listUnrefreshable = async (db, collections) => {
  for (const collection of collections) {
    const works = await db.collection(collection.works).find({}).toArray();
    const entries = await db
      .collection(collection.entries)
      .find({}, { projection: { workRef: 1 } })
      .toArray();
    const counts = entries.reduce(
      (acc, entry) => acc.set(String(entry.workRef), (acc.get(String(entry.workRef)) ?? 0) + 1),
      new Map()
    );

    const missing = works.filter((work) => !findApiRef(work.apiRefs, collection.retrievePrefix));
    console.log(`\n=== ${collection.type}: ${missing.length} with no ${collection.retrievePrefix}__ ref ===`);
    for (const work of missing) {
      const held = counts.get(String(work._id)) ?? 0;
      console.log(
        `  ${work._id}  "${displayTitle(work)}"${work.releaseYear ? ` (${work.releaseYear})` : ""}` +
          `  entries=${held}  apiRefs=${JSON.stringify(work.apiRefs ?? [])}`
      );
    }
  }
};

/**
 * One row of the worklist: the ids it names, tried in order until one passes.
 *
 * `main` has already established that the row names at least one id — a row
 * that names none is passed over there rather than refused here — so `queue[0]`
 * is the row's first choice and is what the messages before the loop speak of.
 * @returns {Promise<boolean>} whether this row was written (or would be).
 */
const repairOne = async (db, pair, apply) => {
  const workId = String(pair.work);
  const queue = refCandidates(pair);
  // The work's own collection decides the type, and the ref's prefix is only
  // the fallback for a work that is not there at all. The other way round,
  // `find` answers `tmdb__` with films every time — both films and tv are
  // retrieved by it — so every tv repair looked itself up in the wrong
  // collection and was refused as a work that does not exist.
  const collection =
    (await collectionHolding(db, workId)) ??
    COLLECTIONS.find((c) => c.retrievePrefix === parseApiRef(queue[0].ref)?.name);

  if (!collection) {
    console.log(
      `  ! ${workId} -> ${queue[0].ref}: refused — no collection holds that work, and "${queue[0].ref}" names no type`
    );
    return false;
  }

  const work = await db.collection(collection.works).findOne({ _id: workId });

  // Every candidate would refuse for this one reason, so it is said once here
  // rather than once per id in the queue.
  if (!work) {
    console.log(`  ! ${workId} -> ${queue[0].ref}: refused — ${refusalReason({ collection, work, ref: queue[0].ref })}`);
    return false;
  }
  const label = `"${displayTitle(work)}"`;
  const adapter = loadAdapter(collection);

  // The guard, once per candidate, in order, stopping at the first that
  // passes — see `chooseRef`. The queue is ids a person chose; the question
  // asked of each is the same one a single `--ref` is asked.
  const { taken, retrieved, refused } = await chooseRef(pair, async ({ ref, retitleWorkTo, replacesRef }) => {
    const parsed = parseApiRef(ref);
    const otherHolders = parsed
      ? await db.collection(collection.works).find({ apiRefs: ref, _id: { $ne: workId } }).toArray()
      : [];

    // Retrieved only once the free checks have passed, so a typo costs
    // nothing — and a queue of three typos still costs nothing.
    const cheapRefusal = refusalReason({ collection, work, ref, replacesRef, otherHolders, retrieved: {} });
    if (cheapRefusal) return { reason: cheapRefusal };

    // The collection's own pause, which is the one thing that keeps this
    // inside the API's budget: an IGDB retrieve is three of the four requests
    // a second it allows, and a flat 200ms spent half a batch on 429s. It
    // sits with the retrieve rather than with the row, so an alternate is
    // paced exactly as a first choice is and a row of three alternates is
    // three pauses rather than one.
    await sleep(collection.defaultDelayMs);
    const result = await adapter.retrieve(parsed.ref);
    const retrieveError = result.isErr() ? describeError(result.error) : undefined;
    const answered = result.isErr() ? undefined : result.value;

    return {
      reason: refusalReason({
        collection, work, ref, retitleWorkTo, replacesRef, otherHolders,
        retrieved: answered, retrieveError,
      }),
      retrieved: answered,
    };
  });

  // Why each earlier candidate was not taken, which is the point of trying
  // them in order: a row that ends up refused says it about every id it had.
  for (const attempt of refused) {
    console.log(`  ! ${label} -> ${attempt.ref}: refused — ${attempt.reason}`);
  }
  if (!taken) return false;

  // Renamed only when the guard was got past, so a `retitleWorkTo` supplied
  // for a work whose title already agreed is a no-op rather than a rewrite.
  // It is the accepted candidate's own, never the queue's first: see #388 and
  // `refCandidates`.
  const retitleTo =
    taken.retitleWorkTo && titlesAgree(work, retrieved) === false ? displayTitle(retrieved) : undefined;
  const { set, unset } = refUpdate(work, taken.ref, retitleTo, taken.replacesRef);

  const ordinal = queue.length > 1 ? `; candidate ${refused.length + 1} of ${queue.length}` : "";
  console.log(`  ~ ${label} -> ${taken.ref}  (${collection.type}; the API answers "${displayTitle(retrieved)}"${ordinal})`);
  console.log(`      apiRefs ${JSON.stringify(work.apiRefs ?? [])} -> ${JSON.stringify(set.apiRefs)}, metadataUpdatedDate cleared`);
  if (retitleTo) {
    console.log(`      englishTranslatedTitle "${displayTitle(work)}" -> "${retitleTo}"`);
    await warnIfNameVanishes(db, collection, work, retitleTo);
  }
  if (apply) await db.collection(collection.works).updateOne({ _id: workId }, { $set: set, $unset: unset });
  return true;
};

/**
 * Takes a ref off, having asked the API whether it is really gone.
 *
 * The retrieve is not skippable the way a cheap refusal skips one above: an
 * answer is the whole verdict here, so there is nothing to decide before it.
 * @type {(db: any, pair: object, apply: boolean) => Promise<boolean>}
 */
const unlinkOne = async (db, { work: workId, unlink: unlinkRef, becauseItNames }, apply) => {
  const parsed = parseApiRef(unlinkRef);
  const collection =
    (await collectionHolding(db, workId)) ??
    COLLECTIONS.find((c) => c.retrievePrefix === parsed?.name);

  if (!collection) {
    console.log(`  ! ${workId} -/- ${unlinkRef}: refused — no collection holds that work, and "${unlinkRef}" names no type`);
    return false;
  }

  const work = await db.collection(collection.works).findOne({ _id: workId });
  const label = work ? `"${displayTitle(work)}"` : workId;

  let retrieved;
  let retrieveError;
  if (parsed && work) {
    await sleep(collection.defaultDelayMs);
    const result = await loadAdapter(collection).retrieve(parsed.ref);
    if (result.isErr()) retrieveError = describeError(result.error);
    else retrieved = result.value;
  }

  const refusal = unlinkRefusalReason({ collection, work, unlinkRef, becauseItNames, retrieved, retrieveError });
  if (refusal) {
    console.log(`  ! ${label} -/- ${unlinkRef}: refused — ${refusal}`);
    return false;
  }

  const { set } = unlinkUpdate(work, unlinkRef);
  console.log(
    `  ~ ${label} -/- ${unlinkRef}  (${collection.type}; ` +
      (retrieveError ? `the API would not answer: ${retrieveError}` : `the API answers "${displayTitle(retrieved)}"`) + `)`
  );
  console.log(`      apiRefs ${JSON.stringify(work.apiRefs ?? [])} -> ${JSON.stringify(set.apiRefs)}`);
  if (!findApiRef(set.apiRefs, collection.retrievePrefix)) {
    console.log(`      no ${collection.retrievePrefix}__ ref left — nothing can refresh this work until one is given`);
  }
  if (apply) await db.collection(collection.works).updateOne({ _id: workId }, { $set: set });
  return true;
};

/**
 * A retitle is how `Portal 2: Coop` gets IGDB's `Portal 2`, and it is also how
 * the word `Coop` stops being written down anywhere. The name was the owner's,
 * it said something the API's title does not, and after this it survives only
 * if an entry carries it as an override.
 *
 * **Only when the stored title is the API's title plus something**, which is
 * what separates a name from a misspelling. `Portal 2: Coop` contains `Portal
 * 2` and the extra word is the whole point of the row; `McCabe & Mrs. McMiller`
 * contains nothing of `McCabe & Mrs. Miller` and losing it is the repair. On
 * the 49-row batch this is the difference between eight warnings worth reading
 * and twenty-six that train you to skip them.
 *
 * Pointed at rather than prevented, and pointed at rather than fixed: writing
 * an override would be this script inventing text on an entry, which is the
 * line the folder does not cross. scripts/link_entry.js takes an `entryTitle`
 * from a person and writes it, and the two run in that order for this reason.
 * @type {(db: any, collection: any, work: any, retitleTo: string) => Promise<void>}
 */
const warnIfNameVanishes = async (db, collection, work, retitleTo) => {
  const was = comparableTitle(displayTitle(work));
  const now = comparableTitle(retitleTo);
  if (!was || !now || !was.includes(now)) return;

  const entries = await db
    .collection(collection.entries)
    .find({ workRef: String(work._id) })
    .toArray();
  const unnamed = entries.filter((entry) => filedAs(entry) === null);
  if (unnamed.length === 0) return;

  console.log(
    `      ! "${displayTitle(work)}" is not written down anywhere else — ` +
      `${unnamed.length} entr${unnamed.length === 1 ? "y" : "ies"} on this work ` +
      `will read "${retitleTo}". Give it back with link_entry.js's entryTitle if it mattered.`
  );
  for (const entry of unnamed) console.log(`          entry ${entry._id}`);
};

/** For a `--work` whose `--ref` did not name a type: find the work by id. */
const collectionHolding = async (db, workId) => {
  for (const collection of COLLECTIONS) {
    if (await db.collection(collection.works).findOne({ _id: workId }, { projection: { _id: 1 } })) {
      return collection;
    }
  }
  return undefined;
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
