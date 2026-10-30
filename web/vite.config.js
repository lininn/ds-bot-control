import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The Bot views take DSH's interface primitives from one module; this shell does not load
// DSH's interface, so app/ui's own module stands in for that one.
const primitives = fileURLToPath(new URL('../app/ui/src/primitives.js', import.meta.url))
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    return source === './dsh-primitives.js' && importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/') ? primitives : null
  },
}

// The relay serves the build from a versioned subdirectory (/web-dist/<version>/), so asset
// paths stay relative. React is deduped because the reused client modules live outside web/.
export default defineConfig({
  base: './',
  plugins: [ownPrimitives],
  resolve: { dedupe: ['react', 'react-dom', 'react-markdown', 'remark-gfm'] },
  // The reused sources are in ../app and ../ds-bot; the dev server must read them.
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
