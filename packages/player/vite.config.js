import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Two IIFE bundles from one source tree, built in two passes:
 *
 *   dist/player.js  window.CineHost - loaded by the iframe embed page
 *   dist/e.js       the drop-on-any-page script embed, self-configuring
 *
 * IIFE and not ESM on purpose: `document.currentScript` is null inside a module
 * script, and e.js reads its own src to discover the collector endpoint.
 */
export default defineConfig(({ mode }) => {
  const embed = mode === 'embed';
  return {
    build: {
      outDir: 'dist',
      emptyOutDir: !embed, // second pass must not wipe the first
      target: 'es2020',
      minify: 'esbuild',
      lib: {
        entry: resolve(import.meta.dirname, embed ? 'src/embed.js' : 'src/global.js'),
        name: 'CineHost',
        formats: ['iife'],
        fileName: () => (embed ? 'e.js' : 'player.js'),
      },
    },
    plugins: [
      {
        name: 'copy-css',
        closeBundle() {
          copyFileSync(
            resolve(import.meta.dirname, 'src/player.css'),
            resolve(import.meta.dirname, 'dist/player.css'),
          );
        },
      },
    ],
  };
});
