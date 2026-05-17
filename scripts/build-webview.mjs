import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('media/vendor', { recursive: true });

await esbuild.build({
  entryPoints: ['media/duckdb-entry.mjs'],
  outfile: 'media/vendor/duckdb.mjs',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'info',
});

console.log('Built media/vendor/duckdb.mjs');
