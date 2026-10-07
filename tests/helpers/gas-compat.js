import vm from 'node:vm';
// Use the Acorn parser shipped in the installed Node binary; no downloads or
// project dependencies. Some Node distributions omit it; callers must report
// the parser check as skipped while still executing restricted-runtime tests.
export function gasParser(source = process.binding('natives')['internal/deps/acorn/acorn/dist/acorn']) {
  if (!source) return null;
  const exports = {};
  vm.runInNewContext(source, {exports, module: {exports}});
  return exports;
}
export function restrictGasContext(context) {
  vm.runInContext(`
    for (const key of ['TextEncoder','TextDecoder','structuredClone','crypto','SubtleCrypto','Buffer','process','require','fetch','URL','URLSearchParams','FormData','File','Blob','DOMException','atob','btoa','window','navigator','performance','setTimeout','setInterval','clearTimeout','clearInterval','ReadableStream','WritableStream']) {
      Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false});
    }
    delete Object.hasOwn;
    delete Array.prototype.at;
    delete String.prototype.at;
  `, context);
  return context;
}
