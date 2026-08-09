import { listSessions, type ISessionRecord } from "../session-store";
import { runInlineMenu, type IMenuRowData } from "../render/inline-menu";

export interface ISessionMenuDeps {
  readonly cwd: string;
  readonly render: (lines: readonly string[]) => void;
  readonly close: () => void;
  /** Pane-safe transcript write (never raw stdout under PaneScreen). */
  readonly out: (s: string) => void;
  readonly columns?: number;
  readonly viewportRows?: number;
}

/** First user message, collapsed to one line for label/describe. */
function sessionSnippet(record: ISessionRecord): string {
  const firstUser =
    record.messages.find((m) => m.role === "user")?.content ?? "";

  return firstUser.replace(/\s+/g, " ").trim();
}

/** Map saved sessions → overlay rows (id + msg count + prompt snippet). */
export function sessionRows(
  sessions: readonly ISessionRecord[]
): IMenuRowData[] {
  return sessions.map((s) => {
    const snippet = sessionSnippet(s);

    return {
      id: s.id,
      label: s.id,
      hint: `${String(s.messages.length)} msgs`,
      describe:
        snippet.length > 0
          ? snippet
          : "(empty session — resume with tsforge --resume <id>)",
    };
  });
}

/**
 * Browse saved sessions in the pane overlay (same chrome as /help, recipes).
 * Enter echoes a resume hint into the transcript; Esc closes.
 * Non-TTY / empty → plain `out` lines (never raw stdout under PaneScreen).
 */
export async function openSessionsMenu(deps: ISessionMenuDeps): Promise<void> {
  const sessions = await listSessions(deps.cwd);

  if (sessions.length === 0) {
    deps.out("no saved sessions for this directory\n");

    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    for (const s of sessions) {
      const snippet = sessionSnippet(s).slice(0, 48);

      deps.out(
        `  ${s.id}  ${String(s.messages.length).padStart(3)} msgs  ${snippet}\n`
      );
    }

    return;
  }

  const rows = sessionRows(sessions);
  const selected = await runInlineMenu(rows, {
    title: "sessions",
    render: deps.render,
    close: deps.close,
    columns: deps.columns,
    viewportRows: deps.viewportRows,
  });

  if (selected === null) {
    return;
  }

  const picked = sessions[selected];

  if (picked === undefined) {
    return;
  }

  deps.out(
    `  resume: tsforge --resume ${picked.id}  ·  ${String(picked.messages.length)} msgs\n`
  );
}
