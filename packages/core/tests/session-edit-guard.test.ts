import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IProvider } from "../src/inference";
import { Session } from "../src/loop";
import type { EditGuard } from "../src/loop/tools";

// A generic guard for this seam test: veto any edit that shrinks the file. This
// verifies editGuard reaches the tool context executeTool uses and reverts —
// independent of the boringstack i18n rule (unit-tested elsewhere).
const shrinkGuard: EditGuard = (file, before, after) =>
  after.length < before.length
    ? { reason: "test-shrink", message: `edit ${file} REJECTED: shrinks file` }
    : null;

const REL = "apps/ui/src/lib/i18n/locales/en/common.json";

const FULL =
  JSON.stringify(
    {
      features: {
        contact: { title: "Contacts", empty: "None.", deleteError: "err" },
      },
    },
    null,
    2
  ) + "\n";

const GUTTED =
  JSON.stringify(
    { features: { contact: { title: "Contacts", empty: "None." } } },
    null,
    2
  ) + "\n";

/** A provider that emits ONE destructive locale edit, then reports done. */
function scriptedDeleteProvider(): IProvider {
  let turn = 0;

  return {
    async complete() {
      turn += 1;

      if (turn === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: "1",
              name: "edit",
              arguments: { file: REL, oldString: FULL, newString: GUTTED },
            },
          ],
        };
      }

      return { content: "done", toolCalls: [] };
    },
  };
}

// The reviewer's concern: editGuard must actually reach the tool context that
// executeTool uses — not just be a config field. This drives a real Session turn
// whose model emits the destructive delete, and asserts the guard reverted it.
test("a Session wired with editGuard vetoes a destructive locale edit end-to-end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-eg-"));

  await Bun.write(join(dir, REL), FULL);

  try {
    const session = await Session.create({
      provider: scriptedDeleteProvider(),
      cwd: dir,
      files: ["**/*"],
      editGuard: shrinkGuard,
    });

    await session.send("gut the locale file");

    // The guard fired through the real tool path and reverted the delete.
    expect(await Bun.file(join(dir, REL)).text()).toBe(FULL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without editGuard the same destructive edit is NOT reverted (guard is the cause)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tsforge-eg-"));

  await Bun.write(join(dir, REL), FULL);

  try {
    const session = await Session.create({
      provider: scriptedDeleteProvider(),
      cwd: dir,
      files: ["**/*"],
    });

    await session.send("gut the locale file");

    // No guard → the delete stands (control that isolates the guard's effect).
    expect(await Bun.file(join(dir, REL)).text()).toBe(GUTTED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
