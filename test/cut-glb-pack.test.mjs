// The shipped Minotaur cut GLB is the source (src/assets/minotaur-106.glb) through optimizeGlb(..., { cut: true }): decode both and hold the
// packed one to stated bounds. Positions within 0.1 mm, rotations within 0.006 degrees, everything structural identical.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { optimizeGlb } from '../scripts/optimize-glb.mjs';
import { BOUNDS, readAccessor, unpackMeshopt } from '../scripts/cut-glb-pack.mjs';

const source = readFileSync(new URL('../src/assets/minotaur-106.glb', import.meta.url));
const parse = async (raw) => { const n = raw.readUInt32LE(12); return unpackMeshopt(JSON.parse(raw.subarray(20, 20 + n)), raw.subarray(28 + n)); };
const packed = await optimizeGlb(source, undefined, { cut: true });
const A = await parse(source), B = await parse(packed);
const acc = (g, i) => readAccessor(g.d, g.bin, g.d.accessors[i]);
const raw = (g, i) => readAccessor(g.d, g.bin, g.d.accessors[i], false);
const prims = (g) => g.d.meshes.flatMap((m) => m.primitives.map((p) => ({ m: m.name, p })));

test('size: the shipped body is about half the source', () => {
  assert.ok(packed.length < 1_300_000, `raw ${packed.length}`);
  assert.ok(gzipSync(packed, { level: 9 }).length < 850_000, 'gzip');
  assert.ok(packed.length < source.length * 0.6);
});

test('structure: pieces, caps, skin joints, nodes and the 26 clips survive', () => {
  assert.deepEqual(B.d.meshes.map((m) => m.name), A.d.meshes.map((m) => m.name));
  assert.equal(B.d.meshes.length, 19);
  assert.ok(B.d.meshes.slice(0, 7).every((m) => m.name.startsWith('piece_')) && B.d.meshes.slice(7).every((m) => m.name.startsWith('cap_')));
  assert.deepEqual(B.d.nodes.map((n) => n.name), A.d.nodes.map((n) => n.name));
  assert.deepEqual(B.d.nodes.map((n) => [n.mesh, n.skin, n.children]), A.d.nodes.map((n) => [n.mesh, n.skin, n.children]));
  assert.deepEqual(B.d.skins[0].joints, A.d.skins[0].joints);
  assert.equal(B.d.skins[0].joints.length, 106);
  assert.deepEqual(acc(B, B.d.skins[0].inverseBindMatrices), acc(A, A.d.skins[0].inverseBindMatrices));
  assert.deepEqual(B.d.animations.map((a) => a.name), A.d.animations.map((a) => a.name));
  assert.equal(B.d.animations.length, 26);
  assert.deepEqual(B.d.materials, A.d.materials);
  assert.deepEqual(prims(B).map(({ p }) => [p.material, p.mode]), prims(A).map(({ p }) => [p.material, p.mode]));
  const need = ['EXT_meshopt_compression', 'KHR_mesh_quantization'];
  const n = packed.readUInt32LE(12), d = JSON.parse(packed.subarray(20, 20 + n));
  for (const x of need) assert.ok(d.extensionsRequired.includes(x), x);
});

test('geometry: positions within 0.1 mm, caps stay welded to their pieces, joints exact, weights sum to 1', () => {
  const pa = prims(A), pb = prims(B);
  let worst = 0;
  const bySource = new Map();   // source position -> decoded position (one function of the value)
  pa.forEach(({ m, p }, k) => {
    const q = pb[k].p, sa = acc(A, p.attributes.POSITION), sb = acc(B, q.attributes.POSITION);
    assert.equal(sa.length, sb.length, m);
    for (let i = 0; i < sa.length; i += 3) {
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(sa[i + c] - sb[i + c]));
      const key = `${sa[i]},${sa[i + 1]},${sa[i + 2]}`, val = `${sb[i]},${sb[i + 1]},${sb[i + 2]}`;
      if (bySource.has(key)) assert.equal(bySource.get(key), val, `${m}: a vertex equal in the source decodes differently (cap and piece would split)`);
      else bySource.set(key, val);
    }
    const ma = A.d.accessors[p.attributes.POSITION], mb = B.d.accessors[q.attributes.POSITION];   // the declared bounds hold the decoded data
    for (let c = 0; c < 3; c++) {
      assert.ok(mb.min[c] <= Math.min(...Array.from({ length: sb.length / 3 }, (_, i) => sb[i * 3 + c])) + 1e-7, `${m} min`);
      assert.ok(mb.max[c] >= Math.max(...Array.from({ length: sb.length / 3 }, (_, i) => sb[i * 3 + c])) - 1e-7, `${m} max`);
      assert.ok(Math.abs(mb.min[c] - ma.min[c]) < BOUNDS.positionMetres && Math.abs(mb.max[c] - ma.max[c]) < BOUNDS.positionMetres, `${m} bounds vs source`);
    }
    assert.deepEqual(Array.from(raw(B, q.attributes.JOINTS_0)), Array.from(raw(A, p.attributes.JOINTS_0)), `${m} joints`);
    const wa = acc(A, p.attributes.WEIGHTS_0), wb = raw(B, q.attributes.WEIGHTS_0);
    for (let i = 0; i < wa.length; i += 4) {
      assert.equal(wb[i] + wb[i + 1] + wb[i + 2] + wb[i + 3], 255, `${m} weights sum`);
      for (let c = 0; c < 4; c++) assert.ok(Math.abs(wb[i + c] / 255 - wa[i + c]) <= 1 / 255 + 1e-6, `${m} weight ${i + c}`);
    }
  });
  assert.ok(worst < BOUNDS.positionMetres, `max position error ${worst}`);
  assert.ok(worst > 0, 'the filter should have cut bits (else this test measures nothing)');
});

test('geometry: normals within 1.5 degrees, UVs within 1e-4, same triangles in the same winding', () => {
  const pa = prims(A), pb = prims(B);
  pa.forEach(({ m, p }, k) => {
    const q = pb[k].p, na = acc(A, p.attributes.NORMAL), nb = acc(B, q.attributes.NORMAL), ua = acc(A, p.attributes.TEXCOORD_0), ub = acc(B, q.attributes.TEXCOORD_0);
    for (let i = 0; i < na.length; i += 3) {
      const la = Math.hypot(na[i], na[i + 1], na[i + 2]), lb = Math.hypot(nb[i], nb[i + 1], nb[i + 2]);
      const dot = (na[i] * nb[i] + na[i + 1] * nb[i + 1] + na[i + 2] * nb[i + 2]) / (la * lb);
      assert.ok(Math.acos(Math.min(1, dot)) * 180 / Math.PI < 1.5, `${m} normal ${i / 3}`);
    }
    for (let i = 0; i < ua.length; i++) assert.ok(Math.abs(ua[i] - ub[i]) < 1e-4, `${m} uv ${i}`);
    const ia = raw(A, p.indices), ib = raw(B, q.indices), canon = (t, i) => { const v = [t[i], t[i + 1], t[i + 2]], r = v.indexOf(Math.min(...v)); return `${v[r]},${v[(r + 1) % 3]},${v[(r + 2) % 3]}`; };
    assert.equal(ia.length, ib.length, m);
    for (let i = 0; i < ia.length; i += 3) assert.equal(canon(ib, i), canon(ia, i), `${m} triangle ${i / 3}`);
  });
});

test('animation: times exact, translations within 0.1 mm, rotations within 0.006 degrees, same targets', () => {
  let rotation = 0, translation = 0;
  B.d.animations.forEach((an, k) => {
    const ao = A.d.animations[k];
    assert.deepEqual(an.channels, ao.channels, an.name);
    an.channels.forEach((ch) => {
      const sb = an.samplers[ch.sampler], sa = ao.samplers[ch.sampler];
      assert.equal(sb.interpolation ?? 'LINEAR', sa.interpolation ?? 'LINEAR');
      assert.deepEqual(Array.from(acc(B, sb.input)), Array.from(acc(A, sa.input)), `${an.name} times`);
      const o = acc(A, sa.output), p = acc(B, sb.output);
      assert.equal(o.length, p.length);
      if (ch.target.path === 'translation') { for (let i = 0; i < o.length; i++) translation = Math.max(translation, Math.abs(o[i] - p[i])); return; }
      for (let i = 0; i < o.length; i += 4) {
        const a = [0, 1, 2, 3].map((c) => o[i + c]), b = [0, 1, 2, 3].map((c) => p[i + c]), la = Math.hypot(...a), lb = Math.hypot(...b);
        const sign = a.reduce((n, x, c) => n + x * b[c], 0) < 0 ? -1 : 1;
        rotation = Math.max(rotation, 4 * Math.asin(Math.min(1, Math.hypot(...a.map((x, c) => x / la - sign * b[c] / lb)) / 2)));
      }
    });
  });
  assert.ok(rotation < BOUNDS.rotationRadians, `max rotation error ${rotation} rad`);
  assert.ok(translation < BOUNDS.positionMetres, `max translation error ${translation}`);
});

test('the strict path is untouched: a meshopt source is refused without the cut option', async () => {
  await assert.rejects(() => optimizeGlb(source), /one embedded buffer|uncompressed/);
});
