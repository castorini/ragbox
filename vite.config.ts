import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { rolldownOptions: { output: { codeSplitting: { groups: [
    { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
    { name: 'ui', test: /node_modules\/@radix-ui\// },
  ] } } } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
