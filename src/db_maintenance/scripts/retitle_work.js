#!/usr/bin/env node
/**
 * @file Renames a work to the title its own identity ref answers with.
 *
 * The population is #448: works whose id is right and whose stored title is
 * not, so `titlesAgree` refuses every refresh and the work is frozen. 126 of
 * them across films and games, found by `audit_database.js --verify-titles`,
 * and the largest group needs nothing but the rename.
 *
 * **Nothing here chooses a title.** The new one must be, character for
 * character, what this work's own ref answers with — see
 * `retitleRefusalReason` in ../work_retitle_plan.js, which is where the
 * argument lives and where the suite can reach it. A row that gets it wrong
 * is refused exactly as a wrong id is in ./set_work_ref.js, so this can only
 * move a work towards what the API says and never away from it.
 *
 * **Why ./set_work_ref.js could not do this.** It renames only alongside an
 * id change and refuses a row whose id is not changing — `already has <ref>`
 * and `<ref> is already this work's ref`. Both are right for what it is for.
 * This is the other half.
 *
 * Writes only to the **work** collections. A person's own name for a work
 * lives on their entry and is not reachable from here; see
 * ../../docs/works_and_entries.md and ./link_entry.js.
 *
 * Usage:
 *   node scripts/retitle_work.js --from=renames.json
 *   node scripts/retitle_work.js --from=renames.json --apply
 *   node scripts/retitle_work.js --work=<id> --only=films --to="The Title" --apply
 *
 * `--from` takes `[{ "work": "<id>", "to": "The API's own title" }, ...]`.
 * One refusal skips its row and the rest carry on, because one bad row in a
 * list of twenty should not cost the other nineteen.
 *
 *   --apply   actually write (without it, nothing is written)
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  selectCollections,
  parseArgs,
  displayTitle,
  findApiRef,
  sleep,
} = require("../work_collections");
const { loadAdapter, describeError } = require("../load_adapter");
const { retitleRefusalReason, retitleUpdate } = require("../work_retitle_plan");

const main = async () => {
  const args = parseArgs(process.argv);
  const apply = args.apply === true;
  const collections = selectCollections(
    args.only === undefined || args.only === true ? undefined : String(args.only).split(",")
  );

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  const rows = args.from
    ? JSON.parse(fs.readFileSync(String(args.from), "utf8"))
    : args.work
      ? [{ work: String(args.work), to: String(args.to ?? "") }]
      : [];

  if (rows.length === 0) {
    console.log("Nothing to do: pass --from=<file>, or --work and --to.");
    return;
  }

  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecateErrors: true },
  });
  await client.connect();
  const db = client.db("memo");

  try {
    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${rows.length} row(s)\n`);
    let written = 0;
    let refused = 0;

    for (const row of rows) {
      const found = await findWork(db, collections, String(row.work ?? ""));
      if (!found) {
        console.log(`  ! ${row.work}: no work with that id in ${collections.map((c) => c.type).join(", ")}`);
        refused += 1;
        continue;
      }
      const { collection, work } = found;

      // Everything decidable without the API first, so a bad row costs no
      // call — the same ordering ./set_work_ref.js uses.
      const cheap = retitleRefusalReason({ collection, work, retitleTo: row.to });
      if (cheap && !/is not what |answered with no title|could not be asked/.test(cheap)) {
        console.log(`  ! "${displayTitle(work)}": ${cheap}`);
        refused += 1;
        continue;
      }

      const ref = findApiRef(work.apiRefs, collection.retrievePrefix);
      await sleep(collection.defaultDelayMs);
      const result = await loadAdapter(collection).retrieve(ref);
      const retrieveError = result.isErr() ? describeError(result.error) : undefined;
      const retrieved = result.isErr() ? undefined : result.value;

      const reason = retitleRefusalReason({
        collection, work, retitleTo: row.to, retrieved, retrieveError,
      });
      if (reason) {
        console.log(`  ! "${displayTitle(work)}": ${reason}`);
        refused += 1;
        continue;
      }

      const { set, unset } = retitleUpdate(work, row.to);
      console.log(
        `  ~ "${displayTitle(work)}" -> "${set.englishTranslatedTitle}"` +
          `  (${collection.type}; ${collection.retrievePrefix}__${ref} answered with it)`
      );

      if (apply) {
        await db.collection(collection.works).updateOne({ _id: work._id }, { $set: set, $unset: unset });
      }
      written += 1;
    }

    console.log(
      `\n${apply ? "renamed" : "would rename"}: ${written}, refused: ${refused}`
    );
    if (!apply && written > 0) console.log("Nothing was written. Re-run with --apply.");
  } finally {
    await client.close();
  }
};

/** The work with this id, in whichever of the selected collections holds it. */
const findWork = async (db, collections, id) => {
  for (const collection of collections) {
    const work = await db.collection(collection.works).findOne({ _id: id });
    if (work) return { collection, work };
  }
  return undefined;
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
