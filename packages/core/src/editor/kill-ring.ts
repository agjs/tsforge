export class KillRing {
  private entries: string[] = [];

  private index = 0;

  push(text: string, opts?: { prepend?: boolean; accumulate?: boolean }): void {
    if (text.length === 0) {
      return;
    }

    const shouldAccumulate = opts?.accumulate ?? false;
    const shouldPrepend = opts?.prepend ?? false;

    if (shouldAccumulate && this.entries.length > 0) {
      this.entries[0] = shouldPrepend
        ? text + (this.entries[0] ?? "")
        : (this.entries[0] ?? "") + text;
    } else {
      this.entries.unshift(text);
      this.index = 0;
    }
  }

  current(): string {
    return this.entries[this.index] ?? "";
  }

  rotate(): void {
    if (this.entries.length === 0) {
      return;
    }

    this.index = (this.index + 1) % this.entries.length;
  }
}
