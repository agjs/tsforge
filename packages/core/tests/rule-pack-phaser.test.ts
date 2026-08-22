import { test, expect, describe } from "bun:test";
import { AST_NODE_TYPES, TSESLint } from "@typescript-eslint/utils";
import tsParser from "@typescript-eslint/parser";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TSESTree } from "@typescript-eslint/utils";

import { RULE_PACKS, buildPackEslintConfig } from "../src/rule-packs";
import {
  analyzePhaserImports,
  isPhaserPackageSource,
  memberChain,
  shouldEnterHotPath,
} from "../src/rule-packs/phaser/utils";

function lint(
  ruleName: string,
  code: string,
  filename = "src/runtime/example.ts",
  options?: unknown[]
) {
  const linter = new TSESLint.Linter();
  const pack = RULE_PACKS.phaser;
  const rule = pack.rules[ruleName];

  if (!rule) {
    throw new Error(`Rule ${ruleName} not found in pack phaser`);
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

const PHASER_IMPORT = 'import * as Phaser from "phaser";\n';

describe("phaser pack registry", () => {
  test("exports the ten v1 rules with matching config keys", () => {
    const pack = RULE_PACKS.phaser;

    expect(pack.id).toBe("phaser");
    expect(pack.description.toLowerCase()).toContain("phaser");
    expect(Object.keys(pack.rules).sort()).toEqual([
      "no-global-phaser",
      "no-ignore-destroy",
      "no-loader-in-update",
      "no-phaser-alloc-in-update",
      "no-phaser-import-in-pure-layers",
      "no-physics-collider-in-update",
      "no-raw-scene-key-literal",
      "no-raw-texture-key-literal",
      "no-unmanaged-global-listeners",
      "require-scene-shutdown-hook",
    ]);
    expect(Object.keys(pack.rulesConfig).sort()).toEqual(
      Object.keys(pack.rules).sort()
    );
    expect(pack.rulesConfig["no-phaser-alloc-in-update"]).toBe("warn");
    expect(pack.rulesConfig["no-ignore-destroy"]).toBe("error");
  });
});

describe("phaser utils", () => {
  test("classifies package sources", () => {
    expect(isPhaserPackageSource("phaser")).toBe(true);
    expect(isPhaserPackageSource("phaser/types")).toBe(true);
    expect(isPhaserPackageSource("./phaser")).toBe(false);
  });

  test("analyzePhaserImports records namespace, default, and named bindings", () => {
    const program = parseProgram(`
      import * as Phaser from "phaser";
      import Engine from "phaser";
      import { Scene as S } from "phaser";
    `);
    const imports = analyzePhaserImports(program);

    expect(imports.hasPhaserImport).toBe(true);
    expect(imports.namespaceNames.has("Phaser")).toBe(true);
    expect(imports.namespaceNames.has("Engine")).toBe(true);
    expect(imports.namedBindings.get("S")).toBe("Scene");
  });

  test("analyzePhaserImports ignores type-only bindings but still marks the file", () => {
    const program = parseProgram(`import type * as Phaser from "phaser";\n`);
    const imports = analyzePhaserImports(program);

    expect(imports.hasPhaserImport).toBe(true);
    expect(imports.namespaceNames.size).toBe(0);
  });

  test("memberChain walks this.physics.add.overlap", () => {
    const program = parseProgram(
      `${PHASER_IMPORT}this.physics.add.overlap(a, b);\n`
    );
    const stmt = program.body[1];

    if (stmt?.type !== AST_NODE_TYPES.ExpressionStatement) {
      throw new Error("expected expression");
    }

    if (stmt.expression.type !== AST_NODE_TYPES.CallExpression) {
      throw new Error("expected call");
    }

    expect(memberChain(stmt.expression.callee)).toEqual([
      "this",
      "physics",
      "add",
      "overlap",
    ]);
  });

  test("shouldEnterHotPath matches object-literal update methods", () => {
    const program = parseProgram(`
      const runtime = {
        update(deltaMs) {
          return deltaMs;
        },
      };
    `);
    const stmt = program.body[0];

    if (stmt?.type !== AST_NODE_TYPES.VariableDeclaration) {
      throw new Error("expected variable");
    }

    const [declarator] = stmt.declarations;
    const init = declarator.init;

    if (init?.type !== AST_NODE_TYPES.ObjectExpression) {
      throw new Error("expected object");
    }

    const prop = init.properties[0];

    if (prop === undefined || prop.type === AST_NODE_TYPES.SpreadElement) {
      throw new Error("expected property");
    }

    expect(shouldEnterHotPath(prop)).toBe(true);
  });
});

describe("no-ignore-destroy", () => {
  test("flags ignoreDestroy = true", () => {
    const code = `${PHASER_IMPORT}sprite.ignoreDestroy = true;\n`;
    const messages = lint("no-ignore-destroy", code);

    expect(messages.map((m) => m.messageId)).toContain("ignoreDestroy");
  });

  test("allows ignoreDestroy = false", () => {
    const code = `${PHASER_IMPORT}sprite.ignoreDestroy = false;\n`;

    expect(lint("no-ignore-destroy", code)).toEqual([]);
  });
});

describe("no-loader-in-update", () => {
  test("flags this.load.image inside update", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  update() {
    this.load.image("hero", "hero.png");
  }
}
`;
    const messages = lint("no-loader-in-update", code);

    expect(messages.map((m) => m.messageId)).toContain("loaderInUpdate");
  });

  test("allows this.load.image in preload", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  preload() {
    this.load.image("hero", "hero.png");
  }
}
`;

    expect(lint("no-loader-in-update", code)).toEqual([]);
  });
});

describe("no-physics-collider-in-update", () => {
  test("flags physics.add.overlap in update", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  update() {
    this.physics.add.overlap(this, this, () => undefined);
  }
}
`;
    const messages = lint("no-physics-collider-in-update", code);

    expect(messages.map((m) => m.messageId)).toContain("colliderInUpdate");
  });

  test("allows physics.add.overlap in create", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.physics.add.overlap(this, this, () => undefined);
  }
}
`;

    expect(lint("no-physics-collider-in-update", code)).toEqual([]);
  });
});

describe("no-raw-scene-key-literal", () => {
  test("flags scene.start string literal", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.scene.start("World");
  }
}
`;
    const messages = lint("no-raw-scene-key-literal", code);

    expect(messages.map((m) => m.messageId)).toContain("rawSceneKey");
  });

  test("flags super('Boot') on a Scene subclass", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  constructor() {
    super("Boot");
  }
}
`;
    const messages = lint("no-raw-scene-key-literal", code);

    expect(messages.map((m) => m.messageId)).toContain("rawSuperKey");
  });

  test("allows named constants", () => {
    const code = `${PHASER_IMPORT}
const WORLD = "World";
export class Play extends Phaser.Scene {
  constructor() {
    super(WORLD);
  }
  create() {
    this.scene.start(WORLD);
  }
}
`;

    expect(lint("no-raw-scene-key-literal", code)).toEqual([]);
  });
});

describe("no-raw-texture-key-literal", () => {
  test("flags load.image string key", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  preload() {
    this.load.image("hero", "hero.png");
  }
}
`;
    const messages = lint("no-raw-texture-key-literal", code);

    expect(messages.map((m) => m.messageId)).toContain("rawTextureKey");
  });

  test("allows identifier keys", () => {
    const code = `${PHASER_IMPORT}
const HERO = "hero";
export class Play extends Phaser.Scene {
  preload() {
    this.load.image(HERO, "hero.png");
  }
}
`;

    expect(lint("no-raw-texture-key-literal", code)).toEqual([]);
  });
});

describe("no-phaser-alloc-in-update", () => {
  test("flags this.add.image in update", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  update() {
    this.add.image(0, 0, "hero");
  }
}
`;
    const messages = lint("no-phaser-alloc-in-update", code);

    expect(messages.map((m) => m.messageId)).toContain("factoryInUpdate");
  });

  test("flags new Phaser.Math.Vector2 in object-literal tick", () => {
    const code = `${PHASER_IMPORT}
export const runtime = {
  tick() {
    return new Phaser.Math.Vector2();
  },
};
`;
    const messages = lint("no-phaser-alloc-in-update", code);

    expect(messages.map((m) => m.messageId)).toContain("ctorInUpdate");
  });

  test("allows object spreads and domain news in update", () => {
    const code = `${PHASER_IMPORT}
class Point {
  constructor(readonly x: number) {}
}
export class Play extends Phaser.Scene {
  update() {
    const state = { ...{ x: 1 }, y: 2 };
    const point = new Point(state.x);
    return point;
  }
}
`;

    expect(lint("no-phaser-alloc-in-update", code)).toEqual([]);
  });

  test("allows factories in create", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.add.image(0, 0, "hero");
  }
}
`;

    expect(lint("no-phaser-alloc-in-update", code)).toEqual([]);
  });
});

describe("require-scene-shutdown-hook", () => {
  test("flags persistent input.on without SHUTDOWN", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.input.on("pointerdown", () => undefined);
  }
}
`;
    const messages = lint("require-scene-shutdown-hook", code);

    expect(messages.map((m) => m.messageId)).toContain("missingShutdownHook");
  });

  test("allows once(SHUTDOWN) alongside persistent listeners", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.input.on("pointerdown", () => undefined);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => undefined);
  }
}
`;

    expect(lint("require-scene-shutdown-hook", code)).toEqual([]);
  });

  test("allows a Scene with no persistent listeners", () => {
    const code = `${PHASER_IMPORT}
export class Boot extends Phaser.Scene {
  create() {
    this.scene.start(WORLD);
  }
}
const WORLD = "World";
`;

    expect(lint("require-scene-shutdown-hook", code)).toEqual([]);
  });
});

describe("no-unmanaged-global-listeners", () => {
  test("flags window.addEventListener inside a Scene", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    window.addEventListener("resize", () => undefined);
  }
}
`;
    const messages = lint("no-unmanaged-global-listeners", code);

    expect(messages.map((m) => m.messageId)).toContain("unmanagedGlobal");
  });

  test("flags this.scale.on inside a Scene", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.scale.on("resize", () => undefined);
  }
}
`;
    const messages = lint("no-unmanaged-global-listeners", code);

    expect(messages.map((m) => m.messageId)).toContain("unmanagedGlobal");
  });

  test("allows this.input.on and this.events.on", () => {
    const code = `${PHASER_IMPORT}
export class Play extends Phaser.Scene {
  create() {
    this.input.on("pointerdown", () => undefined);
    this.events.on("wake", () => undefined);
  }
}
`;

    expect(lint("no-unmanaged-global-listeners", code)).toEqual([]);
  });

  test("allows window.addEventListener outside a Scene class", () => {
    const code = `${PHASER_IMPORT}
window.addEventListener("resize", () => undefined);
`;

    expect(lint("no-unmanaged-global-listeners", code)).toEqual([]);
  });
});

describe("no-phaser-import-in-pure-layers", () => {
  test("flags phaser import in domain", () => {
    const code = `${PHASER_IMPORT}export const n = 1;\n`;
    const messages = lint(
      "no-phaser-import-in-pure-layers",
      code,
      "src/domain/score.ts"
    );

    expect(messages.map((m) => m.messageId)).toContain("phaserInPureLayer");
  });

  test("allows phaser import in runtime", () => {
    const code = `${PHASER_IMPORT}export const n = 1;\n`;

    expect(
      lint("no-phaser-import-in-pure-layers", code, "src/runtime/view.ts")
    ).toEqual([]);
  });

  test("no-ops for a tutorial tree without deny globs", () => {
    const code = `${PHASER_IMPORT}export const n = 1;\n`;

    expect(
      lint("no-phaser-import-in-pure-layers", code, "src/scenes/Play.ts")
    ).toEqual([]);
  });
});

describe("no-global-phaser", () => {
  test("flags an unbound Phaser identifier", () => {
    const code = "const game = new Phaser.Game();\n";
    const messages = lint("no-global-phaser", code);

    expect(messages.map((m) => m.messageId)).toContain("globalPhaser");
  });

  test("allows import * as Phaser", () => {
    const code = `${PHASER_IMPORT}const game = new Phaser.Game();\n`;

    expect(lint("no-global-phaser", code)).toEqual([]);
  });

  test("flags require('phaser')", () => {
    const code = 'const Phaser = require("phaser");\n';
    const messages = lint("no-global-phaser", code);

    expect(messages.map((m) => m.messageId)).toContain("requirePhaser");
  });
});

describe("phaser-starter fixture", () => {
  test("lints clean at pack default severities", () => {
    const root = join(import.meta.dir, "fixtures/phaser-starter");
    const files = collectTsFiles(root);
    const { plugin, rules } = buildPackEslintConfig(["phaser"]);
    const linter = new TSESLint.Linter();
    const errors: string[] = [];

    for (const abs of files) {
      const code = readFileSync(abs, "utf8");
      const filename = abs.slice(root.length + 1).replaceAll("\\", "/");
      const messages = linter.verify(
        code,
        [
          {
            files: ["**/*.ts"],
            plugins: { tsforge: plugin },
            rules,
            languageOptions: {
              parser: tsParser,
              parserOptions: {
                ecmaVersion: 2022,
                sourceType: "module",
              },
            },
          },
        ],
        filename
      );

      for (const message of messages) {
        if (message.severity === 2) {
          errors.push(`${filename}: ${message.message}`);
        }
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);

    if (stat.isDirectory()) {
      out.push(...collectTsFiles(abs));
      continue;
    }

    if (entry.endsWith(".ts")) {
      out.push(abs);
    }
  }

  return out;
}
