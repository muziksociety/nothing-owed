// Stores keep the scheduler state across restarts: pending, parked and dated checks, owed report
// turns, message counters, open tracked jobs, deliveries waiting for a retry, missed notices,
// turn counts and the circuit breaker. A store is { load(), save(state) }; either may return a
// promise. Optional: saveSync(state) for the final save in stop(), lock()/unlock() to refuse a
// second process, and deliveredBacking (where the built-in delivered log lives). The scheduler
// always saves the whole state object. v0.1 (a plain array), v0.2 and v0.3 stores load fine.
//
// One process per store: the file store takes a lock file and refuses a second live process.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

let tmpSeq = 0;

/** In-memory store: nothing survives the process. Good for tests and short-lived hosts. */
export function createMemoryStore(initial = []) {
  let data = JSON.parse(JSON.stringify(initial));
  const save = (state) => { data = JSON.parse(JSON.stringify(state)); };
  return {
    load: () => JSON.parse(JSON.stringify(data)),
    save,
    saveSync: save,
    // The built-in delivered log of a scheduler on this store lives here too, so it survives
    // a stop() and start() in the same process the way the rest of the state does.
    deliveredBacking: { map: new Map() },
  };
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

/**
 * JSON file store. Saves are atomic (write a temp file, then rename); async saves never land
 * after a newer save. A missing or unreadable file loads as empty. The built-in delivered log is
 * kept next to it in `<path>.delivered.json`, and `<path>.lock` holds the owning process id.
 * @param {string} path
 */
export function createFileStore(path) {
  let gen = 0;
  const lockPath = `${path}.lock`;
  const tmpName = () => `${path}.${process.pid}.${++tmpSeq}.tmp`;
  return {
    path,
    deliveredBacking: { path: `${path}.delivered.json`, debounceMs: 100 },
    load() {
      try {
        const v = JSON.parse(readFileSync(path, 'utf8'));
        return v && typeof v === 'object' ? v : [];
      } catch {
        return [];
      }
    },
    async save(state) {
      const mine = ++gen;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = tmpName();
      await writeFile(tmp, JSON.stringify(state, null, 2));
      if (mine !== gen) { await unlink(tmp).catch(() => {}); return; } // a newer save won
      await rename(tmp, path);
    },
    saveSync(state) {
      ++gen;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = tmpName();
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, path);
    },
    /** Take the lock file; throws if another live process holds it. */
    lock() {
      let pid = 0;
      try { pid = Number(readFileSync(lockPath, 'utf8').trim()); } catch { /* no lock */ }
      if (pid && pid !== process.pid && alive(pid)) {
        throw new Error(`nothing-owed: the store ${path} is in use by another process (pid ${pid})`);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(lockPath, String(process.pid));
    },
    unlock() {
      try { if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath); } catch { /* gone */ }
    },
  };
}
