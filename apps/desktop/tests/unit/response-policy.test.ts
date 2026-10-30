import { expect, it } from 'vitest'
import { AppError } from '../../src/main/errors'
import { assertDetailResponse } from '../../src/main/douyin/response-policy'
import {
  parseFavoriteState,
  parseFavoriteFolders,
  parseFavoritesPage,
  parseResponse
} from '../../src/main/douyin/parse'

function code(action: () => unknown, expected: string) {
  try {
    action()
    throw new Error('Expected a classified response error')
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(expected)
  }
}

it('only classifies an empty detail as unavailable when the platform supplies a work-level explanation', () => {
  for (const filter_detail of [
    { aweme_id: '1', filter_reason: 'core_dep', detail_msg: '' },
    { aweme_id: '1', filter_reason: 'status_self_see' },
    { aweme_id: '1', filter_reason: '', detail_msg: '' },
    { filter_reason: 'core_dep' },
    { detail_msg: '作品不可访问' }
  ])
    code(
      () => assertDetailResponse({ status_code: 0, aweme_detail: null, filter_detail }, '1'),
      'CONTENT_UNAVAILABLE'
    )
  for (const aweme_detail of [null, {}])
    code(() => assertDetailResponse({ status_code: 0, aweme_detail }, '1'), 'UPSTREAM_RISK_CONTROL')
  for (const filter_detail of [
    { aweme_id: '2', filter_reason: 'core_dep' },
    { aweme_id: 'bad', filter_reason: 'core_dep' }
  ])
    code(
      () => assertDetailResponse({ status_code: 0, aweme_detail: null, filter_detail }, '1'),
      'UPSTREAM_CHANGED'
    )
  for (const data of [
    { status_code: 0, aweme_detail: [] },
    { status_code: 0, aweme_detail: 'missing', filter_detail: { aweme_id: '1' } },
    { status_code: 0, aweme_detail: { aweme_id: '2', collect_stat: 1 } }
  ])
    code(() => assertDetailResponse(data, '1'), 'UPSTREAM_CHANGED')
})

it('distinguishes status-only reads from terminal pages, schema changes and successful write acknowledgements', () => {
  for (const operation of ['likes', 'favorites', 'folders', 'folderItems', 'detail'] as const) {
    for (const payload of [
      { status_code: 0 },
      { status_code: 0, extra: { logid: 'secret' }, log_pb: { impr_id: 'private' } }
    ]) {
      try {
        parseResponse(JSON.stringify(payload), 200, { operation, workId: '1' })
        throw Error('Expected rejection')
      } catch (error) {
        expect(error).toMatchObject({ code: 'UPSTREAM_RISK_CONTROL', rule: 'payload.bare_envelope' })
        expect(String(error)).not.toMatch(/secret|private/)
      }
    }
  }
  for (const operation of [
    'unlike',
    'favoriteRemove',
    'favoriteAdd',
    'favoriteFolderAdd',
    'favoriteFolderCreate',
    'self'
  ] as const)
    expect(parseResponse('{"status_code":0}', 200, { operation })).toEqual({ status_code: 0 })
  expect(parseFavoritesPage({ status_code: 0, has_more: 0, aweme_list: [] })).toMatchObject({
    hasMore: false,
    received: 0
  })
  code(() => parseFavoritesPage({ status_code: 0, has_more: 1, cursor: '5' }), 'UPSTREAM_CHANGED')
  code(() => parseResponse('[{"status_code":0}]', 200, { operation: 'favorites' }), 'UPSTREAM_CHANGED')
})

it('gives risk and explicit verification precedence over individual content absence', () => {
  for (const status_code of [8, 2154, 2156, 10000, 10001])
    code(
      () =>
        parseResponse(
          JSON.stringify({ status_code, aweme_detail: null, filter_detail: { aweme_id: '1' } }),
          200,
          { operation: 'detail', workId: '1' }
        ),
      'UPSTREAM_RISK_CONTROL'
    )
  for (const extra of [
    { captcha: { url: 'https://private.invalid/' } },
    { verify_page: 'verify' },
    { verify_center_decision_conf: { detail: 'verify' } }
  ])
    code(() => assertDetailResponse({ status_code: 2053, ...extra }, '1'), 'VERIFICATION_REQUIRED')
  // Ordinary post text is not a challenge signal.
  expect(
    parseFavoriteState(
      { status_code: 0, aweme_detail: { aweme_id: '1', collect_stat: 1, desc: 'captcha 教学' } },
      '1'
    ).collected
  ).toBe(true)
  code(() => parseResponse('{"status_code":8}', 200, { operation: 'self' }), 'API_REJECTED')
})

it('treats business 2053 as an unavailable detail or a definite rejected uncollect, never an unknown success', () => {
  for (const operation of ['detail', 'favoriteRemove'] as const)
    code(() => parseResponse('{"status_code":2053}', 200, { operation, workId: '1' }), 'CONTENT_UNAVAILABLE')
  code(
    () => parseResponse('{"status_code":2053}', 200, { operation: 'favoriteAdd', workId: '1' }),
    'API_REJECTED'
  )
  code(() => parseFavoriteState({ status_code: 0, aweme_detail: { aweme_id: '1' } }, '1'), 'UPSTREAM_CHANGED')
})

it('separates withheld reads, uncertain writes, HTTP errors and collection schema changes', () => {
  for (const body of ['', '{}']) {
    for (const operation of ['favorites', 'folders', 'folderItems', 'detail'] as const)
      code(() => parseResponse(body, 200, { operation, workId: '1' }), 'UPSTREAM_RISK_CONTROL')
    code(() => parseResponse(body, 200, { operation: 'favoriteRemove', workId: '1' }), 'EMPTY_RESPONSE')
  }
  code(() => parseResponse('{}', 429, { operation: 'favorites' }), 'RATE_LIMITED')
  code(() => parseResponse('{}', 403, { operation: 'favorites' }), 'AUTH_REQUIRED')
  code(() => parseResponse('{}', 503, { operation: 'favorites' }), 'NETWORK_ERROR')
  code(() => parseResponse('<html>verify</html>', 200, { operation: 'favorites' }), 'VERIFICATION_REQUIRED')
  for (const data of [
    { status_code: 0, has_more: 1, cursor: '5' },
    { status_code: 0, has_more: 0, aweme_list: {} },
    { status_code: 0, has_more: 'maybe', aweme_list: [] },
    { status_code: 0, has_more: 1, cursor: 'bad', aweme_list: [] },
    { status_code: 0, has_more: 1, cursor: '0', aweme_list: [] }
  ])
    code(() => parseFavoritesPage(data, { allowEmpty: true }), 'UPSTREAM_CHANGED')
  code(
    () => parseFavoriteFolders({ status_code: 0, has_more: 0, collects_list: [{ collects_id: 'bad' }] }),
    'UPSTREAM_CHANGED'
  )
})
