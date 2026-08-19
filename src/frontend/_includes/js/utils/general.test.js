/**
 * @file The frontend scripts are plain globals concatenated into a bundle
 * rather than modules, so this evaluates general.js and pulls the global it
 * defines out of it.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, 'general.js'), 'utf8')

const { timeAgo, escapeHtml, toSafeUrl } = vm.runInThisContext(`${source}\n;Utils`)

const NOW = Date.parse('2024-06-30T12:00:00.000Z')
const ago = (milliseconds) => timeAgo(NOW - milliseconds, NOW)

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('something that just happened says so', () => {
  assert.equal(ago(0), 'just now')
  assert.equal(ago(30 * SECOND), '30 seconds ago')
})

test('a single unit is singular', () => {
  assert.equal(ago(MINUTE), '1 minute ago')
  assert.equal(ago(HOUR), '1 hour ago')
  assert.equal(ago(DAY), '1 day ago')
})

test('it moves up a unit rather than counting 90 minutes', () => {
  assert.equal(ago(45 * MINUTE), '45 minutes ago')
  assert.equal(ago(3 * HOUR), '3 hours ago')
  assert.equal(ago(2 * DAY), '2 days ago')
  assert.equal(ago(40 * DAY), '40 days ago')
  assert.equal(ago(75 * DAY), '3 months ago')
})

test('a clock that is slightly ahead does not report the future', () => {
  assert.equal(ago(-5 * SECOND), 'just now')
})

test('a missing timestamp is said to be missing, not rendered as 1970', () => {
  assert.equal(timeAgo(undefined, NOW), 'at an unknown time')
  assert.equal(timeAgo(null, NOW), 'at an unknown time')
  assert.equal(timeAgo(0, NOW), 'at an unknown time')
})

test("a note's own text cannot inject markup into the history", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)"> & "quoted"'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;'
  )
})

test('a url we would render comes back exactly as it was written', () => {
  // Unchanged, not normalised: a relative cover has to stay relative.
  assert.equal(
    toSafeUrl('https://image.tmdb.org/t/p/w500/x.jpg'),
    'https://image.tmdb.org/t/p/w500/x.jpg'
  )
  assert.equal(
    toSafeUrl('http://en.wikipedia.org/wiki/Special:Search?search=X&go=Go'),
    'http://en.wikipedia.org/wiki/Special:Search?search=X&go=Go'
  )
  assert.equal(toSafeUrl('/img/mawaru.png'), '/img/mawaru.png')
})

test('a scheme we would not render is dropped rather than escaped', () => {
  // There is nothing in `javascript:alert(1)` for `escapeHtml` to escape, so
  // it survives that untouched and still runs. Only the scheme check stops it.
  assert.equal(toSafeUrl('javascript:alert(1)'), undefined)
  assert.equal(toSafeUrl('JavaScript:alert(1)'), undefined)
  assert.equal(toSafeUrl('data:text/html,<script>alert(1)</script>'), undefined)
  assert.equal(toSafeUrl('vbscript:msgbox(1)'), undefined)
})

test('whitespace smuggled into a scheme does not get it past the check', () => {
  // The url parser strips tabs and newlines before it reads the scheme, so a
  // check of our own that did not would disagree with the browser about what
  // this is.
  assert.equal(toSafeUrl('java\tscript:alert(1)'), undefined)
  assert.equal(toSafeUrl('java\nscript:alert(1)'), undefined)
  assert.equal(toSafeUrl('  javascript:alert(1)'), undefined)
})

test('a missing url is missing, not a link to nowhere', () => {
  assert.equal(toSafeUrl(undefined), undefined)
  assert.equal(toSafeUrl(null), undefined)
  assert.equal(toSafeUrl(''), undefined)
})

///////////////////////////////////////////////////////////////////////////////

/**
 * `waitForEl` is the one thing in this file that touches the DOM, so it gets a
 * context with just enough of one: a `document` that answers `querySelector`
 * from a variable the test sets, and a `MutationObserver` that keeps hold of
 * its callback — so a test can say when the page changed — and records whether
 * it is still watching.
 *
 * The same source, evaluated into a context of its own rather than into this
 * one: the tests above want Node's real globals and this one wants a page.
 */
const withFakeDom = () => {
  const page = { el: null, observing: false, notify: () => {} }

  const context = vm.createContext({
    document: {
      body: {},
      querySelector: () => page.el,
    },
    MutationObserver: class {
      constructor(callback) { page.notify = callback }
      observe() { page.observing = true }
      disconnect() { page.observing = false }
    },
    setTimeout,
    clearTimeout,
  })

  const { waitForEl } = vm.runInContext(
    `(() => {\n${source}\n;return Utils\n})()`,
    context
  )

  /** Put the element on the page, and tell the observer the page changed. */
  page.render = (el) => {
    page.el = el
    page.notify()
  }

  return { page, waitForEl }
}

test('an element already on the page is handed over without a wait', async () => {
  const { page, waitForEl } = withFakeDom()
  page.el = 'the icon'

  assert.equal(await waitForEl('a.detail-icon', { timeout: 50 }), 'the icon')
  assert.equal(page.observing, false)
})

test('an element that arrives ends the wait and the watching', async () => {
  const { page, waitForEl } = withFakeDom()
  const waiting = waitForEl('a.detail-icon', { timeout: 50 })

  page.render('the icon')

  assert.equal(await waiting, 'the icon')
  assert.equal(page.observing, false)
})

test('a page that changes into something else is still waited on', async () => {
  const { page, waitForEl } = withFakeDom()
  const waiting = waitForEl('a.detail-icon', { timeout: 50 })

  page.notify()
  assert.equal(page.observing, true)

  page.render('the icon')
  assert.equal(await waiting, 'the icon')
})

test('an element that never arrives gives up rather than watching forever', async () => {
  // The bug the timeout is here for: a logged-out visitor on a list with no
  // rows in it never produces an `a.detail-icon`, and the wait for one used to
  // run a `querySelector` over the whole document on every mutation for the
  // life of the page, holding a promise that never settled.
  const { page, waitForEl } = withFakeDom()
  const started = Date.now()

  assert.equal(await waitForEl('a.detail-icon', { timeout: 30 }), undefined)
  assert.ok(Date.now() - started >= 20)
  assert.equal(page.observing, false)
})
