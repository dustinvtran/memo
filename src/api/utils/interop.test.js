import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callableDefault } from './interop.js'

/** What Node's ESM loader, and esbuild since #204, hand over for a Babel-compiled package. */
const asNamespace = (fn) => ({ __esModule: true, default: fn })

test('the namespace of a Babel-compiled package gives up its function', () => {
  const client = () => 'a client'
  assert.equal(callableDefault(asNamespace(client)), client)
})

test('a function that arrived as itself is left alone', () => {
  const client = () => 'a client'
  assert.equal(callableDefault(client), client)
})

/**
 * A function carrying a `default` of its own — axios is one — is already the
 * export. Taking `.default` there would work by luck rather than by rule, and
 * would not for a package whose `default` is something else entirely.
 */
test('a function is preferred to its own default property', () => {
  const client = () => 'a client'
  client.default = () => 'something else'
  assert.equal(callableDefault(client), client)
})

test('a package whose export is not callable comes back whole', () => {
  const parts = { serialize: () => {}, parse: () => {} }
  assert.equal(callableDefault(parts), parts)
  assert.equal(callableDefault(undefined), undefined)
  assert.equal(callableDefault(null), null)
})
