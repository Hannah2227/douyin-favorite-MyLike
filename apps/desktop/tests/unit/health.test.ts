import { afterEach, expect, it, vi } from 'vitest'
import { HealthMonitor } from '../../src/main/health'
import { HEALTH_MAX_AGE } from '../../src/shared/health'
afterEach(() => vi.restoreAllMocks())
it('requires all read capabilities before showing normal, then expires old evidence', () => {
  const h = new HealthMonitor()
  let now = 10000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  for (const op of ['self', 'likes', 'favorites']) h.observe('a', op)
  expect(h.snapshot('a').status).toBe('uncertain')
  h.observe('a', 'folders')
  expect(h.snapshot('a').status).toBe('normal')
  now += HEALTH_MAX_AGE
  expect(h.snapshot('a').status).toBe('uncertain')
  expect(h.snapshot('b').entries).toEqual([])
})
it('counts a failed manual round once while ignoring automatic retry failures and local wait rejection', () => {
  const h = new HealthMonitor()
  for (let round = 1; round <= 3; round++) {
    h.begin('a')
    h.observe('a', 'likes', 'TIMEOUT')
    h.observe('a', 'likes', 'TIMEOUT')
    h.observe('a', 'likes', 'TIMEOUT', undefined, true)
    h.finish('a')
    expect(h.snapshot('a').entries[0]).toMatchObject({
      failures: round,
      status: round === 3 ? 'abnormal' : 'uncertain'
    })
  }
  h.begin('a')
  h.observe('a', 'likes', 'TIMEOUT', Date.now() + 60000, false)
  h.finish('a')
  expect(h.snapshot('a').entries[0]?.failures).toBe(3)
  h.begin('a')
  h.observe('a', 'likes')
  h.finish('a')
  expect(h.snapshot('a').entries[0]).toMatchObject({ status: 'normal', failures: 0 })
})
it('does not clear a failed folder with another successful folder in the same check', () => {
  const h = new HealthMonitor()
  h.begin('a')
  h.observe('a', 'folderItems', 'INVALID_RESPONSE', undefined, true)
  h.observe('a', 'folderItems')
  h.finish('a')
  expect(h.snapshot('a').entries[0]).toMatchObject({ status: 'uncertain', failures: 1 })
})
it('marks explicit refusal immediately and ignores cancellations and unrelated write results', () => {
  const h = new HealthMonitor()
  h.observe('a', 'favorites', 'RATE_LIMITED')
  h.observe('a', 'likes')
  h.observe('a', 'favorites', 'CANCELLED')
  h.observe('a', 'favoriteRemove')
  expect(h.snapshot('a').status).toBe('abnormal')
  expect(h.snapshot('a').entries).toHaveLength(2)
  h.begin('a')
  h.finish('a', false)
  expect(h.snapshot('a').checkedAt).toBeNull()
})

it('counts multiple failed folders once per round without losing the already counted failure', () => {
  const h = new HealthMonitor()
  for (let round = 1; round <= 3; round++) {
    h.begin('a')
    for (let folder = 0; folder < 3; folder++) {
      h.observe('a', 'folderItems', 'INVALID_RESPONSE')
      h.observe('a', 'folderItems', 'INVALID_RESPONSE', undefined, folder === 0)
    }
    h.finish('a')
    expect(h.snapshot('a').entries[0]).toMatchObject({
      failures: round,
      status: round === 3 ? 'abnormal' : 'uncertain'
    })
  }
})

it('distinguishes a withheld bare payload from an explicit risk refusal without guessing the cause', () => {
  const h = new HealthMonitor()
  h.begin('a')
  h.observe('a', 'favorites', 'UPSTREAM_RISK_CONTROL', Date.now() + 60000, true, 'payload.bare_envelope')
  h.finish('a')
  expect(h.snapshot('a').entries[0]).toMatchObject({ status: 'uncertain', failures: 1 })
  h.begin('a')
  h.observe('a', 'favorites', 'UPSTREAM_RISK_CONTROL', Date.now() + 60000, false)
  h.finish('a')
  expect(h.snapshot('a').entries[0]).toMatchObject({ status: 'uncertain', failures: 1 })
  h.observe('b', 'favorites', 'UPSTREAM_RISK_CONTROL', undefined, false, 'envelope.risk_code')
  expect(h.snapshot('b').status).toBe('abnormal')
})

it('does not let expired optional folder-item success override fresh required checks, but retains failures', () => {
  const h = new HealthMonitor()
  let now = 10000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  h.observe('a', 'folderItems')
  now += HEALTH_MAX_AGE + 1
  for (const op of ['self', 'likes', 'favorites', 'folders']) h.observe('a', op)
  expect(h.snapshot('a').status).toBe('normal')
  h.observe('a', 'folderItems', 'INVALID_RESPONSE')
  expect(h.snapshot('a').status).toBe('uncertain')
  h.observe('a', 'folderItems', 'RATE_LIMITED')
  expect(h.snapshot('a').status).toBe('abnormal')
})
