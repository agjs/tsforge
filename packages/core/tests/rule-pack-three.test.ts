import { test, expect, describe } from "bun:test";
import { TSESLint } from "@typescript-eslint/utils";
import tsParser from "@typescript-eslint/parser";
import type { TSESTree } from "@typescript-eslint/utils";

import { RULE_PACKS } from "../src/rule-packs";
import {
  analyzeThreeImports,
  isLegacyExamplesJsmSource,
  isThreeCdnSource,
  isThreePackageSource,
  isThreeSrcSource,
  rewriteExamplesJsmToAddons,
} from "../src/rule-packs/three/utils";

function lint(
  ruleName: string,
  code: string,
  filename = "src/example.ts",
  options?: unknown[]
) {
  const linter = new TSESLint.Linter();
  const pack = RULE_PACKS.three;
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack three`);
  }

  const config = {
    files: ["**/*.ts"],
    plugins: { tsforge: { rules: { [ruleName]: rule } } },
    rules: {
      [`tsforge/${ruleName}`]: options ? ["error", ...options] : "error",
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  } satisfies TSESLint.FlatConfig.Config;

  return linter.verify(code, config, filename);
}

function lintFix(
  ruleName: string,
  code: string,
  filename = "src/example.ts",
  options?: unknown[]
): { output: string; messages: TSESLint.Linter.LintMessage[] } {
  const linter = new TSESLint.Linter();
  const pack = RULE_PACKS.three;
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack three`);
  }

  const config = {
    files: ["**/*.ts"],
    plugins: { tsforge: { rules: { [ruleName]: rule } } },
    rules: {
      [`tsforge/${ruleName}`]: options ? ["error", ...options] : "error",
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  } satisfies TSESLint.FlatConfig.Config;

  if (typeof linter.verifyAndFix !== "function") {
    throw new Error("Linter.verifyAndFix is required for autofix tests");
  }

  return linter.verifyAndFix(code, config, { filename });
}

function parseProgram(code: string): TSESTree.Program {
  const result = tsParser.parseForESLint(code, {
    range: true,
    loc: true,
    tokens: false,
    comment: false,
    ecmaVersion: 2022,
    sourceType: "module",
  });

  return result.ast;
}

describe("three pack registry", () => {
  test("exports the eleven v1 rules with matching config keys", () => {
    const pack = RULE_PACKS.three;

    expect(pack.id).toBe("three");
    expect(pack.description.toLowerCase()).toContain("three");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-direct-children-mutation",
      "no-disabled-frustum-culling",
      "no-global-three",
      "no-mixed-three-entrypoints",
      "no-unbounded-device-pixel-ratio",
      "prefer-named-three-imports",
      "prefer-three-load-async",
      "require-instance-buffer-update",
      "require-projection-update",
      "require-three-dispose-contract",
      "require-three-loader-error-path",
    ]);
    expect(Object.keys(pack.rulesConfig).sort()).toEqual(
      Object.keys(pack.rules).sort()
    );
  });
});

describe("three utils", () => {
  test("classifies package, legacy, src, and CDN sources", () => {
    expect(isThreePackageSource("three")).toBe(true);
    expect(isThreePackageSource("three/addons/loaders/GLTFLoader.js")).toBe(
      true
    );
    expect(isThreePackageSource("./math")).toBe(false);

    expect(
      isLegacyExamplesJsmSource("three/examples/jsm/loaders/GLTFLoader.js")
    ).toBe(true);
    expect(
      isLegacyExamplesJsmSource("three/addons/loaders/GLTFLoader.js")
    ).toBe(false);

    expect(isThreeSrcSource("three/src/Three.js")).toBe(true);
    expect(isThreeSrcSource("three/addons/controls/OrbitControls.js")).toBe(
      false
    );

    expect(
      isThreeCdnSource("https://unpkg.com/three@0.160.0/build/three.module.js")
    ).toBe(true);
    expect(isThreeCdnSource("three")).toBe(false);
  });

  test("rewrites examples/jsm to addons and leaves other paths alone", () => {
    expect(
      rewriteExamplesJsmToAddons("three/examples/jsm/loaders/GLTFLoader.js")
    ).toBe("three/addons/loaders/GLTFLoader.js");
    expect(
      rewriteExamplesJsmToAddons("three/addons/loaders/GLTFLoader.js")
    ).toBeNull();
  });

  test("analyzeThreeImports records aliased named imports, namespaces, and addon paths", () => {
    const program = parseProgram(`
      import * as THREE from "three";
      import { Scene as S, Vector3 } from "three";
      import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
    `);
    const imports = analyzeThreeImports(program);

    expect(imports.hasThreeImport).toBe(true);
    expect(imports.namespaceNames.has("THREE")).toBe(true);
    expect(imports.namedBindings.get("S")).toBe("Scene");
    expect(imports.namedBindings.get("Vector3")).toBe("Vector3");
    expect(imports.namedBindings.get("GLTFLoader")).toBe("GLTFLoader");
  });

  test("analyzeThreeImports ignores same-named imports from other modules", () => {
    const program = parseProgram(`
      import { Vector3 } from "./math";
      import { Scene } from "other-three";
    `);
    const imports = analyzeThreeImports(program);

    expect(imports.hasThreeImport).toBe(false);
    expect(imports.namedBindings.size).toBe(0);
  });
});

describe("no-mixed-three-entrypoints", () => {
  test("flags examples/jsm imports and rewrites them to addons", () => {
    const code = `import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";\n`;
    const messages = lint("no-mixed-three-entrypoints", code);

    expect(messages.map((m) => m.messageId)).toContain("legacyExamplesJsm");

    const fixed = lintFix("no-mixed-three-entrypoints", code);

    expect(fixed.output).toContain('from "three/addons/loaders/GLTFLoader.js"');
    expect(fixed.output).not.toContain("examples/jsm");
  });

  test("allows canonical addon imports", () => {
    const code = `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";\n`;
    const messages = lint("no-mixed-three-entrypoints", code);

    expect(messages).toEqual([]);
  });

  test("flags three/src imports without an autofix", () => {
    const code = `import { Scene } from "three/src/scenes/Scene.js";\n`;
    const messages = lint("no-mixed-three-entrypoints", code);

    expect(messages.map((m) => m.messageId)).toContain("srcEntrypoint");
    expect(messages[0]?.fix).toBeUndefined();
  });

  test("flags CDN URL imports without an autofix", () => {
    const code = `import * as THREE from "https://unpkg.com/three/build/three.module.js";\n`;
    const messages = lint("no-mixed-three-entrypoints", code);

    expect(messages.map((m) => m.messageId)).toContain("cdnEntrypoint");
    expect(messages[0]?.fix).toBeUndefined();
  });
});

describe("prefer-named-three-imports", () => {
  test("flags namespace imports used only as static members and rewrites them", () => {
    const code = `import * as THREE from "three";
const v = new THREE.Vector3();
const c = new THREE.Color();
`;
    const messages = lint("prefer-named-three-imports", code);

    expect(messages.map((m) => m.messageId)).toContain("preferNamedImports");

    const fixed = lintFix("prefer-named-three-imports", code);

    expect(fixed.output).toContain('import { Color, Vector3 } from "three"');
    expect(fixed.output).toContain("new Vector3()");
    expect(fixed.output).toContain("new Color()");
    expect(fixed.output).not.toContain("THREE.");
  });

  test("reports but does not rewrite when the namespace escapes", () => {
    const code = `import * as THREE from "three";
use(THREE);
`;
    const messages = lint("prefer-named-three-imports", code);

    expect(messages.map((m) => m.messageId)).toContain("preferNamedImports");
    expect(messages[0]?.fix).toBeUndefined();
  });

  test("reports but does not rewrite computed member access", () => {
    const code = `import * as THREE from "three";
const name = "Vector3";
const Ctor = THREE[name];
`;
    const messages = lint("prefer-named-three-imports", code);

    expect(messages.map((m) => m.messageId)).toContain("preferNamedImports");
    expect(messages[0]?.fix).toBeUndefined();
  });
});

describe("no-global-three", () => {
  test("flags an unqualified THREE identifier with no import", () => {
    const code = `const v = new THREE.Vector3();\n`;
    const messages = lint("no-global-three", code);

    expect(messages.map((m) => m.messageId)).toContain("globalThree");
  });

  test("flags require('three')", () => {
    const code = `const THREE = require("three");\n`;
    const messages = lint("no-global-three", code);

    expect(messages.map((m) => m.messageId)).toContain("requireThree");
  });

  test("allows an imported THREE namespace", () => {
    const code = `import * as THREE from "three";
const v = new THREE.Vector3();
`;
    const messages = lint("no-global-three", code);

    expect(messages.map((m) => m.messageId)).not.toContain("globalThree");
    expect(messages.map((m) => m.messageId)).not.toContain("requireThree");
  });
});

describe("no-direct-children-mutation", () => {
  test("flags children.push on a Three object and rewrites it to add", () => {
    const code = `import { Scene, Mesh } from "three";
const scene = new Scene();
const mesh = new Mesh();
scene.children.push(mesh);
`;
    const messages = lint("no-direct-children-mutation", code);

    expect(messages.map((m) => m.messageId)).toContain("childrenPush");

    const fixed = lintFix("no-direct-children-mutation", code);

    expect(fixed.output).toContain("scene.add(mesh)");
    expect(fixed.output).not.toContain("children.push");
  });

  test("flags children splice without an autofix", () => {
    const code = `import { Scene } from "three";
const scene = new Scene();
scene.children.splice(0, 1);
`;
    const messages = lint("no-direct-children-mutation", code);

    expect(messages.map((m) => m.messageId)).toContain("childrenMutate");
    expect(messages[0]?.fix).toBeUndefined();
  });

  test("ignores .children.push on a plain object when Three is not imported", () => {
    const code = `const list = { children: [] as object[] };
list.children.push({});
`;
    const messages = lint("no-direct-children-mutation", code);

    expect(messages).toEqual([]);
  });
});

describe("require-projection-update", () => {
  test("flags aspect assignment without updateProjectionMatrix and inserts the call", () => {
    const code = `import { PerspectiveCamera } from "three";
const camera = new PerspectiveCamera();
camera.aspect = 1.5;
`;
    const messages = lint("require-projection-update", code);

    expect(messages.map((m) => m.messageId)).toContain(
      "missingProjectionUpdate"
    );

    const fixed = lintFix("require-projection-update", code);

    expect(fixed.output).toContain("camera.updateProjectionMatrix()");
  });

  test("allows aspect assignment when updateProjectionMatrix follows in the same function", () => {
    const code = `import { PerspectiveCamera } from "three";
const camera = new PerspectiveCamera();
function resize() {
  camera.aspect = 1.5;
  camera.updateProjectionMatrix();
}
`;
    const messages = lint("require-projection-update", code);

    expect(messages).toEqual([]);
  });

  test("ignores .aspect on a non-camera object", () => {
    const code = `import { Scene } from "three";
const scene = new Scene();
const img = { aspect: 0 };
img.aspect = 1;
`;
    const messages = lint("require-projection-update", code);

    expect(messages).toEqual([]);
  });
});

describe("require-three-dispose-contract", () => {
  test("flags a class that constructs GPU resources without dispose", () => {
    const code = `import { BoxGeometry, MeshBasicMaterial } from "three";
class GridView {
  private geometry = new BoxGeometry();
  private material = new MeshBasicMaterial();
}
`;
    const messages = lint("require-three-dispose-contract", code);

    expect(messages.map((m) => m.messageId)).toContain("missingDispose");
  });

  test("allows a class that declares dispose", () => {
    const code = `import { BoxGeometry } from "three";
class GridView {
  private geometry = new BoxGeometry();
  dispose() {
    this.geometry.dispose();
  }
}
`;
    const messages = lint("require-three-dispose-contract", code);

    expect(messages).toEqual([]);
  });

  test("does not flag constructor-injected borrowed resources", () => {
    const code = `import { MeshStandardMaterial } from "three";
class GridView {
  public constructor(private readonly material: MeshStandardMaterial) {}
}
`;
    const messages = lint("require-three-dispose-contract", code);

    expect(messages).toEqual([]);
  });
});

describe("prefer-three-load-async", () => {
  test("flags loader.load callback form", () => {
    const code = `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const loader = new GLTFLoader();
loader.load("/model.glb", (gltf) => {
  use(gltf);
}, undefined, (err) => {
  throw err;
});
`;
    const messages = lint("prefer-three-load-async", code);

    expect(messages.map((m) => m.messageId)).toContain("preferLoadAsync");
  });

  test("allows loadAsync", () => {
    const code = `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const loader = new GLTFLoader();
const gltf = await loader.loadAsync("/model.glb");
`;
    const messages = lint("prefer-three-load-async", code);

    expect(messages).toEqual([]);
  });
});

describe("require-three-loader-error-path", () => {
  test("flags load with onLoad but no onError", () => {
    const code = `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const loader = new GLTFLoader();
loader.load("/model.glb", (gltf) => {
  use(gltf);
});
`;
    const messages = lint("require-three-loader-error-path", code);

    expect(messages.map((m) => m.messageId)).toContain("missingLoaderError");
  });

  test("allows load with an onError argument", () => {
    const code = `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
const loader = new GLTFLoader();
loader.load("/model.glb", (gltf) => {
  use(gltf);
}, undefined, (err) => {
  throw err;
});
`;
    const messages = lint("require-three-loader-error-path", code);

    expect(messages).toEqual([]);
  });
});

describe("require-instance-buffer-update", () => {
  test("flags setMatrixAt without needsUpdate and inserts the write after the loop", () => {
    const code = `import { InstancedMesh, Matrix4 } from "three";
const mesh = new InstancedMesh();
const matrix = new Matrix4();
for (let i = 0; i < 10; i++) {
  mesh.setMatrixAt(i, matrix);
}
`;
    const messages = lint("require-instance-buffer-update", code);

    expect(messages.map((m) => m.messageId)).toContain("missingNeedsUpdate");

    const fixed = lintFix("require-instance-buffer-update", code);

    expect(fixed.output).toContain("mesh.instanceMatrix.needsUpdate = true");
  });

  test("allows setMatrixAt when needsUpdate follows the loop", () => {
    const code = `import { InstancedMesh, Matrix4 } from "three";
const mesh = new InstancedMesh();
const matrix = new Matrix4();
for (let i = 0; i < 10; i++) {
  mesh.setMatrixAt(i, matrix);
}
mesh.instanceMatrix.needsUpdate = true;
`;
    const messages = lint("require-instance-buffer-update", code);

    expect(messages).toEqual([]);
  });

  test("flags setColorAt without instanceColor.needsUpdate", () => {
    const code = `import { InstancedMesh, Color } from "three";
const mesh = new InstancedMesh();
const color = new Color();
mesh.setColorAt(0, color);
`;
    const messages = lint("require-instance-buffer-update", code);

    expect(messages.map((m) => m.messageId)).toContain(
      "missingColorNeedsUpdate"
    );
  });
});

describe("no-unbounded-device-pixel-ratio", () => {
  test("flags setPixelRatio(window.devicePixelRatio) and wraps it in Math.min", () => {
    const code = `import { WebGLRenderer } from "three";
const renderer = new WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio);
`;
    const messages = lint("no-unbounded-device-pixel-ratio", code);

    expect(messages.map((m) => m.messageId)).toContain("unboundedPixelRatio");

    const fixed = lintFix("no-unbounded-device-pixel-ratio", code);

    expect(fixed.output).toContain("Math.min(window.devicePixelRatio, 2)");
  });

  test("honours a configured maxPixelRatio", () => {
    const code = `import { WebGLRenderer } from "three";
const renderer = new WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio);
`;
    const fixed = lintFix(
      "no-unbounded-device-pixel-ratio",
      code,
      "src/example.ts",
      [{ maxPixelRatio: 1.5 }]
    );

    expect(fixed.output).toContain("Math.min(window.devicePixelRatio, 1.5)");
  });

  test("allows an already-capped pixel ratio", () => {
    const code = `import { WebGLRenderer } from "three";
const renderer = new WebGLRenderer();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
`;
    const messages = lint("no-unbounded-device-pixel-ratio", code);

    expect(messages).toEqual([]);
  });
});

describe("no-disabled-frustum-culling", () => {
  test("flags frustumCulled = false on a Three mesh", () => {
    const code = `import { Mesh } from "three";
const mesh = new Mesh();
mesh.frustumCulled = false;
`;
    const messages = lint("no-disabled-frustum-culling", code);

    expect(messages.map((m) => m.messageId)).toContain("frustumCulledDisabled");
  });

  test("allows frustumCulled = true", () => {
    const code = `import { Mesh } from "three";
const mesh = new Mesh();
mesh.frustumCulled = true;
`;
    const messages = lint("no-disabled-frustum-culling", code);

    expect(messages).toEqual([]);
  });

  test("ignores frustumCulled on a non-Three object", () => {
    const code = `const mesh = { frustumCulled: true };
mesh.frustumCulled = false;
`;
    const messages = lint("no-disabled-frustum-culling", code);

    expect(messages).toEqual([]);
  });
});

describe("three pack does not key off spelling alone", () => {
  test("does not flag a local Vector3 that is not imported from three", () => {
    const code = `import { Vector3 } from "./math";
const v = new Vector3();
`;

    expect(lint("require-three-dispose-contract", code)).toEqual([]);
    expect(lint("prefer-named-three-imports", code)).toEqual([]);
    expect(lint("no-global-three", code)).toEqual([]);
  });
});
