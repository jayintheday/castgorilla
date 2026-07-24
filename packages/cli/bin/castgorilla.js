#!/usr/bin/env node
/**
 * castgorilla CLI entry point.
 *
 * Thin loader: the command surface lives in the compiled TypeScript at
 * ../dist/index.js (built by `tsc -b`). Run the repo build once and this bin
 * works standalone.
 */
import { run } from '../dist/index.js';

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`castgorilla: ${error?.stack ?? error}\n`);
    process.exit(1);
  });
