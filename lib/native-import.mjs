// Real ESM import(), outside any Jiti transform. Jiti rewrites import() in the
// modules it transpiles and drops URL query strings, so a query-keyed fresh
// module instance needs this file to be loaded natively: import it with a
// dynamic import() (Jiti hands ESM async imports to Node), never statically.
/**
 * @param {string} specifier
 * @returns {Promise<unknown>}
 */
export function nativeImport(specifier) {
  return import(specifier);
}
