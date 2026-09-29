/**
 * @file The shape of an API token, with no install: `api_token.js` imports
 * only `node:crypto`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  API_TOKEN_PREFIX,
  generateApiToken,
  isApiToken,
  looksLikeApiToken,
  hashApiToken,
} from './api_token.js'

test('a generated token is prefixed, the right length and never repeats', () => {
  const minted = new Set(Array.from({ length: 100 }, generateApiToken))

  assert.equal(minted.size, 100)
  for (const token of minted) {
    assert.ok(token.startsWith(API_TOKEN_PREFIX))
    assert.ok(isApiToken(token), token)
  }
})

test('the hash is stable, hex, and not the token', () => {
  const token = generateApiToken()

  assert.equal(hashApiToken(token), hashApiToken(token))
  assert.match(hashApiToken(token), /^[0-9a-f]{64}$/)
  assert.notEqual(hashApiToken(token), hashApiToken(generateApiToken()))
})

test('a session token is not mistaken for an API token', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJl'

  assert.equal(isApiToken(jwt), false)
  assert.equal(looksLikeApiToken(jwt), false)
})

test('a mangled API token still looks like one, and is not one', () => {
  const truncated = generateApiToken().slice(0, -1)

  assert.equal(looksLikeApiToken(truncated), true)
  assert.equal(isApiToken(truncated), false)
  assert.equal(isApiToken(undefined), false)
})
