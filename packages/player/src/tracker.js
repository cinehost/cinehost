/**
 * Engagement tracker.
 *
 * Records which whole seconds of the video were actually played, as
 * [start, end) ranges, and ships them to the collector on a timer plus at every
 * moment the page might be going away. The server turns ranges into a
 * per-second play-count array - that array is what every Wistia-style metric
 * (play rate, engagement graph, drop-off curve, rewatch spikes) is computed
 * from, so getting this right is the whole product.
 *
 * Wire notes:
 *  - content-type is text/plain so the request stays CORS-simple. A JSON
 *    content type would trigger a preflight, which sendBeacon cannot do and
 *    which the browser drops during pagehide.
 *  - the view id is generated client-side, so every beacon is an idempotent
 *    upsert and no round trip is needed before the first flush.
 */

const FLUSH_INTERVAL_MS = 8000;

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ||
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const rand = (Math.random() * 16) | 0;
    return (ch === 'x' ? rand : (rand & 0x3) | 0x8).toString(16);
  });

function stored(storage, key) {
  try {
    const existing = storage.getItem(key);
    if (existing) return existing;
    const fresh = uuid();
    storage.setItem(key, fresh);
    return fresh;
  } catch {
    // Private mode / blocked storage. An ephemeral id still gives correct
    // per-view numbers, it just can't stitch a returning visitor.
    return uuid();
  }
}

export function createTracker({ endpoint, siteKey, slug, media, meta = {} }) {
  const visitorId = stored(globalThis.localStorage || {}, 'cine_visitor');
  const sessionId = stored(globalThis.sessionStorage || {}, 'cine_session');
  const viewId = uuid();

  let ranges = [];
  let events = [];
  let dirty = false;
  let destroyed = false;
  let lastTime = 0;
  let impressionSent = false;

  const markSecond = (sec) => {
    const s = Math.floor(sec);
    if (!Number.isFinite(s) || s < 0) return;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === s) {
      last[1] = s + 1; // still playing straight through
    } else if (last && s >= last[0] && s < last[1]) {
      // already covered in this flush window
    } else {
      ranges.push([s, s + 1]);
    }
    dirty = true;
  };

  const track = (kind, atSec, extra) => {
    events.push({ k: kind, s: atSec ?? media?.currentTime ?? 0, ...(extra ? { m: extra } : {}) });
    dirty = true;
  };

  const payload = () => ({
    k: siteKey,
    v: slug,
    id: viewId,
    vid: visitorId,
    sid: sessionId,
    ctx: {
      url: location.href.slice(0, 1024),
      ref: document.referrer.slice(0, 1024),
      dur: Number.isFinite(media?.duration) ? Math.round(media.duration) : 0,
      ...meta,
    },
    r: ranges,
    e: events,
  });

  const flush = (useBeacon = false) => {
    if (destroyed || !dirty) return;
    const body = JSON.stringify(payload());
    ranges = [];
    events = [];
    dirty = false;

    const url = `${endpoint}/v1/collect`;
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
        return;
      }
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        keepalive: true,
        credentials: 'omit',
      }).catch(() => {});
    } catch {
      /* analytics must never break playback */
    }
  };

  const timer = setInterval(() => flush(false), FLUSH_INTERVAL_MS);

  /**
   * timeupdate fires on a wall-clock cadence (~4/s), not a media-time one, so
   * at 2x it lands every ~0.5s of media and at 16x every ~4s. Marking only the
   * current second would silently drop everything in between - a 2x viewer
   * would look like they watched half the video. Fill the span instead, but
   * only when the gap is consistent with continuous playback at the current
   * rate; anything larger is a seek and must leave a real hole in the data.
   */
  const onTimeUpdate = () => {
    const now = media.currentTime;
    if (!media.paused && !media.seeking && Number.isFinite(now)) {
      const maxGap = Math.max(2, media.playbackRate * 2);
      const gap = now - lastTime;
      const from = gap > 0 && gap <= maxGap ? Math.floor(lastTime) : Math.floor(now);
      for (let sec = from; sec <= Math.floor(now); sec += 1) markSecond(sec);
    }
    lastTime = now;
  };
  const onPlay = () => track('play');
  const onPause = () => {
    if (media.ended) return;
    track('pause');
    flush(false);
  };
  const onSeeked = () => {
    track('seek', media.currentTime, { from: Math.round(lastTime * 10) / 10 });
    // Don't let the next timeupdate bridge across the jump.
    lastTime = media.currentTime;
  };
  const onEnded = () => {
    markSecond(Math.max(0, media.duration - 1));
    track('ended', media.duration);
    flush(false);
  };
  const onRateChange = () => track('ratechange', media.currentTime, { rate: media.playbackRate });
  const onError = () => track('error', media.currentTime, { code: media.error?.code });

  media.addEventListener('timeupdate', onTimeUpdate);
  media.addEventListener('play', onPlay);
  media.addEventListener('pause', onPause);
  media.addEventListener('seeked', onSeeked);
  media.addEventListener('ended', onEnded);
  media.addEventListener('ratechange', onRateChange);
  media.addEventListener('error', onError);

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush(true);
  };
  const onPageHide = () => flush(true);
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', onPageHide);

  // An impression is "the player was actually on screen", not "the script ran".
  // Play rate is meaningless if a player below the fold counts as an impression.
  let observer = null;
  let visibleSince = null;
  const markImpression = () => {
    if (impressionSent) return;
    impressionSent = true;
    track('impression', 0);
    flush(false);
  };

  if (typeof IntersectionObserver === 'function' && media.parentElement) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.5) {
            visibleSince = visibleSince ?? Date.now();
            setTimeout(() => {
              if (visibleSince && Date.now() - visibleSince >= 900) markImpression();
            }, 1000);
          } else {
            visibleSince = null;
          }
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(media.parentElement);
  } else {
    markImpression();
  }

  return {
    viewId,
    visitorId,
    sessionId,
    track,
    markImpression,
    flush,
    /** Client-side email gate. Unverified by definition - a lead hint. */
    async identify(traits) {
      try {
        await fetch(`${endpoint}/v1/identify/client`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-site-key': siteKey },
          body: JSON.stringify({ view_id: viewId, visitor_id: visitorId, ...traits }),
        });
        track('gate_submit');
        flush(false);
      } catch {
        /* ignore */
      }
    },
    destroy() {
      if (destroyed) return;
      flush(true);
      destroyed = true;
      clearInterval(timer);
      observer?.disconnect();
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('ended', onEnded);
      media.removeEventListener('ratechange', onRateChange);
      media.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('pagehide', onPageHide);
    },
  };
}
