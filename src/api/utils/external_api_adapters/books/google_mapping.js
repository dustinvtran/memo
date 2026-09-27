/**
 * @file Turning a Google Books volume into a stored work.
 *
 * Pure and dependency-free for the same reason ./google_search.js is: ./google.js
 * is axios and a network call, and everything that decides what gets written
 * lives here where the suite can reach it (./google_mapping.test.js).
 */

/**
 * A cover url over TLS.
 *
 * Google Books hands `imageLinks.thumbnail` back as `http://books.google.com/…`
 * and both adapters used to store it as it came. 588 of 653 book covers went
 * into the database that way, and the report-only CSP — `img-src 'self' https:
 * data:` — logged one violation apiece on every load of the books list, since
 * a policy is evaluated against the url as written rather than against the
 * https one Chrome silently upgrades to. Enforcing that header would have
 * blanked 90% of the list. #394.
 *
 * `books.google.com` serves the identical image over TLS, so this is a scheme
 * swap and not a different url. It is the same normalisation ../games/igdb.js
 * does for IGDB's protocol-relative covers, at the point the value enters.
 *
 * An absent thumbnail stays absent: a work with no cover must not acquire the
 * string `"https://"`.
 * @type {(url: any) => string | undefined}
 */
const httpsUrl = (url) =>
  typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : undefined

/**
 * The work stored for the volume Google answered an ISBN lookup with.
 *
 * `apiRefs` is built from the ISBN asked for rather than from anything in the
 * response, because that is the ref the work is filed under — see CLAUDE.md on
 * books carrying a prefixed `ISBN__…`.
 * @type {(ref: string, volumeInfo: any) => object}
 */
const toBook = (ref, volumeInfo) => ({
  entryType: 'Book',
  publishers: volumeInfo.publisher ? [volumeInfo.publisher] : undefined,
  // The bare title, **not** joined with `volumeInfo.subtitle` the way
  // ./google_search.js's `titleOf` joins it. The two are deliberately
  // different and the difference has been measured: see the note on
  // `titleOf` for why joining here made things six times worse.
  englishTranslatedTitle: volumeInfo.title,
  releaseYear: parseInt(volumeInfo.publishedDate?.substring(0, 4)) || undefined,
  duration: volumeInfo.pageCount,
  imageUrl: httpsUrl(volumeInfo?.imageLinks?.thumbnail),
  authors: volumeInfo?.authors,
  apiRefs: [`ISBN__${ref}`],
  externalUrls: volumeInfo?.canonicalVolumeLink
    ? [{ name: 'Google Play', url: volumeInfo?.canonicalVolumeLink }]
    : [],
})

export {
  httpsUrl,
  toBook,
}
