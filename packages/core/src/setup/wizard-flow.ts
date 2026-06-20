import { isWebStack } from "../stack-detection";
import {
  DEFAULT_CONVENTIONS,
  isComponentFoldersConvention,
  isEnumConvention,
  isInterfaceConvention,
  isTestConvention,
} from "../infer-rules/conventions";
import type { IConventions } from "../infer-rules/conventions.types";
import { recommendConventions } from "../infer-rules/scan";
import type { IScanReport } from "../infer-rules/scan.types";
import type {
  IWizardOption,
  IWizardState,
  IWizardStep,
} from "../render/wizard.types";

/** Build a single-select step whose recommended option (by value) is preselected
 *  and tagged. Keeps option ORDER stable; only the default/flag follow the rec. */
function singleStep(
  key: string,
  title: string,
  explanation: string,
  evidence: readonly string[],
  options: readonly Omit<IWizardOption, "recommended">[],
  recommended: string
): IWizardStep {
  const decorated = options.map((o) => ({
    ...o,
    recommended: o.value === recommended,
  }));
  const defaultIndex = Math.max(
    0,
    decorated.findIndex((o) => o.value === recommended)
  );

  return {
    key,
    kind: "single",
    title,
    explanation,
    evidence,
    options: decorated,
    defaultIndex,
  };
}

function interfacesStep(report: IScanReport, rec: IConventions): IWizardStep {
  const { iPrefixed, bare, total, iExamples, bareExamples } = report.interfaces;
  const evidence =
    total === 0
      ? ["No interfaces found — using the tsforge default."]
      : [
          `${total} interfaces scanned`,
          `${iPrefixed} I-prefixed   ${iExamples.join(", ")}`.trim(),
          `${bare} bare PascalCase   ${bareExamples.join(", ")}`.trim(),
        ];

  return singleStep(
    "interfaces",
    "Naming conventions",
    "What should tsforge expect when it writes or reviews interfaces?",
    evidence,
    [
      {
        label: "Match repo: bare PascalCase",
        value: "bare-pascal-case",
        outcome:
          'conventions.interfaces = "bare-pascal-case"; drops I-prefix from gate + prompts.',
      },
      {
        label: "Enforce house style: I-prefix",
        value: "i-prefix",
        outcome: 'conventions.interfaces = "i-prefix" (IUser, IOrder).',
      },
      {
        label: "Don't enforce interface naming",
        value: "off",
        outcome: 'conventions.interfaces = "off"; naming rule removed.',
      },
    ],
    rec.interfaces
  );
}

function enumsStep(report: IScanReport, rec: IConventions): IWizardStep {
  return singleStep(
    "enums",
    "Enums",
    "TypeScript `enum` is banned by default (use `as const`). Allowing enums NEVER affects the separate `as`-cast ban.",
    [`${report.enums.fileCount} files declare an enum`],
    [
      {
        label: "Ban enums (use `as const`)",
        value: "ban",
        outcome: 'conventions.enums = "ban".',
      },
      {
        label: "Allow enums",
        value: "allow",
        outcome: 'conventions.enums = "allow"; cast bans stay intact.',
      },
    ],
    rec.enums
  );
}

function testsStep(report: IScanReport, rec: IConventions): IWizardStep {
  return singleStep(
    "tests",
    "Test layout",
    "Where should a logic file's test live for the gate to accept it?",
    [
      `${report.tests.coLocated} co-located · ${report.tests.mirrored} in a tests/ mirror`,
    ],
    [
      {
        label: "Co-located (`foo.test.ts` beside `foo.ts`)",
        value: "co-located",
        outcome: 'conventions.tests = "co-located".',
      },
      {
        label: "Mirrored (`tests/` directory)",
        value: "mirrored",
        outcome: 'conventions.tests = "mirrored".',
      },
      {
        label: "Either layout is fine",
        value: "either",
        outcome: 'conventions.tests = "either".',
      },
    ],
    rec.tests
  );
}

function componentFoldersStep(
  report: IScanReport,
  rec: IConventions
): IWizardStep {
  const f = report.folders;
  const present = [
    f.views ? "src/views" : "",
    f.features ? "src/features" : "",
    f.flatComponents ? "src/components" : "",
    f.routeFolders ? "route folders" : "",
  ].filter((s) => s.length > 0);

  return singleStep(
    "componentFolders",
    "Component folders",
    "How should frontend components be organized when tsforge writes them?",
    [
      present.length > 0
        ? `Detected: ${present.join(", ")}`
        : "No component folders detected yet.",
    ],
    [
      {
        label: "tsforge views (`src/views/<Feature>/`)",
        value: "tsforge-views",
        outcome: 'conventions.componentFolders = "tsforge-views".',
      },
      {
        label: "Match the repo's own layout",
        value: "repo",
        outcome: 'conventions.componentFolders = "repo".',
      },
      {
        label: "Warn only",
        value: "warn",
        outcome: 'conventions.componentFolders = "warn".',
      },
    ],
    rec.componentFolders
  );
}

/** Build the wizard steps from a scan. The component-folders step only appears for
 *  frontend stacks (it's meaningless for a backend repo). */
export function buildSteps(report: IScanReport): IWizardStep[] {
  const rec = recommendConventions(report);
  const steps = [
    interfacesStep(report, rec),
    enumsStep(report, rec),
    testsStep(report, rec),
  ];

  if (
    isWebStack(report.stack) ||
    report.folders.views ||
    report.folders.features
  ) {
    steps.push(componentFoldersStep(report, rec));
  }

  return steps;
}

/** Map the wizard's recorded single-select answers back to a resolved convention
 *  set (any unanswered step falls back to the house default). */
export function selectionsToConventions(state: IWizardState): IConventions {
  const s = state.single;

  return {
    interfaces: isInterfaceConvention(s.interfaces)
      ? s.interfaces
      : DEFAULT_CONVENTIONS.interfaces,
    enums: isEnumConvention(s.enums) ? s.enums : DEFAULT_CONVENTIONS.enums,
    tests: isTestConvention(s.tests) ? s.tests : DEFAULT_CONVENTIONS.tests,
    componentFolders: isComponentFoldersConvention(s.componentFolders)
      ? s.componentFolders
      : DEFAULT_CONVENTIONS.componentFolders,
  };
}

/** Only the fields that DIFFER from the house default — what we actually write,
 *  so a config stays minimal and a default choice adds no noise. */
export function nonDefaultConventions(
  conventions: IConventions
): Partial<IConventions> {
  const out: { -readonly [K in keyof IConventions]?: IConventions[K] } = {};

  if (conventions.interfaces !== DEFAULT_CONVENTIONS.interfaces) {
    out.interfaces = conventions.interfaces;
  }

  if (conventions.enums !== DEFAULT_CONVENTIONS.enums) {
    out.enums = conventions.enums;
  }

  if (conventions.tests !== DEFAULT_CONVENTIONS.tests) {
    out.tests = conventions.tests;
  }

  if (conventions.componentFolders !== DEFAULT_CONVENTIONS.componentFolders) {
    out.componentFolders = conventions.componentFolders;
  }

  return out;
}

/** The exact tsforge.config.json fragment that will be written (overview preview).
 *  Empty conventions ⇒ a note that nothing changes from the defaults. */
export function configPreview(conventions: IConventions): string {
  const diff = nonDefaultConventions(conventions);

  if (Object.keys(diff).length === 0) {
    return "tsforge.config.json: all choices are tsforge defaults — no conventions written.";
  }

  return `tsforge.config.json:\n${JSON.stringify({ conventions: diff }, null, 2)}`;
}
