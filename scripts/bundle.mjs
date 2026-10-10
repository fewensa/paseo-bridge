import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
import { redocAssets } from './redoc-assets.mjs';
const { source: redoc, licenses } = await redocAssets();
await mkdir('build', { recursive: true });
for (const name of ['cli', 'server', 'container']) {
  const file = `build/paseo-bridge${name === 'cli' ? '' : `-${name}`}.mjs`;
  await build({ entryPoints: [`${name}.ts`], outfile: file, bundle: true,
    platform: 'node', target: 'node22', format: 'esm',
    define: { __BRIDGE_REDOC_SOURCE__: JSON.stringify(redoc), __BRIDGE_REDOC_LICENSES__: JSON.stringify(licenses) },
    banner: { js: "import { createRequire as __bridgeCreateRequire } from 'node:module'; const require = __bridgeCreateRequire(import.meta.url);" } });
  await chmod(file, 0o755);
}
console.log('Bundled executable scripts created in build/; Node.js >=22 required, npm/node_modules not required on target.');
