// Stores keep the scheduler state across restarts: pending, parked and dated checks, owed report
// turns, message counters, open tracked jobs, deliveries waiting for a retry, missed notices and
// today's turn counts. A store is { load(), save(state) }; either may return a promise. The
// scheduler always saves the whole state object. v0.1 (a plain array) and v0.2 stores load fine.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** In-memory store: nothing survives the process. Good for tests and short-lived hosts. */
export function createMemoryStore(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(data)),
    save: (records) => { data = JSON.parse(JSON.stringify(records)); },
  };
}

/**
 * JSON file store with atomic writes (write to a temp file, then rename).
 * A missing or unreadable file loads as empty.
 * @param {string} path
 */
export function createFileStore(path) {
  return {
    path,
    load() {
      try {
        const v = JSON.parse(readFileSync(path, 'utf8'));
        return v && typeof v === 'object' ? v : [];
      } catch {
        return [];
      }
    },
    save(records) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(records, null, 2));
      renameSync(tmp, path);
    },
  };
}
