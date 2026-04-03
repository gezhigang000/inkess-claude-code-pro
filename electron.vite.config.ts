import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
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
      outDir: 'out/preload'
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
