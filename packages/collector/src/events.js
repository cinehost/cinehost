/**
 * Tiny in-process pub/sub for job progress, consumed by the dashboard over SSE.
 *
 * Deliberately not polling: a transcode emits a progress line several times a
 * second and the dashboard should show it moving, which polling either misses
 * or hammers for. One process, one queue, so an in-memory hub is the whole
 * requirement - no Redis.
 */
const subscribers = new Map(); // slug -> Set<fn>

export function subscribe(slug, fn) {
  if (!subscribers.has(slug)) subscribers.set(slug, new Set());
  subscribers.get(slug).add(fn);
  return () => {
    const set = subscribers.get(slug);
    if (!set) return;
    set.delete(fn);
    if (!set.size) subscribers.delete(slug);
  };
}

export function publish(slug, payload) {
  for (const fn of subscribers.get(slug) || []) {
    try {
      fn(payload);
    } catch {
      /* a dead subscriber must never break the job */
    }
  }
  for (const fn of subscribers.get('*') || []) {
    try {
      fn({ slug, ...payload });
    } catch {
      /* ignore */
    }
  }
}
