export type { IGateSpec, IFileLintProblem, FileLinter } from "./types";
export { buildGate, buildCoreFix } from "./core-gate";
export {
  makeFileLinter,
  formatFile,
  formatFiles,
  prettierWriteCommand,
} from "./linter";
export { discoverTestCommand } from "./test-discovery";
