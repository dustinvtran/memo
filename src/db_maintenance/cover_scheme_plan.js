/**
 * @file Which stored cover urls can be moved from `http://` to `https://`.
 *
 * Google Books answers `imageLinks.thumbnail` over plain http, and the two
 * adapters stored it verbatim until #415 normalised the scheme on the way in.
 * That fixed everything written since; this is the plan for the 588 rows
 * written before it.
 *
 * **Why an allowlist of hosts rather than a blanket rewrite.** `http://x` and
 * `https://x` are different urls, and a host that answers one need not answer
 * the other — a blanket rewrite would turn a working cover into a broken one
 * wherever that is true, silently, because nothing here fetches the result.
 * The hosts below are the ones that have been checked by hand. Adding one
 * means checking it the same way, not assuming it.
 *
 * Nothing else about the url is touched: same host, same path, same query. A
 * rewrite that changed anything but the scheme would be fetching a different
 * image, which is a different decision from this one.
 */

/**
 * Hosts known to serve the identical image over TLS.
 *
 * `books.google.com` was confirmed against production on 2026-09-22 by
 * fetching the https form of five stored covers: all five answered `200
 * image/jpeg` with a body between 9.7 KB and 19 KB.
 */
const UPGRADABLE_HOSTS = ["books.google.com"];

/** `http://host/…` where `host` is exactly one of `hosts`. */
const isUpgradable = (url, hosts) => {
  if (typeof url !== "string" || !url.startsWith("http://")) return false;
  // `new URL` rather than a regex: it is what decides what the host actually
  // is, and `http://books.google.com.evil.test/` must not match.
  try {
    return hosts.includes(new URL(url).host);
  } catch {
    return false;
  }
};

/** The scheme, and only the scheme. */
const toHttps = (url) => "https://" + url.slice("http://".length);

/**
 * Splits works into the ones to rewrite and the ones left alone, with a reason
 * for each of the latter so a dry run says why rather than only how many.
 *
 * @type {(works: object[], options?: { hosts?: string[] }) => {
 *   rewrites: { id: string, title: string, from: string, to: string }[],
 *   skipped: { id: string, title: string, reason: string }[],
 * }}
 */
const planCoverScheme = (works, { hosts = UPGRADABLE_HOSTS } = {}) => {
  const rewrites = [];
  const skipped = [];

  for (const work of works) {
    const id = String(work._id);
    const title = work.englishTranslatedTitle ?? work.originalTitle ?? "";
    const url = work.imageUrl;

    if (url === undefined || url === null || url === "") {
      skipped.push({ id, title, reason: "no imageUrl" });
    } else if (typeof url !== "string") {
      skipped.push({ id, title, reason: `imageUrl is ${typeof url}, not a string` });
    } else if (url.startsWith("https://")) {
      skipped.push({ id, title, reason: "already https" });
    } else if (!url.startsWith("http://")) {
      skipped.push({ id, title, reason: "not an http(s) url" });
    } else if (!isUpgradable(url, hosts)) {
      skipped.push({ id, title, reason: `host not on the checked list` });
    } else {
      rewrites.push({ id, title, from: url, to: toHttps(url) });
    }
  }

  return { rewrites, skipped };
};

module.exports = { UPGRADABLE_HOSTS, planCoverScheme, isUpgradable, toHttps };
