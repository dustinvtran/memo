#!/usr/bin/env node
/**
 * @file Moves stored cover urls from `http://` to `https://`, scheme only.
 *
 * Google Books answers `imageLinks.thumbnail` over plain http. The two books
 * adapters stored that verbatim until #415 normalised the scheme where the
 * value enters, so everything written since is already `https://` — this is
 * the pass over the rows written before it, which #394 said would need one and
 * deliberately kept out of that change.
 *
 * **What it is for, beyond tidiness.** `_headers` serves a report-only CSP
 * with `img-src 'self' https: data:`, which allows any host over https and no
 * host over http. Chrome auto-upgrades mixed content today, so the covers
 * still appear and the only symptom is a wall of console noise — 621
 * violations on one load of the books list. But CSP is evaluated against the
 * url as written, which is why they are reported, and which is why they would
 * be *blocked* rather than upgraded the moment that header loses
 * `-Report-Only`. Enforcing the policy with these rows in place would leave
 * 90% of the books list with no cover art, so this is the blocker for
 * enforcing it at all.
 *
 * **Why the scheme and nothing else.** `http://x` and `https://x` are
 * different urls, and a host answering one need not answer the other. The plan
 * module keeps an allowlist of hosts checked by hand rather than rewriting
 * every http url it finds, because nothing here fetches the result and a
 * blanket rewrite would turn a working cover into a broken one silently.
 * `books.google.com` was confirmed against production on 2026-09-22 by
 * fetching the https form of five stored covers: all five answered `200
 * image/jpeg`. Everything after the scheme is preserved byte for byte, query
 * included — a rewrite that changed more would be fetching a different image.
 *
 * **This writes only to the work collections**, which ../../../CLAUDE.md
 * allows without an argued exception: user overrides live on entry documents,
 * and a script that never touches `*Entries` cannot clobber one. `imageUrl` on
 * a work is the API's copy of where the cover lives, which is exactly the kind
 * of field a maintenance script is for.
 *
 * Take a snapshot with ./backup_database.js and verify it with
 * ./verify_backup.js --live before the `--apply`, per CLAUDE.md.
 *
 * Usage:
 *   node scripts/upgrade_cover_urls.js
 *   node scripts/upgrade_cover_urls.js --apply
 *
 *   --apply            actually write (default: dry run)
 *   --only=books       which types to consider (default: all)
 *   --show=N           how many rewrites to print (default 20, `all` for all)
 *   --json=path        write the full report here
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { COLLECTIONS, selectCollections, parseArgs } = require("../work_collections");
const { UPGRADABLE_HOSTS, planCoverScheme } = require("../cover_scheme_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  show: args.show === undefined ? 20 : args.show === "all" ? Infinity : Number(args.show),
};

let client;

const main = async () => {
  const selected = selectCollections(args.only);
  if (selected.length === 0) {
    console.error(
      `--only=${args.only} matched nothing. Valid types: ${COLLECTIONS.map((c) => c.type).join(", ")}`
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    options.apply
      ? "APPLYING: cover urls will be rewritten."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );
  console.log(`Hosts checked by hand and eligible: ${UPGRADABLE_HOSTS.join(", ")}\n`);

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecateErrors: true },
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  let grandTotal = 0;

  for (const collection of selected) {
    const works = await db
      .collection(collection.works)
      .find({}, { projection: { imageUrl: 1, englishTranslatedTitle: 1, originalTitle: 1 } })
      .toArray();

    const { rewrites, skipped } = planCoverScheme(works);
    report[collection.works] = { rewrites, skippedCounts: tally(skipped) };
    grandTotal += rewrites.length;

    console.log(`=== ${collection.works} ===`);
    console.log(`  ${works.length} works, ${rewrites.length} to rewrite`);
    for (const [reason, n] of Object.entries(tally(skipped))) {
      console.log(`    ${String(n).padStart(5)}  ${reason}`);
    }

    for (const r of rewrites.slice(0, options.show)) {
      console.log(`    ${r.title.slice(0, 40).padEnd(40)}  ${r.from.slice(0, 58)}…`);
    }
    if (rewrites.length > options.show) {
      console.log(`    … and ${rewrites.length - options.show} more (--show=all)`);
    }

    if (options.apply && rewrites.length > 0) {
      // One bulk write per collection rather than one round trip per work.
      // Each filter pins the url as well as the id, so a row someone edited
      // between the read above and this write is left alone rather than
      // overwritten with a rewrite of a value that is no longer there.
      const result = await db.collection(collection.works).bulkWrite(
        rewrites.map((r) => ({
          updateOne: {
            filter: { _id: coerceId(r.id, works), imageUrl: r.from },
            update: { $set: { imageUrl: r.to } },
          },
        })),
        { ordered: false }
      );
      console.log(
        `  wrote ${result.modifiedCount} of ${rewrites.length}` +
          (result.modifiedCount === rewrites.length
            ? ""
            : " — the shortfall is rows whose imageUrl changed since the read")
      );
      report[collection.works].modifiedCount = result.modifiedCount;
    }
    console.log();
  }

  console.log(
    options.apply
      ? `Done. ${grandTotal} cover url(s) considered for rewrite.`
      : `${grandTotal} cover url(s) would be rewritten. Re-run with --apply.`
  );

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }
};

/** `_id` is a string on every work here, but read it back rather than assume. */
const coerceId = (id, works) => {
  const found = works.find((w) => String(w._id) === id);
  return found ? found._id : id;
};

const tally = (rows) =>
  rows.reduce((acc, r) => ({ ...acc, [r.reason]: (acc[r.reason] ?? 0) + 1 }), {});

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => client?.close());
