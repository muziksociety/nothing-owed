// v0.5.2: {localTime} in the daily_cap line, in the conversation's time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultGiveUpText } from '../src/index.js';

const UNTIL = Date.UTC(2026, 10, 14, 0, 0, 0); // midnight UTC = 19:00 in UTC-5

test('{localTime} uses the given time zone', () => {
  const s = { giveUp: { daily_cap: 'Vuelvo a revisar a las {localTime}.' } };
  assert.equal(defaultGiveUpText({ reason: 'daily_cap', until: UNTIL, timeZone: 'America/Bogota' }, s), 'Vuelvo a revisar a las 19:00.');
});

test('{localTime} without a time zone is the UTC time', () => {
  const s = { giveUp: { daily_cap: 'at {localTime}' } };
  assert.equal(defaultGiveUpText({ reason: 'daily_cap', until: UNTIL }, s), 'at 00:00');
});

test('the default English line is unchanged', () => {
  assert.equal(defaultGiveUpText({ reason: 'daily_cap', until: UNTIL, timeZone: 'America/Bogota' }), "I've hit today's limit for checking on promises; I'll check again at 00:00 UTC.");
});
