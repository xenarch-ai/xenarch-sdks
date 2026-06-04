// Build @xenarch/sdk → dist/ with:
//   - dist/index.js    ESM bundle (the `module` entry, deps external)
//   - dist/index.cjs   CJS bundle (the `main` entry, deps external)
//   - dist/index.d.ts  Type declarations
//
// Dependencies (@xenarch/core + its transitive viem) stay external — this is a
// library, the consumer installs them. Keeping them external also keeps the
// bundle small and lets the consumer dedupe viem with their own wallet stack.

import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "src/index.ts");
const DIST = resolve(__dirname, "dist");

mkdirSync(DIST, { recursive: true });

const common = {
  entryPoints: [SRC],
  bundle: true,
  minify: false,
  target: ["es2020"],
  platform: "neutral",
  packages: "external",
  legalComments: "none",
};

await build({ ...common, format: "esm", outfile: resolve(DIST, "index.js") });
await build({ ...common, format: "cjs", outfile: resolve(DIST, "index.cjs") });

// Type declarations — separate tsconfig drops noEmit and scopes to src/.
execSync("npx tsc -p tsconfig.build.json", { cwd: __dirname, stdio: "inherit" });

console.log("dist/index.js    ESM, deps external");
console.log("dist/index.cjs   CJS, deps external");
console.log("dist/index.d.ts  Types");
