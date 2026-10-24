import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
  symlinkSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  decodeTransfer,
  encodeTransfer,
  readTransfer,
  MAX_TRANSFER_BYTES
} from '../../src/main/storage/transfer-format'
import { Store } from '../../src/main/storage/database'
import type { Work } from '../../src/shared/contracts'

const item: Work & { collectedAt: number } = {
  id: '9007199254740993000',
  title: '旅行 <script>不会执行</script>',
  author: '作者',
  publishedAt: 1700000000,
  coverUrl: 'https://fixture.douyinpic.com/cover?signature=not-exported',
  mediaType: 'gallery',
  isLive: true,
  collectedAt: 1700000000000
}
const directories: string[] = [],
  stores: Store[] = []
const filter = {
  accountId: 'a',
  search: '',
  mediaType: 'all' as const,
  year: null,
  month: null,
  sort: 'published' as const
}
function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'mylike-transfer-test-'))
  directories.push(folder)
  mkdirSync(join(folder, 'data'))
  const file = join(folder, 'data', 'db.sqlite'),
    store = new Store(file)
  stores.push(store)
  store.call('createAccount', { id: 'a', name: 'A' })
  store.call('createAccount', { id: 'b', name: 'B' })
  store.call('bindAccount', { accountId: 'a', remoteId: 'remote-a', nickname: 'A', avatarUrl: null })
  store.call('savePage', {
    accountId: 'a',
    remoteId: 'remote-a',
    items: [
      { ...item, id: '1' },
      { ...item, id: '2' }
    ],
    cursor: '0',
    hasMore: false
  })
  return { folder, file, store }
}
const total = (store: Store, accountId: string) =>
  store.call('query', { ...filter, accountId, offset: 0, limit: 60 }).total
afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.call('close', undefined)
    } catch {
      /* already closed */
    }
  for (const folder of directories.splice(0)) {
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith('mylike-transfer-test-')
    )
      throw new Error('Unsafe cleanup')
    rmSync(folder, { recursive: true, force: true })
  }
})
describe('versioned metadata transfer', () => {
  it('preserves precision and collection time while excluding authentication and temporary URLs', () => {
    const text = encodeTransfer(
      [{ ...item, ...{ cookie: 'secret', videos: ['secret-media-link'], remoteId: 'secret-user-id' } }],
      '我的本地列表'
    )
    expect(text).not.toContain('signature')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('coverUrl')
    expect(decodeTransfer(text).items[0]).toMatchObject({
      id: item.id,
      collectedAt: item.collectedAt,
      title: item.title,
      isLive: true
    })
  })
  it('deduplicates IDs deterministically without coercing numeric IDs', () => {
    const text = encodeTransfer([item, { ...item, title: 'later' }], 'A')
    expect(decodeTransfer(text)).toMatchObject({ duplicates: 1, items: [{ id: item.id, title: item.title }] })
    const malformed = JSON.parse(text)
    malformed.items[0].id = 123
    expect(() => decodeTransfer(JSON.stringify(malformed))).toThrow(/字段不符合/)
  })
  it('rejects unsupported versions, auth fields, malformed input and URL-bearing extensions', () => {
    const value = JSON.parse(encodeTransfer([item], 'A'))
    expect(() => decodeTransfer(JSON.stringify({ ...value, version: 99 }))).toThrow(/数据版本/)
    expect(() => decodeTransfer(JSON.stringify({ ...value, cookies: 'secret' }))).toThrow(/字段不符合/)
    value.items[0].coverUrl = 'https://untrusted.example/secret'
    expect(() => decodeTransfer(JSON.stringify(value))).toThrow(/字段不符合/)
    expect(() => decodeTransfer('{')).toThrow(/有效的 JSON/)
  })
})
describe('transactional file transfer', () => {
  it('exports the original scoped snapshot atomically without a later collected item or private fields', () => {
    const { store, folder, file } = setup(),
      staged = store.call('prepareExport', { accountId: 'a', source: { type: 'filter', filter } })
    store.call('savePage', {
      accountId: 'a',
      remoteId: 'remote-a',
      items: [{ ...item, id: '3' }],
      cursor: '0',
      hasMore: false
    })
    const output = join(folder, 'out.json')
    writeFileSync(output, 'original file')
    expect(() => store.call('finishExport', { accountId: 'a', token: staged.token, file })).toThrow(
      /应用数据目录之外/
    )
    expect(store.call('finishExport', { accountId: 'a', token: staged.token, file: output })).toMatchObject({
      count: 2,
      fileName: 'out.json'
    })
    const text = readFileSync(output, 'utf8')
    expect(decodeTransfer(text).items.map((work) => work.id)).toEqual(['2', '1'])
    expect(text).not.toContain('signature')
    expect(text).not.toContain('remote-a')
    expect(readdirSync(folder).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(total(store, 'a')).toBe(3)
  })
  it('rejects a directory alias into app data and preserves existing destinations on export failure', () => {
    const { store, folder, file } = setup(),
      alias = join(folder, 'alias')
    symlinkSync(dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const staged = store.call('prepareExport', { accountId: 'a', source: { type: 'filter', filter } })
    expect(() =>
      store.call('finishExport', { accountId: 'a', token: staged.token, file: join(alias, 'db.sqlite') })
    ).toThrow(/应用数据目录之外/)
    const directory = join(folder, 'existing-directory')
    mkdirSync(directory)
    expect(() =>
      store.call('finishExport', { accountId: 'a', token: staged.token, file: directory })
    ).toThrow(/原目标文件未替换/)
    expect(readdirSync(directory)).toEqual([])
    expect(readdirSync(folder).some((name) => name.endsWith('.tmp'))).toBe(false)
    expect(total(store, 'a')).toBe(2)
  })
  it('supports a no-write preview and cancellation, then imports into the selected account without identity or cursor changes', () => {
    const { store, folder, file } = setup(),
      input = join(folder, 'in.json')
    writeFileSync(
      input,
      encodeTransfer(
        [
          { ...item, id: '1', title: 'stale' },
          { ...item, id: '3' },
          { ...item, id: '3' }
        ],
        'other-account'
      )
    )
    const preview = store.call('prepareImport', { accountId: 'b', file: input })
    expect(preview).toMatchObject({ total: 2, newCount: 2, existingCount: 0, duplicates: 1 })
    expect(total(store, 'b')).toBe(0)
    store.call('discardTransfer', { token: preview.token })
    expect(() => store.call('commitImport', { accountId: 'b', token: preview.token })).toThrow(/预览已失效/)
    const confirmed = store.call('prepareImport', { accountId: 'b', file: input })
    expect(() => store.call('commitImport', { accountId: 'a', token: confirmed.token })).toThrow(/预览已失效/)
    expect(store.call('commitImport', { accountId: 'b', token: confirmed.token })).toEqual({
      received: 2,
      added: 2,
      duplicates: 1
    })
    expect(store.call('accounts', undefined).find((account) => account.id === 'b')).toMatchObject({
      remoteId: null,
      lastVerifiedAt: null
    })
    expect(store.call('checkpoint', { accountId: 'b' })).toBeNull()
    expect(
      store
        .call('query', { ...filter, accountId: 'b', offset: 0, limit: 60 })
        .items.find((work) => work.id === '1')?.title
    ).toBe(item.title)
    const raw = new DatabaseSync(file)
    expect(
      raw
        .prepare('SELECT platformSeen,firstSeen FROM account_items WHERE accountId=? AND workId=?')
        .get('b', '3')
    ).toMatchObject({ platformSeen: 0, firstSeen: item.collectedAt })
    raw.close()
  })
  it('backs up before import and rolls back a midway write failure, retaining a valid preview for explicit retry', () => {
    const { store, folder, file } = setup(),
      input = join(folder, 'in.json')
    writeFileSync(
      input,
      encodeTransfer(
        [
          { ...item, id: '3' },
          { ...item, id: '4' }
        ],
        'A'
      )
    )
    const preview = store.call('prepareImport', { accountId: 'b', file: input })
    const raw = new DatabaseSync(file)
    raw.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON account_items WHEN NEW.workId='4' BEGIN SELECT RAISE(ABORT,'fixture import failure'); END;"
    )
    expect(() => store.call('commitImport', { accountId: 'b', token: preview.token })).toThrow(
      /fixture import failure/
    )
    expect(total(store, 'b')).toBe(0)
    expect(raw.prepare('SELECT id FROM works WHERE id=?').get('3')).toBeUndefined()
    const backups = readdirSync(join(dirname(file), 'backups'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(join(dirname(file), 'backups', backups[0]!))
    expect(backup.prepare('SELECT count(*) AS n FROM account_items WHERE accountId=?').get('a')?.n).toBe(2)
    backup.close()
    raw.exec('DROP TRIGGER fail_import')
    raw.close()
    expect(store.call('commitImport', { accountId: 'b', token: preview.token }).added).toBe(2)
  })
  it('does not treat imported records as a previous platform page when checking for new likes', () => {
    const { store, folder } = setup(),
      input = join(folder, 'in.json')
    writeFileSync(input, encodeTransfer([{ ...item, id: '3' }], 'B'))
    const preview = store.call('prepareImport', { accountId: 'a', file: input })
    store.call('commitImport', { accountId: 'a', token: preview.token })
    store.call('startCollection', { accountId: 'a', id: 'task', mode: 'update' })
    const save = (requestCursor: string, cursor: string, id: string) =>
      store.call('saveCollectionPage', {
        accountId: 'a',
        taskId: 'task',
        remoteId: 'remote-a',
        requestCursor,
        cursor,
        hasMore: true,
        items: [{ ...item, id }]
      })
    expect(save('0', '10', '3')).toMatchObject({ status: 'running', phase: 'head', added: 0 })
    expect(save('10', '20', '4')).toMatchObject({ status: 'running', added: 1 })
    expect(save('20', '30', '1')).toMatchObject({ status: 'completed', pages: 3 })
    expect(total(store, 'a')).toBe(4)
  })
  it('rejects invalid UTF-8 and an oversized file before changing any stored records', () => {
    const { store, folder } = setup(),
      bad = join(folder, 'bad.json')
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0xff]))
    expect(() => readTransfer(bad)).toThrow(/UTF-8/)
    truncateSync(bad, MAX_TRANSFER_BYTES + 1)
    expect(() => readTransfer(bad)).toThrow(/67.11 MB/)
    expect(total(store, 'a')).toBe(2)
  })
})
