import { mkdir, writeFile } from 'node:fs/promises';
import { generateOpenAPI } from '../dist/src/api/openapi.js';
await mkdir('build', { recursive: true });
await writeFile('build/openapi.json', JSON.stringify(generateOpenAPI(), null, 2) + '\n');
console.log('Generated build/openapi.json from shared routes and Zod schemas.');
