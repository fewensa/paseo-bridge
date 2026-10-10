#!/usr/bin/env node
import { runContainer } from './src/container-runtime.js';
import { publicError } from './src/errors.js';
try { await runContainer(); }
catch (error) {
  const e = publicError(error);
  console.error(JSON.stringify({ error: { code: e.code, message: e.message } })); process.exitCode = 1;
}
