import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  parseIdentity,
  parseFavoriteFolders,
  parseFavoritesPage,
  parseLikedPage,
  parseMedia,
  parseFavoriteState,
  parseResponse,
  safeMediaUrl
} from '../../src/main/douyin/parse'
import { buildPageScript } from '../../src/main/douyin/page-request'

describe('platform responses', () => {
  it('accepts null and omitted collection arrays only with explicit business success and an explicit terminal marker', () => {
    for (const value of [null, undefined]) {
      const data = { status_code: 0, has_more: 0, aweme_list: value, collects_list: value }
      expect(parseFavoritesPage(data)).toEqual({ items: [], cursor: '0', hasMore: false })
      expect(parseFavoriteFolders(data)).toEqual({ folders: [], cursor: '0', hasMore: false })
      for (const bad of [
        { ...data, status_code: undefined },
        { ...data, status_code: 8 },
        { ...data, has_more: undefined },
        { ...data, has_more: 1, cursor: '123' },
        { ...data, aweme_list: {}, collects_list: {} }
      ]) {
        expect(() => parseFavoritesPage(bad)).toThrow()
        expect(() => parseFavoriteFolders(bad)).toThrow()
      }
      expect(() => parseLikedPage(data)).toThrow()
    }
  })
  it('requires an explicit favorite state for the exact work and preserves string folder IDs from official responses', () => {
    expect(
      parseFavoriteState({ aweme_detail: { aweme_id: '123', collect_stat: '1', aweme_type: 68 } }, '123')
    ).toMatchObject({ collected: true, type: '68', work: { id: '123' } })
    expect(() => parseFavoriteState({ aweme_detail: { aweme_id: '123' } }, '123')).toThrow(/明确的收藏状态/)
    expect(() => parseFavoriteState({ aweme_detail: { aweme_id: '124', collect_stat: 1 } }, '123')).toThrow(
      /目标作品/
    )
    const data = parseResponse(
      '{"status_code":0,"has_more":0,"collects_list":[{"collects_id":9007199254740993999,"collects_id_str":"9007199254740993999","collects_name":"旅行","status":0}]}',
      200
    )
    expect(parseFavoriteFolders(data).folders[0]).toMatchObject({ id: '9007199254740993999', private: true })
  })
  it('rejects missing or zero cursors on nonterminal pages without rewinding a deep checkpoint', () => {
    for (const cursor of [undefined, null, '0', '00']) {
      expect(() =>
        parseLikedPage({ aweme_list: [{ aweme_id: '123' }], has_more: 1, max_cursor: cursor })
      ).toThrow()
      expect(() => parseFavoritesPage({ aweme_list: [{ aweme_id: '123' }], has_more: 1, cursor })).toThrow()
      expect(() =>
        parseFavoriteFolders({ collects_list: [{ collects_id: '456' }], has_more: 1, cursor })
      ).toThrow()
    }
    expect(parseLikedPage({ aweme_list: [], has_more: 0 }).cursor).toBe('0')
    expect(parseFavoriteFolders({ collects_list: [], has_more: 0 }).cursor).toBe('0')
  })
  it('preserves raw 64-bit work IDs and cursors before any JS number conversion', () => {
    const data = parseResponse(
      '{"status_code":0,"aweme_list":[{"aweme_id":7381234567890123456,"desc":"a"}],"max_cursor":7381234567890123457,"has_more":1}',
      200
    )
    const page = parseLikedPage(data)
    expect(page.items[0]?.id).toBe('7381234567890123456')
    expect(page.cursor).toBe('7381234567890123457')
  })
  it('rejects a success-looking HTTP response with an API error or missing paging evidence', () => {
    expect(() => parseResponse('{"status_code":8}', 200)).toThrow()
    expect(() => parseLikedPage({ aweme_list: [] })).toThrow()
    expect(() => parseLikedPage({ aweme_list: [], has_more: true, max_cursor: '1' })).toThrow()
    expect(parseLikedPage({ aweme_list: [], has_more: false, max_cursor: '0' }).hasMore).toBe(false)
  })
  it('distinguishes authentication, verification, malformed responses and rate limits', () => {
    expect(() => parseResponse('{"status_code":9,"status_msg":"请完成安全验证"}', 200)).toThrow(/人工验证/)
    expect(parseResponse('{"status_code":0,"desc":"安全验证教学"}', 200).status_code).toBe(0)
    expect(() => parseIdentity({ status_code: 0 })).toThrow(/登录/)
    expect(() => parseResponse('<html>verification</html>', 200)).toThrow(/人工验证/)
    expect(() => parseResponse('{broken', 200)).toThrow(/JSON/)
    expect(() => parseResponse('{}', 429)).toThrow(/限流/)
  })
  it('permits empty liked-page traversal only when explicitly requested, keeping favorites and single reads strict', () => {
    const empty = { aweme_list: [], has_more: 1, max_cursor: '9007199254740993988' }
    expect(parseLikedPage(empty, { allowEmpty: true })).toEqual({
      items: [],
      hasMore: true,
      cursor: empty.max_cursor
    })
    expect(() => parseLikedPage(empty)).toThrow(/空/)
    expect(() => parseFavoritesPage(empty)).toThrow(/空/)
    for (const cursor of [undefined, '0', 0])
      expect(() => parseLikedPage({ ...empty, max_cursor: cursor }, { allowEmpty: true })).toThrow(/空/)
    expect(() => parseLikedPage({ ...empty, max_cursor: 'bad' }, { allowEmpty: true })).toThrow(/无效/)
  })
  it('accepts only HTTPS media hosts with hostname boundaries, without URL credentials', () => {
    expect(safeMediaUrl('https://v.example.douyinvod.com/test.webm')).toBeTruthy()
    expect(safeMediaUrl('https://sf11-cdn-tos.douyinstatic.com/obj/ies-music/test.mp3')).toBeTruthy()
    expect(safeMediaUrl('https://sf11-cdn-tos.douyinstatic.com.attacker.test/test.mp3')).toBeNull()
    for (const value of [
      'javascript:alert(1)',
      'http://v.douyinvod.com/a',
      'https://douyinvod.com.evil.test/a',
      'https://evil.test/?douyin.com',
      'https://user:pass@v.douyinvod.com/a'
    ])
      expect(safeMediaUrl(value)).toBeNull()
  })
  it('keeps static/live image positions aligned and prioritizes explicit H.264', () => {
    const media = parseMedia({
      aweme_detail: {
        aweme_id: '123',
        video: {
          play_addr_h264: { url_list: ['https://a.douyinvod.com/h264'] },
          play_addr: { url_list: ['https://a.douyinvod.com/other'] }
        },
        images: [
          { url_list: ['https://a.douyinpic.com/1'] },
          {
            url_list: ['https://a.douyinpic.com/2'],
            video: { play_addr: { url_list: ['https://a.douyinvod.com/live'] } }
          }
        ]
      }
    })
    expect(media.images.map((i) => i.liveUrl)).toEqual([null, 'https://a.douyinvod.com/live'])
    expect(media.videos[0]).toBe('https://a.douyinvod.com/h264')
  })
})

describe('main-world page request', () => {
  it('uses only the current page msToken for likes and still delegates to page fetch without leaking it in the reply', async () => {
    const requested: string[] = []
    const document = { cookie: 'other=1; msToken=fixture%2Bfirst' }
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      document,
      fetch: async (url: string) => {
        requested.push(url)
        return { status: 200, headers: new Headers(), text: async () => '{}' }
      }
    }
    const script = buildPageScript({
      id: 'token',
      operation: 'likes',
      parameters: { max_cursor: '10' },
      timeout: 1000
    })
    const first = await runInNewContext(script, context)
    document.cookie = 'msToken=fixture-second'
    await runInNewContext(script, context)
    document.cookie = ''
    await runInNewContext(script, context)
    expect(requested.map((url) => new URL(url).searchParams.get('msToken'))).toEqual([
      'fixture+first',
      'fixture-second',
      null
    ])
    expect(JSON.stringify(first)).not.toContain('fixture')
  })
  it('uses the page-installed fetch and serializes hostile values as data', async () => {
    let requested = ''
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      fetch: async (url: string) => {
        requested = url
        return { status: 200, headers: new Headers(), text: async () => '{"status_code":0}' }
      },
      injected: false
    }
    const value = "');globalThis.injected=true;//</script>\u2028"
    const result = await runInNewContext(
      buildPageScript({ id: 'r1', operation: 'detail', parameters: { aweme_id: value }, timeout: 1000 }),
      context
    )
    expect(result.id).toBe('r1')
    expect(new URL(requested).searchParams.get('aweme_id')).toBe(value)
    expect(context.injected).toBe(false)
  })
  it('matches official favorite POST query and form contracts without exposing tokens or inventing signatures', async () => {
    const requests: { url: URL; options: RequestInit }[] = []
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      fetch: async (url: string, options: RequestInit) => {
        requests.push({ url: new URL(url), options })
        return { status: 200, headers: new Headers(), text: async () => '{"status_code":0}' }
      }
    }
    for (const [operation, parameters] of [
      ['favoriteAdd', { aweme_id: '123', aweme_type: '68' }],
      [
        'favoriteFolderAdd',
        {
          aweme_id: '123',
          item_ids: '123',
          item_type: '2',
          to_collects_id: '9007199254740993999',
          collects_name: '旅行 & 生活'
        }
      ],
      ['favoriteFolderCreate', { action: '1', collects_name: '新收藏夹', secret: '1' }],
      ['favoriteRemove', { aweme_id: '123', aweme_type: '68', action: '1' }]
    ] as const) {
      await runInNewContext(buildPageScript({ id: operation, operation, parameters, timeout: 1000 }), context)
    }
    expect(requests.map((request) => request.options.method)).toEqual(['POST', 'POST', 'POST', 'POST'])
    expect(new URLSearchParams(String(requests[0]!.options.body)).get('aweme_type')).toBe('68')
    expect(requests[0]!.url.searchParams.has('aweme_id')).toBe(false)
    expect(requests[1]!.url.pathname).toBe('/aweme/v1/web/collects/video/move/')
    expect(requests[1]!.url.searchParams.get('item_ids')).toBe('123')
    expect(requests[1]!.url.searchParams.get('to_collects_id')).toBe('9007199254740993999')
    expect(requests[1]!.url.searchParams.get('collects_name')).toBe('旅行 & 生活')
    expect(requests[1]!.url.searchParams.has('move_collects_list')).toBe(false)
    expect(requests[2]!.url.searchParams.get('version_code')).toBe('230000')
    expect(requests[2]!.url.searchParams.get('secret')).toBe('1')
    expect(requests[3]!.url.pathname).toBe('/aweme/v1/web/aweme/collect/')
    expect(Object.fromEntries(new URLSearchParams(String(requests[3]!.options.body)))).toEqual({
      aweme_id: '123',
      aweme_type: '68',
      action: '0'
    })
    expect(requests[3]!.url.searchParams.has('action')).toBe(false)
    expect(requests.every((request) => request.options.credentials === 'include')).toBe(true)
  })
  it('actually aborts fetch when the page-side deadline expires', async () => {
    let aborted = false
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      fetch: (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
    }
    const result = await runInNewContext(
      buildPageScript({ id: 'r2', operation: 'self', parameters: {}, timeout: 5 }),
      context
    )
    expect(aborted).toBe(true)
    expect(result.error).toBe('TIMEOUT')
  })
})
