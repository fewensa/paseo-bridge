import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { openapiJSON } from './openapi.js';
import { documentRoutes } from './routes.js';

declare const __BRIDGE_REDOC_SOURCE__: string;
declare const __BRIDGE_REDOC_LICENSES__: string;
const init = `Redoc.init('./openapi.json', {disableGoogleFont:true,theme:{typography:{fontFamily:'system-ui, sans-serif',headings:{fontFamily:'system-ui, sans-serif'}}}}, document.getElementById('redoc'));`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Paseo Bridge API</title></head><body><div id="redoc"></div><script src="./openapi/assets/redoc.standalone.js"></script><script>${init}</script></body></html>`;
const csp = `default-src 'none'; script-src 'self' 'sha256-${createHash('sha256').update(init).digest('base64')}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; worker-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'`;
let script: Promise<string> | undefined; let licenses: Promise<string> | undefined;
export async function serveDocument(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const route = req.method === 'GET' ? documentRoutes.find(value => value.path === req.url) : undefined;
  if (!route) return false;
  let value: string; const type = `${route.media}; charset=utf-8`;
  if (route.key === 'html') value = html;
  else if (route.key === 'spec') value = openapiJSON;
  else if (route.key === 'script') {
    script ??= typeof __BRIDGE_REDOC_SOURCE__ === 'string' ? Promise.resolve(__BRIDGE_REDOC_SOURCE__) : readFile(new URL('../../assets/redoc.standalone.js', import.meta.url), 'utf8');
    value = await script;
  } else {
    licenses ??= typeof __BRIDGE_REDOC_LICENSES__ === 'string' ? Promise.resolve(__BRIDGE_REDOC_LICENSES__) : readFile(new URL('../../assets/redoc.licenses.txt', import.meta.url), 'utf8');
    value = await licenses;
  }
  if (!res.destroyed) {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': csp });
    res.end(value);
  }
  return true;
}
