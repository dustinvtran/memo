#!/usr/bin/env node
/**
 * @file Takes another work's id off a work that is wearing it, and the
 * metadata that id wrote with it.
 *
 * #290's repair half. Twenty-five groups of works in the four collections
 * carry one identity ref between two documents that are not the same work, and
 * a `--missing-only` backfill has already copied whatever that ref named onto
 * both of them. `Kingdom Hearts` is stored as a 2019 game taking 29 hours and
 * linking to Kingdom Hearts III; Dostoevsky's `Demons` is 600 pages by Dan
 * Brown. #55 is the first sighting of the symptom and #83's backfill is what
 * put most of them there.
 *
 * **Which side is wrong is asked, not assumed.** `--verify-shared-refs` in
 * audit_database.js retrieves each shared id and reports which of the group's
 * titles it actually names; this runs the same check, through the same
 * `verifyIdentities`, immediately before it writes. The verdicts are therefore
 * current at the moment of the write rather than pasted in from a terminal
 * session, and ../shared_ref_repair_plan.js — which decides everything that
 * gets written — never sees anything but that output.
 *
 * Two answers come back and both end in the id coming off:
 *
 *   - **A confirmed owner** (15 groups). The id names one of the works, always
 *     the sequel or the remake, and the other is holding it. Only the other is
 *     touched.
 *   - **A third work** (10 groups). `igdb__134258` is *New Play Control!
 *     Metroid Prime 2*, `9782709637411` is *Anges et démons* — a bundle, a
 *     re-release or a foreign-language edition that is neither of the works
 *     filed under it. No side is right, so every work in the group is.
 *
 * **A work that loses its last identity ref cannot be refreshed again**, and
 * this says so rather than reporting it as fixed: it joins the audit's
 * "no <prefix>__ ref (cannot be refreshed)" line, which is where a work whose
 * id nobody knows honestly belongs. Restoring one means finding the right id
 * by hand and putting it back; the title is deliberately left intact so there
 * is something to search on.
 *
 * **The poisoned fields go too.** Clearing the ref alone would leave the wrong
 * work's year, playtime, cover, links, studios and authors in place with
 * nothing left to correct them from — see ../shared_ref_repair_plan.js for
 * which fields those are and why it is all of them rather than the four #290
 * names. `$unset` rather than `$set`, for clear_unusable_work_fields.js's
 * reason: a missing field is what `isEmptyValue` recognises, so a later
 * backfill fills it if a correct ref is ever found.
 *
 * It writes only to the **work** collections, so no `*Entries` document and no
 * `entry.overrides` is reachable from it. What else bounds it:
 *
 * - A work the API confirmed as the owner of its id is never written to, and
 *   the verification afterwards compares every one of them against what was
 *   read before the run to prove it.
 * - A group whose retrieve failed is skipped, not guessed at. "The API would
 *   not answer" and "the API says neither of these" are different answers.
 * - `apiRefs` is narrowed, never unset: the ids the group shares come off and
 *   anything else the work carries stays.
 * - It re-reads the collection afterwards and checks each repair landed, so a
 *   run that did something other than what it planned says so.
 *
 * Take a snapshot with backup_database.js first and verify it with
 * verify_backup.js — every `--apply` in this folder wants one, and this one
 * removes data that nothing can put back automatically.
 *
 * Environment (../.env): MONGODB_URL, plus the keys for whichever adapters the
 * run reaches — TMDB_API_KEY for films, TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET
 * for games, GOOGLE_API_KEY for books. Asking is the whole point, so a
 * collection whose adapter cannot load is reported and left alone.
 *
 * Usage:
 *   node scripts/repair_shared_refs.js
 *   node scripts/repair_shared_refs.js --only=books
 *   node scripts/repair_shared_refs.js --apply
 *
 * Flags:
 *   --apply             actually write (default: dry run)
 *   --only=a,b          restrict to these types (films, tv, games, books)
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put the pre-run backups (default ../backups)
 */
require("../env");
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  displayTitle,
  selectCollections,
  parseArgs,
} = require("../work_collections");
const { classifySharedRefs } = require("../shared_ref_check");
const { verifyIdentities } = require("../load_adapter");
const { planSharedRefRepair } = require("../shared_ref_repair_plan");

/** How much of a stored value to print beside the work it is coming off. */
const PREVIEW_CHARS = 60;

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

let client;

const main = async () => {
  const selected = selectCollections(args.only);
  if (selected.length === 0) {
    console.error(
      `--only=${args.only} matched nothing. Valid types: ${COLLECTIONS.map(
        (c) => c.type
      ).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? "APPLY MODE: ids that name another work, and the metadata they wrote, " +
          "will be removed."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  let blocked = false;
  for (const collection of selected) {
    const result = await repairCollection(db, collection);
    report[collection.type] = result;
    if (result.blocked) blocked = true;
  }

  summarise(report);

  if (blocked) {
    console.error(
      "\nOne or more collections were refused. Nothing was written for those."
    );
    process.exitCode = 1;
  }

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const repairCollection = async (db, collection) => {
  console.log(`\n=== ${collection.works} ===`);

  const works = await db.collection(collection.works).find().toArray();
  const { collisions } = classifySharedRefs(collection, works);

  console.log(
    collisions.length === 0
      ? `  ${works.length} works, no id shared by works that are not the same work`
      : `  ${works.length} works, ${collisions.length} shared id(s) — asking ` +
          `${collection.retrievePrefix} what each one names`
  );

  // An empty list is still planned rather than returned early, so that a
  // collection with nothing to repair reports the same "cannot be refreshed"
  // count as one that has something — otherwise tv, which can never have a
  // collision, would go missing from the total at the end.
  const identityChecks =
    collisions.length === 0 ? [] : await verifyIdentities(collection, collisions);
  if (collisions.length > 0 && identityChecks.length === 0) {
    // loadAdapter has already said which of the two it was, on its own line.
    console.log("  nothing could be asked, so nothing is repaired here.");
  }

  const plan = planSharedRefRepair(collection, works, identityChecks);
  if (plan.blocked) {
    console.error(`  REFUSED: ${plan.blocked}`);
    return { blocked: plan.blocked };
  }

  report(collection, plan);

  const base = {
    works: plan.totals.works,
    groups: plan.totals.groups,
    ownerConfirmed: plan.totals.ownerConfirmed,
    thirdWork: plan.totals.thirdWork,
    values: plan.totals.values,
    unrefreshableBefore: plan.totals.unrefreshableBefore,
    unrefreshableAfter: plan.totals.unrefreshableAfter,
    skipped: plan.skipped,
    untouched: plan.untouched,
    repairs: plan.repairs.map(({ unset, ...repair }) => ({
      ...repair,
      unset: Object.fromEntries(unset.map(({ field, value }) => [field, value])),
    })),
  };

  if (!options.apply || plan.repairs.length === 0) return base;

  backup(collection.works, works);

  const written = await write(db, collection, plan);
  const verified = await verify(db, collection, plan, works);
  return { ...base, written, verified };
};

/**
 * One `bulkWrite` rather than an `updateMany` per field: every document here
 * keeps a different set of refs, so there is no group of them the same
 * operation is correct for. Thirty-eight documents, one round trip.
 *
 * No `metadataUpdatedDate` is written, and the plan unsets the one that is
 * there: that field says when an adapter last had something to say about this
 * work, and taking away an id that named a different work is not an adapter
 * saying anything.
 */
const write = async (db, collection, plan) => {
  const operations = plan.repairs.map((repair) => ({
    updateOne: {
      filter: { _id: repair._id },
      update: {
        $set: { apiRefs: repair.apiRefs },
        ...(repair.unset.length > 0
          ? {
              $unset: Object.fromEntries(
                repair.unset.map(({ field }) => [field, ""])
              ),
            }
          : {}),
      },
    },
  }));

  const result = await db.collection(collection.works).bulkWrite(operations);
  console.log(`\n  wrote ${result.modifiedCount} work(s)`);

  if (result.modifiedCount !== plan.repairs.length) {
    console.error(
      `  expected ${plan.repairs.length}, modified ${result.modifiedCount} — ` +
        `something else is writing to ${collection.works}.`
    );
    process.exitCode = 1;
  }
  return result.modifiedCount;
};

/**
 * What the run actually did, asked of the database rather than inferred from
 * the plan.
 *
 * The confirmed owners are compared against the documents read before the
 * write, in full. They are the works this must not touch, and "it did not
 * touch them" is worth proving rather than asserting — a bad filter would
 * otherwise show up as a correct-looking count.
 *
 * The identity checks are not re-run. They cost an API call per group, and
 * re-asking would test the API rather than the write.
 */
const verify = async (db, collection, plan, before) => {
  const works = await db.collection(collection.works).find().toArray();
  const byId = new Map(works.map((work) => [String(work._id), work]));
  const beforeById = new Map(before.map((work) => [String(work._id), work]));

  const failures = [];

  if (works.length !== before.length) {
    failures.push(
      `work count changed: ${before.length} -> ${works.length}. Restore from ` +
        `the snapshot taken before this run.`
    );
  }

  for (const repair of plan.repairs) {
    const work = byId.get(String(repair._id));
    if (!work) {
      failures.push(`${repair.title} (${repair._id}) is gone`);
      continue;
    }
    const refs = Array.isArray(work.apiRefs) ? work.apiRefs : [];
    const left = repair.removedRefs.filter((ref) => refs.includes(ref));
    if (left.length > 0) {
      failures.push(`${repair.title} still carries ${left.join(", ")}`);
    }
    const kept = repair.unset
      .map(({ field }) => field)
      .filter((field) => work[field] !== undefined);
    if (kept.length > 0) {
      failures.push(`${repair.title} still has ${kept.join(", ")}`);
    }
    if (displayTitle(work) !== repair.title) {
      failures.push(
        `${repair.title} is now called ${displayTitle(work)} — the title was ` +
          `never this run's to change`
      );
    }
  }

  for (const owner of plan.untouched) {
    const now = JSON.stringify(byId.get(String(owner._id)));
    const then = JSON.stringify(beforeById.get(String(owner._id)));
    if (now !== then) {
      failures.push(
        `${owner.title} (${owner._id}) changed, and it is the work ` +
          `${owner.apiRef} belongs to`
      );
    }
  }

  console.log(
    `  after: ${works.length} works (was ${before.length}), ` +
      `${plan.untouched.length} confirmed owner(s) unchanged, ` +
      `${failures.length} problem(s)`
  );
  for (const failure of failures) console.error(`  ! ${failure}`);
  if (failures.length > 0) process.exitCode = 1;

  return { works: works.length, failures };
};

/**
 * Every group and every document, rather than a sample. There are 25 groups in
 * the whole database and each is a decision somebody may want to disagree
 * with, which a count cannot be disagreed with.
 */
const report = (collection, plan) => {
  const byRef = new Map();
  for (const repair of plan.repairs) {
    byRef.set(repair.apiRef, [...(byRef.get(repair.apiRef) ?? []), repair]);
  }

  for (const [apiRef, repairs] of byRef) {
    const { apiTitle, owner } = repairs[0];
    console.log(
      `\n  ${apiRef} names "${apiTitle}"` +
        (owner === null ? " — which is none of the works filed under it" : "")
    );

    for (const untouched of plan.untouched.filter((w) => w.apiRef === apiRef)) {
      console.log(`    keep        ${untouched.title} (${untouched._id})`);
    }

    for (const repair of repairs) {
      console.log(
        `    ${options.apply ? "clearing   " : "would clear"} ${repair.title} ` +
          `(${repair._id})`
      );
      console.log(
        `      apiRefs  ${repair.removedRefs.join(", ")} -> ` +
          `${repair.apiRefs.join(", ") || "(none)"}`
      );
      if (repair.unset.length > 0) {
        console.log(
          `      unset    ${repair.unset
            .map(({ field, value }) => `${field}=${preview(value)}`)
            .join(", ")}`
        );
      }
      console.log(
        repair.unrefreshable
          ? `      -> no ${collection.retrievePrefix}__ ref left: this work ` +
              `cannot be refreshed until somebody supplies the right id`
          : `      -> still refreshable as ${collection.retrievePrefix}__` +
              `${repair.remainingIdentityRef}`
      );
    }
  }

  for (const skip of plan.skipped) {
    console.log(`\n  ${skip.apiRef}: skipped — ${skip.reason}`);
  }

  console.log(
    `\n  ${plan.totals.ownerConfirmed} group(s) with a confirmed owner, ` +
      `${plan.totals.thirdWork} naming a third work, ` +
      `${plan.skipped.length} skipped`
  );
  console.log(
    `  ${plan.totals.repaired} work(s) ` +
      `${options.apply ? "lose" : "would lose"} ${plan.totals.refs} id(s) and ` +
      `${plan.totals.values} stored value(s)`
  );
  console.log(
    `  cannot be refreshed: ${plan.totals.unrefreshableBefore} -> ` +
      `${plan.totals.unrefreshableAfter}`
  );
};

const summarise = (report) => {
  const results = Object.values(report).filter((result) => !result.blocked);
  const sum = (key) => results.reduce((total, r) => total + (r[key] ?? 0), 0);
  const repaired = results.reduce((total, r) => total + (r.repairs?.length ?? 0), 0);

  console.log(
    `\n${repaired} work(s) ${options.apply ? "lost" : "would lose"} an id ` +
      `that names another work, and ${sum("values")} stored value(s) with it.`
  );
  console.log(
    `Works that cannot be refreshed, across the collections read: ` +
      `${sum("unrefreshableBefore")} -> ${sum("unrefreshableAfter")}. That is ` +
      `the honest state for a work whose id nobody knows, and the audit ` +
      `already has a line for it.`
  );

  if (!options.apply && repaired > 0) {
    console.log(
      "Take a fresh snapshot with backup_database.js, verify it with " +
        "verify_backup.js, then re-run with --apply."
    );
  }
};

/**
 * Enough of a value to recognise it. These are cached API metadata — a year, a
 * playtime, a cover url — and never anybody's writing, which lives on the
 * entry and review documents this script cannot see.
 */
const preview = (value) => {
  const json = JSON.stringify(value) ?? "undefined";
  return json.length > PREVIEW_CHARS
    ? `${json.slice(0, PREVIEW_CHARS)}...`
    : json;
};

const backup = (collectionName, documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${collectionName}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`  backed up ${documents.length} document(s) to ${file}`);
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
