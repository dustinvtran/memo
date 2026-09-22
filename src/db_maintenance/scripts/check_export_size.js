#!/usr/bin/env node
/**
 * @file How close each response `/api/export` would send is to the ceiling
 * that endpoint enforces on itself. #422.
 *
 * `/api/export/:username?limit=N` is the four lists in one body, and
 * `withinBudget` in ../../api/controllers/export.js refuses to send one over
 * `MAX_BODY_BYTES`. The owner's four lists were 4,741,315 bytes on
 * 2026-09-21 against a 5,242,880-byte ceiling, and nothing anywhere watched
 * that number: the library grows by a few entries a week, and the first sign
 * of the line being crossed would have been a language model getting a `413`
 * where a person got a `200`.
 *
 * **This reports and never gates**, which is why it lives in
 * `.github/workflows/audit_database.yml` beside `audit_database.js` rather
 * than in `npm test`. The suite runs with no database by design and this
 * measurement needs one; that workflow already holds the credential, already
 * exists to report numbers that move, and already keeps its report for 90
 * days — which is what turns a number into a number that moved. It exits
 * non-zero only when a body could not be measured at all, never because one
 * is large. The reasoning is the same as that file's own header: a job that
 * went red on a finding it cannot act on gets switched off.
 *
 * **It asks the route rather than assembling the document itself.** What
 * governs is `Buffer.byteLength` of the exact string `withinBudget` weighs,
 * so every body here is measured by driving `routes/export.js` with the event
 * Netlify would hand it and weighing what comes back. A second copy of the
 * assembly — the queries, the joins, the notes, `JSON.stringify` without
 * indentation — would agree for a while and then quietly stop agreeing, and a
 * monitor that reports a number other than the enforced one is worse than no
 * monitor. `MAX_BODY_BYTES` is imported for the same reason: nothing here
 * knows what the ceiling is.
 *
 * **What is measured.** Every url the endpoint serves a list at, in both
 * formats, for every account holding at least one entry: the all-lists
 * `?limit=N`, the four per-type lists, and each of those again as
 * `?format=md`, since Markdown goes through the same budget check and nobody
 * has ever weighed it. The index url is fetched for its counts, which is what
 * they are there for, and not measured — it is a few hundred bytes by
 * construction.
 *
 * Accounts with no entries are counted and not named. An empty export cannot
 * approach a 5 MB ceiling, so measuring them would buy nothing, and the
 * report has no reason to publish a list of who holds an account.
 *
 * **Nothing in the output carries a `userId`.** Every row is keyed by
 * username, which is the value the public url carries anyway, and the route
 * is handed a name and looks the id up itself — so no id reaches this script,
 * let alone its report. `audit_database.yml` checks that rather than trusting
 * it: its redaction step greps this script's two files for every id the audit
 * saw and fails the job on a hit.
 *
 * **The origin matters to the byte count**, which is why it is a flag with a
 * production default rather than something taken from the environment. The
 * document carries absolute urls built from the request's own origin, so
 * measuring against `http://localhost:8888` would answer a slightly
 * different, smaller number than production sends.
 *
 * Usage:
 *   node scripts/check_export_size.js
 *   node scripts/check_export_size.js --user=nil
 *   node scripts/check_export_size.js --json=./export_size.json
 *
 * Flags:
 *   --user=name       measure one account instead of every account
 *   --limit=N         the `?limit=` the all-lists url is measured with
 *                     (default 99999 — larger than any list, so "all of it")
 *   --site-url=url    the origin the bodies are built against
 *                     (default https://nil.moe, which is what production is)
 *   --json=path       where the machine-readable report goes
 *
 * Environment (../.env): MONGODB_URL. No API keys: this reads the database
 * the endpoint reads and nothing else.
 */
require("../env");
const fs = require("fs");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { parseArgs } = require("../work_collections");
const {
  WARN_FRACTION,
  summarizeExportSizes,
  toSummary,
  withThousands,
} = require("../export_budget");
const { MAX_BODY_BYTES } = require("../../api/controllers/export.js");
const { LIST_TYPES } = require("../../api/utils/export_view.js");
const { handler } = require("../../api/routes/export.js");
const { useClient } = require("../../api/utils/db/db.js");

const args = parseArgs(process.argv);

const options = {
  user: args.user === undefined ? undefined : String(args.user),
  limit: parseInt(args.limit) || 99999,
  siteUrl: String(args["site-url"] ?? "https://nil.moe").replace(/\/+$/, ""),
  json: args.json === undefined ? undefined : String(args.json),
};

/** JSON and Markdown, which the same ceiling governs. */
const FORMATS = ["json", "md"];

/** Built inside main() so the module can be required without MONGODB_URL. */
let client;

const main = async () => {
  if (args.apply) {
    console.error(
      "There is no --apply here: this script only reads, and measuring is " +
        "all it does."
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.MONGODB_URL) {
    throw new Error("MONGODB_URL is not set. See the README in this folder.");
  }

  client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();

  // The seam `../../api/utils/db/db.js` leaves for the suite, used here for
  // the one thing a script needs that a deployed function does not: the
  // connection this process opened is one it can close, so the run ends
  // rather than being killed with the pool still open.
  useClient(client);

  const usernames = await findUsernames();
  if (usernames.length === 0) {
    console.error(
      options.user
        ? `No account is named ${options.user}.`
        : "The users collection came back empty, so nothing was measured."
    );
    process.exitCode = 1;
    return;
  }

  const measurements = [];
  const empty = [];

  for (const username of usernames) {
    const counts = await findCounts(username);
    if (counts === undefined) {
      console.error(`Could not read the list counts of ${username}.`);
      process.exitCode = 1;
      continue;
    }

    const total = LIST_TYPES.reduce(
      (sum, type) => sum + (counts[type] ?? 0),
      0
    );
    if (total === 0) {
      empty.push(username);
      continue;
    }

    for (const format of FORMATS) {
      measurements.push(
        await measure({
          username,
          format,
          limit: options.limit,
          // What the body will hold rather than what the lists hold: a
          // limit smaller than a list truncates it, and the bytes are of
          // the entries that were sent.
          entries: LIST_TYPES.reduce(
            (sum, type) => sum + Math.min(counts[type] ?? 0, options.limit),
            0
          ),
        })
      );

      for (const type of LIST_TYPES) {
        measurements.push(
          await measure({ username, type, format, entries: counts[type] ?? 0 })
        );
      }
    }
  }

  const report = summarizeExportSizes({
    ceiling: MAX_BODY_BYTES,
    measurements,
    warnFraction: WARN_FRACTION,
  });

  console.log(preamble(usernames.length - empty.length, empty.length));
  console.log(toSummary(report));

  if (report.counts.unknown > 0) process.exitCode = 1;
  if (options.json) write(report, empty.length);
};

/**
 * One body, weighed the way the route weighs it.
 *
 * A `413` is the route refusing to send the body at all, and the length of
 * the advice it sends instead is not a measurement of anything — so `bytes`
 * is left absent and ../export_budget.js reports the refusal as the finding
 * it is. Any other non-200 is a measurement that failed, which the same
 * absence carries and the summary counts separately.
 */
const measure = async ({ username, type, format, limit, entries }) => {
  const path = type ? `/${type}/${username}` : `/${username}`;
  const query = {
    ...(limit === undefined ? {} : { limit: String(limit) }),
    ...(format === "md" ? { format: "md" } : {}),
  };

  const response = await handler(toEvent(path, query), {});
  const statusCode = response?.statusCode;

  return {
    username,
    url: `/api/export${path}${limit === undefined ? "" : `?limit=${limit}`}`,
    format,
    entries,
    status: statusCode,
    bytes:
      statusCode === 200
        ? Buffer.byteLength(response.body ?? "")
        : undefined,
  };
};

/**
 * How many entries each list holds, from the index document — four counted
 * indexes rather than four assembled lists, which is what the index is for.
 * `undefined` when the index itself did not answer.
 */
const findCounts = async (username) => {
  const response = await handler(toEvent(`/${username}`, null), {});
  if (response?.statusCode !== 200) return undefined;

  try {
    const index = JSON.parse(response.body);
    return Object.fromEntries(
      (index.lists ?? []).map((list) => [list.type, list.count ?? 0])
    );
  } catch (error) {
    return undefined;
  }
};

/**
 * The event Netlify hands the function, which is also the event
 * `../../api/controllers/export.test.js` builds: the path with the function
 * prefix the router strips, the query twice over because the route reads
 * `queryStringParameters` and builds its absolute urls out of `rawUrl`.
 */
const toEvent = (path, query) => {
  const search = query ? `?${new URLSearchParams(query)}` : "";

  return {
    httpMethod: "GET",
    path: `/.netlify/functions/export${path}`,
    rawUrl: `${options.siteUrl}/api/export${path}${search}`,
    headers: {},
    queryStringParameters: query ?? null,
    body: null,
  };
};

/** Every account's name, or the one that was asked for. */
const findUsernames = async () => {
  const found = await client
    .db("memo")
    .collection("users")
    .find(options.user ? { username: options.user } : {}, {
      projection: { username: 1, _id: 0 },
    })
    .toArray();

  return found
    .map((user) => user?.username)
    .filter((username) => typeof username === "string" && username)
    .sort();
};

const preamble = (measured, skipped) =>
  `Export bodies measured through the route itself, against the ` +
  `${withThousands(MAX_BODY_BYTES)}-byte MAX_BODY_BYTES in ` +
  `src/api/controllers/export.js. Origin ${options.siteUrl}, ` +
  `?limit=${options.limit}, ${measured} account(s) with entries` +
  (skipped === 0 ? ".\n" : `, ${skipped} with none left unmeasured.\n`);

const write = (report, accountsWithoutEntries) => {
  fs.writeFileSync(
    options.json,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        siteUrl: options.siteUrl,
        limit: options.limit,
        ceiling: report.ceiling,
        warnFraction: report.warnFraction,
        accountsWithoutEntries,
        level: report.level,
        counts: report.counts,
        // Usernames and byte counts. No `userId` reaches this script at all;
        // see the note in the file header and the redaction step in
        // .github/workflows/audit_database.yml.
        rows: report.rows,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${options.json}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  // The connection this process opened, closed whether the run finished or
  // threw — a report that printed and then hung would read as a script that
  // never finished.
  .finally(() => client?.close().catch(() => {}));
