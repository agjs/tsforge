export interface ISnapshot {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

export class UndoStack {
  private undoStack: ISnapshot[] = [];
  private redoStack: ISnapshot[] = [];

  push(s: ISnapshot): void {
    this.undoStack.push(structuredClone(s));
    this.redoStack = [];
  }

  undo(cur: ISnapshot): ISnapshot | null {
    if (this.undoStack.length === 0) {
      return null;
    }

    this.redoStack.push(structuredClone(cur));
    const snapshot = this.undoStack.pop();

    return snapshot ?? null;
  }

  redo(): ISnapshot | null {
    if (this.redoStack.length === 0) {
      return null;
    }

    const snapshot = this.redoStack.pop();

    return snapshot ?? null;
  }
}
