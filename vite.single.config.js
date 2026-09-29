import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist-single',
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
  },
});
