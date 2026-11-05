import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALLOWED_ENDPOINTS, isForbiddenEndpoint } from '../src/protocol.js'
import {
  ALLOWED_ENDPOINTS as CONNECTOR_ALLOWED_ENDPOINTS,
  isForbiddenEndpoint as connectorForbids,
} from '../../ds-bot/src/shared/relay-protocol.js'

test('the relay and connector keep the same default-deny endpoint set', () => {
  assert.deepEqual([...ALLOWED_ENDPOINTS].sort(), [...CONNECTOR_ALLOWED_ENDPOINTS].sort())
  for (const endpoint of ALLOWED_ENDPOINTS) {
    assert.equal(isForbiddenEndpoint(endpoint), false, endpoint)
    assert.equal(connectorForbids(endpoint), false, endpoint)
  }
})

test('every dangerous or unknown endpoint is refused on both sides', () => {
  for (const endpoint of [
    'providers', 'provider-add', 'provider-key', 'provider-remove', 'secret-set', 'secret-list',
    'capability-add', 'connector-retry', 'relay-login', 'diagnostics-log', 'folder-pick',
    'update-install', 'dsh-update-install', 'unknown-endpoint', 'State', '',
  ]) {
    assert.equal(isForbiddenEndpoint(endpoint), true, endpoint)
    assert.equal(connectorForbids(endpoint), true, endpoint)
  }
})
