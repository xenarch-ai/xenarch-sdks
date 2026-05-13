import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE_BUDGET_GZ = 9 * 1024;

mkdirSync(resolve(__dirname, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(__dirname, "src/index.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2019"],
  outfile: resolve(__dirname, "dist/v1.js"),
  legalComments: "none",
  // IIFE with no globalName: the module exports are discarded, leaving
  // pure side-effect code (DOM scan + click handler bootstrap).
});

const dist = resolve(__dirname, "dist/v1.js");
const raw = readFileSync(dist);
const gz = gzipSync(raw);
const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
).version;
writeFileSync(resolve(__dirname, `dist/v${pkgVersion}.js`), raw);

const rawKb = (raw.length / 1024).toFixed(2);
const gzKb = (gz.length / 1024).toFixed(2);
console.log(`dist/v1.js              ${raw.length} B  raw  (${rawKb} KB)`);
console.log(`dist/v1.js (gzipped)    ${gz.length} B  gzip (${gzKb} KB)`);
console.log(`dist/v${pkgVersion}.js  (versioned twin written)`);

if (gz.length > SIZE_BUDGET_GZ) {
  console.error(
    `FAIL: bundle ${gz.length} B gzipped exceeds ${SIZE_BUDGET_GZ} B budget`,
  );
  process.exit(1);
}
console.log(`OK: under ${(SIZE_BUDGET_GZ / 1024).toFixed(0)} KB gzip budget.`);
