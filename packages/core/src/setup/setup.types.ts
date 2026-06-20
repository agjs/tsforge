import type { ProfileId } from "../config/profiles";
import type { IConventions } from "../infer-rules/conventions.types";
import type { IScanReport } from "../infer-rules/scan.types";

/** The setup-managed fields the wizard writes into tsforge.config.json. Everything
 *  NOT listed here (mcpServers, plugins, policy, rules, stack, unknown keys) is
 *  preserved untouched by the writer. */
export interface ISetupConfig {
  readonly profile?: ProfileId;
  readonly packs?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
  readonly conventions?: Readonly<Partial<IConventions>>;
}

/** Result of writing the config. `invalid-existing-json` means the on-disk config
 *  could not be parsed and `overwriteInvalid` was not set — the caller decides
 *  (interactive: ask; non-TTY: exit non-zero). */
export type IWriteResult =
  | { readonly ok: true; readonly path: string; readonly evidencePath?: string }
  | {
      readonly ok: false;
      readonly reason: "invalid-existing-json";
      readonly error: string;
    }
  | {
      readonly ok: false;
      readonly reason: "write-failed";
      readonly error: string;
    };

/** What the wizard collects and hands to the writer + the final overview screen. */
export interface ISetupResult {
  readonly setup: ISetupConfig;
  readonly report: IScanReport;
}
