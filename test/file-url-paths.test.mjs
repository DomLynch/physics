import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// URL.pathname is "/C:/..." on Windows, so a filesystem path built from it becomes "C:\C:\...". Use fileURLToPath.
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("no tool, script or test turns a file URL into a filesystem path with .pathname", () => {
  const offenders = [];
  for (const dir of ["tools", "scripts", "test", "src"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      if (name === "file-url-paths.test.mjs") continue;
      readFileSync(join(ROOT, dir, name), "utf8").split("\n").forEach((line, i) => {
        if (/(import\.meta\.url|\bROOT)\)?\.pathname/.test(line)) offenders.push(`${dir}/${name}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

test("tools/nightly.mjs main guard compares resolved paths, not file:// strings (those differ on Windows)", () => {
  const src = readFileSync(join(ROOT, "tools", "nightly.mjs"), "utf8");
  assert.doesNotMatch(src, /import\.meta\.url\s*===\s*`file:\/\//);
  assert.match(src, /resolve\(process\.argv\[1\]\)\s*===\s*fileURLToPath\(import\.meta\.url\)/);
});
