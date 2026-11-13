// Type definitions for nothing-owed.

export declare const NOTHING_OWED: 'NOTHING_OWED';
export declare const STILL_RUNNING: 'STILL_RUNNING';

export interface TimedText {
  /** Epoch milliseconds. */
  at: number;
  text: string;
}

export type Outcome = 'nothing' | 'running' | 'deliver' | 'failed';

export interface CheckRecord {
  id: string;
  conversationId: string;
  state: 'pending' | 'running';
  /** Epoch ms when the check fires. */
  due: number;
  /** The agent's replies merged into this check, oldest first. */
  replies: TimedText[];
  /** STILL_RUNNING rechecks used so far. */
  rechecks: number;
}

export interface Store {
  load(): CheckRecord[] | Promise<CheckRecord[]>;
  save(records: CheckRecord[]): void | Promise<void>;
}

export interface TurnResult {
  text: string;
  /** Token usage as your runtime reports it (passed through to onUsage). */
  usage?: unknown;
  /** Cost of this check turn in USD, if you computed it. */
  costUsd?: number | null;
}

export interface TurnContext {
  checkId: string;
  recheck: number;
  isLastCheck: boolean;
}

export interface UsageInfo {
  conversationId: string;
  checkId: string;
  usage: unknown;
  costUsd: number | null;
}

export type NothingOwedEvent =
  | { type: 'scheduled'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'merged'; at: number; conversationId: string; checkId: string; replies: number; due: number }
  | { type: 'check_started'; at: number; conversationId: string; checkId: string; replies: number; delivered: number; recheck: number; isLastCheck: boolean }
  | { type: 'yielded'; at: number; conversationId: string; checkId: string }
  | { type: 'nothing_owed'; at: number; conversationId: string; checkId: string; ms: number }
  | { type: 'still_running'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'delivered'; at: number; conversationId: string; checkId: string; chars: number; ms: number }
  | { type: 'failed'; at: number; conversationId: string; checkId: string; ms: number }
  | ({ type: 'usage'; at: number } & UsageInfo)
  | { type: 'error'; at: number; stage: 'store' | 'check' | 'isUserBusy'; conversationId?: string; checkId?: string; error: unknown }
  | { type: 'started'; at: number; pending: number }
  | { type: 'stopped'; at: number };

export interface DeliveredLog {
  note(conversationId: string, text: string, opts?: { at?: number; id?: string | number }): TimedText;
  since(conversationId: string, sinceMs?: number): TimedText[];
  clear(conversationId?: string): void;
}

export interface DeliveredLogOptions {
  /** Persist to this JSON file. Default: memory only. */
  path?: string;
  /** Default 400. */
  maxPerConversation?: number;
  /** Default 2 days. */
  maxAgeMs?: number;
  /** Default 2000. */
  maxTextLength?: number;
  now?: () => number;
}

export interface BuildPromptInput {
  replies: TimedText[];
  delivered?: TimedText[];
  isLastCheck?: boolean;
  userLabel?: string;
  maxTextLength?: number;
}

export interface NothingOwedOptions {
  /** Quiet time after the last reply before the check fires. Default 600000 (10 min). */
  delayMs?: number;
  /** STILL_RUNNING rechecks before the final one-line-status check. Default 6. */
  maxRechecks?: number;
  /** When isUserBusy() says yes, try again after this long. Default 60000. */
  busyRetryMs?: number;
  /** The delivered window starts this long before the first merged reply. Default 600000. */
  deliveredLookbackMs?: number;
  /** A merged check keeps at most this many replies (the newest). Default 12. */
  maxReplies?: number;
  /** Texts in the prompt are clipped to this length. Default 300. */
  maxTextLength?: number;
  /** How the prompt names the user. Default "the user". */
  userLabel?: string;
  /** Where pending checks live. Default: memory. */
  store?: Store;
  /** Resume the SAME conversation/session with `prompt` and return the agent's reply. */
  runTurn(conversationId: string, prompt: string, ctx: TurnContext): Promise<string | TurnResult>;
  /** Send a check reply to the user. */
  deliver(conversationId: string, text: string): unknown | Promise<unknown>;
  /** Your own send log. Omit it to use the built-in delivered log (noteDelivered). */
  getDelivered?(conversationId: string, sinceMs: number): TimedText[] | Promise<TimedText[]>;
  /** Return true while the user is mid-conversation; the check yields and retries. */
  isUserBusy?(conversationId: string): boolean | Promise<boolean>;
  /** Every scheduler event (scheduled, merged, delivered, usage, error, ...). */
  onEvent?(event: NothingOwedEvent): void;
  /** Called when runTurn returns usage or costUsd. */
  onUsage?(info: UsageInfo): void;
  /** Canned failure notices your runtime returns instead of a reply; treated as failed. */
  failTexts?: string[];
  /** Replace the check prompt. */
  buildPrompt?(input: BuildPromptInput): string;
  /** Replace the outcome parser. */
  parseOutcome?(text: string, opts: { failTexts: string[] }): Outcome;
  /** Built-in delivered log to use (e.g. a file-backed one). */
  deliveredLog?: DeliveredLog;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NothingOwed {
  noteReply(conversationId: string, text: string, opts?: { kind?: 'reply' | 'check' | 'report' | 'system' | string; at?: number }): CheckRecord | null;
  noteDelivered(conversationId: string, text: string, atOrOpts?: number | { at?: number; id?: string | number }): TimedText;
  start(): Promise<NothingOwed>;
  stop(): void;
  tick(): Promise<Array<Outcome | 'busy'>>;
  idle(): Promise<void>;
  pending(): CheckRecord[];
  readonly deliveredLog: DeliveredLog;
}

export declare function createNothingOwed(options: NothingOwedOptions): NothingOwed;
export declare function buildPrompt(input: BuildPromptInput): string;
export declare function parseOutcome(text: string, opts?: { failTexts?: string[] }): Outcome;
export declare function createFileStore(path: string): Store & { path: string };
export declare function createMemoryStore(initial?: CheckRecord[]): Store;
export declare function createDeliveredLog(opts?: DeliveredLogOptions): DeliveredLog;
