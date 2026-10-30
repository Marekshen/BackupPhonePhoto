import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

function commitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

const buildTime = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(5, 16);

export default defineConfig({
  base: '/BackupPhonePhoto/',
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version} · ${commitHash()} · ${buildTime}`),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '照片備份到 Google Drive',
        short_name: '照片備份',
        lang: 'zh-Hant',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1a73e8',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        runtimeCaching: [],
      },
    }),
  ],
});
