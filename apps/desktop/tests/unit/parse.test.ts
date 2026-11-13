import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  parseIdentity,
  parseFavoriteFolders,
  parseFavoritesPage,
  parseLikedPage,
  parseMedia,
  parseFavoriteState,
  parseCommentPage,
  parseWork,
  parseResponse,
  safeMediaUrl
} from '../../src/main/douyin/parse'
import { buildPageScript } from '../../src/main/douyin/page-request'

describe('platform responses', () => {
  it('accepts null and omitted collection arrays only with explicit business success and an explicit terminal marker', () => {
    for (const value of [null, undefined]) {
      const data = { status_code: 0, has_more: 0, aweme_list: value, collects_list: value }
      expect(parseFavoritesPage(data)).toEqual({
        items: [],
        cursor: '0',
        hasMore: false,
        skipped: [],
        received: 0
      })
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
  it('parses scoped comment pages, bounds rich attachments, and rejects stalled or mismatched pages', () => {
    const page = parseCommentPage(
      {
        status_code: 0,
        comments: [
          {
            cid: '9007199254740993999',
            aweme_id: '123',
            text: [{ text: '第一段' }, { text: '第二段' }],
            user: {
              nickname: '评论用户',
              avatar_thumb: { url_list: ['https://p3.douyinpic.com/avatar.webp'] }
            },
            image_list: [
              {
                url_list: ['https://p3.douyinpic.com/comment.webp', 'https://untrusted.invalid/comment.webp']
              }
            ],
            create_time: 1_700_000_000,
            digg_count: '4',
            reply_comment_total: 2
          }
        ],
        cursor: '9007199254740994000',
        has_more: 1
      },
      '123',
      '0'
    )
    expect(page).toMatchObject({
      nextCursor: '9007199254740994000',
      items: [
        {
          id: '9007199254740993999',
          text: '第一段第二段',
          author: '评论用户',
          avatarUrl: 'https://p3.douyinpic.com/avatar.webp',
          attachments: [[{ url: 'https://p3.douyinpic.com/comment.webp', type: 'image' }]],
          publishedAt: 1_700_000_000,
          likes: 4,
          replies: 2
        }
      ]
    })
    expect(() =>
      parseCommentPage({ comments: [{ cid: '1', aweme_id: '456' }], cursor: '2', has_more: 1 }, '123', '0')
    ).toThrow(/当前作品/)
    expect(() => parseCommentPage({ comments: [], cursor: '0', has_more: 1 }, '123', '0')).toThrow()
    expect(
      parseCommentPage({ status_code: 0, comments: null, cursor: '0', has_more: 0 }, '123', '0')
    ).toEqual({ items: [], nextCursor: null })
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
  it('extracts captions from article metadata and rich-text values', () => {
    expect(
      parseWork({
        aweme_id: '7702225379020499323',
        desc: '',
        article_info: JSON.stringify({
          article_title: '我不觉得我如今的下场有什么好遗憾的',
          article_content: JSON.stringify({ markdown: '正文内容' })
        })
      }).title
    ).toBe('我不觉得我如今的下场有什么好遗憾的')
    expect(parseWork({ aweme_id: '123', desc: [{ text: '第一段' }, { text: '第二段' }] }).title).toBe(
      '第一段第二段'
    )
    expect(parseWork({ aweme_id: '124', share_info: { share_title: '分享标题' } }).title).toBe('分享标题')
    expect(
      parseMedia({
        aweme_detail: {
          aweme_id: '7702225379020499323',
          article_info: JSON.stringify({
            article_title: '标题',
            article_content: JSON.stringify({ markdown: '第一段\n\n第二段' })
          })
        }
      }).caption
    ).toBe('第一段\n\n第二段')
  })
  it('extracts a valid author sec_uid for profile navigation', () => {
    expect(
      parseWork({
        aweme_id: '123',
        author: { nickname: '作者', sec_uid: 'MS4wLjABAAAA_example-123' }
      })
    ).toMatchObject({ author: '作者', authorId: 'MS4wLjABAAAA_example-123' })
    expect(parseWork({ aweme_id: '124', author: { nickname: '作者', sec_uid: 'bad id' } })).toMatchObject({
      author: '作者',
      authorId: null
    })
  })
  it('classifies collection items with article metadata as text works', () => {
    expect(
      parseLikedPage({
        aweme_list: [
          {
            aweme_id: '7702225379020499323',
            article_info: JSON.stringify({ article_title: '仅有文章标题' })
          }
        ],
        has_more: 0,
        max_cursor: '0'
      }).items[0]?.mediaType
    ).toBe('text')
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
  it('passes the current page msToken to detail requests', async () => {
    const requested: string[] = []
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      document: { cookie: 'msToken=detail-session' },
      fetch: async (url: string) => {
        requested.push(url)
        return { status: 200, headers: new Headers(), text: async () => '{}' }
      }
    }
    await runInNewContext(
      buildPageScript({
        id: 'detail-token',
        operation: 'detail',
        parameters: { aweme_id: '123' },
        timeout: 1000
      }),
      context
    )
    expect(new URL(requested[0]!).searchParams.get('msToken')).toBe('detail-session')
    expect(new URL(requested[0]!).searchParams.get('from_tab_name')).toBe('main')
    expect(new URL(requested[0]!).searchParams.get('showTab')).toBe('like')
  })
  it('falls back to structured data from the work page when detail API is empty', async () => {
    const requested: string[] = []
    const html = `<script id="RENDER_DATA" type="application/json">${JSON.stringify({
      item: { aweme_id: '123', video: { play_addr: { url_list: ['https://v.douyinvod.com/a'] } } }
    })}</script>`
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      Set,
      Object,
      JSON,
      encodeURIComponent,
      decodeURIComponent,
      setTimeout,
      clearTimeout,
      document: { cookie: '' },
      fetch: async (url: string) => {
        requested.push(url)
        if (requested.length === 1)
          return { status: 200, ok: true, headers: new Headers(), text: async () => '' }
        return { status: 200, ok: true, headers: new Headers(), text: async () => html }
      }
    }
    const result = await runInNewContext(
      buildPageScript({
        id: 'detail-fallback',
        operation: 'detail',
        parameters: { aweme_id: '123' },
        timeout: 1000
      }),
      context
    )
    expect(requested[1]).toContain('/video/123')
    expect(JSON.parse(result.body).aweme_detail.aweme_id).toBe('123')
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
      [
        'favoriteFolderRemove',
        {
          aweme_id: '123',
          item_ids: '123',
          item_type: '2',
          from_collects_id: '9007199254740993999',
          collects_name: '旅行 & 生活'
        }
      ],
      ['favoriteFolderCreate', { action: '1', collects_name: '新收藏夹', secret: '1' }],
      ['favoriteRemove', { aweme_id: '123', aweme_type: '68', action: '1' }]
    ] as const) {
      await runInNewContext(buildPageScript({ id: operation, operation, parameters, timeout: 1000 }), context)
    }
    expect(requests.map((request) => request.options.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'POST',
      'POST'
    ])
    expect(new URLSearchParams(String(requests[0]!.options.body)).get('aweme_type')).toBe('68')
    expect(requests[0]!.url.searchParams.has('aweme_id')).toBe(false)
    expect(requests[1]!.url.pathname).toBe('/aweme/v1/web/collects/video/move/')
    expect(requests[1]!.url.searchParams.get('item_ids')).toBe('123')
    expect(requests[1]!.url.searchParams.get('to_collects_id')).toBe('9007199254740993999')
    expect(requests[1]!.url.searchParams.get('collects_name')).toBe('旅行 & 生活')
    expect(requests[1]!.url.searchParams.has('move_collects_list')).toBe(false)
    expect(requests[2]!.url.pathname).toBe('/aweme/v1/web/collects/video/move/')
    expect(requests[2]!.url.searchParams.get('item_ids')).toBe('123')
    expect(requests[2]!.url.searchParams.get('from_collects_id')).toBe('9007199254740993999')
    expect(requests[2]!.url.searchParams.has('to_collects_id')).toBe(false)
    expect(requests[2]!.url.searchParams.has('aweme_id')).toBe(false)
    expect(requests[3]!.url.searchParams.get('version_code')).toBe('230000')
    expect(requests[3]!.url.searchParams.get('secret')).toBe('1')
    expect(requests[4]!.url.pathname).toBe('/aweme/v1/web/aweme/collect/')
    expect(Object.fromEntries(new URLSearchParams(String(requests[4]!.options.body)))).toEqual({
      aweme_id: '123',
      aweme_type: '68',
      action: '0'
    })
    expect(requests[4]!.url.searchParams.has('action')).toBe(false)
    expect(requests.every((request) => request.options.credentials === 'include')).toBe(true)
  })
  it('uses the v5 collection read contracts with this browser profile and session token', async () => {
    const calls: { url: URL; options: RequestInit }[] = []
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      navigator: {
        language: 'zh-CN',
        platform: 'Win32',
        onLine: true,
        hardwareConcurrency: 8,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0 Safari/537.36'
      },
      screen: { width: 1920, height: 1080 },
      document: { cookie: 'msToken=this-session' },
      fetch: async (url: string, options: RequestInit) => {
        calls.push({ url: new URL(url), options })
        return { status: 200, headers: new Headers(), text: async () => '{"status_code":0}' }
      }
    }
    for (const operation of ['favorites', 'folders', 'folderItems'] as const)
      await runInNewContext(
        buildPageScript({
          id: operation,
          operation,
          parameters: { cursor: '9', ...(operation === 'folderItems' ? { collects_id: '8' } : {}) },
          timeout: 1000
        }),
        context
      )
    expect(calls.map((c) => c.options.method)).toEqual(['POST', 'GET', 'GET'])
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/aweme/v1/web/aweme/listcollection/',
      '/aweme/v1/web/collects/list/',
      '/aweme/v1/web/collects/video/list/'
    ])
    for (const call of calls) {
      expect(Object.fromEntries(call.url.searchParams)).toMatchObject({
        version_code: '290100',
        version_name: '29.1.0',
        update_version_code: '170400',
        msToken: 'this-session',
        browser_language: 'zh-CN',
        browser_platform: 'Win32',
        browser_online: 'true',
        browser_version: '144.0.0.0',
        engine_name: 'Blink',
        screen_width: '1920',
        screen_height: '1080',
        cpu_core_num: '8',
        os_name: 'Windows'
      })
      expect(call.options).toMatchObject({
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection'
      })
      expect(call.url.searchParams.has('sec_user_id')).toBe(false)
      expect(call.url.searchParams.has('a_bogus')).toBe(false)
    }
    expect(calls[0]!.url.searchParams.get('pc_libra_divert')).toBe('Windows')
    expect(calls[0]!.url.searchParams.get('publish_video_strategy_type')).toBe('2')
    expect(calls[0]!.options.headers).toMatchObject({ 'x-secsdk-csrf-token': 'DOWNGRADE' })
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.options.body)))).toEqual({
      count: '20',
      cursor: '9'
    })
    expect(calls[0]!.url.searchParams.has('cursor')).toBe(false)
    expect(calls[0]!.url.searchParams.has('count')).toBe(false)
    for (const call of calls.slice(1)) expect(call.url.searchParams.get('count')).toBe('20')
    expect(calls[2]!.url.searchParams.get('collects_id')).toBe('8')
  })
  it('uses the current session token and work-page referrer for comment and reply reads', async () => {
    const calls: { url: URL; options: RequestInit }[] = []
    const context = {
      URLSearchParams,
      AbortController,
      Map,
      setTimeout,
      clearTimeout,
      navigator: {
        language: 'zh-CN',
        platform: 'Win32',
        onLine: true,
        hardwareConcurrency: 8,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0 Safari/537.36'
      },
      screen: { width: 1920, height: 1080 },
      document: { cookie: 'msToken=comment-session' },
      fetch: async (url: string, options: RequestInit) => {
        calls.push({ url: new URL(url), options })
        return { status: 200, headers: new Headers(), text: async () => '{"status_code":0}' }
      }
    }
    await runInNewContext(
      buildPageScript({
        id: 'comments',
        operation: 'comments',
        parameters: { aweme_id: '123', cursor: '9', count: '20', item_type: '0' },
        timeout: 1000
      }),
      context
    )
    await runInNewContext(
      buildPageScript({
        id: 'comment-replies',
        operation: 'commentReplies',
        parameters: { item_id: '123', comment_id: '456', cursor: '10', count: '20', item_type: '0' },
        timeout: 1000
      }),
      context
    )
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      '/aweme/v1/web/comment/list/',
      '/aweme/v1/web/comment/list/reply/'
    ])
    expect(calls.map(({ options }) => options.method)).toEqual(['GET', 'GET'])
    expect(calls[0]!.url.searchParams.get('aweme_id')).toBe('123')
    expect(calls[0]!.url.searchParams.get('cursor')).toBe('9')
    expect(calls[1]!.url.searchParams.get('item_id')).toBe('123')
    expect(calls[1]!.url.searchParams.get('comment_id')).toBe('456')
    for (const { url, options } of calls) {
      expect(url.searchParams.get('msToken')).toBe('comment-session')
      expect(options).toMatchObject({
        credentials: 'include',
        cache: 'no-store',
        referrer: 'https://www.douyin.com/video/123'
      })
      expect(url.searchParams.has('a_bogus')).toBe(false)
    }
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
