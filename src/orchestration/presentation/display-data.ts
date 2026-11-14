export const DISPLAY_MARKERS = {
  elided: "[elided]",
  malformed: "[unrenderable]",
  accessor: "[accessor property]",
  callable: "[callable value]",
  circular: "[circular reference]",
  repeated: "[repeated reference]",
  ambiguous: "[ambiguous object keys]",
} as const;

const DEPTH = 24;
const WORK = 20_000;

/** Read only an own data descriptor; never execute a recorded getter. A trap
 * failure is local to this property, not evidence that siblings are invalid. */
export function ownDisplayValue(source: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor === undefined
      ? undefined
      : "value" in descriptor
        ? (descriptor.value as unknown)
        : DISPLAY_MARKERS.accessor;
  } catch {
    return DISPLAY_MARKERS.malformed;
  }
}

/** Detached JSON-like display data, not a serialization/execution boundary.
 * Strings and keys are literal unless a display text transform is supplied.
 * No getters, toJSON hooks or structuredClone of unknown records are used.
 * Non-JSON aliases deliberately become repeated markers, ancestor cycles stay
 * circular, and ordinary JSON trees share no mutable objects with the source.
 *
 * Work counts value visits AND property checks, before descriptor/enumerability
 * filtering (including hidden properties and array length/holes). Strings have
 * no character budget. Exhaustion is checked before entering/enumerating another
 * object. One getOwnPropertyNames enumeration itself is NOT a hard CPU/RSS bound,
 * and arbitrary Proxy traps or supplied transforms are not effect-free code. */
export function copyDisplayData(
  value: unknown,
  options?: { text?: (text: string) => string },
): unknown {
  const transform = options === undefined ? undefined : ownDisplayValue(options, "text");
  if (transform !== undefined && typeof transform !== "function") return DISPLAY_MARKERS.malformed;
  const text = (input: string): string => {
    if (transform === undefined) return input;
    const output = (transform as (text: string) => unknown)(input);
    if (typeof output !== "string") throw new TypeError("Invalid display text");
    return output;
  };
  let remaining = WORK;
  const spend = (): boolean => remaining-- > 0;
  const seen = new Set<object>();
  const ancestors = new Set<object>();

  const copy = (input: unknown): unknown => {
    if (!spend()) return DISPLAY_MARKERS.elided;
    if (typeof input === "string") {
      try {
        return text(input);
      } catch {
        return DISPLAY_MARKERS.malformed;
      }
    }
    if (typeof input === "function") return DISPLAY_MARKERS.callable;
    if (input === null || typeof input !== "object") return input;
    if (ancestors.has(input)) return DISPLAY_MARKERS.circular;
    if (seen.has(input)) return DISPLAY_MARKERS.repeated;
    if (remaining <= 0 || ancestors.size >= DEPTH) return DISPLAY_MARKERS.elided;
    seen.add(input);
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (!spend()) return DISPLAY_MARKERS.elided;
        const length = ownDisplayValue(input, "length");
        if (
          typeof length !== "number" ||
          !Number.isInteger(length) ||
          length < 0 ||
          length > 0xffff_ffff
        )
          return DISPLAY_MARKERS.malformed;
        const out: unknown[] = [];
        for (let index = 0; index < length; index++) {
          if (!spend()) {
            out.push(DISPLAY_MARKERS.elided);
            break;
          }
          try {
            const descriptor = Object.getOwnPropertyDescriptor(input, index);
            if (descriptor === undefined) out.length++;
            else
              out.push("value" in descriptor ? copy(descriptor.value) : DISPLAY_MARKERS.accessor);
          } catch {
            out.push(DISPLAY_MARKERS.malformed);
          }
        }
        return out;
      }

      const out: Record<string, unknown> = {};
      const keys = new Set<string>();
      for (const key of Object.getOwnPropertyNames(input)) {
        const admitted = spend();
        let descriptor: PropertyDescriptor | undefined;
        let descriptorFailed = false;
        if (admitted) {
          try {
            descriptor = Object.getOwnPropertyDescriptor(input, key);
            if (descriptor === undefined || !descriptor.enumerable) continue;
          } catch {
            // Preserve healthy siblings when only this descriptor trap fails.
            descriptorFailed = true;
          }
        }
        // The exhaustion marker uses the next original key too. Check it for
        // transformed-key collisions rather than overwriting earlier evidence.
        const projectedKey = text(key);
        if (keys.has(projectedKey)) return DISPLAY_MARKERS.ambiguous;
        keys.add(projectedKey);
        Object.defineProperty(out, projectedKey, {
          value: !admitted
            ? DISPLAY_MARKERS.elided
            : descriptorFailed
              ? DISPLAY_MARKERS.malformed
              : descriptor && "value" in descriptor
                ? copy(descriptor.value)
                : DISPLAY_MARKERS.accessor,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (!admitted) break;
      }
      return out;
    } catch {
      // Enumeration/array identification/key-transform failure affects this
      // object only; the caller can still project its other sibling values.
      return DISPLAY_MARKERS.malformed;
    } finally {
      ancestors.delete(input);
    }
  };
  return copy(value);
}
