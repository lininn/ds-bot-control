import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The Bot views take DSH's interface primitives from one module; this shell does not load
// DSH's interface, so app/ui's own module stands in for that one. Some views (the user's own
// messages) import the package by name instead of through ./dsh-primitives.js, so both reach
// the same stand-in; it leaves the primitives it does not draw undefined, and the views skip them.
const primitives = fileURLToPath(new URL('../app/ui/src/primitives.js', import.meta.url))
const primitivesPackage = '@deepseek-ai/dsh-client-ui-primitives'
const ownPrimitives = {
  name: 'ds-bot-primitives',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer?.replaceAll('\\', '/').includes('/ds-bot/src/client/')) return null
    return source === './dsh-primitives.js' || source === primitivesPackage ? primitives : null
  },
}

// The relay serves the build from a versioned subdirectory (/web-dist/<version>/), so asset
// paths stay relative. React and deep-view are deduped because the reused client modules live
// outside web/: they import these packages, but their own folders have no node_modules in a CI
// checkout that installed only web/, so the copies installed here are the ones to resolve.
export default defineConfig({
  base: './',
  plugins: [ownPrimitives],
  resolve: { dedupe: ['deep-view', 'react', 'react-dom', 'react-markdown', 'remark-gfm'] },
  // The reused sources are in ../app and ../ds-bot; the dev server must read them.
  server: { fs: { allow: ['..'] } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
})
