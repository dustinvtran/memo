/**
 * @file Finds the `.env`, whatever directory you run a script from.
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
 * Three things are consulted, in this order:
 *
 * - **A variable already in the environment always wins**, because dotenv
 *   never overwrites one. `MONGODB_URL=... node scripts/audit_database.js`
 *   works with no .env at all, which is what a CI runner or a scheduled
 *   backup on another machine wants.
 * - **`MEMO_ENV_FILE` points at a different .env.** This is what the Google
 *   Drive workaround in CLAUDE.md needs: the code runs from a copy on local
 *   disk, the credentials stay in the Drive copy, and neither has to be moved
 *   to meet the other.
 * - **Otherwise the first of `CANDIDATES` that exists**, which is this
 *   folder's `.env` and then the repository root's. Two locations rather
 *   than one is not a second source of truth — only one file is ever read,
 *   and which one is decided here. The root is on the list because
 *   `.env.example` lives there, and see `CANDIDATES` for why a template you
 *   cannot copy in place is worse than no template.
 *
 * Node's own `--env-file` would do the first job, but it has to be repeated
 * on every invocation and silently does nothing when a script is required
 * rather than run, so the .env would still be found only sometimes.
 */
const fs = require("node:fs");
const path = require("path");

const { chooseEnvFile } = require("./env_file");

/**
 * Where the .env is looked for, in order. The first that exists wins; if none
 * does, the first is reported so that an error names a path rather than
 * nothing. The repository root is on the list because `.env.example` sits
 * there, and a template you cannot copy in place is a trap: `cp .env.example
 * .env` at the root would otherwise produce a file nothing reads, failing
 * later as `TypeError: Cannot read properties of undefined (reading
 * startsWith)` from mongodb-connection-string-url — an unset MONGODB_URL,
 * which reads as a bad connection string rather than a missing file.
 */
const CANDIDATES = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", "..", ".env"),
];

/** The .env this process will read, whether or not it exists. */
const envFile = chooseEnvFile({
  override: process.env.MEMO_ENV_FILE,
  candidates: CANDIDATES,
  exists: fs.existsSync,
});

// `quiet` because dotenv 17 otherwise announces itself on stdout on every
// load — a banner with the path to the credentials file in it, in the
// middle of a maintenance script's output.
require("dotenv").config({ path: envFile, quiet: true });

module.exports = { envFile };
