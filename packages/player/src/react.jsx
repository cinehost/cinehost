import { useEffect, useRef } from 'react';
import { mount } from './player.js';

/**
 * React binding for consumers that want a component instead of an iframe.
 *
 *   import { CineHost } from '@cinehost/player';
 *   import '@cinehost/player/player.css';
 *
 *   <CineHost slug="how-it-works" endpoint="https://video.example.com" siteKey="pk_..." />
 *
 * The iframe embed (/embed/:slug) needs no import at all - prefer it unless you
 * need the imperative handle.
 */
export function CineHost({
  slug,
  endpoint,
  siteKey,
  color,
  autoplay = false,
  muted = false,
  loop = false,
  controls = true,
  start = 0,
  meta,
  onReady,
  className,
  style,
}) {
  const ref = useRef(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    let instance = null;
    let cancelled = false;

    mount(ref.current, { slug, endpoint, siteKey, color, autoplay, muted, loop, controls, start, meta })
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        instance = created;
        readyRef.current?.(created);
      })
      .catch((err) => console.error('[CineHost]', err));

    return () => {
      cancelled = true;
      instance?.destroy();
    };
    // Remounting on every prop tweak would restart playback; slug/endpoint are
    // the only identity-changing inputs.
  }, [slug, endpoint, siteKey]);

  return <div ref={ref} className={className} style={style} />;
}

export default CineHost;
