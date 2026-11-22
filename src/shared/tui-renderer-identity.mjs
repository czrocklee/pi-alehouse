/** Pi 1.6.0's stable TUI reference forwards Object.valueOf() with the live
 * renderer as `this`. Private hooks must modify that renderer, not the proxy's
 * unused target. Raw and structural hosts need no proxy support.
 * @param {object} [host] @returns {object | undefined}
 */
export function resolveTuiRenderer(host) {
  if (typeof host !== "object" || host === null) return undefined;
  try {
    const valueOf = Reflect.get(host, "valueOf");
    const renderer = typeof valueOf === "function" ? Reflect.apply(valueOf, host, []) : undefined;
    return typeof renderer === "object" && renderer !== null ? renderer : host;
  } catch {
    return undefined; // Optional native integration: an unavailable reference is inert.
  }
}
