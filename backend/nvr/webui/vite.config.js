import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The UI is served from the Go binary at the site root (/), talking to the same
// origin's /api/v1/nvr API. base:'/' keeps asset URLs absolute so the SPA fallback
// (unknown path -> index.html) resolves /assets/* correctly under any route.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // Local dev proxy so `npm run dev` can talk to a running node on :8080.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
