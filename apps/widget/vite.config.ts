import { defineConfig, type Plugin } from 'vite';

/**
 * Escape every non-ASCII character in the output. A classic <script> is decoded
 * with the host page's encoding unless the server sends a charset, and many
 * store pages are not UTF-8; an ASCII-only file reads the same in all of them.
 */
function asciiOnly(): Plugin {
  return {
    name: 'ascii-only',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        chunk.code = chunk.code.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      }
    },
  };
}

// One self-contained file (Lit included) that a merchant loads with a single
// <script> tag. The ES build is for sites that bundle their own JavaScript.
export default defineConfig({
  plugins: [asciiOnly()],
  build: {
    target: 'es2020',
    lib: {
      entry: 'src/jewelry-configurator.ts',
      name: 'JewelryConfigurator',
      formats: ['iife', 'es'],
      fileName: (format) => (format === 'iife' ? 'jewelry-configurator.js' : 'jewelry-configurator.esm.js'),
    },
  },
});
