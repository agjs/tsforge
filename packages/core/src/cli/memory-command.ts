import {
  loadLedger,
  activeRules,
  forgetMemory,
  type IMemoryLedger,
} from "../loop/memory";
import type { Session } from "../loop/session";

/** Minimal surface `/remember` needs — keeps tests free of Session casts. */
export interface IRememberTarget {
  decisionMemoryBankId(): string | null;
  rememberDecision(text: string): Promise<boolean>;
}

/** `/memory`, `/memory forget`, `/remember <text>` — TTSR + decision bank. */
export async function runMemorySlashCommand(
  cwd: string,
  session: Session,
  arg: string,
  write: (text: string) => void
): Promise<void> {
  if (arg.trim() === "forget") {
    await forgetMemory(cwd);
    await session.forgetDecisionMemory();
    write("  memory cleared for this repo\n");

    return;
  }

  const ledger = await loadLedger(cwd);
  const bankId = session.decisionMemoryBankId();
  const decisions = await session.listDecisionMemory();

  write("  coding lessons (Phase 1 → TTSR):\n");

  if (ledger.entries.length === 0) {
    write("    (none yet)\n");
  } else {
    writeCodingLessons(ledger, write);
  }

  write("  project decisions (external provider):\n");
  writeDecisionMemory(bankId, decisions, write);
  write("  /remember <decision> to retain · /memory forget to clear\n");
}

/**
 * `/remember <text>` — explicitly retain a durable product/architecture
 * decision into the configured bank.
 */
export async function runRememberSlashCommand(
  session: IRememberTarget,
  arg: string,
  write: (text: string) => void
): Promise<void> {
  const text = arg.trim();

  if (text.length === 0) {
    write("  usage: /remember <product or architecture decision>\n");

    return;
  }

  if (session.decisionMemoryBankId() === null) {
    write(
      "  decision memory not configured — set providers.memory in tsforge.config.json\n"
    );

    return;
  }

  const ok = await session.rememberDecision(text);

  if (!ok) {
    write("  could not retain that decision\n");

    return;
  }

  write(`  remembered in bank ${session.decisionMemoryBankId() ?? "?"}\n`);
}

function writeCodingLessons(
  ledger: IMemoryLedger,
  write: (text: string) => void
): void {
  const activeNames = new Set(
    activeRules(ledger, Date.now()).map((r) => r.name)
  );

  write(
    `    ${String(ledger.entries.length)} lesson(s), ${String(activeNames.size)} active (● fires · ○ still accruing):\n`
  );

  for (const entry of ledger.entries.slice(0, 20)) {
    const mark = activeNames.has(entry.name) ? "●" : "○";

    write(`      ${mark} ${entry.rule} · ${String(entry.hits)} hit(s)\n`);
  }
}

function writeDecisionMemory(
  bankId: string | null,
  decisions: readonly string[],
  write: (text: string) => void
): void {
  if (bankId === null) {
    write(
      "    (not configured — set providers.memory in tsforge.config.json)\n"
    );

    return;
  }

  write(`    bank: ${bankId}\n`);

  if (decisions.length === 0) {
    write("    (no retained decisions yet)\n");

    return;
  }

  for (const line of decisions.slice(0, 20)) {
    const preview = line.length > 120 ? `${line.slice(0, 119)}…` : line;

    write(`    ● ${preview}\n`);
  }
}
