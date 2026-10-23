import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  parseIdentity,
  parseLikedPage,
  parseMedia,
  parseResponse,
  safeMediaUrl
} from '../../src/main/douyin/parse'
import { buildPageScript } from '../../src/main/douyin/page-request'

describe('platform responses', () => {
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
    expect(() => parseIdentity({ status_code: 0 })).toThrow(/登录/)
    expect(() => parseResponse('<html>verification</html>', 200)).toThrow(/人工验证/)
    expect(() => parseResponse('{broken', 200)).toThrow(/JSON/)
    expect(() => parseResponse('{}', 429)).toThrow(/限流/)
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
