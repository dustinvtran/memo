#!/usr/bin/env node
/**
 * @file Attaches an entry to the work it belongs on, moves one that is on the
 * wrong work, and deletes one whose row is a duplicate.
 *
 * The companion to scripts/set_work_ref.js. That one repairs a work that has
 * no identity; this one is for the entries no work repair can reach — an entry
 * with no `workRef` at all, and an entry sitting on a work that should never
 * have been a work. ../entry_link_plan.js has the three shapes and why each
 * needs a different write.
 *
 * **This is the second script in this folder allowed to write to `*Entries`,
 * and the rule it is an exception to is worth restating.** A maintenance
 * script must not touch entry documents, because `entry.overrides` is text a
 * person wrote and a sweep cannot know what it means. Nothing here sweeps:
 * every operation names one entry by its id, and every `entryTitle` it writes
 * was typed by hand, for that row, by the person whose row it is. A script
 * that selected its own targets would be the thing the rule forbids, however
 * carefully it was written.
 *
 * Usage:
 *   node scripts/link_entry.js --from=ops.json
 *   node scripts/link_entry.js --from=ops.json --apply
 *
 * `--from` takes a JSON array of operations:
 *
 *   { "op": "link", "type": "games", "entry": "<id>", "ref": "igdb__8965",
 *     "entryTitle": "Darkest Dungeon with all 3 DLCs" }
 *
 *       An entry with no work. The work already holding that ref is used if
 *       there is one; otherwise one is created from what the API answers.
 *
 *   { "op": "move", "type": "games", "entry": "<id>" | "fromWork": "<id>",
 *     "toWork": "<id>", "entryTitle": "Portal 2: Coop (2011)" }
 *
 *       An entry on a sub-work — a DLC pack, a season, a second run — moved
 *       onto the work that already answers to the API, carrying its name as an
 *       override. The work it came from is deleted once it is empty.
 *
 *   { "op": "retitle", "type": "games", "entry": "<id>", "toWork": "<id>",
 *     "entryTitle": "Portal 2: Coop (2011)" }
 *
 *       An entry already on the right work, given back a name the work has
 *       just lost. scripts/set_work_ref.js renames a work to the API's own
 *       title, so `Portal 2: Coop` becomes `Portal 2` and the word `Coop` is
 *       written down nowhere; that script says so and this is the answer.
 *       Run the two in that order — a work with no identity ref is refused.
 *
 *   Any of the three above may also carry `"workTitle": "<the API's title>"`,
 *   which renames the work to it and clears `metadataUpdatedDate` so that it
 *   refreshes again. A work is the database's copy of what an API says and a
 *   person's name for it belongs on their entry, overlaying whatever the work
 *   later becomes; where a row is stored the other way round the title guard
 *   freezes the work for good, which is 93 of them. It is refused without an
 *   `entryTitle` to keep the owner's name, and checked against the retrieve
 *   like every other claim here. #381.
 *
 *   { "op": "delete", "type": "films", "entry": "<id>" | "work": "<id>" }
 *
 *       A duplicate row. The entry goes, its notes go with it, and the work
 *       goes too if that entry was its last.
 *
 * Flags:
 *   --from=<file>   the operations, as above
 *   --apply         actually write (without it, nothing is written)
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  parseArgs,
  displayTitle,
  parseApiRef,
  findApiRef,
  sleep,
} = require("../work_collections");
const { loadAdapter, describeError } = require("../load_adapter");
const {
  linkRefusalReason,
  siblingsAfterRun,
  deleteRefusalReason,
  linkUpdate,
  nameAfter,
  overrideIsRedundant,
  workTitleRefusalReason,
  workTitleUpdate,
} = require("../entry_link_plan");
// The API's own parser for a work document. A work created here has to be
// indistinguishable from one created through the site, and the only way to be
// sure of that is to run it through the thing the site runs it through.
const parsers = require("../../api/utils/parsers");

/**
 * The works this run has created, by the ref they were created for, so that a
 * second operation naming the same ref lands on the first one's work rather
 * than making another. Only a dry run needs it — an apply has already written
 * the document and finds it by query — but it is kept for both so the two
 * agree about what the run does.
 * @type {Map<string, any>}
 */
const createdThisRun = new Map();

/**
 * Every entry this run has written, by its id, as the run has left it — on the
 * work it now sits on and under the name it is now filed as. The same argument
 * as `createdThisRun` one level down: a dry run reads the siblings of a work
 * from the database, so without this it judges each operation against the names
 * as they were before the run started and refuses the second half of a file
 * that frees a name and then takes it. ../entry_link_plan.js `siblingsAfterRun`
 * is what folds it over the read. #386.
 *
 * One map per collection, because an id is only unique within one: a `--from`
 * file may name a film and a game, and the numeric ids the first import wrote
 * are short enough for two collections to hold the same one.
 * @type {Map<string, Map<string, any>>}
 */
const assignedThisRun = new Map();

/** The run's writes to one collection's entries, created on first use. */
const assignedIn = (collection) =>
  assignedThisRun.get(collection.entries) ??
  assignedThisRun.set(collection.entries, new Map()).get(collection.entries);

const main = async () => {
  const args = parseArgs(process.argv);
  const apply = args.apply === true;

  if (!args.from) throw new Error("Nothing to do: pass --from=<file>.");
  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  const ops = JSON.parse(fs.readFileSync(String(args.from), "utf8"));
  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecateErrors: true },
  });
  await client.connect();
  const db = client.db("memo");

  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${ops.length} operation(s)\n`);
  let done = 0;
  let refused = 0;

  try {
    for (const [index, op] of ops.entries()) {
      if (index > 0) await sleep(200);
      const ok = await runOne(db, op, apply).catch((error) => {
        console.log(`  ! ${op.op} ${op.entry ?? op.work ?? ""}: failed — ${error.message}`);
        return false;
      });
      ok ? done++ : refused++;
    }
  } finally {
    await client.close();
  }

  console.log(`\n${apply ? "written" : "would write"}: ${done}, refused: ${refused}`);
  if (!apply && done > 0) console.log("Nothing was written. Re-run with --apply.");
};

/** @returns {Promise<boolean>} whether this operation was written (or would be). */
const runOne = async (db, op, apply) => {
  const collection = COLLECTIONS.find((c) => c.type === op.type);
  if (!collection) {
    console.log(`  ! ${op.op}: refused — "${op.type}" is not one of ${COLLECTIONS.map((c) => c.type).join(", ")}`);
    return false;
  }

  const entry = await findEntry(db, collection, op);
  if (op.op === "delete") return await deleteOne(db, collection, op, entry, apply);

  // The work to land on: for a move it is named outright, for a link it is
  // whichever work already holds the ref — and if none does, one is created
  // from what the API answers, which is the only way an entry that predates
  // the databases can ever start refreshing.
  const holders = op.ref
    ? [
        ...(await db.collection(collection.works).find({ apiRefs: op.ref }).toArray()),
        // Works this run has already created. On an `--apply` they are in the
        // database by now and the query above finds them; on a dry run nothing
        // was inserted, so without this each of two seasons of one show would
        // report a work being created and the run would predict two works
        // under one id — the #290 collision, invented by the dry run and never
        // produced by the apply. A dry run that does not describe the apply is
        // worse than no dry run.
        ...(createdThisRun.has(op.ref) && !(await db.collection(collection.works).findOne({ apiRefs: op.ref }))
          ? [createdThisRun.get(op.ref)]
          : []),
      ]
    : undefined;
  const target = op.toWork
    ? await db.collection(collection.works).findOne({ _id: op.toWork })
    : holders?.[0];

  const siblings = siblingsAfterRun({
    siblings: target
      ? await db
          .collection(collection.entries)
          .find({ workRef: String(target._id), userId: entry?.userId })
          .toArray()
      : [],
    workId: target?._id,
    userId: entry?.userId,
    assigned: assignedIn(collection),
  });

  const refusal = linkRefusalReason({
    entry,
    work: target,
    ref: op.ref,
    collection,
    entryTitle: op.entryTitle,
    siblings,
    holders,
  });
  if (refusal) {
    console.log(`  ! ${op.op} ${op.entry ?? op.fromWork}: refused — ${refusal}`);
    return false;
  }

  const work = target ?? (await createWorkFrom(db, collection, op, apply));
  if (!work) return false;
  if (!target && op.ref) createdThisRun.set(op.ref, work);

  // Not a refusal: the target was named, so the choice was made by a person.
  // Worth one line, because the other holder is a collision nobody has
  // resolved and it will keep turning up in the audit.
  if (op.toWork && holders && holders.length > 1) {
    const others = holders.filter((other) => String(other._id) !== String(work._id));
    console.log(`      note: ${op.ref} also names ${others.map((other) => `${other._id} "${displayTitle(other)}"`).join(", ")}`);
  }

  // Before the entry write, so a refused rename leaves the row exactly as it
  // was rather than half-done.
  const renamed = op.workTitle === undefined ? undefined : await adoptApiTitle(db, collection, work, op, apply);
  if (renamed === false) return false;

  const { set, unset } = linkUpdate({ entry, workId: work._id, entryTitle: op.entryTitle });
  const filed = nameAfter(entry, op.entryTitle);

  console.log(`  ~ ${op.op} "${op.was ?? displayTitle(entry?.overrides ?? {})}" (entry ${entry._id})`);
  console.log(`      onto ${collection.works} ${work._id} "${displayTitle(work)}"${target ? "" : "  (created)"}`);
  console.log(`      workRef ${entry.workRef ?? "(none)"} -> ${work._id}, filed as ${filed === null ? "the work's own title" : `"${filed}"`}`);
  // Said rather than done. The override an unlinked entry carries is how its
  // title was stored, and once it is on a work saying the same thing it has
  // become a copy that no refresh will correct - but clearing it is a decision
  // for whoever typed it, so this points and stops.
  if (op.entryTitle === undefined && overrideIsRedundant(entry, work)) {
    console.log(`      its override "${filed}" now says what the work says — pass "entryTitle": "" to drop it and track the work instead`);
  }

  if (apply) {
    await db.collection(collection.entries).updateOne(
      { _id: entry._id },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
    );
  }

  // Recorded in both modes, like `createdThisRun`, so the dry run and the apply
  // answer "what is on this work" the same way rather than by coincidence.
  assignedIn(collection).set(String(entry._id), {
    ...entry,
    workRef: String(work._id),
    overrides: { ...entry.overrides, englishTranslatedTitle: filed },
  });

  // The work the entry came from, now that nothing is on it. Left behind it
  // would be a work with no entries and no id, which is what the audit calls
  // an orphan and what the last prune deleted 18 of.
  if (op.fromWork) await dropEmptyWork(db, collection, op.fromWork, entry._id, apply);
  return true;
};

/**
 * Gives the work the API's own title, so that it can refresh again.
 *
 * A work is the database's copy of what an API says, and a person's own name
 * for it belongs on their entry, overlaying whatever the work later becomes.
 * Where that is not how a row is stored, `mergeWork`'s title guard freezes the
 * work for good: `Ozark: Season 4` under Ozark's id and `House M.D.` under
 * *House*'s are not damaged, they are named by their owner, and neither has
 * refreshed since. #381.
 *
 * Only ever alongside the `entryTitle` that keeps the owner's name — the plan
 * module refuses the rename without it, because buying a refresh by losing the
 * name somebody typed is not a repair.
 *
 * @type {(db: any, collection: any, work: any, op: object, apply: boolean) => Promise<boolean>}
 */
const adoptApiTitle = async (db, collection, work, op, apply) => {
  const ref = findApiRef(work.apiRefs, collection.retrievePrefix);
  let retrieved;
  let retrieveError;
  if (!ref) {
    retrieveError = `it carries no ${collection.retrievePrefix}__ ref`;
  } else {
    await sleep(collection.defaultDelayMs);
    const result = await loadAdapter(collection).retrieve(ref);
    if (result.isErr()) retrieveError = describeError(result.error);
    else retrieved = result.value;
  }

  const refusal = workTitleRefusalReason({
    work,
    workTitle: op.workTitle,
    entryTitle: op.entryTitle,
    retrieved,
    retrieveError,
  });
  if (refusal) {
    console.log(`  ! ${op.op} ${op.entry ?? op.fromWork}: refused — ${refusal}`);
    return false;
  }

  const { set, unset } = workTitleUpdate(retrieved);
  if (set.englishTranslatedTitle !== displayTitle(work)) {
    console.log(`      work "${displayTitle(work)}" -> "${set.englishTranslatedTitle}", metadataUpdatedDate cleared so it refreshes`);
    if (apply) await db.collection(collection.works).updateOne({ _id: work._id }, { $set: set, $unset: unset });
    // So the lines below, and the entry's `filedAs`, describe the work as it
    // will be rather than as it was.
    work.englishTranslatedTitle = set.englishTranslatedTitle;
  }
  return true;
};

/** A duplicate row: the entry, its notes, and the work if that was its last. */
const deleteOne = async (db, collection, op, entry, apply) => {
  const target = entry;
  if (!target) {
    console.log(`  ! delete ${op.entry ?? op.work}: refused — no entry with that id`);
    return false;
  }

  // An entry with no work is a real shape here, not a broken one — it is what
  // 23 of these rows are. So the work half of this is skipped rather than run
  // against `undefined`, which the driver would send as `{ _id: null }` and
  // which really does match a document if one ever carries a null id.
  const workRef = typeof target.workRef === "string" && target.workRef !== "" ? target.workRef : undefined;
  const others = workRef
    ? await db
        .collection(collection.entries)
        .find({ workRef, _id: { $ne: target._id } })
        .toArray()
    : [];
  const refusal = deleteRefusalReason({ entry: target, otherEntries: others });
  if (refusal) {
    console.log(`  ! delete ${target._id}: refused — ${refusal}`);
    return false;
  }

  const reviews = await db
    .collection(collection.reviews)
    .find({ entryRef: String(target._id) })
    .toArray();

  console.log(`  ~ delete "${op.was ?? target._id}" (entry ${target._id}, ${target.status}${target.score != null ? ` ${target.score}` : ""})`);
  console.log(
    workRef
      ? `      work ${workRef} goes with it — no other entry is on it`
      : `      it has no work — the entry and its notes are all there is`
  );
  // Printed in full rather than counted. A note is the one thing in here that
  // cannot be reconstructed from an API, and a person who said "delete the
  // duplicate" may not have known there was one on it.
  for (const review of reviews) {
    console.log(`      note ${review._id} (${String(review.text ?? "").length} chars) goes too:`);
    console.log(
      String(review.text ?? "")
        .split("\n")
        .map((line) => `        | ${line}`)
        .join("\n")
    );
  }

  if (apply) {
    for (const review of reviews) {
      await db.collection(collection.reviews).deleteOne({ _id: review._id });
    }
    await db.collection(collection.entries).deleteOne({ _id: target._id });
    if (workRef) await db.collection(collection.works).deleteOne({ _id: workRef });
  }
  return true;
};

/** The entry named outright, or the only one on the work that was named. */
const findEntry = async (db, collection, op) => {
  if (op.entry) return await db.collection(collection.entries).findOne({ _id: op.entry });

  const on = op.fromWork ?? op.work;
  if (!on) return undefined;
  const entries = await db.collection(collection.entries).find({ workRef: String(on) }).toArray();
  // Naming a work rather than an entry is only shorthand for "the one entry on
  // it". Two would make it a guess, and this refuses to guess.
  return entries.length === 1 ? entries[0] : undefined;
};

/**
 * A work built from what the API answers, for an entry whose work never
 * existed. Everything else it will ever hold arrives on the next refresh,
 * which is why `metadataUpdatedDate` is not written.
 */
const createWorkFrom = async (db, collection, op, apply) => {
  const result = await loadAdapter(collection).retrieve(parseApiRef(op.ref).ref);
  if (result.isErr()) {
    console.log(`  ! link ${op.entry}: refused — the API would not answer for ${op.ref}: ${describeError(result.error)}`);
    return undefined;
  }

  const parsed = parsers[collection.works]({
    apiRefs: [op.ref],
    entryType: collection.entryType,
    ...result.value,
  });
  if (parsed.isErr()) {
    console.log(`  ! link ${op.entry}: refused — ${op.ref} does not answer with a valid ${collection.type} work: ${parsed.error?.message ?? parsed.error}`);
    return undefined;
  }

  // `_id` then the document, which is the order src/api/utils/db writes them
  // in. `metadataUpdatedDate` is deliberately absent: the next refresh should
  // treat this work as never checked and fill in everything an adapter can.
  const work = { _id: newId(), ...parsed.value };
  if (apply) await db.collection(collection.works).insertOne(work);
  return work;
};

/** The work an entry has just left, if nothing else is on it. */
const dropEmptyWork = async (db, collection, workId, movedEntryId, apply) => {
  const left = await db
    .collection(collection.entries)
    .find({ workRef: String(workId), _id: { $ne: movedEntryId } })
    .toArray();
  if (left.length > 0) {
    console.log(`      work ${workId} kept — ${left.length} other entr${left.length === 1 ? "y" : "ies"} still on it`);
    return;
  }
  console.log(`      work ${workId} deleted — nothing is on it now`);
  if (apply) await db.collection(collection.works).deleteOne({ _id: String(workId) });
};

/**
 * The id shape the API gives a new work. `crypto.randomUUID` is what
 * src/api/utils/db writes, and the collections hold both that and the numeric
 * strings the first import used.
 */
const newId = () => require("node:crypto").randomUUID();

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
