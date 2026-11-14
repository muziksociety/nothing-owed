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
  /** Outcome 'due': the epoch ms the agent set with a `DUE <ISO time with zone>` line. */
  dueAt?: number;
  /** Outcome 'due' with a STILL_RUNNING marker too: the timer is set AND the check keeps watching. */
  running?: boolean;
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
  /** DUE-chain depth (capped by maxDueDepth). */
  dueDepth?: number;
  /** When this record (or the run that delivered its text) last ran: the duplicate guard starts there. */
  lastRunAt?: number;
  /** STILL_RUNNING with an open job already got its one recheck: the next one parks. */
  jobRecheck?: boolean;
  /** Waiting for the next day because a daily cap was reached. */
  capped?: boolean;
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
  /** Set by noteJobUserNotified: its finishJob runs no report turn. */
  userNotified?: boolean;
}

export interface FinishedJob extends TrackedJob {
  /** The line the code-written report uses (wrapJob sets it from the result's text or summary). */
  summary?: string;
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
  /** Set (and saved) right before the report is sent: after a restart it is never sent again. */
  delivering?: boolean;
  /** Set by noteJobUserNotified: the report text is dropped before deliver(). */
  userNotified?: boolean;
}

/** What a package delivery is. Passed to deliver() so the host can forward it to noteReply. */
export type DeliveryKind = 'check' | 'report' | 'giveup' | 'fallback' | 'missed';

export interface DeliveryMeta {
  kind: DeliveryKind;
  checkId: string | null;
  jobId: string | null;
  /** The same for every attempt of this delivery, also after a restart (kind, check or job, and a hash of the text). */
  deliveryId: string;
  /** 1 on the first attempt, then 2, 3, ... on retries. */
  attempt: number;
  /** What the host saved with setProgress on an earlier attempt of this delivery, else null. */
  progress: unknown;
  /**
   * Save the host's progress on this delivery (for example the chunks already confirmed), so a
   * retry, also after a restart, sends only the rest. JSON-serializable. Resolves when it is
   * written to the store. Cleared when the delivery succeeds, is skipped or is given up.
   */
  setProgress(data: unknown): Promise<void>;
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

export interface MissedNotice {
  /** The full text that never landed (sent as "Missed: <text>"). */
  text: string;
  at: number;
  /** Next attempt (15 min after the give-up, doubling to 6 h). */
  due: number;
  wait: number;
  /** v0.5.1+, job reports only: the job and kind, so noteJobUserNotified can drop it. Older entries have neither. */
  jobId?: string;
  kind?: 'report' | 'fallback';
}

/** What a store holds. v0.1 stores held a plain CheckRecord[]; that and v0.2/v0.3 objects still load. */
export interface StoredState {
  version: 4;
  records: CheckRecord[];
  reports: ReportRecord[];
  counters: Record<string, number>;
  jobs: Record<string, TrackedJob>;
  outbox: OutboxItem[];
  /** Per conversation: deliveries that were given up on, each on its own timer. */
  missed: Record<string, MissedNotice[]>;
  /** Per conversation: model turns on the current UTC day. */
  turnsByDay: Record<string, { day: number; n: number }>;
  globalTurns: { day: number; n: number; told: boolean };
  /** Per conversation: the days a limit line went out, and whether a give-up line went this outage. */
  notices: Record<string, Record<string, unknown>>;
  circuit: { fails: number; openUntil: number; pauseMs: number };
  /** Per conversation: last activity (idle conversations are pruned after idlePruneMs). */
  lastActive: Record<string, number>;
}

/**
 * Where the state lives. One process per store: the built-in file store takes a lock file.
 */
export interface Store {
  load(): StoredState | CheckRecord[] | Promise<StoredState | CheckRecord[]>;
  save(state: StoredState): void | Promise<void>;
  /** Used for the final save in stop(), so a restart in the same tick reads the latest state. */
  saveSync?(state: StoredState): void;
  /** Called by start(); throw to refuse a second process. */
  lock?(): void;
  unlock?(): void;
  /** Where the built-in delivered log lives when you pass no deliveredLog: a shared Map or a file. */
  deliveredBacking?: { map?: Map<string, unknown[]>; path?: string; debounceMs?: number };
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
  /**
   * failed: the checks kept failing (at most once per conversation per outage, never while the
   * circuit is open); still_running: the last check had nothing but STILL_RUNNING; verify_capped:
   * the verify chain hit maxVerifyDepth; daily_cap: a daily cap was reached (`until` is set);
   * due_limit: a DUE chain or the dated-timer count hit its limit. The last three go at most once
   * per conversation per day.
   */
  reason: 'failed' | 'still_running' | 'verify_capped' | 'daily_cap' | 'due_limit';
  checkId?: string | null;
  until?: number;
  /** daily_cap: the conversation's time zone (from the timeZone option), if any. */
  timeZone?: string;
}

type Ids = Array<string | number>;

export type NothingOwedEvent =
  | { type: 'scheduled'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'merged'; at: number; conversationId: string; checkId: string; replies: number; due: number }
  /** noteReply with a replyId already in the pending check: its text was replaced. */
  | { type: 'reply_updated'; at: number; conversationId: string; checkId: string; replyId: string }
  | { type: 'verify_scheduled'; at: number; conversationId: string; checkId: string; depth: number; due: number }
  | { type: 'verify_capped'; at: number; conversationId: string; depth: number }
  | { type: 'dated'; at: number; conversationId: string; checkId: string; due: number }
  | { type: 'check_started'; at: number; conversationId: string; checkId: string; replies: number; delivered: number; recheck: number; isLastCheck: boolean; reason: CheckReason }
  | { type: 'yielded'; at: number; conversationId: string; checkId: string | null; jobId?: string }
  | { type: 'busy_stuck'; at: number; conversationId: string; checkId: string | null; since: number }
  | { type: 'daily_cap'; at: number; conversationId: string; checkId: string | null; jobId?: string; scope?: 'conv' | 'global'; until: number }
  | { type: 'global_daily_cap'; at: number; cap: number; until: number }
  | { type: 'circuit_open'; at: number; fails: number; until: number; pauseMs: number }
  | { type: 'circuit_closed'; at: number; after: number }
  | { type: 'due_limit'; at: number; conversationId: string; checkId: string | null; dueDepth: number; dated: number }
  | { type: 'missed_retry'; at: number; conversationId: string; retryInMs: number; error: unknown }
  | { type: 'report_done'; at: number; conversationId: string; jobId: string }
  | { type: 'report_skipped'; at: number; conversationId: string; jobId: string; reason: 'host_replied' | 'user_notified' }
  /** A report (or its code-written fallback) already written was not sent: the host told the user itself. */
  | { type: 'report_dropped'; at: number; conversationId: string; jobId: string; kind: 'report' | 'fallback'; reason: 'user_notified' }
  | { type: 'turn_timeout'; at: number; conversationId: string; kind: 'check' | 'report'; checkId?: string | null; jobId?: string | null }
  | { type: 'nothing_owed'; at: number; conversationId: string; checkId: string; ms: number }
  | { type: 'still_running'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'delivered'; at: number; conversationId: string; checkId: string; chars: number; ms: number; ids?: Ids; stillRunning: boolean }
  | { type: 'duplicate_skipped'; at: number; conversationId: string; checkId: string | null; jobId?: string; chars: number }
  | { type: 'failed'; at: number; conversationId: string; checkId: string; recheck: number; ms: number }
  | { type: 'gave_up'; at: number; conversationId: string; checkId?: string | null; reason: GiveUpContext['reason']; delivered: boolean; suppressed?: boolean }
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
  | { type: 'delivery_skipped'; at: number; conversationId: string; kind: DeliveryKind; checkId: string | null; jobId: string | null }
  | { type: 'delivery_recovered'; at: number; conversationId: string; kind: DeliveryKind; checkId?: string; jobId?: string; attempt: number; ids?: Ids }
  | { type: 'delivery_failed'; at: number; conversationId: string; kind: DeliveryKind; checkId?: string; jobId?: string; attempts: number; permanent: boolean; error: unknown }
  | { type: 'missed_notice'; at: number; conversationId: string }
  | ({ type: 'usage'; at: number } & UsageInfo)
  | { type: 'error'; at: number; stage: 'store' | 'check' | 'isUserBusy' | 'getDelivered' | 'report' | 'onJobFinished' | 'onStartJobs' | 'onTurnStart' | 'onTurnEnd' | 'deliver' | 'deliveredLog' | 'userNotifiedOnError' | 'promptLines'; conversationId?: string; checkId?: string; jobId?: string; error: unknown }
  | { type: 'started'; at: number; pending: number; parked: number; dated: number; jobs: number; lost: number; reports: number; outbox: number }
  | { type: 'stopped'; at: number };

export interface DeliveredLog {
  /** The same text noted twice within a minute (for example by the host and by the package) stays one entry. */
  note(conversationId: string, text: string, opts?: { at?: number; id?: string | number }): TimedText;
  since(conversationId: string, sinceMs?: number): TimedText[];
  /** The oldest time the log still covers; a check whose window starts earlier says its list may be incomplete. */
  horizon?(): number;
  clear(conversationId?: string): void;
  /** Write a debounced change now. */
  flush?(): void;
}

export interface DeliveredLogOptions {
  /** Persist to this JSON file. Default: memory only. */
  path?: string;
  /** A store's deliveredBacking. */
  backing?: { map?: Map<string, unknown[]>; path?: string; debounceMs?: number };
  /** Batch file writes this long. Default 100 (pending writes are flushed when the process exits). */
  debounceMs?: number;
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
  /** Deliveries waiting for a retry: sent automatically, not to be rewritten. */
  queued?: TimedText[];
  /** Deliveries given up on: "write it again if still needed". */
  failed?: TimedText[];
  /** Set when the send log does not reach back to the window start: the oldest time it covers. */
  deliveredSince?: number;
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
  /** IANA zone of the user: "Now: <local time> (<zone>), <UTC>". Without it: "Now (UTC): ...". */
  timeZone?: string;
  reason?: CheckReason;
  /** Dated checks: the time the agent set. */
  dueAt?: number;
  /** e.g. 'Spanish': adds the line "Write anything for the user in Spanish." */
  language?: string;
  /** Lines from the host (promptLines), added before the closing "Do not wait" line. Blank lines dropped. */
  hostLines?: string | string[];
}

export interface BuildReportPromptInput {
  job: { id: string; title?: string; status?: string; text?: string };
  /** What reached the user since the job ended (if it already has the result, the agent answers NOTHING_OWED). */
  delivered?: TimedText[];
  maxDelivered?: number;
  userLabel?: string;
  /** Bound the job's output to this many characters (head and tail). Default 1500. */
  maxTextLength?: number;
  /** e.g. 'Spanish': adds the line "Write anything for the user in Spanish." */
  language?: string;
  /** Lines from the host (promptLines), added before the closing line. */
  hostLines?: string | string[];
}

/**
 * Every user-visible string the package writes itself. Templates fill {title}, {status}, {line}
 * and {time}; a placeholder inside a filled value is never expanded.
 */
export interface NothingOwedStrings {
  /** Before a delivery that was given up on. Default "Missed: ". */
  missedPrefix: string;
  /** The code-written job report. Default "{title} {status}: {line}". */
  fallbackReport: string;
  /** The same, when the job returned no usable line. Default "{title} {status}.". */
  fallbackReportNoLine: string;
  /** The word for each job status in the code-written report; an unknown status is used as it is. */
  status: { done: string; error: string; stopped: string; lost: string; [status: string]: string };
  /** The output of a job that died in a restart. Default "the work was interrupted by a restart". */
  lostText: string;
  /** The code-written lines, by reason. daily_cap fills {time} (HH:MM, UTC) and {localTime} (HH:MM in the conversation's time zone, UTC when none). */
  giveUp: Record<GiveUpContext['reason'], string>;
}

/** A partial set: missing keys (and missing keys of status and giveUp) keep the English default. */
export type NothingOwedStringsInput = Partial<Omit<NothingOwedStrings, 'status' | 'giveUp'>> & {
  status?: Partial<NothingOwedStrings['status']>;
  giveUp?: Partial<NothingOwedStrings['giveUp']>;
};

export interface NothingOwedOptions {
  /** The check fires this long after the first reply of a window; later replies never move it. Also the recheck and verify delay. Default 300000 (5 min). */
  delayMs?: number;
  /** Timed rechecks at delayMs (after STILL_RUNNING or a failed turn). Default 6. */
  maxRechecks?: number;
  /** After those, further rechecks wait these steps in turn; the last step asks for a one-line status and ends. Default [15, 30, 60, 120] minutes. [] disables. */
  backoffMs?: number[];
  /** When isUserBusy() says yes, try again after this long. Default 60000. */
  busyRetryMs?: number;
  /** isUserBusy() true this long emits busy_stuck once; the check keeps waiting. Default 30 min. */
  busyStuckMs?: number;
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
  /** deliver, isUserBusy, getDelivered, onJobFinished, onStartJobs and the turn hooks time out after this. A timed-out deliver goes to the outbox; a timed-out isUserBusy counts as busy. Default 30000. 0 disables. */
  callbackTimeoutMs?: number;
  /** A delivery the package made gets one verify check; the chain stops after this many. Default 3. */
  maxVerifyDepth?: number;
  /** A DUE time further away than this is treated as STILL_RUNNING. Default 30 days. */
  maxDueMs?: number;
  /** A chain of DUE answers stops after this many timers, with a code-written line. Default 10. */
  maxDueDepth?: number;
  /** Dated timers per conversation at once; past it, a code-written line. Default 5. */
  maxDatedPerConversation?: number;
  /** Model turns (checks and reports) running at once across conversations, before the backlog bonus. Default 2. */
  maxConcurrent?: number;
  /** The slot count grows by one per 25 waiting turns, up to this. Default 8. */
  maxConcurrentLimit?: number;
  /** Model turns per conversation per day (see capDay); past it checks wait for the next day (one code-written line a day) and reports use the fallback line. Default 60. 0 disables. */
  dailyCap?: number;
  /**
   * Which day the daily caps and the once-a-day lines count. 'local' (default): the conversation's
   * own day in its timeZone (the global cap: timeZone when it is a fixed string), UTC when there is
   * none. 'utc': UTC days (the behaviour before 0.6.0).
   */
  capDay?: 'local' | 'utc';
  /** Conversations that return the same key share one dailyCap (for example every topic of one group chat). Default: each conversation its own. A throw or an empty key means the conversation itself. */
  capKey?(conversationId: string): string | null | undefined;
  /** Of dailyCap, this many are kept for window and dated checks. Default 10. */
  dailyCapReserve?: number;
  /** Model turns per day across all conversations; reaching it emits global_daily_cap once. Default 1000. 0 disables. */
  globalDailyCap?: number;
  /** Failed turns in a row (any conversation) that open the circuit breaker. Default 5. 0 disables. */
  circuitFailures?: number;
  /** First pause of an open circuit; it doubles after each failed probe. Default 15 min. */
  circuitPauseMs?: number;
  /** Longest pause. Default 2 h. */
  circuitMaxPauseMs?: number;
  /** First retry of a missed notice after a give-up; it doubles while sends fail. Default 15 min. */
  missedRetryMs?: number;
  /** Longest wait between missed-notice attempts. Default 6 h. */
  missedMaxRetryMs?: number;
  /** Counters of conversations idle this long (and with nothing open) are dropped. Default 30 days. */
  idlePruneMs?: number;
  /** State writes are batched this long; stop() writes at once. Default 100. 0 writes on every change. */
  saveDebounceMs?: number;
  /** IANA zone of your users for the "Now:" line of the prompt, or a function of the conversation. Default: UTC only. */
  timeZone?: string | ((conversationId: string) => string | undefined);
  /** Wait between delivery retries. Default 300000 (5 min). An error's retryAfterMs overrides one wait. */
  retryMs?: number;
  /** Delivery attempts before giving up. Default 12. */
  maxDeliveryAttempts?: number;
  /** How the prompt names the user. Default "the user". */
  userLabel?: string;
  /** Where the scheduler state lives. Default: memory. */
  store?: Store;
  /**
   * Resume the SAME conversation/session with `prompt` and return the agent's reply. Serialize it
   * with your user turns (onTurnStart / isChecking). It must not send anything itself: the package
   * sends what it returns.
   */
  runTurn(conversationId: string, prompt: string, ctx: TurnContext): Promise<string | TurnResult>;
  /**
   * Send a package-made text to the user. It counts as delivered only if it resolves: throw when
   * the platform did not confirm the send (for example, no message id came back). An error's
   * retryAfterMs sets the wait before the next attempt. The package counts it and logs it in the
   * built-in delivered log itself.
   */
  /** Send a package-made text. Throw if not confirmed. Return { text } when the host changed the text on the way out (it is logged instead), or { skipped: true } when the host chose not to send it (nothing logged, no verify, no retry). */
  deliver(conversationId: string, text: string, meta: DeliveryMeta): void | { ids?: Ids; text?: string; skipped?: boolean } | Promise<void | { ids?: Ids; text?: string; skipped?: boolean }>;
  /** Return true for an error that will never succeed; retrying stops at once. */
  isPermanentError?(error: unknown): boolean;
  /** Return true for a reply that must never reach the user (failed check). Default: tool-call markup (isJunkReply). */
  isJunk?(text: string): boolean;
  /** Called right before each model turn (check or report). Serialize it with your user turns. */
  onTurnStart?(conversationId: string, ctx: Omit<TurnContext, 'signal'>): unknown | Promise<unknown>;
  /** Called after each model turn, also when it failed or timed out. */
  onTurnEnd?(conversationId: string, ctx: Omit<TurnContext, 'signal'>): unknown | Promise<unknown>;
  /** A tracked job ended. If given, the package calls it instead of its own report turn. Note your reply with { kind: 'report' }. */
  onJobFinished?(conversationId: string, job: FinishedJob): unknown | Promise<unknown>;
  /** start() found these jobs in the store. Return the ids the host still runs; the rest finish as 'lost'. Default: none kept. */
  onStartJobs?(jobs: TrackedJob[]): Array<string> | Promise<Array<string>>;
  /** The code-written lines (give-up, still running, limits). Wins over strings.giveUp. */
  giveUpText?(ctx: GiveUpContext): string;
  /** Replace any user-visible string (see defaultStrings). Default: English. */
  strings?: NothingOwedStringsInput;
  /** e.g. 'Spanish': the check and report prompts add "Write anything for the user in Spanish." Default: none. */
  promptLanguage?: string;
  /**
   * Extra lines for a check or report prompt (for example your own queue of reports that will be
   * sent anyway), added before its closing line. Called before each turn, while no turn slot is
   * held; it times out like the other callbacks. A throw emits an error (stage promptLines) and the
   * turn runs without them.
   */
  promptLines?(conversationId: string, ctx: { kind: 'check' | 'report'; checkId?: string; jobId?: string; reason: CheckReason | 'report'; recheck?: number }): string | string[] | null | undefined | Promise<string | string[] | null | undefined>;
  /** Your own send log. Omit it to use the built-in delivered log (noteDelivered). */
  getDelivered?(conversationId: string, sinceMs: number): TimedText[] | Promise<TimedText[]>;
  /** Return true while the user is mid-conversation; checks and report turns yield and retry. No turn slot is held while it runs. */
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
   * replyId (normal replies): the same id noted again (a streamed reply: its start, then the whole)
   * replaces the earlier text instead of adding a reply, and is counted once. If a check already
   * ran on the earlier text, the whole reply joins the next check.
   */
  noteReply(conversationId: string, text: string, opts?: { kind?: 'reply' | DeliveryKind | 'system' | string; at?: number; replyId?: string | number }): CheckRecord | null;
  /** The user sent a message. Returns the conversation's message count. */
  noteUserMessage(conversationId: string): number;
  messageCount(conversationId: string): number;
  noteDelivered(conversationId: string, text: string, atOrOpts?: number | { at?: number; id?: string | number }): TimedText;
  /** "Missed:" notices owed in this conversation, each returned once (their timers are cancelled). Send them before your next message. */
  flushMissed(conversationId: string): string[];
  /** True while a model turn (check or report) runs for this conversation. */
  isChecking(conversationId: string): boolean;
  trackJob(conversationId: string, jobId: string, opts?: { title?: string }): TrackedJob;
  /** Resolves at once with the finished job (null for an unknown job). The report runs in the background: watch report_delivered, report_fallback, report_done. */
  /** userNotified: the host already told the user how it ended: no report turn and no onJobFinished (event report_skipped, reason user_notified); parked checks still unpark. */
  finishJob(jobId: string, opts?: { status?: 'done' | 'error' | 'stopped' | 'lost' | string; text?: string; summary?: string; userNotified?: boolean }): Promise<FinishedJob | null>;
  /** trackJob, await the work, finishJob with its result or error message, return the result (or rethrow). userNotifiedOnError: your error path tells the user itself (true, or decided per error), so a rejection runs no report turn. */
  wrapJob<T>(conversationId: string, jobId: string, work: Promise<T> | (() => Promise<T> | T), opts?: { title?: string; userNotifiedOnError?: boolean | ((error: unknown) => boolean) }): Promise<T>;
  /**
   * The host told the user itself how this job ended. Open job: its finishJob runs no report turn.
   * Report still waiting: skipped (report_skipped). Report turn running, or report waiting for a
   * delivery retry or as a missed notice: its text is dropped before deliver() (report_dropped).
   * False when nothing about the job is still open. True does not promise nothing was sent: a
   * text already inside deliver() when you call this still goes out.
   * The flag on an open job is stored: if that job is then lost in a restart, its "interrupted by
   * a restart" report is skipped too.
   */
  noteJobUserNotified(jobId: string): boolean;
  /** Loads the store (notes made earlier are merged), takes its lock, arms the timer. */
  start(): Promise<NothingOwed>;
  /** Stops the timer and writes the final state (sync when the store can). */
  stop(): Promise<void>;
  /** Write a debounced state change now. */
  flush(): Promise<void>;
  tick(): Promise<Array<Outcome | 'busy' | 'capped' | 'report'>>;
  idle(): Promise<void>;
  pending(): CheckRecord[];
  parked(): CheckRecord[];
  dated(): CheckRecord[];
  jobs(): TrackedJob[];
  reports(): ReportRecord[];
  outbox(): OutboxItem[];
  missed(): Array<{ conversationId: string; text: string; due: number }>;
  circuit(): { open: boolean; fails: number; until: number };
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
export declare function defaultGiveUpText(ctx: { reason?: GiveUpContext['reason']; until?: number; timeZone?: string }, strings?: NothingOwedStringsInput): string;
/** The English defaults of every user-visible string (frozen). */
export declare const defaultStrings: Readonly<NothingOwedStrings>;
/**
 * The send guard: run every text your host sends through it. Cuts NOTHING_OWED / STILL_RUNNING
 * marker lines on the first two and last two lines, a marker glued to the start or end, and a last
 * DUE line; a STILL_RUNNING left in the middle becomes "still running". Never drops a normal
 * message. Returns '' when only markers were left.
 */
export declare function cutMarkers(text: string): string;
/** Marker lines cut from the first two and last two non-empty lines; marker says if one was cut. */
export declare function stripMarkerLines(text: string): { text: string; marker: boolean };
/** A DUE line → its time in epoch ms, else null. */
export declare function dueOf(line: string): number | null;
/** The day number (days since 1970-01-01) of a time in an IANA zone; UTC when none or unknown. */
export declare function dayIn(t: number, timeZone?: string): number;
/** Epoch ms of the midnight that starts a day number in an IANA zone. */
export declare function dayStartIn(day: number, timeZone?: string): number;
/** True for tool-call markup returned as text: a line starting with "<｜", or "invoke name=", "<tool_call", "<function_calls>". */
export declare function isJunkReply(text: string): boolean;
/** "<title> <status>: <first line of output, 300 chars>" */
export declare function fallbackReportText(job: { id: string; title?: string; status?: string; text?: string; summary?: string }, strings?: NothingOwedStringsInput): string;
/** Atomic JSON file store; `<path>.delivered.json` holds the delivered log and `<path>.lock` the owning process. */
export declare function createFileStore(path: string): Store & { path: string };
export declare function createMemoryStore(initial?: StoredState | CheckRecord[]): Store;
export declare function createDeliveredLog(opts?: DeliveredLogOptions): DeliveredLog;
