// Builds proof/bench/dist/bench.html: ONE self-contained page (inline JS, Jolt wasm embedded, minotaur body row inlined, no external requests).
//   node proof/bench/build.mjs        (npm run build:bench)
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
let sha = process.env.GIT_SHA || "unknown";
if (sha === "unknown") { try { sha = execSync("git rev-parse --short HEAD", { cwd: here, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {} }
const stub = join(here, "stub-node.js");

const res = await build({
  entryPoints: [join(here, "main.js")],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", minify: true, legalComments: "none",
  alias: { fs: stub, path: stub, url: stub, module: stub, "node:fs": stub, "node:path": stub, "node:url": stub, "node:module": stub },
  banner: { js: "var __importMetaUrl=location.href;" },
  define: { "import.meta.url": "__importMetaUrl", __GIT_SHA__: JSON.stringify(sha), "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
// a literal </script> inside the bundle would end the inline tag early
const js = res.outputFiles[0].text.replace(/<\/(script)/gi, "<\\/$1");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Physics bench</title>
<style>
:root{--bg:#101114;--fg:#e8e8ea;--mut:#8b8d95;--ok:#3ddc84;--bad:#ff5a4f;--card:#1a1c21}
@media (prefers-color-scheme:light){:root{--bg:#f4f4f6;--fg:#15161a;--mut:#62646c;--ok:#0a8f4a;--bad:#c4281c;--card:#fff}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif;max-width:480px}
h1{font-size:15px;margin:0 0 12px;font-weight:600;color:var(--mut)}
.big{background:var(--card);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.big .l{font-size:13px;color:var(--mut)} .big .v{font-size:56px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums}
.big .v small{font-size:20px;font-weight:500;color:var(--mut)}
.row{display:flex;gap:10px}.row .big{flex:1}.row .big .v{font-size:40px}
#verdict{font-size:34px;font-weight:800;text-align:center;padding:14px;border-radius:14px;margin-bottom:10px;background:var(--card)}
#verdict.ok{color:var(--ok)}#verdict.bad{color:var(--bad)}
button{width:100%;font:600 18px system-ui;padding:14px;border-radius:12px;border:0;background:#3b82f6;color:#fff;margin:4px 0 14px}
button:disabled{opacity:.5}
dl{margin:0;font-size:13px;color:var(--mut);word-break:break-word}dt{float:left;clear:left;width:96px}dd{margin:0 0 4px 96px}
</style></head>
<body>
<h1>@frankendom/physics: 5 fighters + 1 cut</h1>
<div id="verdict">running...</div>
<div class="big"><div class="l">average per frame</div><div class="v"><span id="avg">-</span> <small>ms</small></div></div>
<div class="row"><div class="big"><div class="l">p95</div><div class="v"><span id="p95">-</span></div></div><div class="big"><div class="l">max</div><div class="v"><span id="max">-</span></div></div></div>
<button id="again" disabled>Run again</button>
<dl><dt>calibration</dt><dd id="cal">-</dd><dt>reference</dt><dd>20.2 ms on a quiet Mac (lower is faster)</dd><dt>budget</dt><dd>3 ms, average and p95</dd><dt>build</dt><dd id="sha">-</dd><dt>device</dt><dd id="ua">-</dd><dt>status</dt><dd id="st">-</dd></dl>
<script>${js}</script>
</body></html>
`;
const out = join(here, "dist", "bench.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB) sha ${sha}`);
