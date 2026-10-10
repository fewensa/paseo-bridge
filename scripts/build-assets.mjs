import { mkdir, writeFile } from 'node:fs/promises';
import { redocAssets } from './redoc-assets.mjs';
const { source, licenses } = await redocAssets();
await mkdir('dist/assets', { recursive: true });
await writeFile('dist/assets/redoc.standalone.js', source);
await writeFile('dist/assets/redoc.licenses.txt', licenses);
