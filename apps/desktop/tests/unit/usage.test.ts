import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { metadataBytes } from '../../src/main/storage/usage'

describe('shared metadata disk usage', () => {
  it('counts database, WAL and shared memory while excluding media cache and backups', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mylike-usage-test-'))
    try {
      expect(await metadataBytes(folder)).toBe(0)
      writeFileSync(join(folder, 'mylike.sqlite'), Buffer.alloc(2048))
      writeFileSync(join(folder, 'mylike.sqlite-wal'), Buffer.alloc(512))
      writeFileSync(join(folder, 'mylike.sqlite-shm'), Buffer.alloc(128))
      mkdirSync(join(folder, 'backups'))
      writeFileSync(join(folder, 'backups', 'copy.sqlite'), Buffer.alloc(4096))
      writeFileSync(join(folder, 'media-cache'), Buffer.alloc(4096))
      expect(await metadataBytes(folder)).toBe(2688)
    } finally {
      expect(dirname(resolve(folder))).toBe(resolve(tmpdir()))
      expect(basename(folder)).toMatch(/^mylike-usage-test-/)
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('reports unreadable file paths instead of returning zero usage', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'mylike-usage-test-'))
    try {
      const file = join(folder, 'file')
      writeFileSync(file, '')
      await expect(metadataBytes(file)).rejects.toMatchObject({ code: 'DATA_INFO_FAILED' })
    } finally {
      expect(dirname(resolve(folder))).toBe(resolve(tmpdir()))
      expect(basename(folder)).toMatch(/^mylike-usage-test-/)
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
