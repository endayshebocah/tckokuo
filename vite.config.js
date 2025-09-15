import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['logo192.png', 'logo512.png'],
      manifest: {
        name: "Database Manajemen Peserta Kokuo",
        short_name: "Kokuo Tc",
        description: "Aplikasi manajemen peserta",
        theme_color: "#111827",
        background_color: "#111827",
        display: "standalone",
        start_url: ".",
        icons: [
          {
            src: "/logo192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/logo512.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      }
    })
  ],
  base: "./",
  build: {
    outDir: "dist"
  },
  server: {
    port: 3000
  }
})
