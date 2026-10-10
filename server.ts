#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runServer } from './src/runtime.js';
import { publicError, BridgeError } from './src/errors.js';
try {
  const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) console.log('paseo-bridge-server --config /absolute/server.json');
  else {
    if (!values.config) throw new BridgeError('USAGE', 'Use paseo-bridge-server --config FILE');
    await runServer(values.config);
  }
} catch (error) {
  const e = publicError(error);
  console.error(JSON.stringify({ error: { code: e.code, message: e.message } })); process.exitCode = 1;
}
