#!/usr/bin/env node
/**
 * @file Read-only audit of the production database.
 *
 * Reports every inconsistency backfill_work_metadata.js and dedupe_works.js
 * can act on, plus the ones that need a human decision. It never writes, and
 * by default it needs no external API keys — only MONGODB_URL.
 *
 * `--verify-shared-refs` is the one thing here that reaches an API, and so the
 * one thing that wants the adapter keys. Works sharing an identity ref are
 * split three ways without asking anyone (../shared_ref_check.js), but which
 * *side* of a collision is misfiled cannot be worked out from the database:
 * both documents look equally plausible. So it retrieves each shared id once
 * — 25 calls against production today — and reports which of the group's
 * titles the id actually names. Off by default because a diagnostic that
 * spends someone else's rate limit every time it is run is a diagnostic that
 * stops being run. #290.
 *
 * `--verify-title-years` is the same bargain for the opposite finding. Two
 * works with one title and one year may be one work under two ids or two works
 * that share a name, and the ids can be asked which — one call per id in a
 * group, 37 against production today. Off by default for the same reason.
 * #319.
 *
 * `--verify-titles` is the third, and much the most expensive. A work whose
 * only id resolves to a different title is the same defect again — a document
 * wearing another work's id — but it disagrees with nothing in the database,
 * so unlike the two above there is no group to narrow the question down to and
 * every work carrying a retrievable id has to be asked: some 1,400 calls, and
 * a quarter of an hour for the books alone. It is worth spending because
 * `backfill_work_metadata.js` refuses 357 works over it, 23% of the library,
 * and until now the only trace was a line in a log. ../title_match_check.js
 * and #327.
 *
 * The three counts it fills are zero on a run without it, and the run says so
 * rather than letting a reader take the zero for an answer.
 *
 * Usage:
 *   node scripts/audit_database.js
 *   node scripts/audit_database.js --only=games,books
 *   node scripts/audit_database.js --verify-shared-refs
 *   node scripts/audit_database.js --verify-title-years
 *   node scripts/audit_database.js --only=films --verify-titles
 *   node scripts/audit_database.js --json=./audit.json
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const {
  COLLECTIONS,
  parseApiRef,
  isEmptyValue,
  selectCollections,
  parseArgs,
} = require("../work_collections");
const {
  expectedFields,
  corruptFieldsOf,
  isMissingPlaytimeLink,
} = require("../work_metadata_merge");
const {
  classifySharedRefs,
  sharedRefReason,
  // `describe` moved there when scripts/repair_shared_refs.js started joining
  // its own reads onto the `id` it writes.
  describeWork: describe,
} = require("../shared_ref_check");
const {
  classifyTitleYearGroups,
  reasonFor,
} = require("../title_year_check");
const {
  TITLE_MATCH_BUCKETS,
  titleMatchTargets,
  classifyTitleMatches,
} = require("../title_match_check");
const { implausibleDuration } = require("../duration_plausibility");
const { toSummary, countProblems } = require("../audit_report");
const {
  verifyIdentities,
  verifyTitleYearGroups,
  verifyWorkTitles,
} = require("../load_adapter");

const args = parseArgs(process.argv);

const verifySharedRefs = args["verify-shared-refs"] === true;
const verifyTitleYears = args["verify-title-years"] === true;
const verifyTitles = args["verify-titles"] === true;

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

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();
  const db = client.db("memo");

  const report = {};
  for (const collection of selected) {
    report[collection.type] = await auditCollection(db, collection);
  }

  // One number for "is anything actually wrong", so a clean run says so
  // instead of leaving a reader to add up ten lines per collection and decide
  // for themselves which of them counted.
  const problems = countProblems(selected, report);
  console.log(
    problems === 0
      ? "\nNo problems found."
      : `\n${problems} problem(s) found across ${selected.length} collection(s).`
  );

  if (args.json) {
    fs.writeFileSync(String(args.json), JSON.stringify(report, null, 2));
    console.log(`Full report written to ${args.json}`);
  }

  await client.close();
};

const auditCollection = async (db, collection) => {
  const works = await db.collection(collection.works).find().toArray();
  const entries = await db.collection(collection.entries).find().toArray();
  const reviews = await db.collection(collection.reviews).find().toArray();

  const workIds = new Set(works.map((w) => w._id));
  const entryIds = new Set(entries.map((e) => e._id));
  const referencedWorkIds = new Set(
    entries.map((e) => e.workRef).filter((ref) => ref)
  );

  const noApiRef = [];
  const legacyObjectApiRefs = [];
  const missingFields = [];
  const corruptFields = [];
  const gamesMissingPlaytimeLink = [];
  const implausibleDurations = [];
  const orphanWorks = [];

  for (const work of works) {
    if (!hasRetrieveRef(collection, work)) noApiRef.push(describe(work));

    if (
      Array.isArray(work.apiRefs) &&
      work.apiRefs.some((ref) => parseApiRef(ref)?.flat === false)
    ) {
      legacyObjectApiRefs.push(describe(work));
    }

    const missing = expectedFields(collection).filter((field) =>
      isEmptyValue(work[field])
    );
    if (missing.length > 0) {
      missingFields.push({ ...describe(work), fields: missing });
    }

    const corrupt = corruptFieldsOf(collection, work);
    if (corrupt.length > 0) {
      corruptFields.push({ ...describe(work), fields: corrupt });
    }

    if (isMissingPlaytimeLink(collection, work)) {
      gamesMissingPlaytimeLink.push(describe(work));
    }

    const implausible = implausibleDuration(collection, work);
    if (implausible) {
      implausibleDurations.push({
        ...describe(work),
        duration: work.duration,
        reason: implausible,
      });
    }

    if (!referencedWorkIds.has(work._id)) orphanWorks.push(describe(work));
  }

  // Three findings out of what used to be one. A group of works under one
  // identity ref is copies of one work, seasons of one show, or one work
  // wearing another's id — and only the last is #290's damage.
  const shared = classifySharedRefs(collection, works);
  const duplicateWorks = shared.duplicates.map(describeGroup);
  const expectedSharedRefs = shared.expected.map(describeGroup);
  const sharedIdentityRefs = shared.collisions.map(describeGroup);

  const identityChecks = verifySharedRefs
    ? await verifyIdentities(collection, shared.collisions)
    : [];

  // A fourth meaning, found the other way round: two documents that agree on a
  // title and a year but sit under two different ids share no key with the
  // three findings above and were invisible to all of them. ../title_year_check.js
  // and #319.
  const titleYear = classifyTitleYearGroups(collection, works, entries);

  const titleYearChecks = verifyTitleYears
    ? await verifyTitleYearGroups(collection, titleYearGroups(titleYear))
    : [];

  // And a fifth, which no amount of reading can find: one work under one id
  // that names something else. Only the API knows, so the counts below are
  // zero without --verify-titles — `titleRefAsked` is what a run would cost,
  // and is worth printing either way. ../title_match_check.js and #327.
  const titleTargets = titleMatchTargets(collection, works);
  const titles = classifyTitleMatches(
    verifyTitles
      ? await verifyWorkTitles(
          collection,
          titleTargets,
          progressReporter(collection)
        )
      : []
  );

  const entriesWithoutWorkRef = entries
    .filter((e) => !e.workRef)
    .map((e) => ({ id: e._id, userId: e.userId, status: e.status }));

  const entriesWithDanglingWorkRef = entries
    .filter((e) => e.workRef && !workIds.has(e.workRef))
    .map((e) => ({ id: e._id, userId: e.userId, workRef: e.workRef }));

  // A review is only ever found by `entryRef`, so one whose entry is gone is
  // unreachable rather than deleted. The text is a user's private note and
  // stays out of the report; its length is enough to size what is left behind.
  const orphanReviews = reviews
    .filter((r) => !r.entryRef || !entryIds.has(r.entryRef))
    .map((r) => ({
      id: r._id,
      entryRef: r.entryRef ?? null,
      textLength: r.text?.length ?? 0,
    }));

  const result = {
    works: works.length,
    entries: entries.length,
    reviews: reviews.length,
    noApiRef,
    legacyObjectApiRefs,
    missingFields,
    corruptFields,
    gamesMissingPlaytimeLink,
    implausibleDurations,
    duplicateWorks,
    expectedSharedRefs,
    sharedIdentityRefs,
    identityChecks,
    titleYearDuplicates: titleYear.duplicates,
    titleYearUnidentified: titleYear.unidentified,
    titleYearUndecided: titleYear.undecided,
    titleYearChecks,
    titleRefAsked: titleTargets.length,
    titleRefAgreed: titles.same.length,
    titleRefSpelling: titles.spelling,
    titleRefContained: titles.contained,
    titleRefDifferent: titles.different,
    titleRefUnanswered: titles.unanswered,
    titleRefUncompared: titles.uncompared,
    orphanWorks,
    entriesWithoutWorkRef,
    entriesWithDanglingWorkRef,
    orphanReviews,
  };

  printSummary(collection, result);
  return result;
};

const hasRetrieveRef = (collection, work) =>
  Array.isArray(work.apiRefs) &&
  work.apiRefs.some(
    (ref) => parseApiRef(ref)?.name === collection.retrievePrefix
  );

const describeGroup = ({ key, ref, works }) => ({
  apiRef: key,
  ref,
  count: works.length,
  works: works.map(describe),
});

const printSummary = (collection, result) => {
  const { problems, notes } = toSummary(collection, result);

  console.log(`\n=== ${collection.works} ===`);
  console.log(
    `  works: ${result.works}, entries: ${result.entries}, ` +
      `reviews: ${result.reviews}`
  );

  for (const line of problems) {
    console.log(`  ${String(line.count).padStart(5)}  ${line.label}`);
  }

  // Below the problems and marked, because these are supported states rather
  // than damage — printed in the same list, the user-authored entries were
  // read as broken ones. See ../audit_report.js.
  console.log("  --- not problems, for information ---");
  for (const line of notes) {
    console.log(`  ${String(line.count).padStart(5)}  ${line.label}`);
  }

  for (const finding of result.implausibleDurations) {
    console.log(`  e.g. impossible duration: ${finding.title}: ${finding.reason}`);
  }

  printSharedRefs(collection, result);
  printTitleYears(collection, result);
  printTitleMatches(collection, result);

  const examples = result.missingFields.slice(0, 5);
  if (examples.length > 0) {
    console.log("  e.g. missing:");
    for (const e of examples) {
      console.log(`    - ${e.title}: ${e.fields.join(", ")}`);
    }
  }
};

/**
 * The collision groups in full, and what the API said about each — every one
 * of them rather than a sample, because a count of collisions is not something
 * anyone can act on and the pairs are the whole finding.
 */
const printSharedRefs = (collection, result) => {
  const reason = sharedRefReason(collection);
  if (reason && result.expectedSharedRefs.length > 0) {
    console.log(`  (${result.expectedSharedRefs.length} shared ids: ${reason})`);
  }

  if (result.sharedIdentityRefs.length === 0) return;

  if (!verifySharedRefs) {
    console.log(
      `  shared ids, unverified — pass --verify-shared-refs to ask ` +
        `${collection.retrievePrefix} which work each one names:`
    );
    for (const group of result.sharedIdentityRefs) {
      console.log(
        `    - ${group.apiRef}: ${group.works.map((w) => w.title).join(" | ")}`
      );
    }
    return;
  }

  console.log(`  shared ids, as ${collection.retrievePrefix} reports them:`);
  for (const check of result.identityChecks) {
    if (check.error) {
      console.log(`    - ${check.apiRef}: could not be asked (${check.error})`);
      continue;
    }
    console.log(`    - ${check.apiRef} names "${check.apiTitle}"`);
    const named = check.matches.map((w) => `${w.title} (${w.id})`);
    console.log(`        it is:     ${named.join(", ") || "none of these"}`);
    console.log(
      `        it is not: ${check.mismatches
        .map((w) => `${w.title} (${w.id})`)
        .join(", ")}`
    );
  }
};

/**
 * The three buckets as one list, in the order they are printed, which is also
 * the order they are asked about. Every group is worth a call: a duplicate is
 * confirmed by one, an undecided pair is settled by one, and an unidentified
 * pair has exactly one id to ask — whose answer says which of the two stored
 * titles it belongs to.
 */
const titleYearGroups = (titleYear) => [
  ...titleYear.duplicates,
  ...titleYear.unidentified,
  ...titleYear.undecided,
];

/**
 * The title-and-year groups in full, with the signals that discriminate beside
 * each work — a shared secondary ref, the duration, and how many entries point
 * at it. A count of these is not something anyone can act on and the pairs are
 * the whole finding, so all of them are printed rather than a sample, exactly
 * as the collision groups above are.
 *
 * The three headings are separate because the three mean different things and
 * a reader who sees them in one list will act on the wrong one. Only the last
 * is expected to survive: `mother|2009` is three films.
 */
const printTitleYears = (collection, result) => {
  const sections = [
    ["titleYearDuplicates", "one work under two ids"],
    ["titleYearUnidentified", "same title and year, one side has no id"],
    ["titleYearUndecided", "same title and year, different ids, undecided"],
  ];

  const groups = sections.flatMap(([key]) => result[key] ?? []);
  if (groups.length === 0) return;

  if (!verifyTitleYears) {
    console.log(
      `  same title and year, unverified — pass --verify-title-years to ask ` +
        `${collection.retrievePrefix} whether each is one work:`
    );
  } else {
    console.log(
      `  same title and year, as ${collection.retrievePrefix} reports them:`
    );
  }

  const checksByKey = new Map(
    (result.titleYearChecks ?? []).map((check) => [check.key, check])
  );

  for (const [key, heading] of sections) {
    const found = result[key] ?? [];
    if (found.length === 0) continue;

    console.log(`    ${heading}:`);
    for (const group of found) {
      console.log(
        `      - ${group.title} (${group.releaseYear}) — ${group.reason}`
      );
      // The refs padded to one width, because the durations beside them are
      // the point and two numbers a reader has to hunt for are two numbers a
      // reader does not compare.
      const refWidth = Math.max(
        ...group.works.map((work) => (work.identityRef ?? NO_REF).length)
      );
      for (const work of group.works) {
        console.log(
          `          ${(work.identityRef ?? NO_REF).padEnd(refWidth)}  ` +
            `"${work.title}"  ` +
            `${work.duration === undefined ? "no duration" : `${work.duration} min`}, ` +
            `${work.entries} entr${work.entries === 1 ? "y" : "ies"}  ` +
            `(${work.id})`
        );
      }
      printTitleYearCheck(collection, checksByKey.get(group.key));
    }
  }
};

/** What a document with nothing to retrieve it by shows in the ref column. */
const NO_REF = "(no identity ref)";

/**
 * What each work's own id turned out to name, in full and in three sections.
 *
 * The three are printed apart because they want three different answers, and a
 * reader who sees them in one list will act on the wrong one: the spelling
 * bucket is a stored title to tidy, the contained bucket is triage — half of
 * it is an edition or series suffix and half is somebody having picked the
 * wrong search result — and only the last is a straightforwardly misfiled id.
 *
 * On a run that did not ask, the cost of asking is printed instead of the
 * three zeroes being left to speak for themselves.
 */
const printTitleMatches = (collection, result) => {
  if (!verifyTitles) {
    console.log(
      `  ${result.titleRefAsked} works carry a ${collection.retrievePrefix}__ ` +
        `ref and none of them was asked what it names — pass --verify-titles`
    );
    return;
  }

  console.log(
    `  ${collection.retrievePrefix} answered for ${result.titleRefAsked} ` +
      `works: ${result.titleRefAgreed} named the work filed under them, ` +
      `${result.titleRefUnanswered.length} could not be asked, ` +
      `${result.titleRefUncompared.length} had no title to compare`
  );

  for (const { key, heading } of TITLE_MATCH_BUCKETS) {
    const found = result[key] ?? [];
    if (found.length === 0) continue;

    console.log(`    ${heading}:`);
    for (const check of found) {
      console.log(
        `      - ${check.apiRef} names "${check.apiTitle}", stored as ` +
          `"${check.title}" (${check.id})`
      );
    }
  }
};

/**
 * A line every fifty calls, because --verify-titles is a quarter of an hour of
 * silence for the books otherwise, and a script that prints nothing for that
 * long is one somebody kills half way through. Named by collection, since this
 * is the only output that arrives before the `=== collection ===` heading the
 * summary prints when the reads are done.
 */
const progressReporter = (collection) => (asked, total) => {
  if (asked % 50 === 0 || asked === total) {
    console.log(
      `${collection.works}: asked ${asked} of ${total} ids what they name`
    );
  }
};

/** What the adapter said about one group, when it was asked. */
const printTitleYearCheck = (collection, check) => {
  if (!check) return;

  // Deliberately a sentence about the *ids* and not about the documents. A
  // pair the signals called one work, whose ids name two, is one work wearing
  // another's id — #290's damage, found from the side the shared-ref check
  // cannot see — and "different works" would read as the opposite of that.
  const verdict =
    check.sameWork === true
      ? "these ids name one work"
      : check.sameWork === false
        ? "these ids name different works"
        : "not settled";

  const named = check.names.map((name) =>
    name.error !== undefined
      ? `${name.apiRef} could not be asked (${name.error})`
      : `${name.apiRef} names "${name.apiTitle}" ` +
        `(${name.releaseYear ?? "no year"}, ${name.duration ?? "no"} min)`
  );

  console.log(
    `          ${collection.retrievePrefix} says: ${verdict} — ${named.join("; ")}`
  );
};

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
  await client?.close();
});
