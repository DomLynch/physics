// Opens proof/bench/dist/bench.html in headless Chromium and prints window.__result (a smoke check that the bundle runs; the numbers are the VPS's, not a phone's).
//   node tools/read-bench.mjs [path/to/bench.html]      run on the VPS through `capture` (see tools/capture-clip.mjs for how Playwright is found)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const file = resolve(process.argv[2] || "proof/bench/dist/bench.html");
let chromium;
for (const d of [process.cwd() + "/", process.env.PLAYWRIGHT_NODE_MODULES ? process.env.PLAYWRIGHT_NODE_MODULES + "/" : "", "/opt/frankendom-shadow/work/bn-trunk/node_modules/"].filter(Boolean)) {
  for (const n of ["playwright", "playwright-core"]) { try { ({ chromium } = createRequire(d)(n)); break; } catch {} }
  if (chromium) break;
}
if (!chromium) { console.error("playwright not found"); process.exit(1); }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true });
const page = await ctx.newPage();
const external = [];
page.on("request", (r) => { if (!/^(file|data|blob|about):/.test(r.url())) external.push(r.url()); });
page.on("pageerror", (e) => console.error("pageerror", e));
await page.goto(pathToFileURL(file).href);
await page.waitForFunction(() => window.__result, null, { timeout: 120000 });
console.log(JSON.stringify(await page.evaluate(() => window.__result), null, 1));
console.log("external requests:", external.length);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();
