/**
 * Harness for the real-pty /config e2e (scripts/e2e-config-pty.py): runs the actual
 * `runConfigCommand` interactive flow against `$TSFORGE_HOME/.tsforge/models.json`
 * (set by the driver to a temp dir). suspend/resume are no-ops here (no REPL editor
 * in this harness); reconfigure just prints so the driver can assert the hot-swap.
 */
import { runConfigCommand } from "../src/cli/config-menu";

const result = await runConfigCommand({
  color: false,
  activeName: "stub",
  suspend: () => undefined,
  resume: () => undefined,
  reconfigure: (entry) => {
    process.stdout.write(`\nRECONFIG ${entry.model}\n`);
  },
});

process.stdout.write(`\nRESULT ${JSON.stringify(result)}\n`);
