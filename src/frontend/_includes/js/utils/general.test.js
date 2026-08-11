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

const { timeAgo, escapeHtml } = vm.runInThisContext(`${source}\n;Utils`)

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
