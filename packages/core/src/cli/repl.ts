/**
 * The interactive REPL: a persistent gate-anchored conversation. Owns the
 * status bar, the multi-line editor / readline fallback, the slash-command
 * dispatcher, plan-mode flow, and the inline overlays (palette, @ picker,
 * /config, /help). Extracted from cli.ts; the entry point stays `repl(args)`.
 */
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { formatHelp, takesArg } from "./commands";
import { resolveInitialPlanMode } from "./plan-default";
import { modeById, nextMode } from "./modes";
import { runConfigMenu } from "./config-menu";
import { runCapabilityMenu } from "./capability-menu";
import { openScaffoldInRepl } from "./repl-scaffold";
import { openRecipePicker } from "./repl-recipe";
import { pickCommand, type IPaletteView } from "../render/command-menu";
import {
  pickFileInline,
  filterFiles,
  formatCompletionRows,
  shouldOpenAtPicker,
  type IPickerView,
} from "../render/file-menu";
import { listWorkspaceFiles } from "../lib/fs";
import { composeMessage } from "../loop/prompt";
import { resolveImageInput } from "./image-input";
import { resolveImageCapabilityFlags } from "../loop/tools/image-tools";
import {
  captureClipboardImageToFile,
  readClipboardText,
  discardClipboardImages,
} from "../lib/clipboard/clipboard-image";
import {
  detectImageProtocol,
  renderInlineImage,
  makeImageBudget,
} from "../render/terminal-image";
import {
  Session,
  PLAN_APPROVED_NOTE,
  type Reporter,
  type ILoopEvent,
} from "../loop";
import { loadRecipes } from "../config/recipes";
import { loadAgentSpecs } from "../config/agent-specs";
import {
  loadTsforgeConfig,
  resolveAgentConcurrency,
} from "../config/tsforge-config";
import { makeSpawnAgentFn } from "./spawn-runner";
import { scopeOf, WHOLE_REPO, resolveCliProfile, type ICliArgs } from "./args";
import { isPolicyMode } from "../policy";
import { startEditor, type IEditorHandle } from "../editor";
import { renderEditor } from "../editor/view";
import { flags } from "../config/flags";
import type { OpenAICompatibleProvider } from "../inference";
import type { IModelEntry } from "../models-config";
import {
  renderStatus,
  userBubble,
  agentCardTop,
  agentCardBottom,
  agentBar,
  makeAgentRail,
  StatusBar,
  MIN_ROWS,
  STYLE,
  paint,
  PROMPT_COLS,
  renderAgentTree,
  AgentTreeModel,
  type IStatusInfo,
  type IAgentRow,
} from "../render";
import { loadLedger, activeRules, forgetMemory } from "../loop/memory";
import { buildCoreFix } from "../gate";
import {
  saveSession,
  latestSession,
  loadSession,
  pruneSessions,
  type ISessionRecord,
} from "../session-store";
import {
  currentVersion,
  getUpdateNotice,
  refreshUpdateCacheInBackground,
} from "../update-check";
import {
  spinner,
  outputRouter,
  makeReporter,
  resolveLogPath,
  observeEvents,
} from "./logging";
import {
  modelInfo,
  detectContextWindow,
  envNumber,
  providerConfig,
  makeProvider,
  warnDefaultModelOnRemote,
  runModelCommand,
  modelForRun,
} from "./model-setup";
import {
  scopeLabel,
  planHint,
  printHeader,
  maybePrintNoConfigHint,
} from "./banner";
import { resolveGate } from "./gate-setup";
import {
  printSessions,
  turnsToGreenLine,
  runMapCommand,
  runReviewCommand,
  runTraceCommand,
} from "./repl-commands";

/** A unique-enough id for a new session (time + a little randomness). */
function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Wide approval — the staged-web checkpoint explicitly prompted "type
 *  'approve'", so casual yeses count there. */
export function isApproval(line: string): boolean {
  return /^(approve|approved|ok|okay|yes|y|go|lgtm)\.?$/i.test(line.trim());
}

/** Narrow approval — GENERAL plan mode, where the model asks clarifying
 *  questions: a "yes" may ANSWER a question, so only unambiguous approval
 *  words exit the mode and start implementing. */
export function isPlanApproval(line: string): boolean {
  return /^(approve|approved|go|lgtm|implement)[.!]?$/i.test(line.trim());
}

// The /help body is generated from the command registry (src/cli/commands.ts) so
// the help text and the interactive `/` palette can never drift.
const HELP = formatHelp();

/** Initialize the REPL session: resolve model, gate, context window, and create
 *  the session object. Returns the session, provider, and config metadata.
 *  Extracted to reduce repl() cognitive complexity. */
async function initReplSession(args: ICliArgs): Promise<{
  session: Session;
  provider: OpenAICompatibleProvider;
  activeName: string;
  contextWindow: number;
  id: string;
  gateLabel: string;
  logFile: string;
  persist: () => Promise<void>;
  report: Reporter;
  resumed: ISessionRecord | null;
  files: string[];
  activeModelEntry: IModelEntry;
}> {
  const activeModel = await modelForRun(args);
  const provider = makeProvider(activeModel.entry);
  const activeName = activeModel.name;

  warnDefaultModelOnRemote(activeModel.entry);

  // Best-effort cleanup of stale sessions on every launch.
  await pruneSessions();

  // --resume <id> loads a specific session; --continue the newest for this dir.
  const resumed =
    args.resumeId.length > 0
      ? await loadSession(args.resumeId)
      : args.continue
        ? await latestSession(args.dir)
        : null;

  if ((args.continue || args.resumeId.length > 0) && resumed === null) {
    process.stdout.write("(no matching saved session — starting fresh)\n");
  }

  const id = resumed?.id ?? newSessionId();
  const { accept, gateLabel, lintFile } = await resolveGate(args, resumed);
  const files = resumed !== null ? resumed.files : scopeOf(args);
  const logFile = resolveLogPath(id, args.log);

  if (logFile.length > 0) {
    process.stdout.write(`  ↳ logging this run to ${logFile}\n`);
  }

  // Scout seeds a one-shot drive-to-green run's first prompt; interactive sessions
  // gather context conversationally, so it doesn't apply here. Say so rather than
  // silently ignore the flag.
  if (args.scout) {
    process.stdout.write(
      '  ↳ note: --scout applies to one-shot runs (tsforge "task" --files … --scout); ignored in interactive mode\n'
    );
  }

  const thinkingTokenBudget = envNumber("TSFORGE_THINKING_BUDGET");
  // Auto-compaction threshold (fraction of the window); session default 0.8.
  const autoCompactAt = envNumber("TSFORGE_COMPACT_AT");
  // The model's real context window: explicit env wins, else ask the server
  // (max_model_len), else a conservative fallback. Drives the status gauge AND
  // auto-compaction (the session compacts before a send once it nears the window).
  const contextWindow =
    activeModel.entry.contextWindow ??
    envNumber("TSFORGE_CONTEXT_WINDOW") ??
    (await detectContextWindow(provider.config)) ??
    32_768;
  const report = makeReporter(logFile, id, id);
  const profile = resolveCliProfile(args.profile);
  const config = {
    provider,
    cwd: args.dir,
    files,
    accept,
    contextWindow,
    report,
    // PER-WRITE lint moat (eslint rules per file as it's written), so violations
    // surface immediately instead of piling up at the end-of-turn gate.
    ...(lintFile === undefined ? {} : { lintFile }),
    ...(resumed === null ? {} : { history: resumed.messages }),
    scaffoldWeb: true,
    fix: buildCoreFix(),
    ...(thinkingTokenBudget === undefined ? {} : { thinkingTokenBudget }),
    ...(autoCompactAt === undefined ? {} : { autoCompactAt }),
    // `--policy-mode` (validated) overrides the config file's policy.mode.
    ...(isPolicyMode(args.policyMode) ? { policyMode: args.policyMode } : {}),
    ...(profile === undefined ? {} : { profile }),
    // Thinking OFF for interactive replies so they STREAM immediately instead of
    // stalling on a long hidden chain-of-thought (qwen-local defaults thinking on).
    // The session still flips thinking ON automatically while repairing gate errors.
    enableThinking: false,
  };

  const session = await Session.create(config);

  // A self-describing run-meta line at the top of the --log so the analyzer knows
  // which model / context window the metrics are against (the thread's advice:
  // many "model failures" are really quant/config failures — record the config).
  report({
    kind: "start",
    task: "session",
    message: `model ${modelInfo(provider.config).model} · context window ${contextWindow}`,
    model: modelInfo(provider.config).model,
    contextWindow,
  });

  const persist = async (): Promise<void> => {
    await saveSession({
      id,
      cwd: args.dir,
      // The LIVE gate/scope — not the startup constants. /gate, /files, and a web
      // scaffold all mutate these mid-session; persisting the originals would
      // silently restore stale settings on --continue. See P2 review.
      accept: session.gate,
      files: session.scope,
      updatedAt: Date.now(),
      planMode: false, // will be set by caller
      messages: [...session.messages],
    });
  };

  return {
    session,
    provider,
    activeName,
    contextWindow,
    id,
    gateLabel,
    logFile,
    persist,
    report,
    resumed,
    files,
    activeModelEntry: activeModel.entry,
  };
}

/** Interactive REPL: a persistent gate-anchored conversation. */
export async function repl(args: ICliArgs): Promise<number> {
  // Interactive sessions get web tools ON by default (an assistant that can't look
  // things up is silly). Only a DEFAULT — an explicit TSFORGE_WEB (incl. "0") wins,
  // and one-shot/headless/eval never run this path, so they stay offline+deterministic.
  process.env.TSFORGE_WEB ??= "1";

  const {
    session: initialSession,
    provider,
    activeName: initialActiveName,
    contextWindow: initialContextWindow,
    id,
    gateLabel: initialGateLabel,
    logFile,
    resumed,
    files,
    activeModelEntry,
  } = await initReplSession(args);

  // Load delegation inputs HERE — before readline is created below. Any `await`
  // between `createInterface` and the `rl.on("line")` listener would yield the
  // event loop with readline live but unlistened, dropping the first typed line
  // (a real pty regression the e2e caught). All boot IO must finish up front.
  const agentSpecs = await loadAgentSpecs(args.dir, (m) =>
    process.stdout.write(`  ↳ ${m}\n`)
  );
  const delegationConfig = await loadTsforgeConfig(args.dir);
  // Which image capabilities are configured — decides whether read_image /
  // generate_image are offered and whether attached images get described.
  // Resolved up front (a boot IO), so the wiring below stays synchronous.
  const imageCaps = await resolveImageCapabilityFlags();

  let session = initialSession;
  let activeName = initialActiveName;
  let contextWindow = initialContextWindow;
  // A human label for the gate (e.g. "strict TypeScript / project lint"), shown in
  // the header + /config instead of the raw multi-line command. Updated when the
  // user sets a gate via /config.
  let gateLabel = initialGateLabel;

  const persist = async (): Promise<void> => {
    await saveSession({
      id,
      cwd: args.dir,
      // The LIVE gate/scope — not the startup constants. /gate, /files, and a web
      // scaffold all mutate these mid-session; persisting the originals would
      // silently restore stale settings on --continue. See P2 review.
      accept: session.gate,
      files: session.scope,
      updatedAt: Date.now(),
      planMode,
      messages: [...session.messages],
    });
  };

  // "update available" notice: read from the local cache (no network on the hot
  // path) and refresh it in the background for next time. Gated to interactive,
  // non-CI sessions inside update-check, so eval/headless runs are unaffected.
  const updateNotice = await getUpdateNotice(currentVersion());

  refreshUpdateCacheInBackground();

  printHeader({
    dir: args.dir,
    id,
    gateLabel,
    files,
    resumed,
    model: modelInfo(provider.config),
    updateNotice,
  });

  maybePrintNoConfigHint(args.dir, resumed);

  // Pin an editable input row only on a real TTY tall enough to host the bar.
  // In that mode readline does line-EDITING but must not RENDER (we paint the
  // row ourselves), so it gets a discard sink for output; otherwise it writes to
  // stdout as before (pipes, small terminals — behaviour unchanged).
  const useInputRow =
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.stdout.rows >= MIN_ROWS;

  // In editor mode, do NOT create readline — the editor owns stdin exclusively.
  // In fallback mode (non-TTY or basicInput), readline is the only consumer.
  const useEditor = useInputRow && !flags.basicInput();

  const inputSink = new Writable({
    write(_chunk, _enc, cb): void {
      cb();
    },
  });

  const rl = useEditor
    ? null
    : createInterface({
        input: process.stdin,
        output: useInputRow ? inputSink : process.stdout,
        terminal: true,
      });

  // Ctrl-C: while a turn is running, abort it and return to the prompt; while
  // idle at the prompt, quit. (readline emits SIGINT on the interface, so the
  // process isn't killed — we decide what it means.)
  let active: AbortController | null = null;
  // Lines typed WHILE a run is in flight — drained at each turn boundary to steer
  // the model (see Session.send `steer`), instead of blocking until the run ends.
  const pending: string[] = [];

  if (rl !== null) {
    rl.on("SIGINT", () => {
      if (active !== null) {
        active.abort();
      } else {
        rl.close();
      }
    });
  }

  // Plan mode is the DEFAULT for a fresh interactive session (opt out with
  // `--no-plan` or an explicit non-plan `--policy-mode`/config `policy.mode`).
  // For a staged web build it pauses after the design phase to review the plan;
  // for EVERYTHING else it is the general read-only mode: the agent explores,
  // asks clarifying questions, and proposes a plan — only an explicit approval
  // unlocks tools and implements. A resumed session restores its saved mode
  // (the read-only guarantee must survive `--continue`).
  let planMode = resolveInitialPlanMode(
    args,
    resumed?.planMode,
    session.basePolicyMode
  );
  // True once a plan-mode exchange has happened, so a stray "approve" before any
  // discussion is just a message, not an approval.
  let planDiscussed = false;
  // The current interactive mode (Shift+Tab cycles it; /plan toggles it). Kept in
  // sync with `planMode`; shown as a chip in the status bar.
  let currentModeId = planMode ? "plan" : "normal";

  session.setPlanMode(planMode);

  if (planMode) {
    const chip = paint("◆ plan mode (default)", STYLE.brand + STYLE.bold, true);
    const body = paint(
      "— I'll explore and propose a plan; reply",
      STYLE.dim,
      true
    );
    const approve = paint("approve", STYLE.green + STYLE.bold, true);
    const tail = paint("to build", STYLE.dim, true);

    process.stdout.write(`  ${chip} ${body} ${approve} ${tail}\n`);
  }

  // Model-driven delegation: the orchestrator can spawn read-only specialist
  // subagents via the `spawn_agent` tool — the user never names an agent.
  // Specialists ship built-in (explore/research/verify/review-lens); a
  // project/global `.tsforge/agents/*.json` extends or overrides them.
  // Build the delegation runner from the specs/config loaded up front (sync — no
  // await here, so readline's line listener attaches in the same tick as the
  // rest of the interactive setup; see the load site above).
  const delegationCap = resolveAgentConcurrency(delegationConfig);
  const spawnAgentFn = makeSpawnAgentFn({
    specs: agentSpecs,
    cwd: args.dir,
    concurrency: delegationCap,
    // Subagents auto-compact against the same window as the main loop, so a
    // long read-only investigation never overflows and 400s.
    contextWindow,
    policyMode: isPolicyMode(args.policyMode)
      ? args.policyMode
      : (delegationConfig.policy?.mode ?? "default"),
    ...(delegationConfig.policy?.rules === undefined
      ? {}
      : { policyRules: delegationConfig.policy.rules }),
    ...(args.model.length > 0 ? { defaultModel: args.model } : {}),
    // Reuse the session's TS LanguageService across subagents (read lazily so it
    // tracks the current session after /clear) instead of building one per child.
    getTsService: () => session.tsService,
  });

  // Re-applied after `/clear` rebuilds the session (like setSetupWeb). Skipped
  // entirely under TSFORGE_NO_DELEGATION — the A/B control arm / pure single-stream.
  const delegationOff = flags.noDelegation();

  const wireDelegation = (): void => {
    if (delegationOff) {
      return;
    }

    session.setDelegation(agentSpecs, spawnAgentFn);
  };

  wireDelegation();

  // Image capabilities: offer read_image/generate_image when their backends are
  // configured, and wire the inline preview for generated images. The preview
  // emits the terminal's inline-image escape (iTerm2 today) via the StatusBar
  // stream so the pinned bar re-anchors below it; unsupported terminal → no-op
  // (the tool still reports the saved path).
  // A small budget stops a runaway loop from flooding the scrollback. Re-applied
  // after /clear (like setSetupWeb/wireDelegation) since /clear rebuilds session.
  const imageProtocol = detectImageProtocol();
  const imageBudget = makeImageBudget();
  // Absolute temp-file paths captured from the clipboard (Ctrl+V of image bytes),
  // consumed (described + cleared) on the next send by resolveImageInput.
  const pendingImages: string[] = [];

  // Ctrl+V in the editor: a clipboard IMAGE becomes a `[image #N]` chip + a pending
  // attachment (described on send); otherwise fall back to pasting clipboard text.
  // (Cmd+V is swallowed by the terminal — for text it arrives as a bracketed paste;
  // an image on the clipboard never reaches an in-terminal app, hence Ctrl+V.)
  const pasteFromClipboard = async (): Promise<string | null> => {
    // Reading the clipboard shells out (osascript can take ~1s), so show a
    // transient hint above the input so the pause reads as "working", not hung.
    // (Install `pngpaste` to make it instant — the reader prefers it.)
    const hinting = statusBar.active;

    if (hinting) {
      statusBar.setEditorOverlay(["📋 reading clipboard…"]);
    }

    try {
      const captured = await captureClipboardImageToFile();

      if (captured !== null) {
        pendingImages.push(captured);

        return `[image #${String(pendingImages.length)}]`;
      }

      // Nothing to paste (empty clipboard, or only whitespace/newline — which
      // otherwise injected a blank line). Insert only when there's real content.
      const text = await readClipboardText();

      return text.trim().length > 0 ? text : null;
    } finally {
      if (hinting) {
        statusBar.clearEditorOverlay();
      }
    }
  };

  const previewGeneratedImage: NonNullable<
    Parameters<typeof session.setPreviewImage>[0]
  > = ({ path, base64 }) => {
    if (imageProtocol === "none" || !imageBudget.take()) {
      return;
    }

    // `name` is a human-readable filename (base64-encoded into the OSC-1337
    // params), so use the saved file's basename — not the mime type. Split on
    // both separators so a Windows path resolves too.
    const name = path.split(/[\\/]/u).pop() ?? "image";
    const escape = renderInlineImage(base64, imageProtocol, { name });

    if (escape !== null) {
      // Route through the StatusBar stream channel (NOT raw stdout): it commits the
      // content to scrollback and re-anchors the pinned bar/input row at the cursor
      // the terminal left below the image. A raw write left the bar's cursor
      // tracking stale, so it painted over the image (overlapping text). Bracket
      // with newlines so the image sits on its own committed lines.
      statusBar.writeStream(`\n${escape}\n`);
    }
  };

  const wireImages = (): void => {
    session.setImageCapabilities(imageCaps);
    session.setPreviewImage(previewGeneratedImage);
  };

  wireImages();

  if (imageCaps.vision || imageCaps.imageGen) {
    const on = [
      ...(imageCaps.vision ? ["read"] : []),
      ...(imageCaps.imageGen ? ["generate"] : []),
    ].join(" + ");

    process.stdout.write(`  ↳ image: ${on} (drag/@ to attach)\n`);
  }

  // Make the delegation setup visible so the concurrency cap is never a mystery
  // (cap 1 ⇒ subagents run serially; raise agents.concurrency to overlap them).
  if (delegationOff) {
    process.stdout.write("  ↳ delegation: OFF (TSFORGE_NO_DELEGATION)\n");
  } else if (agentSpecs.length > 0) {
    const names = agentSpecs.map((s) => s.id).join(", ");

    process.stdout.write(
      `  ↳ delegation: ${String(agentSpecs.length)} specialists (${names}) · cap ${String(delegationCap)}\n`
    );
  }

  // Last-turn summary, surfaced in the status line shown before each prompt.
  let lastTurns = 0;
  // Turns the last GREEN run took (the loop-efficiency signal shown in /metrics).
  let lastTurnsToGreen: number | null = null;
  let lastElapsedMs = 0;
  let lastStatus = "ready";

  // Run one user-driven exchange: fresh abort controller, time it, record the
  // outcome for the status line, persist. `run` gets the live signal + a steer
  // drain so in-flight user messages reach the model.
  const drive = async (
    run: (opts: { signal: AbortSignal; steer: () => string[] }) => Promise<{
      status: string;
      turns: number;
    }>
  ): Promise<void> => {
    active = new AbortController();
    const started = performance.now();

    lastStatus = "working"; // reflected live on the bar (● working) during the turn
    spinner.start();

    try {
      const result = await run({
        signal: active.signal,
        steer: () => pending.splice(0, pending.length),
      });

      lastTurns = result.turns;

      if (result.status === "done") {
        lastTurnsToGreen = result.turns;
      }

      lastElapsedMs = performance.now() - started;
      lastStatus = result.status;
    } finally {
      spinner.stop();
      active = null;
      // Seal the agent card's `╰` bottom cap the moment streaming ends, so any
      // post-turn hint (plan-mode notice, PLAN review, etc.) lands BELOW the card
      // instead of inside it — which would break the rail. Idempotent.
      closeAgentTurn();
      resetTree(); // clear the live agent tree once the turn's delegation is done
    }

    await persist();
  };

  // Free-text user sends route through here: resolve `@file` mentions to inlined
  // contents (composeMessage) before handing the message to the session. The
  // plan-approval / staged-build sends call session.send directly and are not
  // touched, so only ordinary messages get mention expansion.
  const runSend = (line: string): Promise<void> =>
    drive(async (opts) => {
      // Images the user attached (dragged/quoted paths or @-mentioned image files
      // in the line, plus any clipboard captures) are sent to the vision backend
      // and their descriptions prepended as text — the primary model is text-only.
      // The image tokens are stripped from the line before @-file expansion.
      //
      // Only keep clipboard captures whose `[image #N]` chip SURVIVES in the line
      // (paste is `pendingImages[i]` ↔ chip `#${i+1}`) — a deleted chip / cleared
      // buffer must not smuggle a hidden image into a later send. Consumed and
      // dropped temp files are unlinked so tmpdir doesn't accumulate.
      const captures = pendingImages.map((path, i) => ({
        path,
        chip: `[image #${String(i + 1)}]`,
      }));

      pendingImages.length = 0;
      const kept = captures
        .filter((c) => line.includes(c.chip))
        .map((c) => c.path);
      const dropped = captures
        .filter((c) => !line.includes(c.chip))
        .map((c) => c.path);

      await discardClipboardImages(dropped);

      const { cleanedLine, contextBlock } = await resolveImageInput(
        line,
        args.dir,
        { extraPaths: kept, signal: opts.signal }
      );

      await discardClipboardImages(kept);
      const composed = await composeMessage(args.dir, cleanedLine);

      return session.send(`${contextBlock}${composed}`, opts);
    });

  const dispatch = async (line: string): Promise<void> => {
    // GENERAL plan mode, approval: unlock the tools and implement the plan that
    // is already the latest assistant message. Only an explicit approval word
    // counts ("yes" may be answering one of the model's clarifying questions).
    if (planMode && planDiscussed && isPlanApproval(line)) {
      planMode = false;
      planDiscussed = false;
      session.setPlanMode(false);
      echo("  ✓ plan approved — implementing\n");
      await drive((opts) => session.send(PLAN_APPROVED_NOTE, opts));

      return;
    }

    // GENERAL plan mode, discussion: the agent explores read-only, asks its
    // clarifying questions, and proposes/revises a plan. Stays in plan mode.
    if (planMode) {
      await runSend(line);
      planDiscussed = true;

      const last = session.messages.at(-1);
      const planned =
        last?.role === "assistant" && /^##\s*plan\b/im.test(last.content);

      echo(`\n${planHint(planned)}\n`);

      return;
    }

    // No up-front classifier: the AGENT decides. It calls `scaffold_web` itself
    // when the request is a from-scratch web app, and just answers/edits otherwise
    // (so "render a table in the CLI" is no longer mis-scaffolded as a Vite app).
    await runSend(line);
  };

  // Placeholder declaration for handleHelp; defined after runLine is available.
  let handleHelp: () => Promise<void>;

  // Slash-command dispatch. Returns true to EXIT the REPL. Kept as a closure so
  // it can rebuild `session` (e.g. /clear) and reach config/persist.
  const command = async (line: string): Promise<boolean> => {
    const [verb, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();

    switch ((verb ?? "").toLowerCase()) {
      case "exit":
      case "quit":
        return true;
      case "help":
        await handleHelp();
        break;

      case "clear": {
        // Rebuild the session with the current state (config is not reused;
        // repl's /clear creates a fresh Session.create call)
        const profile = resolveCliProfile(args.profile);

        session = await Session.create({
          provider,
          cwd: args.dir,
          files: session.scope,
          accept: session.gate,
          contextWindow,
          report: makeReporter(logFile, id, id),
          enableThinking: false,
          ...(profile === undefined ? {} : { profile }),
        });
        wireDelegation(); // re-offer spawn_agent on the rebuilt session
        wireImages(); // re-offer read_image/generate_image + preview on the rebuild
        // Drop any un-sent clipboard captures — /clear wipes the buffer (and its
        // chips), so their temp files are now orphaned.
        void discardClipboardImages(pendingImages.splice(0));
        session.setPlanMode(planMode); // a /clear must not silently drop the mode
        planDiscussed = false;
        await persist();
        clearScreen(); // wipe the visible terminal + scrollback, not just the state
        process.stdout.write("conversation cleared\n");
        break;
      }

      case "compact": {
        // Compaction is a full model round-trip (can take many seconds). Drive the
        // SAME live-activity path a turn uses: lastStatus → "● working" on the bar,
        // spinner.start() runs the tick timer whose onTick repaints the bar with the
        // "⠋ compacting · Ns" activity segment (the inline spinner is suppressed in
        // the REPL, so the bar IS the loader). ALWAYS restore + stop, even on a
        // provider error, so the prompt comes back clean and idle.
        lastStatus = "working";
        spinner.start();
        spinner.setLabel("compacting");

        try {
          const { before, after } = await session.compact();

          await persist();
          process.stdout.write(`compacted ${before} → ${after} messages\n`);
        } finally {
          spinner.stop();
          lastStatus = "ready";
        }

        break;
      }

      case "plan":
        togglePlanMode();
        break;

      case "gate":
        session.setGate(arg);
        process.stdout.write(
          arg.length > 0 ? `gate: ${arg}\n` : "gate cleared\n"
        );
        // Persist immediately so a `/gate` change survives even if the user quits
        // before the next send (persist otherwise only runs after a turn).
        await persist();
        break;

      case "review":
        await runReviewCommand(provider, args.dir, arg);
        break;

      case "map":
        await runMapCommand(args.dir, arg);
        break;

      case "trace":
        await runTraceCommand(arg, logFile);
        break;

      case "config":
        await handleConfig();
        break;

      case "setup": {
        const { runSetup } = await import("../setup/run-setup");

        // runSetup prints its own apply/cancel summary — don't add a second,
        // possibly-misleading line (it would claim success even on cancel).
        await runSetup({
          cwd: args.dir,
          yes: false,
          color: process.stdout.isTTY,
          // The REPL editor/readline owns stdin — don't let the wizard pause it
          // on exit (that would quit the whole process).
          manageInput: false,
        });
        break;
      }

      case "files": {
        const globs = arg
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

        session.setScope(globs.length > 0 ? globs : WHOLE_REPO);
        process.stdout.write(`scope: ${scopeLabel(session.scope)}\n`);
        await persist();
        break;
      }

      case "model": {
        const result = await runModelCommand({
          arg,
          provider,
          activeName,
          fallbackEntry: activeModelEntry,
          contextWindow,
        });

        activeName = result.activeName;
        contextWindow = result.contextWindow;
        // Keep auto-compaction in sync with the new model's window — not just the
        // status bar. Otherwise a swap to a smaller model compacts too late.
        session.setContextWindow(contextWindow);
        break;
      }

      case "sessions":
        await printSessions(args.dir);
        break;

      case "memory": {
        if (arg.trim() === "forget") {
          await forgetMemory(args.dir);
          process.stdout.write("  memory cleared for this repo\n");
          break;
        }

        const ledger = await loadLedger(args.dir);

        if (ledger.entries.length === 0) {
          process.stdout.write("  no learned lessons yet\n");
          break;
        }

        const activeNames = new Set(
          activeRules(ledger, Date.now()).map((r) => r.name)
        );

        process.stdout.write(
          `  ${String(ledger.entries.length)} lesson(s), ${String(activeNames.size)} active (● fires · ○ still accruing):\n`
        );

        for (const entry of ledger.entries.slice(0, 20)) {
          const mark = activeNames.has(entry.name) ? "●" : "○";

          process.stdout.write(
            `    ${mark} ${entry.rule} · ${String(entry.hits)} hit(s)\n`
          );
        }

        process.stdout.write("  /memory forget to clear\n");
        break;
      }

      case "cost": {
        const chars = session.messages.reduce(
          (sum, m) => sum + m.content.length,
          0
        );

        process.stdout.write(
          `  ${String(session.messages.length)} messages · ~${String(Math.round(chars / 4))} tokens (rough)\n`
        );
        break;
      }

      case "metrics": {
        const m = session.metrics;

        if (m.calls === 0) {
          process.stdout.write("  no model calls yet\n");
        } else {
          process.stdout.write(
            `  ${String(m.calls)} call(s) · ${String(m.promptTokens)} in / ${String(m.completionTokens)} out · ` +
              `${String(m.lastTokensPerSecond)} tok/s last · ${String(m.avgTokensPerSecond)} tok/s avg\n`
          );
        }

        process.stdout.write(turnsToGreenLine(lastTurnsToGreen));

        break;
      }

      default:
        process.stdout.write(`unknown command: ${line} (try /help)\n`);
    }

    return false;
  };

  // Current state as the status surface sees it — shared by the pinned bar and
  // the inline fallback so both show identical content.
  const statusInfo = (): IStatusInfo => ({
    model: modelInfo(provider.config).model,
    contextTokens: session.contextTokens,
    contextWindow,
    turns: lastTurns,
    elapsedMs: lastElapsedMs,
    status: lastStatus,
    scope: scopeLabel(session.scope),
    mode: modeById(currentModeId).label,
    tokensPerSecond: session.metrics.lastTokensPerSecond,
    ...(spinner.frameLabel().length > 0
      ? { activity: spinner.frameLabel() }
      : {}),
  });

  // Pinned bottom status bar when we're on a real terminal; otherwise the bar is
  // inactive and `prompt()` falls back to the inline status line (pipes, --log).
  const statusBar = new StatusBar(process.stdout, true, true, useInputRow);

  // --- live agent tree ------------------------------------------------------
  // When the orchestrator delegates (`spawn_agent`), its subagents render as a
  // live tree pinned above the input row, with the focused agent's streaming
  // output beneath it — so a run is never a black box. Each subagent's output is
  // diverted to a per-agent buffer (via the OutputRouter) instead of interleaving
  // into the transcript; only the orchestrator writes the transcript.
  let agentTree = new AgentTreeModel();
  const agentOutput = new Map<string, string[]>();
  // Every agentId we installed an OutputRouter sink for — tracked separately from
  // agentOutput because a subagent that produces no routed output never gets an
  // agentOutput entry, yet its sink still needs clearing (else it leaks + keeps
  // diverting that id's future chunks away from the transcript).
  const agentSinkIds = new Set<string>();
  let treeFrame = 0;
  let treeActive = false;
  // The detail pane auto-follows the newest running agent; ↑/↓ overrides it.
  let focusedAgentId: string | null = null;
  let userPickedFocus = false;
  const AGENT_DETAIL_LINES = 8;
  // Strip SGR color codes from captured subagent output. Built via fromCharCode
  // so the literal carries no control byte (no-control-regex).
  const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

  const treeCols = (): number =>
    process.stdout.columns > 0 ? process.stdout.columns : 80;

  const detailPane = (rows: readonly IAgentRow[]): string[] => {
    const id = focusedAgentId ?? rows.at(-1)?.id;

    if (id === undefined) {
      return [];
    }

    const label = rows.find((r) => r.id === id)?.label ?? id;
    const width = Math.max(10, treeCols() - 5);
    // Show the last N non-blank lines (the reassembled stream may end on an empty
    // in-progress line; blanks would waste rows in the small pane).
    const lines = (agentOutput.get(id) ?? [])
      .map((l) => l.replace(/\s+$/u, ""))
      .filter((l) => l.length > 0);
    const body =
      lines.length === 0
        ? [paint("    (working…)", STYLE.dim, true)]
        : lines
            .slice(-AGENT_DETAIL_LINES)
            .map((l) => `    ${l.slice(0, width)}`);

    return [paint(`  ↳ ${label}`, STYLE.dim, true), ...body];
  };

  const repaintTree = (): void => {
    if (!statusBar.active) {
      return;
    }

    const rows = agentTree.rows();

    if (rows.length === 0) {
      statusBar.setAgentTree([]);

      return;
    }

    const viewportRows = process.stdout.rows > 0 ? process.stdout.rows : 24;
    const tree = renderAgentTree(rows, {
      columns: treeCols(),
      frame: treeFrame,
      maxRows: Math.max(3, viewportRows - AGENT_DETAIL_LINES - 4),
      ...(focusedAgentId === null ? {} : { selectedId: focusedAgentId }),
    });

    statusBar.setAgentTree([...tree, ...detailPane(rows)]);
  };

  const pushAgentOutput = (agentId: string, text: string): void => {
    const buf = agentOutput.get(agentId) ?? [""];
    // Streaming chunks are small and often newline-free (mid-word), so we can't
    // treat each chunk as a whole line. The LAST buffered entry is the line still
    // in progress: the chunk's first segment continues it, and each embedded
    // newline starts a new line. This reassembles fragments into coherent lines.
    const segments = text.replace(SGR_RE, "").split(/\r?\n/u);

    buf[buf.length - 1] = `${buf[buf.length - 1] ?? ""}${segments[0] ?? ""}`;

    for (let k = 1; k < segments.length; k += 1) {
      buf.push(segments[k] ?? "");
    }

    agentOutput.set(agentId, buf.slice(-200));

    if (agentId === focusedAgentId) {
      repaintTree();
    }
  };

  const feedTree = (event: ILoopEvent): void => {
    const id = event.agentId;

    if (id !== undefined && event.kind === "agent_spawned") {
      // Only DIVERT a subagent's output to the (invisible) detail buffer when the
      // tree can actually render it. With the bar inactive (non-TTY / tiny
      // terminal) we leave the sink unset so output routes to the parent/stdout
      // and stays visible instead of being swallowed.
      if (statusBar.active) {
        outputRouter.setAgentSink(id, (t) => {
          pushAgentOutput(id, t);
        });
        agentSinkIds.add(id);
      }

      treeActive = true;
    }

    if (
      id !== undefined &&
      event.kind === "agent_started" &&
      !userPickedFocus
    ) {
      focusedAgentId = id; // auto-follow the newest running agent
    }

    if (
      event.kind === "agent_spawned" ||
      event.kind === "agent_started" ||
      event.kind === "agent_result"
    ) {
      agentTree.applyEvent(event);
      repaintTree();
    }
  };

  // Move the detail-pane focus between rows (↑/↓ while agents run).
  const moveTreeFocus = (delta: number): void => {
    const rows = agentTree.rows();

    if (rows.length === 0) {
      return;
    }

    // Start from the CURRENTLY-shown row: when nothing is explicitly picked yet
    // the pane auto-follows the last row, so resolve that same id first — else the
    // first ↑/↓ would jump to row 0 instead of stepping from what's on screen.
    const activeId = focusedAgentId ?? rows.at(-1)?.id;
    const current = rows.findIndex((r) => r.id === activeId);
    const base = current < 0 ? rows.length - 1 : current;
    const next = Math.min(rows.length - 1, Math.max(0, base + delta));

    focusedAgentId = rows[next]?.id ?? null;
    userPickedFocus = true;
    repaintTree();
  };

  // Fresh tree next turn; drop the per-agent sinks so output routes normally.
  const resetTree = (): void => {
    if (!treeActive) {
      return;
    }

    // Clear EVERY sink we installed (not just ids with buffered output — an agent
    // that streamed nothing still has a live sink that would otherwise leak).
    for (const id of agentSinkIds) {
      outputRouter.clearAgentSink(id);
    }

    agentSinkIds.clear();
    agentOutput.clear();
    agentTree = new AgentTreeModel();
    focusedAgentId = null;
    userPickedFocus = false;
    treeActive = false;
    statusBar.clearAgentTree();
  };

  observeEvents(feedTree);

  // Switch the interactive mode (via the extensible registry) and reflect it in
  // the status bar. The single entry point for /plan, Shift+Tab, and startup —
  // so `planMode`, `currentModeId`, and the bar never drift apart.
  const setMode = (id: string): void => {
    const mode = modeById(id);

    mode.apply(session);
    currentModeId = mode.id;
    planMode = mode.id === "plan";
    planDiscussed = false;

    if (statusBar.active) {
      statusBar.update(statusInfo());
    }
  };

  // `/plan` toggles between plan and normal. Extracted so the slash-command
  // dispatcher stays under the cognitive-complexity cap.
  const togglePlanMode = (): void => {
    const turningOn = !planMode;

    setMode(turningOn ? "plan" : "normal");
    process.stdout.write(
      turningOn
        ? "plan mode ON — read-only: the agent explores, asks, and proposes " +
            "a plan; type 'approve' to implement\n"
        : "plan mode OFF\n"
    );
  };

  // `/config` — the in-harness settings hub. Runs as one owned-stdin menu loop;
  // extracted from the dispatcher to keep it under the complexity cap.
  const setEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  };

  const handleConfig = async (): Promise<void> => {
    editorControl?.suspend();
    editorControl?.setInputInert(true);

    try {
      await runConfigMenu({
        color: process.stdout.isTTY,
        suspend: () => {
          editorControl?.suspend();
          editorControl?.setInputInert(true);
        },
        resume: () => {
          editorControl?.setInputInert(false);
          editorControl?.resume();
          editorControl?.getBuffer().setText("");
        },
        reconfigure: (entry) => {
          provider.reconfigure(providerConfig(entry));
        },
        currentModelName: () => activeName,
        onModelChange: (name) => {
          activeName = name;
        },
        currentMode: () => modeById(currentModeId).label,
        setMode,
        getGate: () => gateLabel,
        setGate: (cmd) => {
          const trimmed = cmd.trim();

          session.setGate(trimmed);
          gateLabel = trimmed.length === 0 ? "none" : trimmed;
        },
        getScope: () => scopeLabel(session.scope),
        setScope: (globs) => {
          const parts = globs
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

          session.setScope(parts.length > 0 ? parts : WHOLE_REPO);
        },
        getEnv: (name) => process.env[name],
        setEnv,
        view: {
          render: (lines) => {
            statusBar.setOverlay(lines, statusInfo());
          },
          close: () => {
            statusBar.clearOverlay(statusInfo());
          },
        },
      });
    } finally {
      editorControl?.setInputInert(false);
      editorControl?.resume();
      editorControl?.getBuffer().setText("");
    }

    if (statusBar.active) {
      statusBar.update(statusInfo());
    }

    await persist();
  };

  // Set once the multi-line editor is created (it lives in a nested scope); the
  // resize handler below calls it so the editor re-wraps/re-windows at the new
  // size instead of clipping the current line at its pre-resize dimensions.
  let resizeEditor: ((columns: number, rows: number) => void) | null = null;
  // The live editor handle, exposed to repl-scope closures (e.g. the `/config`
  // command) so they can suspend/resume its stdin ownership around an overlay
  // wizard — the editor itself is created inside the loop's nested scope.
  let editorControl: IEditorHandle | null = null;

  // Each agent turn renders as a left-accent card: a rounded `╭ <model>` cap, every
  // body line prefixed with the `│ ` rail (wrapping inside it), and a `╰` cap when
  // the turn ends. The cap is emitted once, on the turn's first streamed output.
  // The card's content budget leaves the rail (2) + 2 spare columns, so no terminal
  // — however it treats the right margin — ever wraps a row and drops the rail.
  const railInnerWidth = (): number =>
    (process.stdout.columns > 0 ? process.stdout.columns : 80) -
    PROMPT_COLS -
    2;
  let agentTurnOpen = false;
  let agentRail = makeAgentRail(agentBar(true), railInnerWidth);

  // Route streamed agent output through the bar so it scrolls above the pinned
  // input row; cleared on loop exit so later/headless writes go straight to stdout.
  if (useInputRow) {
    outputRouter.setParentSink((text): void => {
      if (!agentTurnOpen) {
        agentTurnOpen = true;
        agentRail = makeAgentRail(agentBar(true), railInnerWidth); // fresh per turn
        statusBar.writeStream(`\n${agentCardTop(statusInfo().model, true)}\n`);
      }

      statusBar.writeStream(agentRail.feed(text));
    });
  }

  // Start a fresh agent card for each turn (the cap re-emits on its first output).
  const beginAgentTurn = (): void => {
    agentTurnOpen = false;
  };

  // Close the current agent card (rounded bottom cap) once its turn is done. A
  // no-op for turns that produced no streamed output (e.g. slash commands).
  const closeAgentTurn = (): void => {
    if (agentTurnOpen && useInputRow) {
      statusBar.writeStream(`${agentCardBottom(true)}\n`);
      agentTurnOpen = false;
    }
  };

  // Mirror readline's buffer onto the input row after each keypress. setImmediate
  // lets readline update rl.line/rl.cursor first (it processes the key async).
  const syncInput = (): void => {
    if (useInputRow && rl !== null) {
      setImmediate(() => {
        statusBar.setInput(rl.line, rl.cursor);
      });
    }
  };

  // Echo a CLI-side line (queued-steer notice, etc.) into the scroll region so it
  // doesn't clobber the pinned input row; plain write when the row isn't active.
  const echo = (text: string): void => {
    if (useInputRow) {
      statusBar.writeStream(text);
    } else {
      process.stdout.write(text);
    }
  };

  // In the interactive REPL a readline prompt owns stdin for the WHOLE session, so
  // the spinner's carriage-return inline write would clobber whatever the user is
  // typing mid-turn — regardless of whether the pinned bar is active. So suppress
  // the inline write unconditionally here: when the bar is up (≥5 rows) it shows the
  // activity itself via statusInfo; on a sub-5-row TTY there's simply no inline
  // spinner (correct — better silent than corrupting the input line). The default
  // `() => true` gate still applies to any non-interactive spinner use.
  spinner.setInlineGate(() => false);

  // A drag-resize fires SIGWINCH continuously while the terminal reflows. Painting
  // the bar into that moving target strands copies of it (the multi-bar / stray-rule
  // mess a circular corner-drag produced). So we DEBOUNCE: while resizes are still
  // arriving we suppress ALL bar repaints (spinner ticks included) and repaint once,
  // cleanly, only after the size settles (~120ms of quiet).
  const RESIZE_SETTLE_MS = 120;
  let resizing = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  // Repaint the bar on every spinner tick so tok/s and the context meter update
  // live mid-turn (both read live session state) — but NOT during a resize storm.
  spinner.onTick(() => {
    if (statusBar.active && !resizing) {
      statusBar.update(statusInfo());

      // Advance the tree's spinner so running agent rows animate in step.
      if (treeActive) {
        treeFrame += 1;
        repaintTree();
      }
    }
  });

  // Named so it can be detached on loop exit (an anonymous listener on the
  // global process.stdout would pin the whole REPL closure for the process
  // lifetime). columns/rows are typed `number` here, so no nullish guard is
  // needed; the editor's resize ignores non-positive values regardless.
  const handleResize = (): void => {
    resizing = true;
    statusBar.pauseForResize(); // buffer streamed output; draw nothing mid-storm

    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizing = false;
      resizeTimer = null;
      statusBar.resize(statusInfo());
      // The editor wraps/windows at the dimensions it was created with; without
      // this it keeps using the pre-resize size and can clip the current line.
      resizeEditor?.(process.stdout.columns, process.stdout.rows);
      statusBar.flushStream(); // replay buffered output into the settled region
    }, RESIZE_SETTLE_MS);
  };

  process.stdout.on("resize", handleResize);

  // Restore the terminal even on an unexpected exit (teardown is idempotent).
  process.on("exit", () => {
    statusBar.teardown();
  });

  // Wipe the visible terminal + scrollback (2J + 3J + home), re-pinning the status
  // bar around it so its scroll region stays correct. Used by /clear so the screen
  // is a clean slate, not just the conversation state.
  const clearScreen = (): void => {
    const wasActive = statusBar.active;

    if (wasActive) {
      statusBar.teardown();
    }

    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

    if (wasActive) {
      statusBar.install(statusInfo());
    }
  };

  // The prompt. With the editable input row pinned it's always visible, so we
  // just repaint the bar + row; with the bar (no input row) it shows the inline
  // marker; otherwise it prints the inline status line above the marker.
  const prompt = (): void => {
    if (useInputRow) {
      if (rl !== null) {
        statusBar.setInput(rl.line, rl.cursor);
      }

      statusBar.update(statusInfo());

      return;
    }

    if (statusBar.active) {
      statusBar.update(statusInfo());
      process.stdout.write("\n› ");

      return;
    }

    process.stdout.write("\n");
    process.stdout.write(renderStatus(statusInfo()));
    process.stdout.write("› ");
  };

  await new Promise<void>((resolveLoop) => {
    let editorHandle: IEditorHandle | null = null;
    let busy = false;
    let closed = false;
    let paletteOpen = false;

    // Finish the loop only when stdin has closed AND no run is in flight — so a
    // stdin EOF (piped input / Ctrl-D) never kills a build mid-turn.
    const maybeFinish = (): void => {
      if (closed && !busy) {
        resolveLoop();
      }
    };

    // Submit a line of input: check if busy/pending, echo it, handle /exit, or run it.
    const submitLine = (raw: string): void => {
      const line = raw.trim();

      if (line.length === 0) {
        if (!busy) {
          prompt();
        }

        return;
      }

      // readline's output is sinked in input-row mode, so the submitted line is
      // never echoed to scrollback — record it ourselves so the transcript reads
      // naturally above the (now-cleared) input row.
      if (useInputRow) {
        echo(`\n${userBubble(line, true, process.stdout.columns)}\n`);
      }

      if (busy) {
        if (line === "/exit" || line === "/quit") {
          active?.abort();

          if (rl !== null) {
            rl.close();
          }

          if (editorHandle !== null) {
            editorHandle.close();
          }
        } else {
          pending.push(line);
          echo("  ↳ queued (steers the next turn)\n");
        }

        return;
      }

      void runLine(line);
    };

    // Handle one idle line (slash command or a message), then any queued follow-up.
    const runLine = async (line: string): Promise<void> => {
      busy = true;
      beginAgentTurn(); // the agent's response opens a fresh "▌ <model>" block

      try {
        if (line.startsWith("/")) {
          if (await command(line)) {
            if (rl !== null) {
              rl.close();
            }

            return;
          }
        } else {
          await dispatch(line);
        }
      } catch (err) {
        // A command/turn that throws (e.g. a provider error mid-/compact) must NOT
        // escape: runLine is invoked fire-and-forget (`void runLine(...)`), so an
        // unhandled rejection would terminate the whole REPL — which read as "the
        // CLI just exits". Surface the error and fall through to re-prompt instead.
        spinner.stop(); // belt-and-suspenders: clear any spinner the failed path left running
        echo(`\n⚠ ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        closeAgentTurn(); // seal the agent card's bottom cap before re-prompting
        busy = false;
      }

      // A line typed in the gap after the last steer-drain becomes the next turn.
      const next = pending.shift();

      if (next !== undefined) {
        void runLine(next);

        return;
      }

      if (closed) {
        maybeFinish();
      } else {
        prompt();
      }
    };

    // `/help` — the capability browser. On a TTY, opens an inline dropdown menu;
    // off-TTY, prints the static help text so pipes/logs are unchanged. Extracted
    // to keep cognitive complexity in check.
    const buildHelpDeps = async (): Promise<
      Parameters<typeof runCapabilityMenu>[0]
    > => {
      const suspend = (): void => {
        editorControl?.suspend();
        editorControl?.setInputInert(true);
      };

      const resume = (): void => {
        editorControl?.setInputInert(false);
        editorControl?.resume();
        editorControl?.getBuffer().setText("");
      };

      const hasRecipes = (await loadRecipes(args.dir)).length > 0;

      return {
        color: process.stdout.isTTY,
        hasRecipes,
        runCommand: (c) => {
          // c already includes the leading slash (registry stores "/sessions").
          void runLine(c);
        },
        prefill: (c) => {
          editorControl?.getBuffer().setText(`${c} `);
        },
        openWizard: async (opener) =>
          opener === "scaffold"
            ? openScaffoldInRepl({
                cwd: args.dir,
                suspend,
                resume,
                out: (s) => process.stdout.write(s),
              })
            : openRecipePicker({
                cwd: args.dir,
                render: (lines) => {
                  statusBar.setOverlay(lines, statusInfo());
                },
                close: () => {
                  statusBar.clearOverlay(statusInfo());
                },
                out: (s) => process.stdout.write(s),
                runRecipe: (recipe) => {
                  if (recipe.gate !== undefined) {
                    session.setGate(recipe.gate);
                    gateLabel = recipe.gate;
                  }

                  if (recipe.files !== undefined) {
                    session.setScope([...recipe.files]);
                  }

                  if (recipe.task !== undefined) {
                    void runLine(recipe.task);
                  }
                },
              }),
        render: (lines) => {
          statusBar.setOverlay(lines, statusInfo());
        },
        close: () => {
          statusBar.clearOverlay(statusInfo());
        },
      };
    };

    handleHelp = async (): Promise<void> => {
      if (!process.stdout.isTTY) {
        process.stdout.write(`${HELP}\n`);

        return;
      }

      editorControl?.suspend();
      editorControl?.setInputInert(true);

      try {
        const deps = await buildHelpDeps();

        await runCapabilityMenu(deps);
      } finally {
        editorControl?.setInputInert(false);
        editorControl?.resume();
        editorControl?.getBuffer().setText("");
      }

      if (statusBar.active) {
        statusBar.update(statusInfo());
      }
    };

    // Helper: repaint the editor buffer to the status bar after palette insertion.
    const repaintEditor = (handle: IEditorHandle): void => {
      const { line, col } = handle.getBuffer().getCursor();
      const lines = handle.getBuffer().getText().split("\n");

      const frame = renderEditor(
        {
          lines,
          cursorLine: line,
          cursorCol: col,
        },
        {
          columns: process.stdout.columns,
          // Mirror the editor controller's own repaint window (rows minus the bar
          // block) so wrapping/windowing matches.
          maxRows: Math.max(1, process.stdout.rows - 3),
          color: true,
        }
      );

      // Repaint the editor block IN the pinned live region (setEditor), NOT via
      // writeStream — writeStream treats its argument as conversation content, so
      // it would strand the editor frame in scrollback (a leftover "/" per palette
      // open). This mirrors the editor's renderEditor→setEditor callback.
      statusBar.setEditor(
        frame.frame.split("\n"),
        frame.cursorRow,
        frame.cursorCol
      );
    };

    // Open the interactive `/` command palette: pick a command from a navigable
    // list, then either run it (no-arg) or prefill the line so the user types the
    // argument. Cancel ⇒ back to a clean prompt. Only meaningful on a TTY.
    const openPalette = async (): Promise<void> => {
      paletteOpen = true;
      // Suspend the editor's stdin ownership so the palette's keypress loop owns
      // input (see openFilePicker). Resumed in finally.
      editorHandle?.suspend();

      // Inline palette: paint the command list as an overlay above the input row
      // (no alt-screen), same mechanism as the `@` picker and /help. The live
      // query rides in the overlay title.
      const view: IPaletteView = {
        render: (lines) => {
          statusBar.setOverlay(lines, statusInfo());
        },
        close: () => {
          statusBar.clearOverlay(statusInfo());
        },
      };

      try {
        const picked = await pickCommand(view);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().setText("");

            if (takesArg(picked)) {
              // Prefill "<cmd> " so the user types the argument next.
              editorHandle.getBuffer().insert(`${picked.name} `);
              repaintEditor(editorHandle);
            } else {
              // No-arg command: run it and leave the input EMPTY. Inserting the
              // name would linger in the buffer and reappear on the next keystroke
              // (the "/clear" ghost after the screen is cleared).
              repaintEditor(editorHandle);
              void runLine(picked.name);
            }
          } else if (rl !== null) {
            rl.write(null, { ctrl: true, name: "u" }); // clear the typed "/"

            if (takesArg(picked)) {
              rl.write(`${picked.name} `);
            } else {
              void runLine(picked.name);
            }
          }
        } else if (editorHandle !== null) {
          // Cancel (Esc / backspace-past-empty): drop the lingering trigger "/"
          // so it doesn't stay in the input.
          editorHandle.getBuffer().setText("");
          repaintEditor(editorHandle);
        } else if (rl !== null) {
          rl.write(null, { ctrl: true, name: "u" });
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        if (useInputRow) {
          statusBar.update(statusInfo());

          if (rl !== null) {
            syncInput();
          }
        }
      }
    };

    // Open the interactive `@` file picker: a compact dropdown rendered INLINE just
    // above the input row (the conversation stays visible — no alternate screen),
    // recency-ordered, type to fuzzy-filter. The buffer keeps its `@`; the live
    // query is echoed onto the input row for feedback (it isn't in readline's/editor's
    // buffer — the picker owns input). On select, the full path is appended after
    // the `@`; at send time `@path` expands to the file's contents (see runSend).
    const openFilePicker = async (): Promise<void> => {
      paletteOpen = true;
      // In editor mode the editor owns stdin via a `data` listener; suspend it so
      // the inline picker's own `keypress` loop isn't fighting the editor for every
      // keystroke (both would otherwise consume the same input). Resumed in finally.
      editorHandle?.suspend();

      const base =
        editorHandle !== null
          ? editorHandle.getBuffer().getText()
          : rl !== null
            ? rl.line
            : ""; // text up to and including the just-typed `@`

      const view: IPickerView = {
        render: (query, items, selected): void => {
          const rows = formatCompletionRows(
            items,
            selected,
            process.stdout.columns,
            process.stdout.isTTY
          );

          statusBar.setInput(`${base}${query}`, base.length + query.length);
          statusBar.setOverlay(rows, statusInfo());
        },
        close: (): void => {
          statusBar.clearOverlay(statusInfo());
        },
      };

      try {
        const files = await listWorkspaceFiles(args.dir);
        const picked = await pickFileInline(files, view);

        if (picked !== null) {
          if (editorHandle !== null) {
            editorHandle.getBuffer().insert(`${picked} `);
            repaintEditor(editorHandle);
          } else if (rl !== null) {
            rl.write(`${picked} `);
          }
        }
      } finally {
        paletteOpen = false;

        // Hand stdin back to the editor and repaint its input row (the overlay
        // cleared it). No-op in readline mode (editorHandle is null).
        if (editorHandle !== null) {
          editorHandle.resume();
          repaintEditor(editorHandle);
        }

        if (useInputRow) {
          statusBar.update(statusInfo());

          if (rl !== null) {
            syncInput();
          }
        }
      }
    };

    // `/` on an empty line opens the palette; `@` at a word boundary opens the file
    // picker. The editor handles these internally (via openPalette/openFilePicker deps);
    // readline mode uses keypress detection. The shared paletteOpen guard keeps the
    // two overlays mutually exclusive. No-op while busy.

    if (process.stdin.isTTY && !useEditor && !flags.basicInput()) {
      // Only set up keypress detection for readline mode (not editor mode).
      emitKeypressEvents(process.stdin);
      process.stdin.on(
        "keypress",
        (str: string | undefined, key: { name?: string } | undefined) => {
          // Navigate the live agent tree while subagents run — checked BEFORE the
          // busy guard, because a turn is exactly when the tree is active. ↑/↓
          // move the detail-pane focus between agents.
          if (treeActive && (key?.name === "up" || key?.name === "down")) {
            moveTreeFocus(key.name === "up" ? -1 : 1);

            return;
          }

          syncInput(); // keep the pinned input row in sync as the user types

          if (busy || paletteOpen) {
            return;
          }

          if (str === "/" && rl !== null) {
            setImmediate(() => {
              if (!busy && !paletteOpen && rl.line === "/") {
                void openPalette();
              }
            });
          } else if (str === "@" && useInputRow && rl !== null) {
            // The inline dropdown renders above the input row, so it needs that row
            // (a tall-enough TTY). Without it we skip the picker — `@path` typed by
            // hand still expands at send time (composeMessage), just no live popup.
            setImmediate(() => {
              if (
                !busy &&
                !paletteOpen &&
                shouldOpenAtPicker(rl.line, rl.cursor)
              ) {
                void openFilePicker();
              }
            });
          }
        }
      );
    }

    // Event-driven (not for-await) so stdin is read DURING a run: a line typed
    // mid-run is queued to steer the next turn (or, if "/exit", aborts). This is
    // what makes it feel like a real harness — you can redirect without waiting.
    // When the editor is active, submitLine is wired via onSubmit; otherwise it's
    // called here from readline. Crucially: the editor owns stdin exclusively in
    // editor mode, and readline is NOT created in that case.
    if (useEditor) {
      // Editor-native `@`-completion: preload the workspace file list once, then
      // filter it synchronously as the user types. The dropdown is painted ABOVE
      // the editor block (not the readline input row), so it can't fight the editor
      // for the cursor — the cause of the earlier display corruption.
      let completionFiles: readonly string[] = [];

      void listWorkspaceFiles(args.dir).then((files) => {
        completionFiles = files;
      });

      const editorCompletion = {
        items: (query: string): readonly string[] =>
          filterFiles(completionFiles, query),
        render: (items: readonly string[], selected: number): void => {
          statusBar.setEditorOverlay(
            formatCompletionRows(
              items,
              selected,
              process.stdout.columns,
              process.stdout.isTTY
            )
          );
        },
        clear: (): void => {
          statusBar.clearEditorOverlay();
        },
      };

      editorHandle = startEditor({
        stdin: {
          on: (event: string, cb: (data: string) => void) => {
            process.stdin.on(event, cb);
          },
          removeListener: (event: string, cb: (data: string) => void) => {
            process.stdin.removeListener(event, cb);
          },
          setRawMode: (mode: boolean) => {
            process.stdin.setRawMode(mode);
          },
          resume: () => {
            process.stdin.resume();
          },
          // The editor does string ops per chunk; without UTF-8 encoding,
          // process.stdin emits Buffers and the first keypress crashes.
          setEncoding: () => {
            process.stdin.setEncoding("utf8");
          },
        },
        out: (s: string) => {
          statusBar.writeStream(s);
        },
        // Multi-row editor rendering callback: paints to the pinned input area
        renderEditor: (
          lines: string[],
          cursorRow: number,
          cursorCol: number
        ) => {
          statusBar.setEditor(lines, cursorRow, cursorCol);
        },
        // Reserve the `› ` prompt gutter the StatusBar paints in front of the
        // editor block, so wrapping matches the visible width and the prompt row
        // never exceeds `columns`.
        columns: Math.max(1, process.stdout.columns - PROMPT_COLS),
        rows: process.stdout.rows,
        openPalette,
        openFilePicker,
        completion: editorCompletion,
        pasteFromClipboard,
      });

      resizeEditor = (columns, rows): void => {
        editorHandle?.resize(Math.max(1, columns - PROMPT_COLS), rows);
      };

      editorControl = editorHandle;

      editorHandle.onSubmit(submitLine);
      editorHandle.onInterrupt(() => {
        if (active === null) {
          closed = true;
          editorHandle?.close();
          maybeFinish();
        } else {
          active.abort();
        }
      });
      editorHandle.onExit(() => {
        closed = true;
        editorHandle?.close();
        maybeFinish();
      });
      // Shift+Tab cycles the interactive mode (plan → normal → …).
      editorHandle.onCycleMode(() => {
        setMode(nextMode(currentModeId).id);
      });
      // ↑/↓ on an empty input row navigate the live agent tree (parity with the
      // readline path at the keypress handler above). Consumed only while a tree
      // is active; otherwise the editor keeps the arrows for history/cursor.
      editorHandle.onNavigateTree((delta) => {
        if (!treeActive) {
          return false;
        }

        moveTreeFocus(delta);

        return true;
      });
    } else if (rl !== null) {
      rl.on("line", submitLine);
    }

    rl?.on("close", () => {
      closed = true;
      editorHandle?.close();
      statusBar.teardown();
      observeEvents(null); // stop feeding the agent tree once the REPL is gone
      maybeFinish();
    });

    // Pin the bar before the first turn so it's visible while that turn streams.
    statusBar.install(statusInfo());

    if (args.task.length > 0) {
      void runLine(args.task); // sent as the first message; prompts when done
    } else {
      prompt();
    }
  });

  statusBar.teardown(); // belt-and-suspenders: restore the terminal on loop exit
  process.stdout.off("resize", handleResize); // don't pin the REPL closure
  outputRouter.setParentSink(null); // later/headless writes go straight to stdout again

  return 0;
}
