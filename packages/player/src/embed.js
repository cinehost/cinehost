import { mount, mountAll } from './player.js';

/**
 * Script-tag embed. Drop this on any page:
 *
 *   <script async src="https://video.example.com/e.js" data-key="pk_live_..."></script>
 *   <div data-cine data-video="how-it-works"></div>
 *
 * The endpoint is derived from this script's own src, so there is nothing to
 * configure twice. New [data-cine] nodes added later (turbo frames, React
 * renders) are picked up by the MutationObserver.
 */

const script = document.currentScript;
const base = script ? new URL('.', script.src).href.replace(/\/$/, '') : '';
const siteKey = script?.dataset.key || '';

const defaults = { endpoint: base, siteKey };

const styles = document.createElement('link');
styles.rel = 'stylesheet';
styles.href = `${base}/player.css`;
document.head.appendChild(styles);

const boot = () => mountAll(defaults);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

new MutationObserver((mutations) => {
  if (mutations.some((m) => m.addedNodes.length)) boot();
}).observe(document.documentElement, { childList: true, subtree: true });

const api = {
  mount: (target, options) => mount(target, { ...defaults, ...options }),
  mountAll: (options) => mountAll({ ...defaults, ...options }),
  endpoint: base,
};

window.CineHost = Object.assign(window.CineHost || {}, api);

export default api;
