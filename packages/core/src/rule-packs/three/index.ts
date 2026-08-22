import type { TSESLint } from "@typescript-eslint/utils";

import { noDirectChildrenMutationRule } from "./rules/no-direct-children-mutation";
import { noDisabledFrustumCullingRule } from "./rules/no-disabled-frustum-culling";
import { noGlobalThreeRule } from "./rules/no-global-three";
import { noMixedThreeEntrypointsRule } from "./rules/no-mixed-three-entrypoints";
import { noUnboundedDevicePixelRatioRule } from "./rules/no-unbounded-device-pixel-ratio";
import { preferNamedThreeImportsRule } from "./rules/prefer-named-three-imports";
import { preferThreeLoadAsyncRule } from "./rules/prefer-three-load-async";
import { requireInstanceBufferUpdateRule } from "./rules/require-instance-buffer-update";
import { requireProjectionUpdateRule } from "./rules/require-projection-update";
import { requireThreeDisposeContractRule } from "./rules/require-three-dispose-contract";
import { requireThreeLoaderErrorPathRule } from "./rules/require-three-loader-error-path";
import type { IRulePack } from "../rule-packs.types";

const rules: Record<string, TSESLint.RuleModule<string, readonly unknown[]>> = {
  "no-direct-children-mutation": noDirectChildrenMutationRule,
  "no-disabled-frustum-culling": noDisabledFrustumCullingRule,
  "no-global-three": noGlobalThreeRule,
  "no-mixed-three-entrypoints": noMixedThreeEntrypointsRule,
  "no-unbounded-device-pixel-ratio": noUnboundedDevicePixelRatioRule,
  "prefer-named-three-imports": preferNamedThreeImportsRule,
  "prefer-three-load-async": preferThreeLoadAsyncRule,
  "require-instance-buffer-update": requireInstanceBufferUpdateRule,
  "require-projection-update": requireProjectionUpdateRule,
  "require-three-dispose-contract": requireThreeDisposeContractRule,
  "require-three-loader-error-path": requireThreeLoaderErrorPathRule,
};

export const threePack: IRulePack = {
  id: "three",
  description:
    "Three.js as a render substrate: canonical imports, GPU dispose, scene-graph APIs, loader errors, and instanced-buffer updates",
  rules,
  rulesConfig: {
    "no-direct-children-mutation": "error",
    "no-disabled-frustum-culling": "warn",
    "no-global-three": "warn",
    "no-mixed-three-entrypoints": "error",
    "no-unbounded-device-pixel-ratio": "warn",
    "prefer-named-three-imports": "warn",
    "prefer-three-load-async": "warn",
    "require-instance-buffer-update": "error",
    "require-projection-update": "error",
    "require-three-dispose-contract": "error",
    "require-three-loader-error-path": "error",
  },
};

export default threePack;
