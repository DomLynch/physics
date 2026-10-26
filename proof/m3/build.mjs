// Bundles the M3 proof page into proof/m3/dist (the GLB is copied in from V3's repo, not committed here).
//   node proof/m3/build.mjs [path/to/minotaur.glb]
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = resolve(HERE, "dist");
mkdirSync(dist, { recursive: true });
const glb = process.argv[2] || resolve(process.env.HOME, "Developer/frankendom-v3/src/assets/minotaur.glb");
copyFileSync(glb, resolve(dist, "minotaur.glb"));
copyFileSync(resolve(HERE, "index.html"), resolve(dist, "index.html"));
writeFileSync(resolve(dist, "stub-empty.js"), "export default {};\n");
await build({
  entryPoints: [resolve(HERE, "main.js")], outfile: resolve(dist, "main.js"), bundle: true, format: "esm", platform: "browser", target: "es2022",
  external: ["node:module"], // Jolt's glue imports it only on its Node branch
  alias: { fs: resolve(dist, "stub-empty.js"), path: resolve(dist, "stub-empty.js") }, loader: { ".json": "json" }, minify: false,
});
console.log("built", dist);
