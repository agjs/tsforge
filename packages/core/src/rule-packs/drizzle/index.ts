import type { TSESLint } from "@typescript-eslint/utils";

import { accountScopedTablesRequireWhereRule } from "./rules/account-scoped-tables-require-where";
import { noNestedDbTransactionRule } from "./rules/no-nested-db-transaction";
import { noRawSqlOutsideAllowlistRule } from "./rules/no-raw-sql-outside-allowlist";
import { relationsMustCoverFksRule } from "./rules/relations-must-cover-fks";
import { schemaFilesMustNotImportDriverRule } from "./rules/schema-files-must-not-import-driver";
import { schemaFilesMustOnlyExportSchemaRule } from "./rules/schema-files-must-only-export-schema";
import { tablesMustHaveTimestampsRule } from "./rules/tables-must-have-timestamps";
import { timestampMustSpecifyModeRule } from "./rules/timestamp-must-specify-mode";
import { updateDeleteAccountScopedMustFilterScopeRule } from "./rules/update-delete-account-scoped-must-filter-scope";
import { updateDeleteMustHaveWhereRule } from "./rules/update-delete-must-have-where";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "account-scoped-tables-require-where": accountScopedTablesRequireWhereRule,
  "no-nested-db-transaction": noNestedDbTransactionRule,
  "no-raw-sql-outside-allowlist": noRawSqlOutsideAllowlistRule,
  "relations-must-cover-fks": relationsMustCoverFksRule,
  "schema-files-must-not-import-driver": schemaFilesMustNotImportDriverRule,
  "schema-files-must-only-export-schema": schemaFilesMustOnlyExportSchemaRule,
  "tables-must-have-timestamps": tablesMustHaveTimestampsRule,
  "timestamp-must-specify-mode": timestampMustSpecifyModeRule,
  "update-delete-account-scoped-must-filter-scope":
    updateDeleteAccountScopedMustFilterScopeRule,
  "update-delete-must-have-where": updateDeleteMustHaveWhereRule,
};

export const drizzlePack: IRulePack = {
  id: "drizzle",
  description:
    "Database access patterns using Drizzle ORM (schema safety, query scoping, transaction safety)",
  rules,
  rulesConfig: {
    "account-scoped-tables-require-where": "error",
    "no-nested-db-transaction": "error",
    "no-raw-sql-outside-allowlist": "error",
    "relations-must-cover-fks": "error",
    "schema-files-must-not-import-driver": "error",
    "schema-files-must-only-export-schema": "warn",
    "tables-must-have-timestamps": "warn",
    "timestamp-must-specify-mode": "error",
    "update-delete-account-scoped-must-filter-scope": "error",
    "update-delete-must-have-where": "error",
  },
};

export default drizzlePack;
