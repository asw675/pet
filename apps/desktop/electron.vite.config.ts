import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

// Each preload is a standalone CJS bundle. The runtime native addon remains
// external and is loaded only from the separate utility-process entry.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: resolve('src/main/bootstrap.ts'),
          'app-service': resolve('src/app-service/index.ts'),
        },
        external: ['better-sqlite3'],
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          pet: resolve('src/preload/pet.ts'),
          'control-center': resolve('src/preload/control-center.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [vue()],
    build: { rollupOptions: { input: {
      pet: resolve('src/renderer/pet/index.html'),
      'control-center': resolve('src/renderer/control-center/index.html'),
    } } },
  },
});
