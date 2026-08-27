/**
 * @file Fetches a third-party script the first time a page actually needs it.
 *
 * One caller: the profile's score histograms. ApexCharts is 862,713 bytes —
 * more than every render-blocking library in `base.njk` put together — and it
 * draws five charts on `/profile/:name` and nothing anywhere else. It was a
 * `<script defer>` in `base.njk`, which is the layout for every page, and
 * `_redirects` rewrites every url to that one HTML document: so every list,
 * every entry form and the home page fetched all 862 KB to draw nothing with
 * it. #269.
 *
 * The url stays pinned and hashed, because none of the reasons for that have
 * changed: the file is third-party, the page holds the reader's 14-day
 * `nf_jwt`, and a jsDelivr that starts serving something else has to be
 * refused rather than run. `integrity`, `crossOrigin` and `referrerPolicy` are
 * set on the element exactly as the tag set the attributes — as properties,
 * which is why this builds the element rather than any markup.
 *
 * `check_cdn_advisories.js` reads the pin below as well as the tags in
 * `base.njk`. It has to: that check counts what it finds, so a pin that moved
 * out of its reach would not have failed anything — the count would simply
 * have gone from 8 to 7, and the library would be unwatched, which is the one
 * outcome that file exists to prevent.
 */

/**
 * 6.8.0, the version the deferred tag in `base.njk` pinned. Recompute the hash
 * with `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A` if
 * you change it, and check the profile still draws: a wrong hash blocks the
 * file silently, and a blocked file here is five empty containers.
 */
const APEXCHARTS = {
  url: 'https://cdn.jsdelivr.net/npm/apexcharts@6.8.0',
  integrity: 'sha384-nLD6rKRJ1yssfWSVXJJaNpF3g7f2F5/5qnJ6rRBt/KjLrJ5H/ch4uI80FwqxknkC',
}

/**
 * url -> the load that is already in flight or already done.
 *
 * This is what makes a second ask free, and it has to be a promise rather than
 * a flag: the five charts on a profile initialise in the same tick, so the
 * four that come after the first arrive while the request is open rather than
 * after it. A flag would let all five through and inject five tags.
 *
 * It lasts as long as the document, which on this site is as long as the
 * profile — every navigation here is a full page load, whatever `_redirects`
 * makes it look like. So what a settled entry saves is a component drawn a
 * second time into a page that already has the script: the same 862 KB is
 * fetched once per visit and not once per chart.
 */
const inFlight = new Map()

const loadScript = ({ url, integrity }) => {
  const already = inFlight.get(url)
  if (already) return already

  const load = new Promise((resolve, reject) => {
    const element = document.createElement('script')
    element.src = url
    element.integrity = integrity
    element.crossOrigin = 'anonymous'
    element.referrerPolicy = 'no-referrer'
    element.addEventListener('load', () => resolve(), { once: true })
    element.addEventListener(
      'error',
      () => {
        // The tag failed, so it is not going to run and a retry cannot reuse
        // it. Taking it back out keeps the document honest about what is
        // loaded, which is the thing anyone counting injections reads.
        element.remove()
        reject(new Error(`${url} did not load`))
      },
      { once: true }
    )
    document.head.appendChild(element)
  })

  inFlight.set(url, load)

  // A failure is remembered only for as long as the callers waiting on it. A
  // dropped connection is the likeliest way this fails, and that is a thing
  // that stops being true; remembering it would mean the profile never drew a
  // chart again for the life of the page. The guard is against a retry that
  // has already started: only this load clears its own entry.
  load.catch(() => {
    if (inFlight.get(url) === load) inFlight.delete(url)
  })

  return load
}

/**
 * The `ApexCharts` constructor, once it is there to be had.
 *
 * The script is a UMD bundle with no module system to publish itself into
 * here, so it assigns a global and this reads it back. Asking rather than
 * assuming: a load that resolves without leaving the global behind would
 * otherwise be a `TypeError` at the call site with no clue where it came from.
 */
const loadApexCharts = () =>
  loadScript(APEXCHARTS).then(() => {
    if (!window.ApexCharts) {
      throw new Error(`${APEXCHARTS.url} loaded but defined no ApexCharts`)
    }
    return window.ApexCharts
  })

LoadScript = {
  loadApexCharts,
}
