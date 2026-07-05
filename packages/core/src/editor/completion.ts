/**
 * The `@`-mention completion state machine, extracted from the editor
 * controller so it is unit-testable without stdin: the anchor/query tracking,
 * dropdown navigation, and accept/replace behaviour. The controller feeds it
 * key names and re-queries it after edits; the host-supplied source does the
 * filtering and painting (see IEditorCompletionSource).
 */
import type { EditorBuffer } from "./buffer";
import { graphemes } from "./segments";

/** An `@`-mention completion source, supplied by the host. The editor owns the
 *  query (text after the `@`) and the selected index; the source filters a file
 *  list, paints the dropdown ABOVE the editor block, and tears it down. Keeping
 *  rendering here (not a separate readline overlay) is what stops the picker from
 *  fighting the editor for the input row. */
export interface IEditorCompletionSource {
  /** Filtered, ranked candidate paths for the current query. */
  items(query: string): readonly string[];
  /** Paint the dropdown for `items` with `selected` highlighted. */
  render(items: readonly string[], selected: number): void;
  /** Tear the dropdown down. */
  clear(): void;
}

export interface ICompletionDeps {
  buffer: EditorBuffer;
  source: IEditorCompletionSource | undefined;
  /** Repaint the editor block (called after an accept mutates the buffer). */
  repaint: () => void;
  /** Notify the host the buffer changed (after an accept). */
  notifyChange: () => void;
}

export interface ICompletionController {
  /** True while the dropdown is open. */
  isOpen(): boolean;
  /** Open the dropdown anchored at the CURRENT cursor (right after the `@`). */
  open(): void;
  /** Recompute the dropdown for the current query, or close it if the cursor
   *  left the mention (moved before the `@`, onto another line, or typed
   *  whitespace — paths contain none). */
  refresh(): void;
  close(): void;
  /** While the dropdown is open it owns navigation/accept/cancel keys. Returns
   *  true if the key was consumed (so normal editing is skipped). */
  handleKey(name: string): boolean;
}

export function createCompletion(deps: ICompletionDeps): ICompletionController {
  const { buffer, source, repaint, notifyChange } = deps;
  // The cursor position right AFTER the `@` (the query anchor) and the
  // highlighted row. null when the dropdown is closed.
  let state: {
    anchorLine: number;
    anchorCol: number;
    selected: number;
  } | null = null;

  /** The query typed after the `@` (anchor → cursor on the anchor line). */
  function query(): string {
    if (state === null) {
      return "";
    }

    const { line, col } = buffer.getCursor();

    if (line !== state.anchorLine || col < state.anchorCol) {
      return "";
    }

    const lineText = buffer.getText().split("\n")[line] ?? "";

    return graphemes(lineText).slice(state.anchorCol, col).join("");
  }

  function close(): void {
    if (state === null) {
      return;
    }

    state = null;
    source?.clear();
  }

  function refresh(): void {
    if (state === null || source === undefined) {
      return;
    }

    const { line, col } = buffer.getCursor();

    if (line !== state.anchorLine || col < state.anchorCol) {
      close();

      return;
    }

    const q = query();

    if (/\s/u.test(q)) {
      close(); // a space ends the mention (paths contain none)

      return;
    }

    const items = source.items(q);

    state.selected = Math.max(0, Math.min(state.selected, items.length - 1));
    source.render(items, state.selected);
  }

  function open(): void {
    if (source === undefined) {
      return;
    }

    const { line, col } = buffer.getCursor();

    state = { anchorLine: line, anchorCol: col, selected: 0 };
    refresh();
  }

  function move(delta: number): void {
    if (state === null) {
      return;
    }

    state.selected = Math.max(0, state.selected + delta);
    refresh();
  }

  /** Accept the highlighted candidate: replace the typed query with `<path> `
   *  (the `@` stays — it's part of the at-mention syntax). */
  function accept(): void {
    if (state === null || source === undefined) {
      return;
    }

    const items = source.items(query());
    const pick = items[state.selected];

    if (pick === undefined) {
      close();

      return;
    }

    const { col } = buffer.getCursor();
    const remove = Math.max(0, col - state.anchorCol);

    for (let i = 0; i < remove; i += 1) {
      buffer.deleteBackward();
    }

    buffer.insert(`${pick} `);
    close();
    repaint();
    notifyChange();
  }

  function handleKey(name: string): boolean {
    if (state === null) {
      return false;
    }

    if (name === "up") {
      move(-1);

      return true;
    }

    if (name === "down") {
      move(1);

      return true;
    }

    if (name === "return" || name === "tab") {
      accept();

      return true;
    }

    if (name === "escape") {
      close();

      return true;
    }

    return false;
  }

  return {
    isOpen: (): boolean => state !== null,
    open,
    refresh,
    close,
    handleKey,
  };
}
