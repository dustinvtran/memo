/**
 * @file Which `.env` a process should read — the decision, with no I/O in it.
 *
 * `env.js` is the half that touches the filesystem and loads dotenv, so it
 * cannot be tested by the dependency-free suite. This is the half that decides,
 * and it is separated for the reason the folder layout exists: the logic that
 * picks goes in a pure module, the reading goes in the caller.
 */

/**
 * The first of `candidates` that `exists` says is there, unless `override`
 * names one outright. Falls back to the first candidate when none exists, so
 * that a failure names a path rather than `undefined` — the file not being
 * there is a normal state (CI passes the variables in the environment instead)
 * and is not this function's to complain about.
 *
 * `override` wins even when it points at nothing. Pointing `MEMO_ENV_FILE` at a
 * path that lacks a `.env` is a mistake worth seeing, and silently falling back
 * to a different file would read credentials the caller did not ask for — which
 * on this project means reading production's by accident.
 *
 * @type {(args: {
 *   override?: string,
 *   candidates: string[],
 *   exists: (path: string) => boolean,
 * }) => string}
 */
const chooseEnvFile = ({ override, candidates, exists }) =>
  override ?? candidates.find((candidate) => exists(candidate)) ?? candidates[0];

module.exports = { chooseEnvFile };
