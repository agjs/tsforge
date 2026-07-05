import { test, expect, describe } from "bun:test";
import { EditorBuffer } from "../src/editor/buffer";
import {
  createCompletion,
  type IEditorCompletionSource,
} from "../src/editor/completion";

/** The @-mention completion state machine extracted from the controller (B3):
 *  these pin the anchor/query tracking, selection clamping, whitespace close,
 *  and the accept-replaces-query-keeps-@ contract WITHOUT stdin. */

interface IFakeSource extends IEditorCompletionSource {
  readonly rendered: { items: readonly string[]; selected: number }[];
  cleared: number;
}

function makeSource(files: readonly string[]): IFakeSource {
  const rendered: { items: readonly string[]; selected: number }[] = [];
  const src: IFakeSource = {
    rendered,
    cleared: 0,
    items: (query) => files.filter((f) => f.includes(query)),
    render: (items, selected) => {
      rendered.push({ items, selected });
    },
    clear: () => {
      src.cleared += 1;
    },
  };

  return src;
}

function setup(files: readonly string[] = ["alpha.ts", "beta.ts"]): {
  buffer: EditorBuffer;
  source: IFakeSource;
  completion: ReturnType<typeof createCompletion>;
  repaints: () => number;
} {
  const buffer = new EditorBuffer();
  const source = makeSource(files);
  let repaints = 0;

  const completion = createCompletion({
    buffer,
    source,
    repaint: () => {
      repaints += 1;
    },
    notifyChange: () => undefined,
  });

  return { buffer, source, completion, repaints: () => repaints };
}

describe("open + query tracking", () => {
  test("opens anchored after the @ and renders the full list", () => {
    const { buffer, source, completion } = setup();

    buffer.insert("@");
    completion.open();

    expect(completion.isOpen()).toBe(true);
    expect(source.rendered.at(-1)?.items).toEqual(["alpha.ts", "beta.ts"]);
  });

  test("typing narrows the query; refresh re-renders the filtered list", () => {
    const { buffer, source, completion } = setup();

    buffer.insert("@");
    completion.open();
    buffer.insert("alp");
    completion.refresh();

    expect(source.rendered.at(-1)?.items).toEqual(["alpha.ts"]);
  });

  test("whitespace in the query closes the dropdown (paths contain none)", () => {
    const { buffer, source, completion } = setup();

    buffer.insert("@");
    completion.open();
    buffer.insert("a b");
    completion.refresh();

    expect(completion.isOpen()).toBe(false);
    expect(source.cleared).toBe(1);
  });

  test("moving the cursor before the anchor closes it", () => {
    const { buffer, completion } = setup();

    buffer.insert("@");
    completion.open();
    buffer.moveLeft(); // now BEFORE the @ anchor
    completion.refresh();

    expect(completion.isOpen()).toBe(false);
  });
});

describe("selection + keys", () => {
  test("down/up move the highlight; it clamps to the list", () => {
    const { buffer, source, completion } = setup();

    buffer.insert("@");
    completion.open();
    expect(completion.handleKey("down")).toBe(true);
    expect(source.rendered.at(-1)?.selected).toBe(1);
    completion.handleKey("down"); // past the end → clamped
    expect(source.rendered.at(-1)?.selected).toBe(1);
    completion.handleKey("up");
    expect(source.rendered.at(-1)?.selected).toBe(0);
  });

  test("keys are NOT consumed while closed", () => {
    const { completion } = setup();

    expect(completion.handleKey("down")).toBe(false);
    expect(completion.handleKey("return")).toBe(false);
  });

  test("escape closes without touching the buffer", () => {
    const { buffer, completion } = setup();

    buffer.insert("@al");
    completion.open();
    expect(completion.handleKey("escape")).toBe(true);
    expect(completion.isOpen()).toBe(false);
    expect(buffer.getText()).toBe("@al");
  });
});

describe("accept", () => {
  test("replaces the typed query with the pick, KEEPS the @, appends a space", () => {
    const { buffer, completion, repaints } = setup();

    buffer.insert("@");
    completion.open();
    buffer.insert("alp");
    completion.refresh();
    completion.handleKey("return");

    expect(buffer.getText()).toBe("@alpha.ts ");
    expect(completion.isOpen()).toBe(false);
    expect(repaints()).toBe(1);
  });

  test("tab accepts too; an empty candidate list just closes", () => {
    const { buffer, completion } = setup([]);

    buffer.insert("@");
    completion.open();
    completion.handleKey("tab");

    expect(buffer.getText()).toBe("@"); // nothing to accept — buffer untouched
    expect(completion.isOpen()).toBe(false);
  });
});
