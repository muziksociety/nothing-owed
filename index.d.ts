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

export type Outcome = 'nothing' | 'running' | 'deliver' | 'deliver_running' | 'due' | 'failed';

export interface CheckReply {
  outcome: Outcome;
  /** The text to deliver now ('' unless the outcome is deliver, deliver_running, or due with content). */
  text: string;
  /** Outcome 'due': the epoch ms the agent set with a `DUE <ISO time>` line. */
  dueAt?: number;
}

/** Why a check turn runs. */
export type CheckReason = 'window' | 'recheck' | 'verify' | 'due' | 'park_timeout';

export interface CheckRecord {
  id: string;
  conversationId: string;
  /** pending: one per conversation; parked: waits for jobs; dated: a DUE timer (any number). */
  state: 'pending' | 'running' | 'parked' | 'dated';
  /** window: opened by a reply; verify: follows a delivery the user saw; due: a DUE timer. */
  kind?: 'window' | 'verify' | 'due';
  /** Epoch ms when the check fires (parked: when the job timeout runs; dated: the DUE time). */
  due: number;
  /** The agent's replies in this check: reply 1 plus the newest ones. */
  replies: ReplyEntry[];
  /** Timed rechecks used so far (STILL_RUNNING or failed). */
  rechecks: number;
  /** Verify-chain depth: 0 for a window, +1 for each check reply that led here. */
  depth?: number;
  /** Dated checks: the time the agent set. */
  dueAt?: number;
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
  /** 'lost' when the job was found in the store at start() and not kept by onStartJobs. */
  status: 'done' | 'error' | 'stopped' | 'lost' | string;
  text: string;
  finishedAt: number;
}

/** A report turn still owed for a finished job. */
export interface ReportRecord {
  id: string;
  conversationId: string;
  job: FinishedJob;
  /** Epoch ms of the next attempt. */
  due: number;
  /** Failed report turns so far. */
  attempts: number;
  state: 'pending' | 'running';
}

/** What a package delivery is. Passed to deliver() so the host can forward it to noteReply. */
export type DeliveryKind = 'check' | 'report' | 'giveup' | 'fallback' | 'missed';

export interface DeliveryMeta {
  kind: DeliveryKind;
  checkId: string | null;
  jobId: string | null;
}

export interface OutboxItem {
  id: string;
  conversationId: string;
  /** The text already produced. Retries resend it and never call runTurn again. */
  text: string;
  kind: DeliveryKind;
  checkId?: string;
  jobId?: string;
  depth?: number;
  /** Delivery attempts so far (persists across restarts). */
  attempts: number;
  /** Epoch ms of the next attempt. */
  due: number;
  /** Epoch ms of the first attempt. */
  at?: number;
}

/** What a store holds. v0.1 stores held a plain CheckRecord[]; that and v0.2 objects still load. */
export interface StoredState {
  version: 3;
  records: CheckRecord[];
  reports: ReportRecord[];
  counters: Record<string, number>;
  jobs: Record<string, TrackedJob>;
  outbox: OutboxItem[];
  /** Per conversation: full texts of deliveries that were given up on (sent as "Missed: ..."). */
  missed: Record<string, string[]>;
  /** Per conversation: model turns on the current UTC day. */
  turnsByDay: Record<string, { day: number; n: number }>;
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
  /** Check: rechecks used so far. Report: failed attempts so far. */
  recheck: number;
  isLastCheck: boolean;
  /** Why the turn runs ('report' on a report turn). */
  reason: CheckReason | 'report';
  /** Aborted when the turn passes turnTimeoutMs. Pass it to your model call. */
  signal: AbortSignal;
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

export interface GiveUpContext {
  conversationId: string;
  /** failed: the checks kept failing; still_running: the last check had nothing but STILL_RUNNING. */
  reason: 'failed' | 'still_running';
  checkId?: string;
}

type Ids = Array<string | number>;

export type NothingOwedEvent =
  | { type: 'scheduled'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'merged'; at: number; conversationId: string; checkId: string; replies: number; due: number }
  | { type: 'verify_scheduled'; at: number; conversationId: string; checkId: string; depth: number; due: number }
  | { type: 'verify_capped'; at: number; conversationId: string; depth: number }
  | { type: 'dated'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'check_started'; at: number; conversationId: string; checkId: string; replies: number; delivered: number; recheck: number; isLastCheck: boolean; reason: CheckReason }
  | { type: 'yielded'; at: number; conversationId: string; checkId: string | null; jobId?: string }
  | { type: 'daily_cap'; at: number; conversationId: string; checkId: string | null; jobId?: string; until: number }
  | { type: 'turn_timeout'; at: number; conversationId: string; kind: 'check' | 'report'; checkId?: string | null; jobId?: string | null }
  | { type: 'nothing_owed'; at: number; conversationId: string; checkId: string; ms: number }
  | { type: 'still_running'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'delivered'; at: number; conversationId: string; checkId: string; chars: number; ms: number; ids?: Ids; stillRunning: boolean }
  | { type: 'duplicate_skipped'; at: number; conversationId: string; checkId: string | null; jobId?: string; chars: number }
  | { type: 'failed'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'gave_up'; at: number; conversationId: string; checkId?: string; reason: 'failed' | 'still_running'; delivered: boolean }
  | { type: 'parked'; at: number; conversationId: string; checkId: string; jobIds: string[]; until: number }
  | { type: 'unparked'; at: number; conversationId: string; checkId: string; jobId: string | null }
  | { type: 'park_timeout'; at: number; conversationId: string; checkId: string; jobIds: string[] }
  | { type: 'park_ended'; at: number; conversationId: string; checkId: string; jobIds: string[] }
  | { type: 'job_tracked'; at: number; conversationId: string; jobId: string; title: string }
  | { type: 'job_finished'; at: number; conversationId: string; jobId: string; status: string }
  | { type: 'job_lost'; at: number; conversationId: string; jobId: string }
  | { type: 'report_delivered'; at: number; conversationId: string; jobId: string; chars: number; ids?: Ids }
  | { type: 'report_retry'; at: number; conversationId: string; jobId: string; attempt: number; due: number }
  | { type: 'report_fallback'; at: number; conversationId: string; jobId: string; reason: 'failed' | 'nothing' | 'running' | 'capped' | string; delivered: boolean }
  | { type: 'delivery_retry'; at: number; conversationId: string; kind: DeliveryKind; checkId?: string; jobId?: string; attempt: number; retryInMs: number; error: unknown }
  | { type: 'delivery_recovered'; at: number; conversationId: string; kind: DeliveryKind; checkId?: string; jobId?: string; attempt: number; ids?: Ids }
  | { type: 'delivery_failed'; at: number; conversationId: string; kind: DeliveryKind; checkId?: string; jobId?: string; attempts: number; permanent: boolean; error: unknown }
  | { type: 'missed_notice'; at: number; conversationId: string }
  | ({ type: 'usage'; at: number } & UsageInfo)
  | { type: 'error'; at: number; stage: 'store' | 'check' | 'isUserBusy' | 'report' | 'onJobFinished' | 'onStartJobs' | 'deliver' | 'deliveredLog'; conversationId?: string; checkId?: string; jobId?: string; error: unknown }
  | { type: 'started'; at: number; pending: number; parked: number; dated: number; jobs: number; lost: number; reports: number; outbox: number }
  | { type: 'stopped'; at: number };

export interface DeliveredLog {
  /** The same text noted twice within a minute (for example by the host and by the package) stays one entry. */
  note(conversationId: string, text: string, opts?: { at?: number; id?: string | number }): TimedText;
  since(conversationId: string, sinceMs?: number): TimedText[];
  clear(conversationId?: string): void;
}

export interface DeliveredLogOptions {
  /** Persist to this JSON file. Default: memory only. */
  path?: string;
  /** Default 400. */
  maxPerConversation?: number;
  /** Entries, and whole conversations idle this long, are dropped. Default 2 days. */
  maxAgeMs?: number;
  /** Default 2000. */
  maxTextLength?: number;
  now?: () => number;
}

export interface BuildPromptInput {
  replies: ReplyEntry[];
  delivered?: TimedText[];
  /** Deliveries waiting for a retry and missed notices: sent automatically, not to be rewritten. */
  queued?: TimedText[];
  isLastCheck?: boolean;
  userLabel?: string;
  /** Texts longer than this keep their head and tail. Default 300. */
  maxTextLength?: number;
  /** Show the newest N delivered messages, with "(M older not shown)". Default 40. */
  maxDelivered?: number;
  /** Messages in the conversation so far; with reply seqs it gives "N messages back". */
  messageCount?: number;
  /** The time now (shown so the agent can write DUE times). */
  now?: number;
  reason?: CheckReason;
  /** Dated checks: the time the agent set. */
  dueAt?: number;
}

export interface BuildReportPromptInput {
  job: { id: string; title?: string; status?: string; text?: string };
  userLabel?: string;
  /** Bound the job's output to this many characters (head and tail). Default 1500. */
  maxTextLength?: number;
}

export interface NothingOwedOptions {
  /** The check fires this long after the first reply of a window; later replies never move it. Also the recheck and verify delay. Default 300000 (5 min). */
  delayMs?: number;
  /** Timed rechecks at delayMs (after STILL_RUNNING or a failed turn). Default 6. */
  maxRechecks?: number;
  /** After those, further rechecks wait these steps in turn; the last step asks for a one-line status and ends. Default [15, 30, 60, 120] minutes. [] disables. */
  backoffMs?: number[];
  /** When isUserBusy() says yes, try again after this long. Default 60000. */
  busyRetryMs?: number;
  /** The delivered window starts this long before the first reply of the check. Default 600000. */
  deliveredLookbackMs?: number;
  /** A check keeps at most this many replies: reply 1 plus the newest. Default 12. */
  maxReplies?: number;
  /** Texts longer than this keep their first and last halves (150 + " … " + 150). Default 300. */
  maxTextLength?: number;
  /** A job's output in the report prompt is bounded to this length. Default 1500. */
  maxReportLength?: number;
  /** The prompt shows the newest N delivered messages. Default 40. */
  maxDeliveredInPrompt?: number;
  /** A check parked on jobs longer than this runs once with the last-check prompt, parks one more period, then ends. Default 7200000 (2 h). */
  jobTimeoutMs?: number;
  /** A runTurn that does not settle in this long counts as failed and its ctx.signal is aborted. Default 180000 (3 min). 0 disables. */
  turnTimeoutMs?: number;
  /** A delivery the package made gets one verify check; the chain stops after this many. Default 3. */
  maxVerifyDepth?: number;
  /** A DUE time further away than this is treated as STILL_RUNNING. Default 30 days. */
  maxDueMs?: number;
  /** Model turns (checks and reports) running at once across conversations. Default 2. */
  maxConcurrent?: number;
  /** Model turns per conversation per UTC day; past it checks wait for the next day and reports use the fallback line. Default 60. 0 disables. */
  dailyCap?: number;
  /** Wait between delivery retries. Default 300000 (5 min). An error's retryAfterMs overrides one wait. */
  retryMs?: number;
  /** Delivery attempts before giving up. Default 12. */
  maxDeliveryAttempts?: number;
  /** How the prompt names the user. Default "the user". */
  userLabel?: string;
  /** Where the scheduler state lives. Default: memory. */
  store?: Store;
  /** Resume the SAME conversation/session with `prompt` and return the agent's reply. */
  runTurn(conversationId: string, prompt: string, ctx: TurnContext): Promise<string | TurnResult>;
  /**
   * Send a package-made text to the user. It counts as delivered only if it resolves: throw when
   * the platform did not confirm the send (for example, no message id came back). An error's
   * retryAfterMs sets the wait before the next attempt. The package counts it and logs it in the
   * built-in delivered log itself.
   */
  deliver(conversationId: string, text: string, meta: DeliveryMeta): unknown | Promise<unknown>;
  /** Return true for an error that will never succeed; retrying stops at once. */
  isPermanentError?(error: unknown): boolean;
  /** A tracked job ended. If given, the package calls it instead of its own report turn. Note your reply with { kind: 'report' }. */
  onJobFinished?(conversationId: string, job: FinishedJob): unknown | Promise<unknown>;
  /** start() found these jobs in the store. Return the ids the host still runs; the rest finish as 'lost'. Default: none kept. */
  onStartJobs?(jobs: TrackedJob[]): Array<string> | Promise<Array<string>>;
  /** The fixed line sent when checks are exhausted with no answer for the user. */
  giveUpText?(ctx: GiveUpContext): string;
  /** Your own send log. Omit it to use the built-in delivered log (noteDelivered). */
  getDelivered?(conversationId: string, sinceMs: number): TimedText[] | Promise<TimedText[]>;
  /** Return true while the user is mid-conversation; checks and report turns yield and retry. */
  isUserBusy?(conversationId: string): boolean | Promise<boolean>;
  /** Every scheduler event. */
  onEvent?(event: NothingOwedEvent): void;
  /** Called when runTurn returns usage or costUsd. */
  onUsage?(info: UsageInfo): void;
  /** Canned failure notices your runtime returns instead of a reply; treated as failed. */
  failTexts?: string[];
  /** Replace the check prompt. */
  buildPrompt?(input: BuildPromptInput): string;
  /** Replace the job report prompt. */
  buildReportPrompt?(input: BuildReportPromptInput): string;
  /** Replace the outcome parser (checks and reports). Return an outcome, or { outcome, text, dueAt }. */
  parseOutcome?(text: string, opts: { failTexts: string[] }): Outcome | CheckReply;
  /** Built-in delivered log to use (e.g. a file-backed one). */
  deliveredLog?: DeliveredLog;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface NothingOwed {
  /**
   * The agent replied. Kinds 'check' and 'report' (replies you delivered yourself) count and get one
   * verify check; 'giveup', 'fallback' and 'missed' only count; 'system' does neither. A package
   * delivery routed back here is recognized and ignored. Returns the check it joined, or null.
   */
  noteReply(conversationId: string, text: string, opts?: { kind?: 'reply' | DeliveryKind | 'system' | string; at?: number }): CheckRecord | null;
  /** The user sent a message. Returns the conversation's message count. */
  noteUserMessage(conversationId: string): number;
  messageCount(conversationId: string): number;
  noteDelivered(conversationId: string, text: string, atOrOpts?: number | { at?: number; id?: string | number }): TimedText;
  /** "Missed: <full text>" notices owed in this conversation, each returned once. Send them before your next message. */
  flushMissed(conversationId: string): string[];
  trackJob(conversationId: string, jobId: string, opts?: { title?: string }): TrackedJob;
  /** Resolves after the report (or onJobFinished) and any unparked check ran, or once they wait; null for an unknown job. */
  finishJob(jobId: string, opts?: { status?: 'done' | 'error' | 'stopped' | 'lost' | string; text?: string }): Promise<FinishedJob | null>;
  /** trackJob, await the work, finishJob with its result or error message, return the result (or rethrow). */
  wrapJob<T>(conversationId: string, jobId: string, work: Promise<T> | (() => Promise<T> | T), opts?: { title?: string }): Promise<T>;
  start(): Promise<NothingOwed>;
  stop(): void;
  tick(): Promise<Array<Outcome | 'busy' | 'capped' | 'report'>>;
  idle(): Promise<void>;
  pending(): CheckRecord[];
  parked(): CheckRecord[];
  dated(): CheckRecord[];
  jobs(): TrackedJob[];
  reports(): ReportRecord[];
  outbox(): OutboxItem[];
  readonly deliveredLog: DeliveredLog;
}

export declare function createNothingOwed(options: NothingOwedOptions): NothingOwed;
export declare function buildPrompt(input: BuildPromptInput): string;
export declare function buildReportPrompt(input: BuildReportPromptInput): string;
export declare function parseOutcome(text: string, opts?: { failTexts?: string[] }): Outcome;
export declare function parseCheckReply(text: string, opts?: { failTexts?: string[] }): CheckReply;
export declare function stripStillRunning(text: string): string;
/** Flatten whitespace; a text longer than max keeps its head and tail joined by " … ". */
export declare function clipText(text: string, max?: number): string;
export declare function defaultGiveUpText(ctx: { reason?: 'failed' | 'still_running' }): string;
/** "<title> <status>: <first line of output, 300 chars>" */
export declare function fallbackReportText(job: { id: string; title?: string; status?: string; text?: string }): string;
export declare function createFileStore(path: string): Store & { path: string };
export declare function createMemoryStore(initial?: StoredState | CheckRecord[]): Store;
export declare function createDeliveredLog(opts?: DeliveredLogOptions): DeliveredLog;
