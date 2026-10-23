import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'database-worker': resolve('src/main/storage/worker.ts')
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } }
  },
  renderer: { plugins: [react()] }
})
