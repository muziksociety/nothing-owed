// v0.5.0: every user-visible string can be replaced (strings); promptLanguage asks the model for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, defaultStrings, defaultGiveUpText, fallbackReportText, buildPrompt, buildReportPrompt } from '../src/index.js';
import { world, MIN } from './helpers.js';

const C = 'chat-50';
const FIVE = 5 * MIN;
const texts = (w) => w.sent.map((s) => s.text);
const ev = (w, type) => w.events.filter((e) => e.type === type);

async function five(opts = {}, extra = {}) {
  const w = world(opts);
  w.no = w.make({ delayMs: FIVE, ...extra });
  await w.no.start();
  return w;
}

// ---- 2. language ----------------------------------------------------------------------------

const ES = {
  missedPrefix: 'Perdido: ',
  fallbackReport: '{title}: {status}. {line}',
  fallbackReportNoLine: '{title}: {status}.',
  status: { done: 'terminado', error: 'falló', stopped: 'detenido', lost: 'interrumpido' },
  lostText: 'el trabajo se interrumpió por un reinicio',
  giveUp: {
    failed: 'Quizá dije que te avisaría de algo y no pude comprobarlo. Pregúntame si algo sigue pendiente.',
    still_running: 'Algo que empecé puede seguir en marcha y ya no lo vigilo. Pregúntame si necesitas novedades.',
    verify_capped: 'Ya no vigilo esto automáticamente. Pregúntame si algo sigue pendiente.',
    daily_cap: 'Llegué al límite de hoy; vuelvo a comprobar a las {time} UTC.',
    due_limit: 'No puedo guardar otro recordatorio aquí. Pídemelo más cerca de la hora.',
  },
};

test('defaultStrings holds the English defaults, and the defaults keep today\'s output', () => {
  assert.equal(defaultStrings.missedPrefix, 'Missed: ');
  assert.equal(defaultStrings.lostText, 'the work was interrupted by a restart');
  assert.equal(defaultStrings.giveUp.failed, defaultGiveUpText({ reason: 'failed' }));
  assert.equal(defaultGiveUpText({ reason: 'daily_cap', until: Date.UTC(2026, 0, 2) }), "I've hit today's limit for checking on promises; I'll check again at 00:00 UTC.");
  assert.equal(fallbackReportText({ id: 'j', title: 'render', status: 'done', text: 'ok\nmore' }), 'render done: ok');
  assert.equal(fallbackReportText({ id: 'j', title: 'render', status: 'error' }), 'render error.');
  assert.ok(Object.isFrozen(defaultStrings));
});

test('the exported helpers take a strings set', () => {
  assert.equal(defaultGiveUpText({ reason: 'daily_cap', until: Date.UTC(2026, 0, 2, 7, 30) }, ES), 'Llegué al límite de hoy; vuelvo a comprobar a las 07:30 UTC.');
  assert.equal(fallbackReportText({ id: 'j', title: 'render', status: 'error', text: 'disco lleno' }, ES), 'render: falló. disco lleno');
  assert.equal(fallbackReportText({ id: 'j', title: 'render', status: 'odd' }, ES), 'render: odd.', 'an unknown status stays as it is');
  assert.equal(fallbackReportText({ id: 'j', title: 'a {line} b', status: 'done', text: 'x' }, ES), 'a {line} b: terminado. x', 'placeholders in values are not expanded');
});

test('Spanish: a give-up line after failed checks', async () => {
  const w = await five({ reply: () => { throw new Error('down'); } }, { strings: ES, maxRechecks: 0, backoffMs: [], circuitFailures: 0 });
  w.no.noteReply(C, 'Te mando el resumen.');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), [ES.giveUp.failed]);
});

test('Spanish: the daily-cap line', async () => {
  const w = await five({ reply: 'STILL_RUNNING' }, { strings: ES, dailyCap: 1, dailyCapReserve: 0 });
  w.no.noteReply(C, 'Te aviso.');
  await w.advance(FIVE);
  await w.advance(FIVE);
  assert.equal(texts(w).length, 1);
  assert.match(texts(w)[0], /^Llegué al límite de hoy; vuelvo a comprobar a las \d\d:\d\d UTC\.$/);
});

test('Spanish: a giveUpText option still wins over strings', async () => {
  const w = await five({ reply: () => { throw new Error('down'); } }, { strings: ES, giveUpText: () => 'custom', maxRechecks: 0, backoffMs: [], circuitFailures: 0 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), ['custom']);
});

test('Spanish: the code-written report uses the status words and the template', async () => {
  const w = await five({ reply: 'unused' }, { strings: ES, dailyCap: 1, dailyCapReserve: 1 }); // reports are capped at once
  w.no.trackJob(C, 'j', { title: 'render' });
  await w.no.finishJob('j', { status: 'error', text: 'disco lleno\nmás' });
  await w.no.idle();
  assert.deepEqual(texts(w), ['render: falló. disco lleno']);
});

test('Spanish: a job lost in a restart uses lostText and the lost status word', async () => {
  const t = 1_700_000_000_000;
  const store = createMemoryStore({ version: 4, records: [], jobs: { j: { id: 'j', conversationId: C, title: 'render', startedAt: t - MIN } } });
  const w = await five({ store, reply: 'unused' }, { strings: ES, dailyCap: 1, dailyCapReserve: 1 });
  await w.no.idle();
  assert.deepEqual(texts(w), ['render: interrumpido. el trabajo se interrumpió por un reinicio']);
});

test('Spanish: missed notices carry the Spanish prefix (timer and flushMissed)', async () => {
  let n = 0;
  const w = world({ reply: 'El resumen: tres puntos.' });
  w.no = w.make({
    delayMs: FIVE,
    strings: ES,
    maxDeliveryAttempts: 1,
    deliver: async (cid, text) => {
      n++;
      if (n === 1) throw new Error('down');
      w.sent.push({ conversationId: cid, text });
    },
  });
  await w.no.start();
  w.no.noteReply(C, 'Te mando el resumen.');
  await w.advance(FIVE);
  await w.advance(15 * MIN);
  assert.deepEqual(texts(w).slice(0, 1), ['Perdido: El resumen: tres puntos.']);

  const w2 = await five({ reply: 'El resumen.' }, { strings: ES, isPermanentError: () => true, deliver: async () => { throw new Error('gone'); } });
  w2.no.noteReply(C, 'x');
  await w2.advance(FIVE);
  assert.deepEqual(w2.no.flushMissed(C), ['Perdido: El resumen.']);
});

test('a partial strings set keeps the other defaults', async () => {
  const w = await five({ reply: () => { throw new Error('down'); } }, { strings: { missedPrefix: 'X: ', giveUp: { due_limit: 'nope' } }, maxRechecks: 0, backoffMs: [], circuitFailures: 0 });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  assert.deepEqual(texts(w), [defaultStrings.giveUp.failed]);
});

test('promptLanguage adds one line to the check and the report prompts', async () => {
  const line = 'Write anything for the user in Spanish.';
  const w = await five({ reply: 'NOTHING_OWED' }, { promptLanguage: 'Spanish' });
  w.no.noteReply(C, 'x');
  await w.advance(FIVE);
  w.no.trackJob(C, 'j');
  await w.no.finishJob('j', { text: 'ok' });
  await w.no.idle();
  const [check, report] = w.turns;
  assert.equal(check.ctx.kind, 'check');
  assert.equal(report.ctx.kind, 'report');
  assert.equal(check.prompt.split(line).length, 2, 'once in the check prompt');
  assert.equal(report.prompt.split(line).length, 2, 'once in the report prompt');
});

test('without promptLanguage the prompts are unchanged', () => {
  const input = { replies: [{ at: 0, text: 'x' }], now: 0 };
  assert.equal(buildPrompt({ ...input, language: undefined }), buildPrompt(input));
  assert.doesNotMatch(buildPrompt(input), /Write anything/);
  const job = { id: 'j', title: 't', status: 'done', text: 'ok' };
  assert.doesNotMatch(buildReportPrompt({ job }), /Write anything/);
  assert.match(buildReportPrompt({ job, language: 'Spanish', userLabel: 'the customer' }), /Write anything for the customer in Spanish\./);
});
