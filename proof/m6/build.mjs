// Bundles the M6 proof page into proof/m6/dist.
//   node proof/m6/build.mjs                                   the page against the generated FIXTURE cut body (proof/m6/fixture.js)
//   node proof/m6/build.mjs <body>.cut.glb [<body>.cut.manifest.json]   the real cut body: both files are copied into dist and config.json names the body
// The page reads dist/config.json ({ "body": null | "minotaur-106" }); `?body=minotaur-106` in the URL overrides it in a normal browser.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const dist = resolve(HERE, "dist");
mkdirSync(dist, { recursive: true });
const [glb, manifestArg] = process.argv.slice(2);
let body = null;
if (glb) {
  const m = basename(glb).match(/^(.+)\.cut\.glb$/);
  if (!m) throw new Error("expected a <body>.cut.glb, got " + glb);
  body = m[1];
  const manifest = manifestArg || glb.replace(/\.glb$/, ".manifest.json");
  if (!existsSync(manifest)) throw new Error("manifest not found: " + manifest);
  copyFileSync(glb, resolve(dist, `${body}.cut.glb`));
  copyFileSync(manifest, resolve(dist, `${body}.cut.manifest.json`));
}
writeFileSync(resolve(dist, "config.json"), JSON.stringify({ body }) + "\n");
copyFileSync(resolve(HERE, "index.html"), resolve(dist, "index.html"));
writeFileSync(resolve(dist, "stub-empty.js"), "export default {};\n");
await build({
  entryPoints: [resolve(HERE, "main.js")], outfile: resolve(dist, "main.js"), bundle: true, format: "esm", platform: "browser", target: "es2022",
  external: ["node:module"], // Jolt's glue imports it only on its Node branch
  alias: { fs: resolve(dist, "stub-empty.js"), path: resolve(dist, "stub-empty.js") }, loader: { ".json": "json" }, minify: false,
});
console.log("built", dist, body ? "(real cut body " + body + ")" : "(fixture)");
