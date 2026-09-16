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
 *
 * `--from` takes `[{ "work": "<id>", "ref": "igdb__1234" }, ...]`, which is
 * what makes a backfill of 168 tractable: assemble the pairs however you like,
 * and every one still gets asked the same question before it is written. A
 * refusal in a batch skips that pair and the rest carry on, because one bad id
 * in a list of a hundred should not cost the other ninety-nine.
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
 *   --from=<file>   a JSON array of { work, ref } pairs
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
const { refusalReason, refUpdate } = require("../work_ref_repair");
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
      : [{ work: String(args.work), ref: String(args.ref ?? "") }];

    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${pairs.length} work(s)\n`);
    let done = 0;
    let refused = 0;

    for (const pair of pairs) {
      (await repairOne(db, pair, apply)) ? done++ : refused++;
    }

    console.log(`\n${apply ? "written" : "would write"}: ${done}, refused: ${refused}`);
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

/** @returns {Promise<boolean>} whether this pair was written (or would be). */
const repairOne = async (db, { work: workId, ref, retitleWorkTo }, apply) => {
  const parsed = parseApiRef(ref);
  // The work's own collection decides the type, and the ref's prefix is only
  // the fallback for a work that is not there at all. The other way round,
  // `find` answers `tmdb__` with films every time — both films and tv are
  // retrieved by it — so every tv repair looked itself up in the wrong
  // collection and was refused as a work that does not exist.
  const collection =
    (await collectionHolding(db, workId)) ??
    COLLECTIONS.find((c) => c.retrievePrefix === parsed?.name);

  if (!collection) {
    console.log(`  ! ${workId} -> ${ref}: refused — no collection holds that work, and "${ref}" names no type`);
    return false;
  }

  const work = await db.collection(collection.works).findOne({ _id: workId });
  const otherHolders = parsed
    ? await db.collection(collection.works).find({ apiRefs: ref, _id: { $ne: workId } }).toArray()
    : [];

  // Retrieved only once the free checks have passed, so a typo costs nothing.
  const cheapRefusal = refusalReason({ collection, work, ref, otherHolders, retrieved: {} });
  let retrieved;
  let retrieveError;
  if (!cheapRefusal) {
    // The collection's own pause, which is the one thing that keeps this
    // inside the API's budget: an IGDB retrieve is three of the four requests
    // a second it allows, and a flat 200ms spent half a batch on 429s.
    await sleep(collection.defaultDelayMs);
    const result = await loadAdapter(collection).retrieve(parsed.ref);
    if (result.isErr()) retrieveError = describeError(result.error);
    else retrieved = result.value;
  }

  const refusal =
    cheapRefusal ??
    refusalReason({ collection, work, ref, retitleWorkTo, otherHolders, retrieved, retrieveError });
  const label = work ? `"${displayTitle(work)}"` : workId;

  if (refusal) {
    console.log(`  ! ${label} -> ${ref}: refused — ${refusal}`);
    return false;
  }

  // Renamed only when the guard was got past, so a `retitleWorkTo` supplied
  // for a work whose title already agreed is a no-op rather than a rewrite.
  const retitleTo =
    retitleWorkTo && titlesAgree(work, retrieved) === false ? displayTitle(retrieved) : undefined;
  const { set, unset } = refUpdate(work, ref, retitleTo);

  console.log(`  ~ ${label} -> ${ref}  (${collection.type}; the API answers "${displayTitle(retrieved)}")`);
  console.log(`      apiRefs ${JSON.stringify(work.apiRefs ?? [])} -> ${JSON.stringify(set.apiRefs)}, metadataUpdatedDate cleared`);
  if (retitleTo) {
    console.log(`      englishTranslatedTitle "${displayTitle(work)}" -> "${retitleTo}"`);
    await warnIfNameVanishes(db, collection, work, retitleTo);
  }
  if (apply) await db.collection(collection.works).updateOne({ _id: workId }, { $set: set, $unset: unset });
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
