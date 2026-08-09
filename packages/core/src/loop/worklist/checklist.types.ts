/** One node in a session-bound project plan checklist. */
export type ChecklistStatus = "pending" | "active" | "done" | "blocked";

/** Advisory item kind — guides decomposition; not an execution mode. */
export type ChecklistItemKind = "investigate" | "create" | "modify" | "test";

export interface IChecklistItem {
  readonly id: string;
  readonly title: string;
  readonly status: ChecklistStatus;
  readonly detail?: string;
  readonly files?: readonly string[];
  /** Hint only — not executed as a harness gate. */
  readonly verify?: string;
  /** Advisory classify for planning (investigate/create/modify/test). */
  readonly kind?: ChecklistItemKind;
  readonly blockedReason?: string;
  readonly updatedAt?: string;
  readonly completedAt?: string;
  readonly children?: readonly IChecklistItem[];
}

/** Full plan document under `.tsforge/worklist/plans/<id>.json`. */
export interface IPlanDocument {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly goal: string;
  readonly activeItemId: string | null;
  readonly updatedAt: string;
  readonly items: readonly IChecklistItem[];
}

export interface IPlanIndexEntry {
  readonly id: string;
  readonly goal: string;
  readonly updatedAt: string;
}

export interface IPlanIndex {
  readonly plans: readonly IPlanIndexEntry[];
}

/** Draft item shape the model may emit (ids/status optional). */
export interface IChecklistItemDraft {
  readonly id?: string;
  readonly title: string;
  readonly status?: ChecklistStatus;
  readonly detail?: string;
  readonly files?: readonly string[];
  readonly verify?: string;
  readonly kind?: ChecklistItemKind;
  readonly blockedReason?: string;
  readonly children?: readonly IChecklistItemDraft[];
}

/** Draft plan JSON from the assistant (before normalize). */
export interface IPlanDraft {
  readonly goal?: string;
  readonly items: readonly IChecklistItemDraft[];
}
