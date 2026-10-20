// Node's --experimental-strip-types resolves import specifiers literally:
// `./foo.js` is looked up as a file named foo.js on disk, with no fallback
// to a sibling foo.ts (https://nodejs.org/api/typescript.html — "file
// extensions are mandatory... import './file.ts', not import './file.js'").
// This repo's src/ uses NodeNext-style `.js` specifiers pointing at `.ts`
// files (required for the tsc-emitted dist/ output and honoured by
// vitest/Vite's resolver), so running src/*.ts directly under raw
// --experimental-strip-types needs this one-line remap. Registered
// synchronously, in-thread, via `--import` in the worker-smoke test's
// execArgv — registerHooks (not the deprecated async module.register) is
// the current API for an in-thread resolve hook this simple.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  }
});
