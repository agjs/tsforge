export type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
  MetaRuleCategory,
} from "./meta-rules.types";
export { buildMetaRuleContext } from "./context";
export { runMetaRules } from "./runner";
export { META_RULES } from "./registry";
