// Browser stand-in for node:fs / node:path / node:crypto-style imports that Jolt's wasm-compat build carries behind an `ENVIRONMENT_IS_NODE` check
// (it never runs in a browser). Every call throws, so a code path that really needs the host fails loudly instead of silently.
const no = (name) => () => { throw new Error(name + " is not available in the browser bench"); };
export const readFileSync = no("fs.readFileSync");
export const readFile = no("fs.readFile");
export const existsSync = () => false;
export const resolve = no("path.resolve");
export const normalize = (p) => p;
export const dirname = (p) => p;
export const join = (...a) => a.join("/");
export const createRequire = () => no("module.createRequire");
export const fileURLToPath = (u) => u;
export default { readFileSync, readFile, existsSync, resolve, normalize, dirname, join };
