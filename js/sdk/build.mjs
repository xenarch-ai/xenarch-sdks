// Build @xenarch/sdk → dist/ with:
//   - dist/index.js       ESM bundle (the `main` for bundlers, React external)
//   - dist/index.cjs      CJS bundle (for older toolchains, React external)
//   - dist/index.d.ts     Type declarations
//
// React + ReactDOM stay external — they're peer deps. The merchant brings
// their own; the bundler dedupes.
//
// No CDN UMD bundle: a standalone <script> SDK would need both React AND
// ReactDOM (this package uses no react-dom symbols, but renders React
// elements, which require ReactDOM to mount). For drop-on-any-page use,
// `@xenarch/embed` is the right tool — it's vanilla JS, zero deps.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "src/index.tsx");
const DIST = resolve(__dirname, "dist");
const REACT_EXTERNAL = ["react", "react-dom", "react/jsx-runtime"];

mkdirSync(DIST, { recursive: true });

await build({
  entryPoints: [SRC],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2019"],
  external: REACT_EXTERNAL,
  outfile: resolve(DIST, "index.js"),
  legalComments: "none",
});

await build({
  entryPoints: [SRC],
  bundle: true,
  minify: true,
  format: "cjs",
  target: ["es2019"],
  external: REACT_EXTERNAL,
  outfile: resolve(DIST, "index.cjs"),
  legalComments: "none",
});

// Type declarations — separate tsconfig drops noEmit and scopes the
// file set to src/ so @types/chai bleeding in from vitest doesn't
// fail the emit on its ES2015-target globals.
execSync("npx tsc -p tsconfig.build.json", {
  cwd: __dirname,
  stdio: "inherit",
});

console.log("dist/index.js    ESM, React external");
console.log("dist/index.cjs   CJS, React external");
console.log("dist/index.d.ts  Types");
