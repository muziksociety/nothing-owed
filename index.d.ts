// Type definitions for nothing-owed.

export declare const NOTHING_OWED: 'NOTHING_OWED';
export declare const STILL_RUNNING: 'STILL_RUNNING';

export interface TimedText {
  /** Epoch milliseconds. */
  at: number;
  text: string;
}

export interface ReplyEntry extends TimedText {
  /** The conversation's message count right after this reply (for "N messages back"). Absent on v0.1 records. */
  seq?: number;
}

export type Outcome = 'nothing' | 'running' | 'deliver' | 'deliver_running' | 'failed';

export interface CheckReply {
  outcome: Outcome;
  /** The text to deliver ('' unless the outcome is deliver or deliver_running). */
  text: string;
}

export interface CheckRecord {
  id: string;
  conversationId: string;
  state: 'pending' | 'running' | 'parked';
  /** Epoch ms when the check fires (for a parked check: when the job timeout runs). */
  due: number;
  /** The agent's replies in this check: reply 1 plus the newest ones. */
  replies: ReplyEntry[];
  /** Timed STILL_RUNNING rechecks used so far. */
  rechecks: number;
  /** Parked checks: the open job ids it waits for. */
  parkedOn?: string[];
  /** Parked checks: when it parked. */
  parkedAt?: number;
  /** Parked checks: true once the job-timeout status check has run. */
  timedOut?: boolean;
}

export interface TrackedJob {
  id: string;
  conversationId: string;
  title: string;
  startedAt: number;
}

export interface FinishedJob extends TrackedJob {
  status: 'done' | 'error' | 'stopped' | string;
  text: string;
  finishedAt: number;
}

export interface OutboxItem {
  id: string;
  conversationId: string;
  /** The text already produced. Retries resend it and never call runTurn again. */
  text: string;
  kind: 'check' | 'report';
  checkId?: string;
  jobId?: string;
  /** Delivery attempts so far (persists across restarts). */
  attempts: number;
  /** Epoch ms of the next attempt. */
  due: number;
}

/** What a store holds. v0.1 stores held a plain CheckRecord[]; that still loads. */
export interface StoredState {
  version: 2;
  records: CheckRecord[];
  counters: Record<string, number>;
  jobs: Record<string, TrackedJob>;
  outbox: OutboxItem[];
  /** Per conversation: the clipped text of a delivery that was given up on (sent once as "Missed: ..."). */
  missed: Record<string, string>;
}

export interface Store {
  load(): StoredState | CheckRecord[] | Promise<StoredState | CheckRecord[]>;
  save(state: StoredState): void | Promise<void>;
}

export interface TurnResult {
  text: string;
  /** Token usage as your runtime reports it (passed through to onUsage). */
  usage?: unknown;
  /** Cost of this turn in USD, if you computed it. */
  costUsd?: number | null;
}

export interface TurnContext {
  /** 'check' for a check turn, 'report' for a job report turn. */
  kind: 'check' | 'report';
  /** null on a report turn. */
  checkId: string | null;
  /** Set on a report turn. */
  jobId?: string;
  recheck: number;
  isLastCheck: boolean;
}

export interface UsageInfo {
  conversationId: string;
  /** null on a report turn. */
  checkId: string | null;
  jobId?: string;
  usage: unknown;
  costUsd: number | null;
}

/** deliver() may return the platform's message ids; they go into the delivered events. */
export interface DeliverResult {
  ids?: Array<string | number>;
}

type Ids = Array<string | number>;

export type NothingOwedEvent =
  | { type: 'scheduled'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'merged'; at: number; conversationId: string; checkId: string; replies: number; due: number }
  | { type: 'check_started'; at: number; conversationId: string; checkId: string; replies: number; delivered: number; recheck: number; isLastCheck: boolean }
  | { type: 'yielded'; at: number; conversationId: string; checkId: string }
  | { type: 'nothing_owed'; at: number; conversationId: string; checkId: string; ms: number }
  | { type: 'still_running'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'delivered'; at: number; conversationId: string; checkId: string; chars: number; ms: number; ids?: Ids; stillRunning: boolean }
  | { type: 'failed'; at: number; conversationId: string; checkId: string; ms: number }
  | { type: 'parked'; at: number; conversationId: string; checkId: string; jobIds: string[]; until: number }
  | { type: 'unparked'; at: number; conversationId: string; checkId: string; jobId: string | null }
  | { type: 'park_timeout'; at: number; conversationId: string; checkId: string; jobIds: string[] }
  | { type: 'park_ended'; at: number; conversationId: string; checkId: string; jobIds: string[] }
  | { type: 'job_tracked'; at: number; conversationId: string; jobId: string; title: string }
  | { type: 'job_finished'; at: number; conversationId: string; jobId: string; status: string }
  | { type: 'report_delivered'; at: number; conversationId: string; jobId: string; chars: number; ids?: Ids }
  | { type: 'report_skipped'; at: number; conversationId: string; jobId: string; reason: 'failed' | 'nothing' | 'running' }
  | { type: 'delivery_retry'; at: number; conversationId: string; kind: 'check' | 'report'; checkId?: string; jobId?: string; attempt: number; retryInMs: number; error: unknown }
  | { type: 'delivery_recovered'; at: number; conversationId: string; kind: 'check' | 'report'; checkId?: string; jobId?: string; attempt: number; ids?: Ids }
  | { type: 'delivery_failed'; at: number; conversationId: string; kind: 'check' | 'report'; checkId?: string; jobId?: string; attempts: number; permanent: boolean; error: unknown }
  | { type: 'missed_notice'; at: number; conversationId: string }
  | ({ type: 'usage'; at: number } & UsageInfo)
  | { type: 'error'; at: number; stage: 'store' | 'check' | 'isUserBusy' | 'report' | 'onJobFinished' | 'deliver'; conversationId?: string; checkId?: string; jobId?: string; error: unknown }
  | { type: 'started'; at: number; pending: number; parked: number; jobs: number; outbox: number }
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
  replies: ReplyEntry[];
  delivered?: TimedText[];
  isLastCheck?: boolean;
  userLabel?: string;
  maxTextLength?: number;
  /** Messages in the conversation so far; with reply seqs it gives "N messages back". */
  messageCount?: number;
}

export interface BuildReportPromptInput {
  job: { id: string; title?: string; status?: string; text?: string };
  userLabel?: string;
  /** Clip the job's output to this many characters. Default 1500. */
  maxTextLength?: number;
}

export interface NothingOwedOptions {
  /** The check fires this long after the first reply of a window; later replies never move it. Also the recheck delay. Default 300000 (5 min). */
  delayMs?: number;
  /** Timed STILL_RUNNING rechecks at delayMs. Default 6. */
  maxRechecks?: number;
  /** After those, further rechecks wait these steps in turn; the last step asks for a one-line status and ends. Default [15, 30, 60, 120] minutes. [] disables. */
  backoffMs?: number[];
  /** When isUserBusy() says yes, try again after this long. Default 60000. */
  busyRetryMs?: number;
  /** The delivered window starts this long before the first reply of the check. Default 600000. */
  deliveredLookbackMs?: number;
  /** A check keeps at most this many replies: reply 1 plus the newest. Default 12. */
  maxReplies?: number;
  /** Texts in the prompt are clipped to this length. Default 300. */
  maxTextLength?: number;
  /** A job's output in the report prompt is clipped to this length. Default 1500. */
  maxReportLength?: number;
  /** A check parked on jobs longer than this runs once with the last-check prompt, parks one more period, then ends. Default 7200000 (2 h). */
  jobTimeoutMs?: number;
  /** Wait between delivery retries. Default 300000 (5 min). An error's retryAfterMs overrides one wait. */
  retryMs?: number;
  /** Delivery attempts before giving up. Default 12. */
  maxDeliveryAttempts?: number;
  /** The "Missed:" line after a give-up carries this many characters of the lost text. Default 120. */
  missedLength?: number;
  /** How the prompt names the user. Default "the user". */
  userLabel?: string;
  /** Where the scheduler state lives. Default: memory. */
  store?: Store;
  /** Resume the SAME conversation/session with `prompt` and return the agent's reply. */
  runTurn(conversationId: string, prompt: string, ctx: TurnContext): Promise<string | TurnResult>;
  /**
   * Send a check reply or job report to the user. It counts as delivered only if it resolves:
   * throw when the platform did not confirm the send (for example, no message id came back).
   * An error's retryAfterMs sets the wait before the next attempt.
   */
  deliver(conversationId: string, text: string): unknown | Promise<unknown>;
  /** Return true for an error that will never succeed; retrying stops at once. */
  isPermanentError?(error: unknown): boolean;
  /** A tracked job ended. If given, the package calls it instead of running its own report turn. */
  onJobFinished?(conversationId: string, job: FinishedJob): unknown | Promise<unknown>;
  /** Your own send log. Omit it to use the built-in delivered log (noteDelivered). */
  getDelivered?(conversationId: string, sinceMs: number): TimedText[] | Promise<TimedText[]>;
  /** Return true while the user is mid-conversation; the check yields and retries. */
  isUserBusy?(conversationId: string): boolean | Promise<boolean>;
  /** Every scheduler event (scheduled, merged, delivered, parked, usage, error, ...). */
  onEvent?(event: NothingOwedEvent): void;
  /** Called when runTurn returns usage or costUsd. */
  onUsage?(info: UsageInfo): void;
  /** Canned failure notices your runtime returns instead of a reply; treated as failed. */
  failTexts?: string[];
  /** Replace the check prompt. */
  buildPrompt?(input: BuildPromptInput): string;
  /** Replace the job report prompt. */
  buildReportPrompt?(input: BuildReportPromptInput): string;
  /** Replace the outcome parser. Return an outcome, or { outcome, text } with the text to deliver. */
  parseOutcome?(text: string, opts: { failTexts: string[] }): Outcome | CheckReply;
  /** Built-in delivered log to use (e.g. a file-backed one). */
  deliveredLog?: DeliveredLog;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NothingOwed {
  /** Kinds 'check' and 'report' count as messages but never schedule; 'system' does neither. */
  noteReply(conversationId: string, text: string, opts?: { kind?: 'reply' | 'check' | 'report' | 'system' | string; at?: number }): CheckRecord | null;
  /** The user sent a message. Returns the conversation's message count. */
  noteUserMessage(conversationId: string): number;
  messageCount(conversationId: string): number;
  noteDelivered(conversationId: string, text: string, atOrOpts?: number | { at?: number; id?: string | number }): TimedText;
  trackJob(conversationId: string, jobId: string, opts?: { title?: string }): TrackedJob;
  /** Resolves after the report (or onJobFinished) and any unparked check ran; null for an unknown job. */
  finishJob(jobId: string, opts?: { status?: 'done' | 'error' | 'stopped' | string; text?: string }): Promise<FinishedJob | null>;
  /** trackJob, await the work, finishJob with its result or error message, return the result (or rethrow). */
  wrapJob<T>(conversationId: string, jobId: string, work: Promise<T> | (() => Promise<T> | T), opts?: { title?: string }): Promise<T>;
  start(): Promise<NothingOwed>;
  stop(): void;
  tick(): Promise<Array<Outcome | 'busy'>>;
  idle(): Promise<void>;
  pending(): CheckRecord[];
  parked(): CheckRecord[];
  jobs(): TrackedJob[];
  outbox(): OutboxItem[];
  readonly deliveredLog: DeliveredLog;
}

export declare function createNothingOwed(options: NothingOwedOptions): NothingOwed;
export declare function buildPrompt(input: BuildPromptInput): string;
export declare function buildReportPrompt(input: BuildReportPromptInput): string;
export declare function parseOutcome(text: string, opts?: { failTexts?: string[] }): Outcome;
export declare function parseCheckReply(text: string, opts?: { failTexts?: string[] }): CheckReply;
export declare function stripStillRunning(text: string): string;
export declare function createFileStore(path: string): Store & { path: string };
export declare function createMemoryStore(initial?: StoredState | CheckRecord[]): Store;
export declare function createDeliveredLog(opts?: DeliveredLogOptions): DeliveredLog;
