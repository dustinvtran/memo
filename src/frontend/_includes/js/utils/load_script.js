/**
 * @file Fetches a third-party script the first time a page actually needs it.
 *
 * Two callers, and both were the same mistake: a library one screen wants, in
 * `base.njk`, which is the layout for every page — and `_redirects` rewrites
 * every url to that one HTML document, so every visitor to every page fetched
 * it whether or not anything was ever going to use it. `defer` keeps a file
 * from blocking the parser and does nothing whatever about fetching it. #269.
 *
 * ApexCharts is 862,713 bytes — more than every render-blocking library in
 * `base.njk` put together — and it draws five charts on `/profile/:name` and
 * nothing anywhere else.
 *
 * Litepicker is 64,114 bytes for the two date fields of the entry form, which
 * opens when the signed-in owner of a list clicks add or edit. Every other
 * reader of every list and every profile fetched it for a form they have no
 * way to reach.
 *
 * The urls stay pinned and hashed, because none of the reasons for that have
 * changed: the files are third-party, the page holds the reader's 14-day
 * `nf_jwt`, and a jsDelivr that starts serving something else has to be
 * refused rather than run. `integrity`, `crossOrigin` and `referrerPolicy` are
 * set on the element exactly as the tags set the attributes — as properties,
 * which is why this builds the element rather than any markup.
 *
 * `check_cdn_advisories.js` reads the pins below as well as the tags in
 * `base.njk`. It has to: that check counts what it finds, so a pin that moved
 * out of its reach would not have failed anything — the count would simply
 * have dropped by one, quietly, and the library would be unwatched, which is
 * the one outcome that file exists to prevent.
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
 * 2.0.12, the version the deferred tag in `base.njk` pinned, with the hash it
 * carried — same recipe as above. The url before #122 named no version at all,
 * so the code the site ran changed whenever the package published; this is
 * what that had resolved to.
 *
 * A wrong hash here is two date fields that stay plain text boxes rather than
 * anything that looks broken, so check that the picker actually opens if you
 * change it.
 */
const LITEPICKER = {
  url: 'https://cdn.jsdelivr.net/npm/litepicker@2.0.12/dist/litepicker.js',
  integrity: 'sha384-TwHJTusQtbcoEHJcrF5aeo0MHBgj8lt8onFRrG7wKk8Q/LG9EphkEsqNRiVWzIP9',
}

/**
 * url -> the load that is already in flight or already done.
 *
 * This is what makes a second ask free, and it has to be a promise rather than
 * a flag: the five charts on a profile initialise in the same tick, as do the
 * entry form's two date fields, so the asks after the first arrive while the
 * request is open rather than after it. A flag would let all five through and
 * inject five tags.
 *
 * It lasts as long as the document, which on this site is as long as the page
 * — every navigation here is a full page load, whatever `_redirects` makes it
 * look like. So what a settled entry saves is a component drawn a second time
 * into a page that already has the script: the script is fetched once per
 * visit, not once per chart and not once per opening of the form.
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
 * The constructor one of these scripts leaves behind, once it is there to be
 * had.
 *
 * Both are UMD bundles with no module system to publish themselves into here,
 * so each assigns a global and this reads it back. Asking rather than
 * assuming: a load that resolves without leaving the global behind would
 * otherwise be a `TypeError` at the call site with no clue where it came from.
 */
const loadGlobal = (pin, name) =>
  loadScript(pin).then(() => {
    if (!window[name]) {
      throw new Error(`${pin.url} loaded but defined no ${name}`)
    }
    return window[name]
  })

/** For the score histograms on `/profile/:name`. */
const loadApexCharts = () => loadGlobal(APEXCHARTS, 'ApexCharts')

/** For the two date fields of the entry form. */
const loadLitepicker = () => loadGlobal(LITEPICKER, 'Litepicker')

LoadScript = {
  loadApexCharts,
  loadLitepicker,
}
