#!/usr/bin/env node

import { createProgram } from "../src/index.js";

const program = createProgram();

// Force a clean exit once the command finishes (XEN-612). Some paths — notably
// WalletConnect's relay WebSocket + keepalive timers (see lib/wc-connect.ts) —
// leave handles open that keep Node's event loop alive, so the process would
// otherwise hang after the command has already done its work and printed its
// result. `parseAsync` resolves only after the (async) action completes, so it
// is safe to hard-exit here. We flush stdout/stderr first so piped output
// (e.g. `--json | jq`) is never truncated by the exit.
program
  .parseAsync()
  .then(() => flushAndExit(process.exitCode ?? 0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    flushAndExit(1);
  });

function flushAndExit(code: number): void {
  const finish = (): never => process.exit(code);
  // The empty-write callbacks fire once buffered output has been handed to the
  // OS (writes are ordered, so this drains any prior output too), then we exit.
  process.stdout.write("", () => process.stderr.write("", finish));
  // Safety net: never let a stuck stream re-introduce the very hang we're
  // fixing. Unref'd so the timer itself can't keep the process alive.
  setTimeout(finish, 200).unref();
}
