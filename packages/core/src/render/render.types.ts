export interface IRenderOptions {
  /** Emit ANSI color codes (terminal) vs plain text (log files). Default true. */
  color?: boolean;
  /** Speaker label for assistant turns (the model name). Default "assistant". */
  speaker?: string;
  /** Terminal width for sizing the user message bubble. Default 80. */
  columns?: number;
}

/** A compact post-turn status line — the "where am I" summary modern CLIs show. */
export interface IStatusInfo {
  model: string;
  /** Estimated tokens of conversation context currently held. */
  contextTokens: number;
  /** The model's context window (for the used/total ratio). */
  contextWindow: number;
  /** Turns the last send took. */
  turns: number;
  /** Wall-clock of the last send, in ms. */
  elapsedMs: number;
  /** Outcome of the last send (responded / done / stuck / interrupted). */
  status: string;
  /** Editable scope label. */
  scope: string;
  /** The current interactive mode label (e.g. "plan", "normal"), shown as a chip.
   *  Omitted/empty renders nothing. */
  mode?: string;
  /** Output generation rate of the last model call (tokens/second); omitted or
   *  0 before the first call. */
  tokensPerSecond?: number;
  /** Live activity indicator (e.g. `⠋ thinking · 12s`) shown WHILE a turn runs,
   *  so the spinner animates IN the bar instead of on the readline input line
   *  (which it would otherwise clobber). Omitted between turns. */
  activity?: string;
}
