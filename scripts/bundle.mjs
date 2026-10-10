import { build } from 'esbuild';
import { chmod, mkdir } from 'node:fs/promises';
await mkdir('build', { recursive: true });
for (const name of ['cli', 'server']) {
  const file = `build/paseo-bridge${name === 'server' ? '-server' : ''}.mjs`;
  await build({ entryPoints: [`${name}.ts`], outfile: file, bundle: true,
    platform: 'node', target: 'node22', format: 'esm',
    banner: { js: "import { createRequire as __bridgeCreateRequire } from 'node:module'; const require = __bridgeCreateRequire(import.meta.url);" } });
  await chmod(file, 0o755);
}
console.log('Bundled executable scripts created in build/; Node.js >=22 required, npm/node_modules not required on target.');
