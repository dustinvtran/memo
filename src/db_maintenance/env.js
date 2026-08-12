/**
 * @file Finds this folder's `.env`, whatever directory you run a script from.
 *
 * `dotenv` resolves a bare `config()` against the *working directory*, so the
 * scripts used to find the file only when you happened to be standing in
 * `src/db_maintenance`. That is a bad way to fail: you get "MONGODB_URL not
 * set" from a script that is sitting right next to the .env that has it.
 *
 * This module lives beside the `.env` and resolves it from its own location,
 * so the answer depends on neither the working directory nor how deep in the
 * tree the caller sits. A script requires it before anything that reads
 * `process.env` — including `mongodb`, which reads the URL at import time.
 *
 * Two escape hatches, in the order they are consulted:
 *
 * - **A variable already in the environment always wins**, because dotenv
 *   never overwrites one. `MONGODB_URL=... node scripts/audit_database.js`
 *   works with no .env at all, which is what a CI runner or a scheduled
 *   backup on another machine wants.
 * - **`MEMO_ENV_FILE` points at a different .env.** This is what the Google
 *   Drive workaround in CLAUDE.md needs: the code runs from a copy on local
 *   disk, the credentials stay in the Drive copy, and neither has to be moved
 *   to meet the other.
 *
 * Node's own `--env-file` would do the first job, but it has to be repeated
 * on every invocation and silently does nothing when a script is required
 * rather than run, so the .env would still be found only sometimes.
 */
const path = require("path");

/** The .env this process will read, whether or not it exists. */
const envFile = process.env.MEMO_ENV_FILE ?? path.join(__dirname, ".env");

require("dotenv").config({ path: envFile });

module.exports = { envFile };
