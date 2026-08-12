#!/usr/bin/env node
/**
 * @file Fills in the playtimes games are missing, from IGDB's
 * `/game_time_to_beats` endpoint.
 *
 * Games added while the `howlongtobeat` package was quietly 404ing got no
 * duration at all. HowLongToBeat's API is now behind authentication and there
 * is no way back into it (docs/API_choices.md), so IGDB supplies the number
 * instead, and every playtime it writes is tagged `durationSource: "igdb"` so
 * a later look can tell the two apart without measuring.
 *
 * **It never overwrites a playtime that is already there.** IGDB's times come
 * from a median of three submissions and the stored ones from far larger
 * HowLongToBeat samples; replacing them would visibly move numbers people
 * already read. The rule lives in ../game_playtime_plan.js and is unit tested.
 *
 * User overrides are never touched: they live on the *entry* documents
 * (`entry.overrides`), and this only ever writes to the `games` collection.
 *
 * It is a dry run unless you pass --apply, and it takes a JSON backup of the
 * games collection before writing.
 *
 * Every id is looked up in batches of 500, so the whole library costs three
 * requests rather than one per game.
 *
 * Environment (../.env): MONGODB_URL, TWITCH_CLIENT_ID,
 * TWITCH_CLIENT_SECRET.
 *
 * Usage:
 *   node scripts/backfill_game_playtimes.js
 *   node scripts/backfill_game_playtimes.js --apply
 *   node scripts/backfill_game_playtimes.js --json=./playtimes.json --limit=20
 *
 * Flags:
 *   --apply             actually write (default: dry run)
 *   --limit=N           stop after N games would be filled
 *   --json=path         write a machine-readable report
 *   --backup-dir=path   where to put the backup (default ../backups)
 */
require("../env");
const fs = require("fs");
const path = require("path");
const axios = require("axios").default;
const { MongoClient, ServerApiVersion } = require("mongodb");
const { parseArgs, sleep } = require("../work_collections");
const {
  TIME_TO_BEATS_URL,
  timeToBeatQuery,
  batchGameIds,
  indexTimesByGameId,
} = require("../../api/utils/external_api_adapters/games/time_to_beat");
const {
  gameIdsToLookUp,
  planPlaytimeBackfill,
  summarize,
} = require("../game_playtime_plan");

const args = parseArgs(process.argv);

const options = {
  apply: args.apply === true,
  limit: parseInt(args.limit) || Infinity,
  backupDir: String(args["backup-dir"] ?? path.join(__dirname, "..", "backups")),
};

const main = async () => {
  requireEnv("MONGODB_URL", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET");

  console.log(
    options.apply
      ? "APPLY MODE: the database will be modified."
      : "DRY RUN: nothing will be written. Re-run with --apply to commit."
  );

  const client = new MongoClient(process.env.MONGODB_URL, {
    serverApi: ServerApiVersion.v1,
  });
  await client.connect();

  try {
    const db = client.db("memo");
    const games = await db.collection("games").find().toArray();
    const entriesBefore = await db.collection("gameEntries").countDocuments();

    const ids = gameIdsToLookUp(games);
    console.log(
      `\n${games.length} games, ${ids.length} distinct IGDB ids to look up ` +
        `in ${batchGameIds(ids).length} request(s).`
    );

    const times = await fetchTimesToBeat(ids);
    console.log(`IGDB has a time to beat for ${times.size} of them.\n`);

    const plan = planPlaytimeBackfill(games, times);
    const summary = summarize(games, plan);
    const filling = plan.fill.slice(0, options.limit);

    for (const { title, gameId, updates, submissions } of filling) {
      console.log(
        `  + ${title} (igdb__${gameId}): duration=${updates.duration}m ` +
          `[${updates.durationSource}, ${submissions} submission${
            submissions === 1 ? "" : "s"
          }]`
      );
    }

    report(summary, plan, filling);

    if (options.apply && filling.length > 0) {
      backup("games", games);
      for (const { id, updates } of filling) {
        await db
          .collection("games")
          .updateOne(
            { _id: id },
            { $set: { ...updates, metadataUpdatedDate: Date.now() } }
          );
      }
      console.log(`\nWrote ${filling.length} playtimes.`);
      await verify(db, filling, games.length, entriesBefore);
    }

    if (args.json) {
      fs.writeFileSync(
        String(args.json),
        JSON.stringify({ summary, ...plan }, null, 2)
      );
      console.log(`\nFull report written to ${args.json}`);
    }
  } finally {
    await client.close();
  }
};

/**
 * IGDB caps a query at 500 rows, so ids go up in batches and the misses
 * simply don't come back — a game with no time to beat is not an error, and
 * about a third of them haven't got one.
 * @type {(gameIds: number[]) => Promise<Map<number, any>>}
 */
const fetchTimesToBeat = async (gameIds) => {
  const token = await twitchToken();
  const times = new Map();

  for (const [index, batch] of batchGameIds(gameIds).entries()) {
    // IGDB allows 4 requests a second; this is three requests in total.
    if (index > 0) await sleep(300);
    const { data } = await axios({
      method: "post",
      url: TIME_TO_BEATS_URL,
      headers: {
        "Client-ID": process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      data: timeToBeatQuery(batch),
    });
    for (const [id, row] of indexTimesByGameId(data)) times.set(id, row);
  }

  return times;
};

const twitchToken = () =>
  axios({
    method: "post",
    url:
      "https://id.twitch.tv/oauth2/token" +
      `?client_id=${process.env.TWITCH_CLIENT_ID}` +
      `&client_secret=${process.env.TWITCH_CLIENT_SECRET}` +
      "&grant_type=client_credentials",
  }).then(({ data }) => data.access_token);

/**
 * Re-reads what was written and checks the two things a bad run would break:
 * that every playtime landed, and that no entry lost the work it points at.
 */
const verify = async (db, filled, gamesBefore, entriesBefore) => {
  const ids = filled.map(({ id }) => id);
  const written = await db
    .collection("games")
    .countDocuments({ _id: { $in: ids }, durationSource: "igdb" });
  const gamesAfter = await db.collection("games").countDocuments();
  const entriesAfter = await db.collection("gameEntries").countDocuments();

  const workIds = new Set(
    (await db.collection("games").find({}, { projection: { _id: 1 } }).toArray())
      .map(({ _id }) => String(_id))
  );
  const dangling = (await db.collection("gameEntries").find().toArray()).filter(
    (entry) => entry.workRef && !workIds.has(String(entry.workRef))
  ).length;

  console.log("\n--- verification ---");
  console.log(`  playtimes written and readable back: ${written}/${ids.length}`);
  console.log(`  games:   ${gamesBefore} -> ${gamesAfter}`);
  console.log(`  entries: ${entriesBefore} -> ${entriesAfter}`);
  console.log(`  entries pointing at a game that doesn't exist: ${dangling}`);

  if (written !== ids.length || gamesAfter !== gamesBefore || entriesAfter !== entriesBefore || dangling > 0) {
    console.error("\nVERIFICATION FAILED. Restore from the backup above.");
    process.exitCode = 1;
  }
};

const report = (summary, plan, filling) => {
  const capped = filling.length < plan.fill.length;
  console.log(`\n--- ${options.apply ? "applying" : "would apply"} ---`);
  console.log(`  games:                          ${summary.games}`);
  console.log(
    `  with a playtime:                ${summary.withPlaytimeBefore} -> ` +
      `${summary.withPlaytimeBefore + filling.length}`
  );
  console.log(
    `  without one:                    ${summary.withoutPlaytimeBefore} -> ` +
      `${summary.withoutPlaytimeBefore - filling.length}`
  );
  console.log(`  filled from IGDB:               ${filling.length}` +
    (capped ? ` (of ${plan.fill.length}, --limit=${options.limit})` : ""));
  console.log(`  existing playtimes overwritten: ${summary.overwritten}`);
  console.log(`  still empty, no IGDB id:        ${summary.unfillableNoIgdbRef}`);
  console.log(`  still empty, IGDB has no time:  ${summary.unfillableNoIgdbTime}`);
};

const backup = (collectionName, documents) => {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(
    options.backupDir,
    `${collectionName}_${new Date().toISOString().replace(/:/g, "-")}.json`
  );
  fs.writeFileSync(file, JSON.stringify(documents, null, 2));
  console.log(`\nBacked up ${documents.length} documents to ${file}`);
};

const requireEnv = (...names) => {
  const missing = names.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(", ")} not set. See the README in this folder.`
    );
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.response?.data ?? error);
    process.exitCode = 1;
  });
}
