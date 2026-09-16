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
  sleep,
} = require("../work_collections");
const { loadAdapter, describeError } = require("../load_adapter");
const { refusalReason, refUpdate } = require("../work_ref_repair");

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

    for (const [index, pair] of pairs.entries()) {
      // One call per pair, spaced by the collection's own pause: this walks
      // the same APIs the crawl does and has no more right to their quota.
      if (index > 0) await sleep(200);
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
const repairOne = async (db, { work: workId, ref }, apply) => {
  const parsed = parseApiRef(ref);
  const collection =
    COLLECTIONS.find((c) => c.retrievePrefix === parsed?.name) ??
    (await collectionHolding(db, workId));

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
    const result = await loadAdapter(collection).retrieve(parsed.ref);
    if (result.isErr()) retrieveError = describeError(result.error);
    else retrieved = result.value;
  }

  const refusal = cheapRefusal ?? refusalReason({ collection, work, ref, otherHolders, retrieved, retrieveError });
  const label = work ? `"${displayTitle(work)}"` : workId;

  if (refusal) {
    console.log(`  ! ${label} -> ${ref}: refused — ${refusal}`);
    return false;
  }

  const { set, unset } = refUpdate(work, ref);
  console.log(`  ~ ${label} -> ${ref}  (${collection.type}; the API answers "${displayTitle(retrieved)}")`);
  console.log(`      apiRefs ${JSON.stringify(work.apiRefs ?? [])} -> ${JSON.stringify(set.apiRefs)}, metadataUpdatedDate cleared`);
  if (apply) await db.collection(collection.works).updateOne({ _id: workId }, { $set: set, $unset: unset });
  return true;
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
