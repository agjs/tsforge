import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { flags } from "../config/flags";

const OSC8_START = "\x1b]8;;";
const OSC8_END = "\x1b\\";

const FILE_LINE = /(\S+\.(?:ts|tsx)):(\d+)/gu;

/** Wrap `text` in an OSC 8 hyperlink pointing at `url`. */
export function osc8Link(text: string, url: string): string {
  return `${OSC8_START}${url}${OSC8_END}${text}${OSC8_START}${OSC8_END}`;
}

function fileLineUrl(file: string, line: string, cwd: string): string {
  const abs = resolve(cwd, file);

  return `${pathToFileURL(abs).href}:${line}`;
}

/** Replace `path.ts:12` segments with OSC 8 file:// links when enabled. */
export function linkifyFileLine(text: string, cwd: string): string {
  if (!flags.osc8Links()) {
    return text;
  }

  return text.replace(FILE_LINE, (match, file: string, line: string) => {
    return osc8Link(match, fileLineUrl(file, line, cwd));
  });
}

/** Linkify file:line segments in a transcript/tool line. */
export function linkifyTranscriptLine(text: string, cwd: string): string {
  if (!flags.osc8Links()) {
    return text;
  }

  return linkifyFileLine(text, cwd);
}
