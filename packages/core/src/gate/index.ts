export type { IGate, IFileLintProblem, FileLinter } from "./types";
export { buildGate, buildCoreFix } from "./core-gate";
export {
  buildWebGate,
  buildWebTypeGate,
  buildWebTscCheck,
  buildWebFix,
  WEB_FRAMEWORKS,
  WEB_PACKS,
} from "./web-gate";
export { makeFileLinter, formatFile, prettierWriteCommand } from "./linter";
export { discoverTestCommand, webTestProbe } from "./test-discovery";
