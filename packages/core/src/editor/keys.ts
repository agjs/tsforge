import { graphemes } from "./segments";

export interface IKeyEvent {
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  text: string;
}

const LEGACY_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CODEPOINT_NAMES: Record<number, string> = {
  9: "tab",
  13: "return",
  27: "escape",
};

const ESC = "\x1b";
const CSI_U_PATTERN = /^(\d+)(?::\d+)*;(\d+)(?::\d+)*u/u;
const XTERM_PATTERN = /^27;(\d+);(\d+)~/u;
const LEGACY_PATTERN = /^([ABCDHF])/u;
const DELETE_SEQ = "\x1b[3~";
const ALT_CR = "\x1b\r";
const ALT_LF = "\x1b\n";

interface IModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

function decodeModifier(modBits: number): IModifiers {
  const bitValue = modBits - 1;

  return {
    shift: (bitValue & 1) !== 0,
    alt: (bitValue & 2) !== 0,
    ctrl: (bitValue & 4) !== 0,
  };
}

const DEFAULT_MODS: IModifiers = {
  shift: false,
  alt: false,
  ctrl: false,
};

function createKeyEvent(
  name: string,
  text = "",
  mods: IModifiers = DEFAULT_MODS
): IKeyEvent {
  return {
    name,
    text,
    shift: mods.shift,
    alt: mods.alt,
    ctrl: mods.ctrl,
  };
}

function tryParseCsiU(
  chunk: string,
  idx: number
): { event: IKeyEvent; len: number } | null {
  if (!chunk.slice(idx).startsWith(ESC + "[")) {
    return null;
  }

  const regexResult = CSI_U_PATTERN.exec(chunk.slice(idx + 2));

  if (!regexResult) {
    return null;
  }

  const cpStr = regexResult[1];
  const modStr = regexResult[2];

  if (cpStr === undefined || modStr === undefined) {
    return null;
  }

  const codepoint = Number.parseInt(cpStr, 10);
  const modBits = Number.parseInt(modStr, 10);
  const mods = decodeModifier(modBits);
  const name = CODEPOINT_NAMES[codepoint] ?? "char";
  const text = name === "char" ? String.fromCharCode(codepoint) : "";

  return {
    event: createKeyEvent(name, text, mods),
    len: 2 + regexResult[0].length,
  };
}

function tryParseXterm(
  chunk: string,
  idx: number
): { event: IKeyEvent; len: number } | null {
  if (!chunk.slice(idx).startsWith(ESC + "[")) {
    return null;
  }

  const regexResult = XTERM_PATTERN.exec(chunk.slice(idx + 2));

  if (!regexResult) {
    return null;
  }

  const modStr = regexResult[1];
  const cpStr = regexResult[2];

  if (modStr === undefined || cpStr === undefined) {
    return null;
  }

  const modBits = Number.parseInt(modStr, 10);
  const codepoint = Number.parseInt(cpStr, 10);
  const mods = decodeModifier(modBits);
  const name = CODEPOINT_NAMES[codepoint] ?? "char";
  const text = name === "char" ? String.fromCharCode(codepoint) : "";

  return {
    event: createKeyEvent(name, text, mods),
    len: 2 + regexResult[0].length,
  };
}

function tryParseLegacy(
  chunk: string,
  idx: number
): { event: IKeyEvent; len: number } | null {
  if (!chunk.slice(idx).startsWith(ESC + "[")) {
    return null;
  }

  const regexResult = LEGACY_PATTERN.exec(chunk.slice(idx + 2));

  if (!regexResult) {
    return null;
  }

  const key = regexResult[1];

  if (key === undefined) {
    return null;
  }

  const keyName = LEGACY_KEYS[key] ?? "unknown";

  return { event: createKeyEvent(keyName), len: 2 + regexResult[0].length };
}

function tryParsePrintable(
  chunk: string,
  idx: number
): { event: IKeyEvent; len: number } | null {
  const ch = chunk.charCodeAt(idx);

  if (ch < 0x20 || ch >= 0x7f) {
    return null;
  }

  const graphemeList = graphemes(chunk.slice(idx));
  const grapheme = graphemeList[0];

  if (grapheme === undefined) {
    return null;
  }

  return {
    event: createKeyEvent("char", grapheme, DEFAULT_MODS),
    len: grapheme.length,
  };
}

interface IParseResult {
  event: IKeyEvent;
  len: number;
}

function parseOneKey(chunk: string, idx: number): IParseResult | null {
  const ch = chunk.charCodeAt(idx);
  const remaining = chunk.slice(idx);

  // Kitty CSI-u
  const csiU = tryParseCsiU(chunk, idx);

  if (csiU !== null) {
    return csiU;
  }

  // xterm modifyOtherKeys
  const xterm = tryParseXterm(chunk, idx);

  if (xterm !== null) {
    return xterm;
  }

  // Legacy arrow/home/end/delete
  const legacy = tryParseLegacy(chunk, idx);

  if (legacy !== null) {
    return legacy;
  }

  if (remaining.startsWith(DELETE_SEQ)) {
    return { event: createKeyEvent("delete"), len: 4 };
  }

  // Alt+Return
  const altMods: IModifiers = { shift: false, alt: true, ctrl: false };

  if (remaining.startsWith(ALT_CR)) {
    return { event: createKeyEvent("return", "", altMods), len: 2 };
  }

  if (remaining.startsWith(ALT_LF)) {
    return { event: createKeyEvent("return", "", altMods), len: 2 };
  }

  // Plain return
  if (ch === 0x0d || ch === 0x0a) {
    return { event: createKeyEvent("return"), len: 1 };
  }

  // Backspace
  if (ch === 0x7f || ch === 0x08) {
    return { event: createKeyEvent("backspace"), len: 1 };
  }

  // Control bytes
  if (ch >= 0x01 && ch <= 0x1a) {
    const text = String.fromCharCode(ch + 96);
    const ctrlMods: IModifiers = { shift: false, alt: false, ctrl: true };

    return { event: createKeyEvent("char", text, ctrlMods), len: 1 };
  }

  // Alt+printable
  const altCharMods: IModifiers = { shift: false, alt: true, ctrl: false };

  if (ch === 0x1b && idx + 1 < chunk.length) {
    const nextCh = chunk.charCodeAt(idx + 1);

    if (nextCh >= 0x20 && nextCh < 0x7f) {
      const text = chunk[idx + 1];

      return { event: createKeyEvent("char", text, altCharMods), len: 2 };
    }
  }

  // Printable
  return tryParsePrintable(chunk, idx);
}

export function decodeKeys(chunk: string): IKeyEvent[] {
  const events: IKeyEvent[] = [];
  let idx = 0;

  while (idx < chunk.length) {
    const result = parseOneKey(chunk, idx);

    if (result !== null) {
      events.push(result.event);
      idx += result.len;
    } else {
      idx += 1;
    }
  }

  return events;
}
