import { expect, it } from 'vitest'
import { commands, filterSchema } from '../../src/shared/contracts'

const accountId = '00000000-0000-4000-8000-000000000000'
const localFolderId = 'local-5a4c1e0e-1111-4222-8333-444455556666'

it('accepts remote and locally generated folder ids wherever a folder can be chosen', () => {
  for (const folderId of ['7234567890123456789', localFolderId]) {
    expect(filterSchema.parse({ accountId, folderId })).toMatchObject({ folderId })
    expect(() =>
      commands.favoriteSave.parse({ accountId, token: accountId, folderIds: [folderId] })
    ).not.toThrow()
    expect(() =>
      commands.aiClassifyFavorites.parse({
        accountId,
        folderIds: [folderId],
        createAiFolders: false,
        aiFolderNames: []
      })
    ).not.toThrow()
    expect(() =>
      commands.favoriteFolderRemoveWorks.parse({ accountId, folderId, workIds: ['1'] })
    ).not.toThrow()
  }
})

it('rejects folder ids that could not come from the local store', () => {
  expect(() =>
    commands.favoriteFolderRemoveWorks.parse({ accountId, folderId: 'bad id!', workIds: ['1'] })
  ).toThrow()
  expect(() => filterSchema.parse({ accountId, folderId: 'x'.repeat(101) })).toThrow()
})
