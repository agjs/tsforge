import { test, expect } from "bun:test";
import { StreamGuard } from "../src/inference/stream-guard";

function feed(lines: string[]): boolean {
  const guard = new StreamGuard();
  let tripped = false;

  for (const line of lines) {
    tripped = guard.observe(`${line}\n`, "content") || tripped;
  }

  return tripped;
}

test("trips on an exact-line repetition loop", () => {
  const lines = Array.from(
    { length: 30 },
    () => "processing the next item now"
  );

  expect(feed(lines)).toBe(true);
});

test("trips on a templated repetition loop (varying last word)", () => {
  const verbs = [
    "aligning",
    "positioning",
    "placing",
    "putting",
    "setting",
    "laying",
    "resting",
    "sitting",
    "standing",
    "walking",
    "running",
    "jumping",
    "leaping",
    "hopping",
    "skipping",
    "dancing",
    "moving",
    "going",
    "coming",
    "arriving",
    "departing",
    "leaving",
    "exiting",
    "entering",
    "accessing",
    "reaching",
    "touching",
  ];
  const lines = verbs.map((v) => `I will ensure it is ${v}.`);

  expect(feed(lines)).toBe(true);
});

test("does not trip on normal varied prose", () => {
  const lines = [
    "I will read the existing store module first.",
    "Then I need to add a new filter function.",
    "The component receives props from its parent.",
    "Let me check how the selectors compose together.",
    "After that the test should pass without changes.",
    "The build configuration already targets the browser.",
    "I should keep the types in their own module.",
    "Each column renders its own cards independently.",
    "The search filter is case-insensitive by design.",
    "Wiring the prop through three layers is the plan.",
    "Finally I will run the gate to confirm green.",
    "There are no remaining type errors to fix here.",
  ];

  expect(feed(lines)).toBe(false);
});

test("trips on a LARGE repeated block (period bigger than the window)", () => {
  // A ~40-line block (prose + a re-printed function) — the real "wait, I think I
  // see the issue… let me check the hook again" loop. Its period exceeds WINDOW,
  // so the sliding-window checks can't see it; the global long-line counter must.
  const block = [
    "This looks correct. The state is managed correctly here.",
    "Wait, I think I see the issue now with the useAppState hook.",
    "No, that is not right - useState only initializes state once.",
    "OK, I am going to stop going in circles and check the code.",
    "Let me check the useAppState hook implementation one more time:",
    "export function useAppState(): AppStateController {",
    "  const [state, setState] = useState<IAppState>({",
    "    issues: initialIssues, projects: initialProjects,",
    "    selectedIssueId: null, searchQuery: '', sidebarOpen: true,",
    "  });",
    "  const addIssue = useCallback((issue: NewIssueInput) => {",
    "    const now = new Date().toISOString();",
    "    setState((prev) => ({ ...prev, issues: [...prev.issues] }));",
    "  }, []);",
    "  return { state, addIssue, updateIssue, deleteIssue };",
    "}",
    "This looks correct again. The functions use functional updates.",
    "The state is being managed correctly across every callback here.",
    ...Array.from(
      { length: 24 },
      (_, i) => `Filler reasoning line number ${i}.`
    ),
  ];
  const lines: string[] = [];

  // Repeat the whole block 5 times (period = block.length, well over WINDOW).
  for (let r = 0; r < 5; r += 1) {
    lines.push(...block);
  }

  expect(feed(lines)).toBe(true);
});

test("does not trip on long-form prose with many distinct long lines", () => {
  // 60 distinct, long sentences — a legitimately verbose answer. No single line
  // recurs, so the global counter must stay well under its limit.
  const lines = Array.from(
    { length: 60 },
    (_, i) =>
      `Point ${i}: this is a distinct sentence about a different topic entirely.`
  );

  expect(feed(lines)).toBe(false);
});

test("does not trip on short/trivial lines like braces and blanks", () => {
  const lines = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "}" : ""));

  expect(feed(lines)).toBe(false);
});

test("channels are tracked independently", () => {
  const guard = new StreamGuard();
  let tripped = false;

  // Alternate the same loop line across two channels, 2 times EACH (4 total).
  // Global limit is 3 per channel — 2 stays under; if channels aggregated, 4
  // would trip.
  for (let i = 0; i < 4; i += 1) {
    const channel = i % 2 === 0 ? "content" : "reasoning";

    tripped =
      guard.observe("the same repeated sentence here\n", channel) || tripped;
  }

  expect(tripped).toBe(false);
});

test("trips after three exact long-line repeats (not five)", () => {
  expect(
    feed([
      "The gate flags src/time.ts itself. Let me check the config.",
      "The gate flags src/time.ts itself. Let me check the config.",
      "The gate flags src/time.ts itself. Let me check the config.",
    ])
  ).toBe(true);
});
