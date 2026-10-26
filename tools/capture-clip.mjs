// Generic frame-stepped clip capture for a static page that follows the capture contract:
//   window.__ready            Promise, resolved when assets are loaded
//   window.__advance(ticks)   advances the sim `ticks` 60 Hz ticks and renders ONE frame synchronously
//   window.__done             boolean, true when the scripted timeline has finished
// Loop: __advance(2) then screenshot (30 fps out of 60 Hz ticks) until __done, then ffmpeg -> mp4 (h264, yuv420p, 30 fps, +faststart) and a middle-frame png.
//   node tools/capture-clip.mjs <dir> <out.mp4> [--max-frames N]
// Runs on the VPS through `capture` (see the vps-heavy-jobs skill); never install Playwright or a browser on the Mac. Playwright is not a dependency of
// this package: it is resolved from the working directory, then from PLAYWRIGHT_NODE_MODULES (default: the VPS's shared tooling install, read only).
// Env: CHROMIUM_PATH (executablePath), CAPTURE_CHROMIUM_ARGS (extra flags, space separated), CAPTURE_TICKS_PER_FRAME (default 2).
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, stat, mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, extname, normalize, dirname, basename } from "node:path";

const args = process.argv.slice(2);
const mi = args.indexOf("--max-frames");
const maxFrames = mi >= 0 ? Number(args.splice(mi, 2)[1]) : 1800;
const [dir, out] = args;
if (!dir || !out || !(maxFrames > 0)) { console.error("usage: node tools/capture-clip.mjs <dir> <out.mp4> [--max-frames N]"); process.exit(2); }
const TPF = Number(process.env.CAPTURE_TICKS_PER_FRAME || 2);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg", ".ogg": "audio/ogg" };
const root = resolve(dir);
const server = createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "content-length": s.size, "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

function loadPlaywright() {
  const dirs = [process.cwd() + "/", process.env.PLAYWRIGHT_NODE_MODULES ? process.env.PLAYWRIGHT_NODE_MODULES + "/" : "", "/opt/frankendom-shadow/work/bn-trunk/node_modules/"].filter(Boolean);
  for (const d of dirs) for (const name of ["playwright", "playwright-core"]) {
    try { return createRequire(d)(name); } catch {}
  }
  throw new Error("playwright not found (run this on the VPS through capture; tried " + dirs.join(", ") + ")");
}
const { chromium } = loadPlaywright();

const tmp = await mkdtemp(join(tmpdir(), "capture-clip-"));
const cleanup = async () => { await rm(tmp, { recursive: true, force: true }); server.close(); };
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox", ...(process.env.CAPTURE_CHROMIUM_ARGS || "").split(" ").filter(Boolean)],
  });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__ready && typeof window.__advance === "function", null, { timeout: 30000 });
  await page.evaluate(() => window.__ready);

  let n = 0, done = false;
  const t0 = Date.now();
  while (!done && n < maxFrames) {
    await page.evaluate((k) => window.__advance(k), TPF);
    n++;
    await page.screenshot({ path: join(tmp, String(n).padStart(5, "0") + ".png") });
    done = await page.evaluate(() => window.__done === true);
  }
  console.log(`captured ${n} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s (${done ? "timeline done" : "stopped at --max-frames " + maxFrames})`);
  if (errors.length) console.log("page errors:\n  " + errors.slice(0, 5).join("\n  "));
  await browser.close(); browser = null;

  await mkdir(dirname(resolve(out)), { recursive: true });
  const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "30", "-i", join(tmp, "%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-movflags", "+faststart", resolve(out)], { stdio: "inherit" });
  if (ff.status !== 0) throw new Error("ffmpeg failed (status " + ff.status + ")");
  const still = resolve(out).replace(/\.mp4$/i, "") + ".png";
  await copyFile(join(tmp, String(Math.ceil(n / 2)).padStart(5, "0") + ".png"), still);
  const size = (await stat(resolve(out))).size;
  console.log(`wrote ${out} (${(size / 1024).toFixed(0)} KB, ${n} frames, ${(n / 30).toFixed(1)} s) and ${basename(still)} (frame ${Math.ceil(n / 2)})`);
  if (!done) process.exitCode = 3;
} catch (e) {
  console.error(String((e && e.stack) || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  await cleanup();
}
