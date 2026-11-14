/**
 * Final display filter for one styled pane row.
 *
 * Tool renderers receive raw result text, so a recorded payload can still
 * carry terminal protocols (the native edit path bypassed the generic
 * fallback's ANSI strip and exposed OSC 52 in pane rows). This is the last display-stage
 * gate: theme SGR and OSC 8 hyperlinks survive, every other complete or
 * unterminated terminal protocol does not; remaining control bytes become
 * visible escapes. It is a display filter, not a secrecy redaction for payloads
 * the SDK already split across rows, and it never rewrites the recorded data
 * it filters. Allowed SGR can still conceal glyphs; OSC 8 parameters/URIs may
 * retain Unicode bidi characters. This does not validate link destinations or
 * guarantee visible text. Tabs outside preserved protocols stay visible `\x09`.
 *
 * Rules, in one left-to-right scan that recognizes each whole protocol
 * before deciding what survives inside it — a payload that merely looks
 * like a safe sequence never escapes a dropped protocol body:
 *
 * - Complete normal SGR (`ESC [` + numeric `;`/`:` bytes + `m`, including
 *   reset and truecolor) stays verbatim, as do complete OSC 8 hyperlinks
 *   (`8;params;URI`, BEL or `ESC \` terminated, no control byte in params or
 *   URI). C1 spellings of the same display commands are canonicalized to the
 *   ESC spelling (C1 CSI SGR -> `ESC [ ... m`, C1 OSC 8 -> `ESC ] ... ST`).
 * - Every other complete or unterminated OSC/APC/DCS/SOS/PM sequence and its
 *   payload is removed (`ESC ] _ P X ^` and C1 0x9d/0x9f/0x90/0x98/0x9e; ST
 *   is `ESC \` or C1 0x9c, BEL ends OSC only, and an unterminated protocol
 *   dies with the rest of the row). Non-SGR CSI (both spellings) and other
 *   complete escape sequences are removed without leaking partial
 *   parameters.
 * - A lone ESC that completes nothing stays visible as `\x1b`, like every
 *   remaining C0/C1/DEL byte (`\xNN`) and bidi control (`\uXXXX`); all other
 *   text — including surrogate pairs, joiners, variation selectors and
 *   combining marks — stays verbatim.
 *
 * Pure string in / string out, no IO or state, O(n) with output bounded at
 * 6x the input (the widest escape).
 */

const BEL = 0x07;
const ESC = 0x1b;
const BACKSLASH = 0x5c;
const CSI_C1 = 0x9b;
const OSC_C1 = 0x9d;
const DCS_C1 = 0x90;
const SOS_C1 = 0x98;
const PM_C1 = 0x9e;
const APC_C1 = 0x9f;
const ST_C1 = 0x9c;

/** C0, DEL and C1 control codes; all single UTF-16 units. */
const isControlCode = (code: number): boolean => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/** The complete Unicode Bidi_Control set; all single UTF-16 units. */
const isBidiControl = (code: number): boolean =>
  code === 0x061c ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/** plainText's explicit control spelling: visible and inert, never a byte the
 * terminal would execute. */
const controlEscape = (code: number): string => `\\x${code.toString(16).padStart(2, "0")}`;

const bidiEscape = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/** Normal SGR parameter bytes only: digits and the `;`/`:` separators. */
const isSgrParams = (params: string): boolean => {
  for (let index = 0; index < params.length; index++) {
    const code = params.charCodeAt(index);
    if ((code < 0x30 || code > 0x39) && code !== 0x3b && code !== 0x3a) return false;
  }
  return true;
};

interface CsiScan {
  /** Where the row scan resumes: just past the final byte when the sequence
   * completed, at the offending byte (or the row end) when it never does. */
  readonly resume: number;
  /** Final-byte index when the sequence completed, else -1. */
  readonly finalIndex: number;
}

/** Scan a CSI body: parameter/intermediate bytes 0x20..0x3f, then a final
 * 0x40..0x7e. An unterminated body drops without leaking its partial
 * parameters; a malformed one resumes at the offending byte. */
function scanCsi(text: string, bodyStart: number): CsiScan {
  for (let index = bodyStart; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return { resume: index + 1, finalIndex: index };
    if (code < 0x20 || code > 0x3f) return { resume: index, finalIndex: -1 };
  }
  return { resume: text.length, finalIndex: -1 };
}

/** Index of the byte terminating a string protocol payload, or -1 when the
 * row ends first. BEL ends OSC only; inside APC/DCS/SOS/PM it is payload. */
function stringProtocolEnd(text: string, payloadStart: number, osc: boolean): number {
  for (let index = payloadStart; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ST_C1 || (code === ESC && text.charCodeAt(index + 1) === BACKSLASH)) return index;
    if (osc && code === BEL) return index;
  }
  return -1;
}

interface Osc8Link {
  readonly params: string;
  readonly uri: string;
}

/** `8;params;URI` with no control byte in params or URI; unknown, malformed
 * or control-carrying OSC 8 bodies are dropped whole. */
function osc8Link(payload: string): Osc8Link | null {
  if (!payload.startsWith("8;")) return null;
  const rest = payload.slice(2);
  const separator = rest.indexOf(";");
  if (separator < 0) return null;
  const params = rest.slice(0, separator);
  const uri = rest.slice(separator + 1);
  return hasControlByte(params) || hasControlByte(uri) ? null : { params, uri };
}

function hasControlByte(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (isControlCode(value.charCodeAt(index))) return true;
  }
  return false;
}

/** Handle one string protocol. Returns the resume index and the emitted text
 * (null when the protocol is dropped). Existing ESC-spelled OSC 8 links with
 * a BEL or `ESC \` terminator stay verbatim; C1 intros or a C1 ST terminator
 * are canonicalized to the `ESC ] ... ESC \` spelling. */
function consumeStringProtocol(
  text: string,
  start: number,
  payloadStart: number,
  osc: boolean,
  c1Intro: boolean,
): readonly [number, string | null] {
  const end = stringProtocolEnd(text, payloadStart, osc);
  if (end < 0) return [text.length, null]; // unterminated: the rest of the row goes too
  const terminator = text.charCodeAt(end);
  const resume = terminator === ESC ? end + 2 : end + 1;
  if (!osc) return [resume, null];
  const link = osc8Link(text.slice(payloadStart, end));
  if (!link) return [resume, null];
  if (!c1Intro && (terminator === BEL || terminator === ESC))
    return [resume, text.slice(start, resume)];
  return [resume, `\x1b]8;${link.params};${link.uri}\x1b\\`];
}

/** Handle one ESC-led introducer. Returns the resume index and the emitted
 * text (null when the sequence is dropped). */
function consumeEscape(text: string, start: number): readonly [number, string | null] {
  const next = start + 1 < text.length ? text.charCodeAt(start + 1) : -1;
  if (next === 0x5b) {
    const scan = scanCsi(text, start + 2);
    const sgr =
      scan.finalIndex >= 0 &&
      text.charCodeAt(scan.finalIndex) === 0x6d &&
      isSgrParams(text.slice(start + 2, scan.finalIndex));
    return [scan.resume, sgr ? text.slice(start, scan.resume) : null];
  }
  if (next === 0x5d || next === 0x5f || next === 0x50 || next === 0x58 || next === 0x5e)
    return consumeStringProtocol(text, start, start + 2, next === 0x5d, false);
  if (next >= 0x20 && next <= 0x2f) {
    // Intermediate bytes (charset designations and friends): complete
    // sequences drop; one that never completes leaves a visible lone ESC.
    for (let index = start + 1; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code >= 0x30 && code <= 0x7e) return [index + 1, null];
      if (code < 0x20 || code > 0x2f) break;
    }
    return [start + 1, "\\x1b"];
  }
  if (next >= 0x30 && next <= 0x7e) return [start + 2, null]; // complete escape
  return [start + 1, "\\x1b"]; // unrecognized lone ESC stays visible
}

export function safeStyledRow(text: string): string {
  const length = text.length;
  let out = "";
  let from = 0;
  let index = 0;
  while (index < length) {
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code <= 0x7e) {
      index++; // printable ASCII stays verbatim
      continue;
    }
    if (code >= 0xa0) {
      if (isBidiControl(code)) {
        out += text.slice(from, index) + bidiEscape(code);
        index++;
        from = index;
      } else {
        index++; // ordinary text (CJK, emoji, joiners, ...) stays verbatim
      }
      continue;
    }
    // A byte that needs a decision: flush the ordinary run in front of it.
    out += text.slice(from, index);
    if (code === ESC) {
      const [resume, emitted] = consumeEscape(text, index);
      if (emitted !== null) out += emitted;
      index = resume;
    } else if (code === CSI_C1) {
      // C1 CSI: only normal SGR survives, canonicalized to the ESC spelling.
      const scan = scanCsi(text, index + 1);
      if (
        scan.finalIndex >= 0 &&
        text.charCodeAt(scan.finalIndex) === 0x6d &&
        isSgrParams(text.slice(index + 1, scan.finalIndex))
      )
        out += `\x1b[${text.slice(index + 1, scan.finalIndex)}m`;
      index = scan.resume;
    } else if (
      code === OSC_C1 ||
      code === DCS_C1 ||
      code === SOS_C1 ||
      code === PM_C1 ||
      code === APC_C1
    ) {
      const [resume, emitted] = consumeStringProtocol(
        text,
        index,
        index + 1,
        code === OSC_C1,
        true,
      );
      if (emitted !== null) out += emitted;
      index = resume;
    } else {
      // Remaining C0 (minus ESC), DEL and leftover C1 stay visible, inert.
      out += controlEscape(code);
      index++;
    }
    from = index;
  }
  return out + text.slice(from);
}
