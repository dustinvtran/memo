/**
 * @file What `scripts/restore_backup.js` may restore, and where it may
 * restore it to. Pure and dependency-free, so both decisions are tested
 * without a database — see restore_plan.test.js. The script reads the
 * snapshot, the environment and the `.env`, and hands them here.
 *
 * Two rules, each the answer to a way a restore can do harm that a snapshot
 * cannot undo:
 *
 * - **A credential is not data.** A restore puts back what is missing, and a
 *   revoked API token is exactly a document that is missing — so restoring
 *   any snapshot taken before a revocation would make that token valid again,
 *   silently (#465). `CREDENTIAL_COLLECTIONS` are therefore skipped unless
 *   `--only` names them.
 * - **The target is stated, not inferred.** Which deployment a restore writes
 *   to is whatever `MONGODB_URL` holds, and `env.js` will read production's
 *   `.env` whenever the variable is not set in the shell. A drill run with the
 *   variable mistyped restores into production (#466). So `--target` must
 *   name the host the URL actually points at, and the production host — the
 *   one in the `.env` that `env.js` would load — is refused unless
 *   `--production` is also given.
 */

/** Collections whose documents grant access rather than record anything. */
const CREDENTIAL_COLLECTIONS = ["apiTokens"];

/**
 * Splits the manifest's collections into those to restore and those skipped,
 * with the reason for each skip. `only` is the `--only` list, or undefined
 * when none was given.
 *
 * A credential collection is restored only when `only` names it. It is
 * reported as skipped only when it would otherwise have been restored — a
 * collection that `--only` left out is not news.
 *
 * @type {(args: {
 *   collections: Array<{ name: string, file: string }>,
 *   only?: string[],
 * }) => {
 *   restore: Array<{ name: string, file: string }>,
 *   skipped: Array<{ name: string, reason: string }>,
 * }}
 */
const planCollections = ({ collections, only }) => {
  const wanted = collections.filter(({ name }) =>
    only ? only.includes(name) : true
  );
  const isHeldBack = ({ name }) =>
    CREDENTIAL_COLLECTIONS.includes(name) && !(only ?? []).includes(name);
  return {
    restore: wanted.filter((collection) => !isHeldBack(collection)),
    skipped: wanted.filter(isHeldBack).map(({ name }) => ({
      name,
      reason:
        "holds credentials — restoring it would revive revoked tokens; " +
        `pass --only=${name} to restore it deliberately`,
    })),
  };
};

/**
 * The hosts a connection string names, lower-cased and sorted, joined with
 * commas — or undefined for anything that is not a `mongodb://` or
 * `mongodb+srv://` URL. Credentials and everything after the host are
 * dropped, so the result is safe to print.
 *
 * @type {(url: unknown) => string | undefined}
 */
const hostsOf = (url) => {
  if (typeof url !== "string") return undefined;
  const match = url.trim().match(/^mongodb(?:\+srv)?:\/\/(?:[^/]*@)?([^/?#]+)/i);
  return match ? normalizeHosts(match[1]) : undefined;
};

/** A `--target` value, or a URL's host part, in the form hostsOf returns. */
const normalizeHosts = (hosts) => {
  const list = hosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return list.length > 0 ? list.join(",") : undefined;
};

/**
 * Decides whether a restore may connect. Returns `{ host }` when it may, and
 * `{ refusal }` — a message to print — when it may not.
 *
 * - `target` is the `--target` flag: `true` when given bare, undefined when
 *   absent.
 * - `connectionUrl` is the `MONGODB_URL` the script will connect with.
 * - `productionUrl` is the `MONGODB_URL` written in the `.env` that `env.js`
 *   would load, read from the file rather than the environment, so that an
 *   inline override cannot hide which host production is.
 * - `envFile` is that file's path, for the message when it has no URL.
 * - `production` is the `--production` flag.
 *
 * The production check is on any host in common, not on equality, so a
 * replica-set URL listing one production member is caught as well. It
 * compares the text of the URLs: an SRV name and the seed list it resolves to
 * are the same cluster and would not match, which is why `--target` must also
 * equal the URL's own host — the two checks together refuse a mistyped
 * variable whichever form it is written in.
 *
 * @type {(args: {
 *   target?: string | boolean,
 *   connectionUrl?: string,
 *   productionUrl?: string,
 *   envFile?: string,
 *   production?: boolean,
 * }) => { host: string, isProduction: boolean } | { refusal: string }}
 */
const checkTarget = ({
  target,
  connectionUrl,
  productionUrl,
  envFile,
  production = false,
}) => {
  const host = hostsOf(connectionUrl);
  if (host === undefined) {
    return {
      refusal:
        "MONGODB_URL is not set, or is not a mongodb:// or mongodb+srv:// URL.",
    };
  }

  const wanted = typeof target === "string" ? normalizeHosts(target) : undefined;
  if (wanted === undefined) {
    return {
      refusal:
        `--target=<host> is required. MONGODB_URL points at ${host}; ` +
        "pass --target with that host if it is where you mean to restore.",
    };
  }
  if (wanted !== host) {
    return {
      refusal:
        `--target says ${wanted} but MONGODB_URL points at ${host}. ` +
        "Nothing was read or written.",
    };
  }

  const productionHosts = hostsOf(productionUrl);
  if (productionHosts === undefined) {
    return {
      refusal:
        `Cannot tell which host is production: ${envFile ?? "the .env"} ` +
        "holds no MONGODB_URL. Point MEMO_ENV_FILE at the .env that names " +
        "production so the restore can check it is not aimed there.",
    };
  }

  const productionSet = new Set(productionHosts.split(","));
  const isProduction = host.split(",").some((h) => productionSet.has(h));
  if (isProduction && !production) {
    return {
      refusal:
        `${host} is the production host (it is the one in ${envFile ?? "the .env"}). ` +
        "Pass --production as well if you mean to restore into production.",
    };
  }
  if (!isProduction && production) {
    return {
      refusal:
        `--production given, but ${host} is not the production host. ` +
        "Drop --production to restore there.",
    };
  }
  return { host, isProduction };
};

module.exports = {
  CREDENTIAL_COLLECTIONS,
  planCollections,
  hostsOf,
  checkTarget,
};
