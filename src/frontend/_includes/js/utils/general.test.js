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

const { timeAgo, escapeHtml, toSafeUrl, html, raw } =
  vm.runInThisContext(`${source}\n;Utils`)

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
// `html`. Everything the site draws goes through it, and what it is for is
// that a component author who thought about none of this still gets escaped
// markup. So the properties are asserted here rather than at the forty places
// that rely on them.

/** What a template comes out as once somebody asks it for a string. */
const drawn = (markup) => String(markup)

const HOSTILE = '<img src=x onerror="alert(1)">'
const HOSTILE_ESCAPED = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'

test('a value is text, and the markup around it is markup', () => {
  assert.equal(
    drawn(html`<p>${HOSTILE}</p>`),
    `<p>${HOSTILE_ESCAPED}</p>`
  )
})

test('the literals are left exactly as they were written', () => {
  // Including the entities components write on purpose — `&frac12` in a
  // playtime, `&nbsp;` in a blank diff line, `&minus;` in its gutter. That is
  // the difference a tagged template can see and a string cannot.
  assert.equal(drawn(html`<i>10h&frac12;</i>&nbsp;&minus;`), '<i>10h&frac12;</i>&nbsp;&minus;')
})

test('a value in a quoted attribute cannot leave it', () => {
  // Both quotes, because a template is free to use either and a caller should
  // not have to know which one it used.
  assert.equal(
    drawn(html`<a href="${`/x" onmouseover="alert(1)`}">go</a>`),
    '<a href="/x&quot; onmouseover=&quot;alert(1)">go</a>'
  )
  assert.equal(
    drawn(html`<a href='${`/x' onmouseover='alert(1)`}'>go</a>`),
    `<a href='/x&#39; onmouseover=&#39;alert(1)'>go</a>`
  )
})

test('a nested template composes rather than being escaped', () => {
  // The property the whole design rests on: a component's content is other
  // components' markup, and it must survive being interpolated.
  const row = html`<td>${HOSTILE}</td>`

  assert.equal(
    drawn(html`<table><tr>${row}</tr></table>`),
    `<table><tr><td>${HOSTILE_ESCAPED}</td></tr></table>`
  )
})

test('nesting escapes each value once and once only', () => {
  // Double escaping is the loud failure: an apostrophe in a film title coming
  // out as `&amp;#39;`. It is what a surviving manual `escapeHtml` under a
  // template that now escapes for itself would look like.
  const inner = html`${`Marley & Me`}`

  assert.equal(drawn(html`<h1>${inner}</h1>`), '<h1>Marley &amp; Me</h1>')
  assert.equal(drawn(html`<h1>${html`${inner}`}</h1>`), '<h1>Marley &amp; Me</h1>')
})

test('an array is its elements, with nothing put between them', () => {
  const cells = ['a', HOSTILE].map((text) => html`<td>${text}</td>`)

  assert.equal(
    drawn(html`<tr>${cells}</tr>`),
    `<tr><td>a</td><td>${HOSTILE_ESCAPED}</td></tr>`
  )
})

test('an array of plain values is escaped element by element', () => {
  assert.equal(drawn(html`<p>${['<b>', '&']}</p>`), '<p>&lt;b&gt;&amp;</p>')
})

test("a `.join('')` left on an array of templates is caught, loudly", () => {
  // Not a property worth having so much as one worth knowing about: joining
  // flattens the brand off, and what arrives is a plain string of markup that
  // this then escapes. Visible on the page rather than silent, which is the
  // right way round.
  const joined = [html`<td>a</td>`, html`<td>b</td>`].join('')

  assert.equal(drawn(html`<tr>${joined}</tr>`), '<tr>&lt;td&gt;a&lt;/td&gt;&lt;td&gt;b&lt;/td&gt;</tr>')
})

test('nothing is nothing, rather than the word for it', () => {
  // `${data.progress}` on an entry that has none used to write "undefined"
  // into the cell.
  assert.equal(drawn(html`<td>${undefined}</td>`), '<td></td>')
  assert.equal(drawn(html`<td>${null}</td>`), '<td></td>')
  assert.equal(drawn(html`<td>${[undefined, null]}</td>`), '<td></td>')
})

test('a number is drawn as itself, and so is zero', () => {
  assert.equal(drawn(html`<td>${0}</td>`), '<td>0</td>')
  assert.equal(drawn(html`<td>${10}h${2.5}</td>`), '<td>10h2.5</td>')
  assert.equal(drawn(html`<td>${false}</td>`), '<td>false</td>')
})

test('a template with no values at all is still markup', () => {
  assert.equal(drawn(html`<hr>`), '<hr>')
  assert.equal(drawn(html`${html``}`), '')
})

test('`raw` is the way to hand over markup from somewhere else', () => {
  // What `DOMPurify.sanitize` comes back as. The sanitiser is the boundary
  // there, and it is a boundary a tag function cannot see.
  assert.equal(drawn(html`<div>${raw('<em>note</em>')}</div>`), '<div><em>note</em></div>')
  assert.equal(drawn(html`<div>${raw(undefined)}</div>`), '<div></div>')
})

test('an object out of a JSON response cannot claim to be markup', () => {
  // The brand is a `Symbol`, so a stored override saying it is trusted is
  // still just an object, and an object is still just text.
  const forged = JSON.parse('{"__safe": true, "safe": true, "raw": "<script>"}')

  assert.doesNotMatch(drawn(html`<p>${forged}</p>`), /<script>/)
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
