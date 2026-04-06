import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'browser-toolbar': resolve(__dirname, 'src/preload/browser-toolbar.ts'),
        }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5174  // Different from CLI version (5173) to avoid localStorage collision
    },
    build: {
      outDir: 'out/renderer'
    }
  }
})
