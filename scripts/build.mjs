// Builds the site into dist/: all the code bundled by esbuild into ONE module (b/<build>/src/client/main.js), served under b/<build>/ so a
// phone never runs a cached older module after a deploy. It replaced one module per source file (402 modules, 3.1 MB, which a phone
// resolved import level by import level: 30-60 s to a playable fight on Dom's phone, 2026-10-26). three.js (package.json, pinned
// to 0.186.0, the version V1 ships) and its addons are bundled by us too, tree-shaken, into one content-hashed vendor module beside it
// (b/vendor/, see "as ONE vendor module" below): they used to come from 18 jsdelivr files through an import map in index.html
// (0.47 MB and a second origin to connect to on a phone's first visit). Data JSON a module imports statically is bundled into it. Code that loads on demand (specials, finishers,
// the gfx lift) rides the same file, still run only when first asked for (esbuild's lazy module wrappers); only the big clip JSON loaded
// by a dynamic import (special-*.json, the finishers' killer/victim clips, ~1.5 MB) stays a separate .json.js module, fetched when used.
// Binary assets (GLB, audio, textures, fonts) are served under content-hashed names outside b/ (see "Content-hashed art" below), so a
// deploy that does not touch them costs a repeat visitor nothing and one that does is a new URL (the nginx site caches hashed names for
// good and revalidates plain paths; its copy is /srv/frankendom-v3/conf/nginx-v3-tls.conf on the VPS).
// Every text and GLB file also gets a .gz twin (gzip -9) that nginx's gzip_static serves as it is: the GLBs halve (raw float geometry).
//   node scripts/build.mjs            -> dist/, build id "dev"
//   BUILD=<sha> node scripts/build.mjs -> dist/, build id <sha> (CI deploy)
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { optimizeGlb } from './optimize-glb.mjs';
import { keepBladeTables } from './blade-tables.mjs';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const out = join(root, 'dist');
const id = process.env.BUILD || 'dev';
const code = join(out, 'b', id);
const ENTRY = 'src/client/main.ts';
const ENTRY_DIR = join(code, 'src/client');   // where main.js lands: lazy JSON specifiers are relative to it
const ENTRY_CSS = ['src/style.css'];   // V1's stylesheet, linked from index.html
const CODE = /\.(ts|js|mjs)$/;
const GZ = /\.(js|css|json|glb|svg|txt|html)$/;   // precompressed for gzip_static; images and audio are compressed already
const BLADE_PATHS = join(root, 'src/fight/blade-paths.ts');

const rel = (p) => relative(root, p).split('\\').join('/');
// new URL('<relative>', import.meta.url): made root-absolute so it resolves to the stable copy, not one under b/<build>/ (the bundle's
// own URL is no longer the source file's). A fixed asset is copied; a template's folder (up to its first ${) is copied whole.
const ASSET_URL = /new URL\(\s*(['"`])(\.{1,2}\/[^'"`]*)\1\s*,\s*import\.meta\.url\s*\)/g;
// The path then goes through artUrl (src/art-url.ts), which names the content-hashed copy (see "Content-hashed art" below).
const ART_URL = join(root, 'src/art-url.ts');
const assets = new Set(), lazyJson = new Set();
function rewrite(file, src) {
  let hits = 0;
  const out = src.replace(ASSET_URL, (_, q, spec) => {
    const cut = spec.indexOf('${'), target = resolve(dirname(file), cut < 0 ? spec : spec.slice(0, spec.lastIndexOf('/', cut) + 1));
    if (existsSync(target)) assets.add(target);
    hits++;
    return `new URL(__v3artUrl(${q}/${rel(resolve(dirname(file), spec.replace(/\$\{/g, '\u0000'))).replace(/\u0000/g, '${')}${q}), import.meta.url)`;
  });
  return hits ? `import { artUrl as __v3artUrl } from ${JSON.stringify(ART_URL)};\n${out}` : out;
}
// import('<relative>.json'): left as a dynamic import of a .json.js module written beside the code (b/<build>/<source path>.json.js)
const lazyModule = (file) => join(code, rel(file) + '.js');

// three.js (and the addons we import) as ONE vendor module named by its content, b/vendor/three.<sha256 8 hex>.js: nginx caches all
// of b/ for good, and the name only changes when three's version or the set of three names our code uses changes, so a code-only deploy
// costs a returning player nothing for it. It holds only what main.js uses (tree-shaken), found in three steps:
//   1. bundle main.ts unminified with three left external, and read off every name it takes from each three specifier;
//   2. bundle a vendor entry that re-exports exactly those names (minified, as main.js is), hash it, write it;
//   3. bundle main.ts for real, with every three specifier pointing at the vendor file.
const THREE = /^three(\/|$)/;
// The physics chunk (src/fight/physics-chunk.ts: @frankendom/physics with Jolt's WASM embedded, ~3 MB raw) is its own content-hashed module,
// b/vendor/physics.<sha256 8 hex>.js, imported by src/fight/ragdoll.ts only after the first frame (data/physics.json), so a first visit never
// waits on it and a code-only deploy costs a returning player nothing for it. Jolt's glue reaches node:module / fs / path only on its Node branch.
const PHYSICS_CHUNK = join(root, 'src/fight/physics-chunk.ts');
let physicsSpec = './physics-chunk.js';   // the probe bundle's stand-in; the real name is set once the chunk is written
const bundleMain = (minify, threeTo) => build({
  entryPoints: [join(root, ENTRY)], outdir: ENTRY_DIR, entryNames: '[name]', write: minify,
  bundle: true, splitting: false, format: 'esm', target: 'es2022', minify, keepNames: true, legalComments: 'none', metafile: true,
  logLevel: 'warning', charset: 'utf8',
  plugins: [{ name: 'v3', setup(b) {
    b.onResolve({ filter: THREE }, (args) => ({ path: threeTo(args.path), external: true }));
    b.onResolve({ filter: /physics-chunk\.ts$/ }, (args) => (args.kind === 'dynamic-import' && resolve(args.resolveDir, args.path) === PHYSICS_CHUNK ? { path: physicsSpec, external: true } : undefined));
    b.onResolve({ filter: /\.json$/ }, (args) => {
      if (args.kind !== 'dynamic-import') return undefined;
      const file = resolve(args.resolveDir, args.path); lazyJson.add(file);
      const spec = relative(ENTRY_DIR, lazyModule(file)).split('\\').join('/');
      return { path: spec.startsWith('.') ? spec : './' + spec, external: true };
    });
    b.onLoad({ filter: CODE }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      // V1's blade table cut to the sweeps the duel reads (data/fight.json bladeTables, scripts/blade-tables.mjs)
      if (args.path === BLADE_PATHS) src = keepBladeTables(src, JSON.parse(readFileSync(join(root, 'data/fight.json'), 'utf8')).bladeTables);
      return { contents: rewrite(args.path, src), loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
    });
  } }],
});

rmSync(out, { recursive: true, force: true });
const probe = (await bundleMain(false, (p) => p)).outputFiles.find((f) => f.path.endsWith('.js')).text;
const used = new Map();   // three specifier -> names main.js takes from it
const take = (spec, name) => { if (!used.has(spec)) used.set(spec, new Set()); used.get(spec).add(name); };
let threeImports = 0;
for (const m of probe.matchAll(/^import\s+(\*\s+as\s+[\w$]+|\{[^}]*\})\s+from\s+"(three(?:\/[^"]*)?)";$/gm)) {
  threeImports++;
  const [, what, spec] = m, ns = /^\*\s+as\s+([\w$]+)$/.exec(what);
  if (ns) for (const [, name] of probe.matchAll(new RegExp(`(?<![\\w$.])${ns[1].replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) take(spec, name);
  else for (const part of what.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)) take(spec, part.split(/\s+as\s+/)[0]);
}
if (threeImports !== (probe.match(/from\s+"three(?:\/[^"]*)?"/g) || []).length) throw new Error('a three import was not read');
const vendorSrc = [...used].map(([spec, names]) => `export { ${[...names].sort().join(', ')} } from ${JSON.stringify(spec)};`).join('\n');
const vendor = (await build({ stdin: { contents: vendorSrc, resolveDir: root, loader: 'js' }, write: false, bundle: true, format: 'esm',
  target: 'es2022', minify: true, keepNames: true, legalComments: 'none', logLevel: 'warning', charset: 'utf8' })).outputFiles[0].contents;
const vendorFile = join(out, 'b/vendor', `three.${createHash('sha256').update(vendor).digest('hex').slice(0, 8)}.js`);
mkdirSync(dirname(vendorFile), { recursive: true });
writeFileSync(vendorFile, vendor);
const vendorSpec = relative(ENTRY_DIR, vendorFile).split('\\').join('/');
const physicsChunk = (await build({ entryPoints: [PHYSICS_CHUNK], write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'none', logLevel: 'warning', charset: 'utf8', external: ['node:module'],
  plugins: [{ name: 'node-stubs', setup(b) {
    b.onResolve({ filter: /^(node:)?(fs|path|url)$/ }, () => ({ path: 'stub', namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  } }] })).outputFiles[0].contents;
const physicsFile = join(out, 'b/vendor', `physics.${createHash('sha256').update(physicsChunk).digest('hex').slice(0, 8)}.js`);
writeFileSync(physicsFile, physicsChunk);
physicsSpec = relative(ENTRY_DIR, physicsFile).split('\\').join('/');
const result = await bundleMain(true, () => vendorSpec);
// 106 only (Dom 2026-10-26; data/build.json notShipped): no 65 body, kit or 65-keyed clip JSON may be referenced by the bundle. A reference is a
// loader that could fetch a 65 file in production, so the build fails rather than ship it (or a 404 in its place).
const NOT_SHIPPED = JSON.parse(readFileSync(join(root, 'data/build.json'), 'utf8')).notShipped.map((p) => join(root, p));
const named = [...assets, ...lazyJson].filter((f) => NOT_SHIPPED.some((n) => n === f || n.startsWith(f.endsWith('/') ? f : f + '/')));
if (named.length) throw new Error(`data/build.json notShipped: the bundle references ${named.map(rel).join(', ')} (106 only: no 65 loader in production)`);
// The body measure rows the ragdoll fetches (data/physics.json `measure`: physics/bodies/<body>.measure.json), from the package as pinned.
cpSync(join(root, 'node_modules/@frankendom/physics/data/bodies'), join(out, 'physics/bodies'), { recursive: true });
for (const f of lazyJson) {
  mkdirSync(dirname(lazyModule(f)), { recursive: true });
  writeFileSync(lazyModule(f), `export default ${JSON.stringify(JSON.parse(readFileSync(f, 'utf8')))};\n`);
}
for (const a of assets) cpSync(a, join(out, rel(a)), { recursive: true });
cpSync(join(root, 'data'), join(out, 'data'), { recursive: true });
if (existsSync(join(root, 'public'))) cpSync(join(root, 'public'), out, { recursive: true });   // root-absolute files V1 names by URL (/weapons/shapes/, /game/fonts/)
const html = readFileSync(join(root, 'index.html'), 'utf8').replaceAll('./src/', `./b/${id}/src/`);
const entryTag = `<script type="module" src="./b/${id}/src/client/main.js"></script>`;
if (!html.includes(entryTag)) throw new Error('index.html: entry script not found');
// the vendor module is fetched beside main.js, not after it (the browser would only find it once main.js had arrived)
writeFileSync(join(out, 'index.html'), html.replace(entryTag, `<link rel="modulepreload" href="./${rel(vendorFile).replace('dist/', '')}">\n  ${entryTag}`));
writeFileSync(join(out, 'build.txt'), id);
for (const n of NOT_SHIPPED) if (existsSync(join(out, rel(n)))) throw new Error(`data/build.json notShipped: ${rel(n)} was copied into dist/ (106 only)`);

// V1's production GLB packing (scripts/optimize-glb.mjs, copied from V1 as it is): meshopt-coded buffers, int8 normals and uint8 skin
// weights, unused images dropped, JPEGs recoded losslessly by jpegtran. Only the dist copy is packed: the sources stay plain for Blender and
// the bakes. ?load=v1 does not unpack them: the loaders have had the meshopt decoder since V1.
// The 65 bodies and kits (psyche.glb, warrior.glb, minotaur.glb, veteran.glb, carriers-*.glb) are no longer shipped (106 only, data/build.json notShipped).
// The Minotaur's drawn Cleaver (data/fight.json foeWeapon): its equip file and V1's plain rank shape (public/, served at /weapons/shapes/).
const PACKED = ['src/assets/weapons/foe/cleaver.glb', 'weapons/shapes/cleaver-plain.glb'];
// The 106-joint bodies (src/assets/*-106.glb, src/fight/rig-bones.ts) are not in the list: OpenTrident ships them meshopt-packed and quantized already.
for (const glb of PACKED) {
  const target = join(out, glb);
  if (existsSync(target)) writeFileSync(target, await optimizeGlb(readFileSync(target)));
}
// The Minotaur cut GLB (physics tool output, float32 + meshopt filter NONE, 2.37 MB in git, kept so: Blender and the cut validator read it plain)
// ships through the lossy cut path (scripts/cut-glb-pack.mjs): positions within 0.1 mm, rotations within 0.006 degrees, 1.2 MB. Only this file.
const CUT_GLBS = ['src/assets/minotaur-106.glb'];
for (const glb of CUT_GLBS) {
  const target = join(out, glb);
  if (existsSync(target)) writeFileSync(target, await optimizeGlb(readFileSync(target), undefined, { cut: true }));
}

// Content-hashed art (2026-10-26: a phone kept the pre-#19 warrior.glb, the old hero clips, for a day, because art sat at fixed paths
// cached a day). Every art file outside b/ (after packing, so the hash is of the bytes served) gets a copy named <name>.<sha256 8 hex>.<ext>
// beside it; the bundle's artUrl map (src/art-url.ts) and the stylesheet's url()s name the copies. nginx caches those names for good and
// revalidates the plain paths (kept for anything that names a file directly), so a changed file is a new URL and an unchanged one stays
// cached across deploys. The .gz twins below are made for the hashed names too.
const files = (p) => statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : [p];
const ART = /\.(glb|ogg|m4a|png|webp|jpg|woff2)$/;
const artMap = {};
for (const f of files(out).filter((f) => ART.test(f) && !relative(out, f).startsWith('b/'))) {
  const hashed = f.replace(/(\.[^./]+)$/, `.${createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 8)}$1`);
  cpSync(f, hashed);
  artMap['/' + relative(out, f).split('\\').join('/')] = '/' + relative(out, hashed).split('\\').join('/');
}
const mainJs = join(ENTRY_DIR, 'main.js'), PLACEHOLDER = /(["'`])__V3_ART_MANIFEST__\1/g, bundle = readFileSync(mainJs, 'utf8');
if ((bundle.match(PLACEHOLDER) || []).length !== 1) throw new Error('main.js: art manifest placeholder not found exactly once');
writeFileSync(mainJs, bundle.replace(PLACEHOLDER, () => JSON.stringify(JSON.stringify(artMap))));
for (const css of ENTRY_CSS) {   // stylesheets ride the build's folder, as the code does; their root-absolute url()s name the hashed copies
  writeFileSync(join(code, css), readFileSync(join(root, css), 'utf8').replace(/url\((['"]?)(\/[^)'"]+)\1\)/g, (m, q, p) => artMap[p] ? `url(${q}${artMap[p]}${q})` : m));
}

// .gz twins, only where they save something (gzip_static falls back to the plain file, gzipped on the fly or not at all)
let raw = 0, packed = 0;
for (const f of files(out).filter((f) => GZ.test(f))) {
  const body = readFileSync(f), gz = gzipSync(body, { level: 9 });
  if (gz.length < body.length * 0.9) { writeFileSync(f + '.gz', gz); raw += body.length; packed += gz.length; }
}

const main = join(ENTRY_DIR, 'main.js'), kb = (n) => (n / 1024).toFixed(0);
console.log(`dist/ build ${id}: ${Object.keys(result.metafile.inputs).length} sources -> main.js ${kb(statSync(main).size)} KB (gzip ${kb(statSync(main + '.gz').size)} KB) + ${rel(vendorFile).replace('dist/', '')} ${kb(statSync(vendorFile).size)} KB (gzip ${kb(statSync(vendorFile + '.gz').size)} KB) + lazy ${rel(physicsFile).replace('dist/', '')} ${kb(statSync(physicsFile).size)} KB (gzip ${kb(statSync(physicsFile + '.gz').size)} KB) + ${lazyJson.size} lazy JSON modules, assets ${assets.size}, art files hashed ${Object.keys(artMap).length}; .gz twins ${(raw / 1048576).toFixed(1)} MB -> ${(packed / 1048576).toFixed(1)} MB`);
