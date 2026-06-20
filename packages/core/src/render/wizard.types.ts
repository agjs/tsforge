/** One selectable option in a wizard step. `outcome` is shown under the choices
 *  when this option is highlighted (single-select); `note` is a trailing tag
 *  (e.g. "always on", "next dependency found"). */
export interface IWizardOption {
  readonly label: string;
  readonly value: string;
  readonly recommended?: boolean;
  readonly outcome?: string;
  readonly note?: string;
}

/** A single wizard step — either arrow-key single-select or checkbox multi-select. */
export interface IWizardStep {
  readonly key: string;
  readonly kind: "single" | "multi";
  readonly title: string;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly options: readonly IWizardOption[];
  /** Single-select: the preselected option index (the recommendation). */
  readonly defaultIndex?: number;
  /** Multi-select: option indices checked on entry. */
  readonly defaultChecked?: readonly number[];
}

/** Normalized input action (the driver maps raw keypresses to these). */
export type IWizardAction =
  | "up"
  | "down"
  | "toggle"
  | "confirm"
  | "back"
  | "cancel";

/** The wizard's full state. `stepIndex === steps.length` is the final overview
 *  screen. `status` leaves "active" only on apply/cancel. */
export interface IWizardState {
  readonly stepIndex: number;
  readonly cursor: number;
  readonly single: Readonly<Record<string, string>>;
  readonly multi: Readonly<Record<string, readonly number[]>>;
  readonly status: "active" | "apply" | "cancel";
}
