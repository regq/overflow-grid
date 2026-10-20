import { defineConfig } from 'vite';

// `base` is set at build time so the same source deploys either to GitHub Pages
// (https://<user>.github.io/<repo>/) or to a root domain (Cloudflare Pages).
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  build: { target: 'es2020', sourcemap: true },
});
