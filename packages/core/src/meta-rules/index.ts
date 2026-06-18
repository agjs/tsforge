export type {
  IMetaRule,
  IMetaRuleContext,
  IMetaRuleViolation,
  MetaRuleCategory,
} from "./meta-rules.types";
export { buildMetaRuleContext } from "./context";
export { runMetaRules } from "./runner";
export { META_RULES, PER_WRITE_META_RULES } from "./registry";
