import { readFile } from 'node:fs/promises';

export async function redocAssets() {
  let source = await readFile('node_modules/redoc/bundles/redoc.standalone.js', 'utf8');
  // The pinned standalone build otherwise attempts a CDN footer-logo fetch.
  // Vendor the fixed image (Redoc's MIT license/attribution retained) as data.
  const externalLogo = 'https://cdn.redoc.ly/redoc/logo-mini.svg';
  if (source.split(externalLogo).length !== 2) throw new Error('Pinned Redoc logo reference changed');
  const logo = await readFile('assets/redoc-logo.svg');
  source = source.replace(externalLogo, `data:image/svg+xml;base64,${logo.toString('base64')}`);
  const licenses = (await Promise.all(['node_modules/redoc/LICENSE', 'node_modules/redoc/bundles/redoc.standalone.js.LICENSE.txt'].map(path => readFile(path, 'utf8')))).join('\n\n');
  return { source, licenses };
}
