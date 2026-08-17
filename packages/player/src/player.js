import { createTracker } from './tracker.js';

/**
 * Dependency-free player chrome. A native <video> underneath (never with its
 * own `controls`), everything above it is ours, so it can be brand-coloured and
 * restyled without fighting a shadow DOM.
 *
 * One DOM tree serves three skins - `glass`, `edge`, `minimal` - selected with
 * data-skin on the root and expressed entirely in CSS. Adding a skin should
 * never mean touching this file.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const SKINS = new Set(['glass', 'edge', 'minimal', 'bar']);

/**
 * The `bar` skin paints the control strip in the accent colour, so its text and
 * icons have to flip to dark on a light accent or the bar becomes unreadable.
 * Relative luminance per WCAG; 0.5 is about where white ink stops working.
 */
function inkFor(hex) {
  const value = String(hex || '').replace('#', '');
  if (value.length !== 6) return '#ffffff';
  const channel = (pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(value.slice(0, 2)) +
    0.7152 * channel(value.slice(2, 4)) +
    0.0722 * channel(value.slice(4, 6));
  return luminance > 0.45 ? 'rgba(0,0,0,0.88)' : '#ffffff';
}

const fmt = (secs) => {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

const el = (tag, className, attrs = {}) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  return node;
};

const icon = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

const ICONS = {
  // The triangle is drawn UNDER-sized and then stroked with a round linejoin,
  // which grows it back to size with softened corners. Rounding the apex is the
  // whole difference between a play glyph that looks drawn and one that looks
  // like a default: a hard point at 34px reads as cheap.
  play: icon('<path d="M9 6.6 18 12l-9 5.4Z" stroke="currentColor" stroke-width="3.1" stroke-linejoin="round" stroke-linecap="round"/>'),
  pause: icon('<rect x="7.2" y="5.3" width="3.5" height="13.4" rx="1.6"/><rect x="13.3" y="5.3" width="3.5" height="13.4" rx="1.6"/>'),
  replay: icon('<path d="M12 5a7 7 0 1 1-6.6 4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M12 2.2 15 5l-3 2.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  volume: icon('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  muted: icon('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9.5l4 5m0-5l-4 5" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  cc: icon('<path d="M3 5h18v14H3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.2a2 2 0 1 0 0 3.6M16 10.2a2 2 0 1 0 0 3.6" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  pip: icon('<path d="M3 5h18v14H3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 12h7v5h-7z"/>'),
  expand: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2"/>'),
  collapse: icon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2"/>'),
  // Sliders, not a cog: at 20px a cog's teeth turn to mush and read as a sun.
  gear: icon('<path d="M4 8h10M18 8h2M4 16h4M12 16h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="16" r="2.3" fill="none" stroke="currentColor" stroke-width="2"/>'),
  check: icon('<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
};

const isHls = (source) => /mpegurl|m3u8/i.test(source.type || source.src || '');

/**
 * Progressive MP4 is the whole story for v1 - a faststart mp4 behind
 * Cloudflare seeks fine over Range requests and needs no player library.
 * Native HLS (Safari) is honoured if a playlist is listed. Adding an adaptive
 * ladder later means adding hls.js here and nothing else.
 */
function attachSource(media, sources) {
  const hls = sources.find(isHls);
  const progressive = sources.filter((s) => !isHls(s));

  if (hls && media.canPlayType('application/vnd.apple.mpegurl')) {
    media.src = hls.src;
    return;
  }
  if (hls && !progressive.length) {
    console.warn('[CineHost] HLS source with no progressive fallback and no native HLS support');
  }

  for (const source of progressive) {
    media.appendChild(el('source', null, { src: source.src, type: source.type || 'video/mp4' }));
  }
}

export async function mount(target, options = {}) {
  const root = typeof target === 'string' ? document.querySelector(target) : target;
  if (!root) throw new Error('CineHost.mount: target not found');

  const endpoint = (options.endpoint || root.dataset.endpoint || '').replace(/\/$/, '');
  const slug = options.slug || root.dataset.video;
  const siteKey = options.siteKey || root.dataset.siteKey;
  if (!slug) throw new Error('CineHost.mount: no video slug');

  const config =
    options.config ||
    (await fetch(`${endpoint}/v1/videos/${encodeURIComponent(slug)}`).then((r) => {
      if (!r.ok) throw new Error(`CineHost: unknown video "${slug}"`);
      return r.json();
    }));

  const accent = options.color || root.dataset.color || config.accent || '#2563eb';
  const requested = options.skin || root.dataset.skin || config.skin;
  const skin = SKINS.has(requested) ? requested : 'glass';

  root.classList.add('cine');
  if (options.fill) root.classList.add('cine--fill');
  root.dataset.skin = skin;
  const applyAccent = (color) => {
    root.style.setProperty('--cine-accent', color);
    root.style.setProperty('--cine-bar-ink', inkFor(color));
  };
  applyAccent(accent);
  if (!options.fill) root.style.setProperty('--cine-ratio', (config.aspectRatio || '16/9').replace(':', '/'));
  root.innerHTML = '';
  root.tabIndex = 0;

  const captions = config.captions || [];

  // Autoplay is a three-state setting, not a boolean: `muted` is the only mode
  // browsers reliably permit, and `sound` has to be attempted then recovered
  // from. `?autoplay=1` from an embed URL means the muted variant.
  const AUTOPLAY_MODES = ['off', 'muted', 'sound'];
  const autoplayMode = (() => {
    if (options.autoplay === true) return 'muted';
    if (AUTOPLAY_MODES.includes(options.autoplay)) return options.autoplay;
    if (options.autoplay === false) return 'off';
    return AUTOPLAY_MODES.includes(config.autoplay) ? config.autoplay : 'off';
  })();
  const shouldLoop = options.loop ?? config.loop ?? false;

  // A bare embed: no chrome at all, for ambient / background video. The URL
  // wins over the saved setting, and the saved setting over the default.
  const showControls =
    typeof options.controls === 'boolean' ? options.controls
      : typeof config.controls === 'boolean' ? config.controls
        : true;

  const media = el('video', 'cine-video', {
    playsinline: true,
    preload: options.preload || 'metadata',
    poster: config.poster || undefined,
    // crossorigin ONLY when there are subtitle tracks, which genuinely need it
    // when they are cross-origin. Setting it unconditionally makes the browser
    // demand CORS headers on the video file itself, and an R2 custom domain
    // sends none by default - playback then stalls silently at 0:00 with a
    // fired `play` event and no error the tracker can see.
    crossorigin: captions.length ? 'anonymous' : undefined,
    loop: shouldLoop,
    muted: options.muted || autoplayMode === 'muted',
  });
  media.muted = Boolean(options.muted) || autoplayMode === 'muted';
  root.appendChild(media);

  for (const track of captions) {
    media.appendChild(
      el('track', null, {
        kind: 'subtitles',
        src: track.src,
        srclang: track.srclang || 'en',
        label: track.label || 'English',
        default: track.default,
      }),
    );
  }

  attachSource(media, config.sources || []);

  // ---- chrome -------------------------------------------------------------
  const bigPlay = el('button', 'cine-bigplay', { type: 'button', 'aria-label': 'Play', html: ICONS.play });
  const spinner = el('div', 'cine-spinner', { 'aria-hidden': 'true' });

  // Teaser: a short silent loop shown on hover before anyone presses play.
  // preload="none" so it costs nothing until it is actually wanted.
  const teaserSrc = config.teaser && config.teaser.mp4;
  const teaser = teaserSrc && options.teaser !== false
    ? el('video', 'cine-teaser', {
        src: teaserSrc, muted: true, loop: true, playsinline: true,
        preload: 'none', 'aria-hidden': 'true', tabindex: '-1',
      })
    : null;
  if (teaser) teaser.muted = true;

  const unmute = el('button', 'cine-unmute', {
    type: 'button',
    html: `${ICONS.muted}<span>Tap for sound</span>`,
  });
  const controls = el('div', 'cine-controls');

  const scrub = el('div', 'cine-scrub', {
    role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0',
  });
  const buffered = el('div', 'cine-buffered');
  const progress = el('div', 'cine-progress');
  const handle = el('div', 'cine-handle');
  scrub.append(buffered, progress, handle);

  const thumbs = config.thumbnails && config.thumbnails.url ? config.thumbnails : null;
  const preview = el('div', 'cine-preview', { 'aria-hidden': 'true' });
  const previewImage = el('div', 'cine-preview-img');
  const previewTime = el('span', 'cine-preview-time', { text: '0:00' });
  preview.append(previewImage, previewTime);
  if (thumbs) {
    previewImage.style.backgroundImage = `url(${thumbs.url})`;
    previewImage.style.width = `${thumbs.width}px`;
    previewImage.style.height = `${thumbs.height}px`;
    previewImage.style.backgroundSize = `${thumbs.width * thumbs.columns}px ${thumbs.height * thumbs.rows}px`;
  } else {
    preview.classList.add('cine-preview--time-only');
  }

  const scrubRow = el('div', 'cine-scrub-row');
  scrubRow.append(scrub, preview);

  const playBtn = el('button', 'cine-btn cine-play', { type: 'button', 'aria-label': 'Play', html: ICONS.play });
  const muteBtn = el('button', 'cine-btn', { type: 'button', 'aria-label': 'Mute', html: ICONS.volume });
  const volume = el('input', 'cine-volume', {
    type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume',
  });
  const volumeWrap = el('div', 'cine-volume-wrap');
  volumeWrap.append(muteBtn, volume);

  const time = el('span', 'cine-time', { text: '0:00 / 0:00' });
  const spacer = el('div', 'cine-flex');

  const ccBtn = captions.length
    ? el('button', 'cine-btn', { type: 'button', 'aria-label': 'Captions', html: ICONS.cc })
    : null;

  // ---- settings menu ----
  const gearBtn = el('button', 'cine-btn', {
    type: 'button', 'aria-label': 'Settings', 'aria-haspopup': 'true', 'aria-expanded': 'false', html: ICONS.gear,
  });
  const menu = el('div', 'cine-menu', { role: 'menu' });
  const menuWrap = el('div', 'cine-menu-wrap');
  menuWrap.append(gearBtn, menu);

  const speedItems = SPEEDS.map((speed) => {
    const item = el('button', 'cine-menu-item', { type: 'button', role: 'menuitemradio' });
    item.append(
      el('span', 'cine-menu-check', { html: ICONS.check }),
      el('span', null, { text: speed === 1 ? 'Normal' : `${speed}×` }),
    );
    item.addEventListener('click', () => {
      media.playbackRate = speed;
      closeMenu();
    });
    return { speed, item };
  });

  const captionItem = captions.length
    ? (() => {
        const item = el('button', 'cine-menu-item', { type: 'button', role: 'menuitemcheckbox' });
        item.append(el('span', 'cine-menu-check', { html: ICONS.check }), el('span', null, { text: 'Subtitles' }));
        item.addEventListener('click', () => toggleCaptions());
        return item;
      })()
    : null;

  menu.append(el('div', 'cine-menu-label', { text: 'Speed' }), ...speedItems.map((s) => s.item));
  if (captionItem) menu.append(el('div', 'cine-menu-label', { text: 'Captions' }), captionItem);

  const pipBtn = document.pictureInPictureEnabled
    ? el('button', 'cine-btn', { type: 'button', 'aria-label': 'Picture in picture', html: ICONS.pip })
    : null;
  const fsBtn = el('button', 'cine-btn', { type: 'button', 'aria-label': 'Fullscreen', html: ICONS.expand });

  const bar = el('div', 'cine-bar');
  bar.append(playBtn, volumeWrap, time, spacer);
  if (ccBtn) bar.append(ccBtn);
  bar.append(menuWrap);
  if (pipBtn) bar.append(pipBtn);
  bar.append(fsBtn);

  controls.append(scrubRow, bar);
  if (teaser) root.appendChild(teaser);
  root.appendChild(spinner);

  // With no chrome AND autoplay on, the big play button would be the only thing
  // on screen - which is the opposite of what a bare embed is for. With
  // autoplay off it has to stay, or the video is simply unplayable.
  if (showControls || autoplayMode === 'off') root.appendChild(bigPlay);

  // The unmute prompt survives bare mode on purpose: if `sound` autoplay is
  // blocked and there is no chrome, it is the viewer's ONLY route to audio.
  root.appendChild(unmute);
  if (showControls) root.appendChild(controls);
  root.classList.toggle('cine--bare', !showControls);

  // ---- tracker ------------------------------------------------------------
  // `track: false` mounts a real player that records nothing. The dashboard
  // preview uses it: without this, every time someone opened a video to tweak
  // its poster they would log an impression and a play against their own
  // analytics.
  const tracker = options.track === false
    ? { viewId: null, track() {}, flush() {}, identify() {}, destroy() {}, markImpression() {} }
    : createTracker({ endpoint, siteKey, slug, media, meta: options.meta });

  // ---- behaviour ----------------------------------------------------------
  const durationOf = () => media.duration || config.duration || 0;

  const setPlayIcon = () => {
    playBtn.innerHTML = media.ended ? ICONS.replay : media.paused ? ICONS.play : ICONS.pause;
    bigPlay.innerHTML = media.ended ? ICONS.replay : ICONS.play;
    playBtn.setAttribute('aria-label', media.paused ? 'Play' : 'Pause');
    root.classList.toggle('is-playing', !media.paused);
    root.classList.toggle('is-ended', media.ended);
  };

  const toggle = () => (media.paused ? media.play().catch(() => {}) : media.pause());

  const renderProgress = () => {
    const duration = durationOf();
    const pct = duration ? (media.currentTime / duration) * 100 : 0;
    progress.style.width = `${pct}%`;
    handle.style.left = `${pct}%`;
    scrub.setAttribute('aria-valuemax', String(Math.round(duration)));
    scrub.setAttribute('aria-valuenow', String(Math.round(media.currentTime)));
    scrub.setAttribute('aria-valuetext', `${fmt(media.currentTime)} of ${fmt(duration)}`);
    time.textContent = `${fmt(media.currentTime)} / ${fmt(duration)}`;
    if (media.buffered.length) {
      const end = media.buffered.end(media.buffered.length - 1);
      buffered.style.width = duration ? `${(end / duration) * 100}%` : '0%';
    }
  };

  const ratioFromPointer = (event) => {
    const rect = scrub.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  const seekFromPointer = (event) => {
    const duration = durationOf();
    if (duration) media.currentTime = ratioFromPointer(event) * duration;
  };

  /** Sprite lookup: one cached image, offset to the tile for this second. */
  const showPreview = (event) => {
    const duration = durationOf();
    if (!duration) return;
    const ratio = ratioFromPointer(event);
    const at = ratio * duration;
    previewTime.textContent = fmt(at);

    if (thumbs) {
      const index = Math.min(thumbs.count - 1, Math.max(0, Math.floor(at / thumbs.interval)));
      const col = index % thumbs.columns;
      const row = Math.floor(index / thumbs.columns);
      previewImage.style.backgroundPosition = `-${col * thumbs.width}px -${row * thumbs.height}px`;
    }

    const rect = scrub.getBoundingClientRect();
    const rowRect = scrubRow.getBoundingClientRect();
    const width = preview.offsetWidth || (thumbs ? thumbs.width : 54);
    const raw = rect.left - rowRect.left + ratio * rect.width - width / 2;
    preview.style.left = `${Math.min(rowRect.width - width, Math.max(0, raw))}px`;
    root.classList.add('is-previewing');
  };

  const hidePreview = () => root.classList.remove('is-previewing');

  const closeMenu = () => {
    root.classList.remove('is-menu-open');
    gearBtn.setAttribute('aria-expanded', 'false');
  };
  const syncMenu = () => {
    for (const { speed, item } of speedItems) {
      const active = Math.abs(media.playbackRate - speed) < 0.001;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-checked', String(active));
    }
    if (captionItem) {
      const on = Array.from(media.textTracks).some((t) => t.mode === 'showing');
      captionItem.classList.toggle('is-active', on);
      captionItem.setAttribute('aria-checked', String(on));
      ccBtn?.classList.toggle('is-active', on);
    }
  };

  function toggleCaptions() {
    const tracks = Array.from(media.textTracks);
    const active = tracks.some((t) => t.mode === 'showing');
    tracks.forEach((t) => { t.mode = active ? 'disabled' : 'showing'; });
    syncMenu();
    tracker.track(active ? 'mute' : 'unmute', media.currentTime, { captions: !active });
  }

  gearBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = root.classList.toggle('is-menu-open');
    gearBtn.setAttribute('aria-expanded', String(open));
    if (open) syncMenu();
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeMenu);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  playBtn.addEventListener('click', toggle);
  bigPlay.addEventListener('click', toggle);
  media.addEventListener('click', toggle);
  media.addEventListener('play', setPlayIcon);
  media.addEventListener('pause', setPlayIcon);
  media.addEventListener('ended', setPlayIcon);
  media.addEventListener('timeupdate', renderProgress);
  media.addEventListener('progress', renderProgress);
  media.addEventListener('loadedmetadata', renderProgress);
  media.addEventListener('ratechange', syncMenu);
  media.addEventListener('waiting', () => root.classList.add('is-loading'));
  media.addEventListener('playing', () => root.classList.remove('is-loading'));
  media.addEventListener('canplay', () => root.classList.remove('is-loading'));

  let scrubbing = false;
  scrub.addEventListener('pointerdown', (event) => {
    scrubbing = true;
    scrub.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  });
  scrub.addEventListener('pointermove', (event) => {
    showPreview(event);
    if (scrubbing) seekFromPointer(event);
  });
  scrub.addEventListener('pointerup', (event) => {
    scrubbing = false;
    scrub.releasePointerCapture(event.pointerId);
  });
  scrub.addEventListener('pointerleave', () => {
    if (!scrubbing) hidePreview();
  });
  scrub.addEventListener('keydown', (event) => {
    const duration = durationOf();
    if (!duration) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); media.currentTime = Math.min(duration, media.currentTime + 5); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); media.currentTime = Math.max(0, media.currentTime - 5); }
  });

  muteBtn.addEventListener('click', () => { media.muted = !media.muted; });
  media.addEventListener('volumechange', () => {
    muteBtn.innerHTML = media.muted || media.volume === 0 ? ICONS.muted : ICONS.volume;
    muteBtn.setAttribute('aria-label', media.muted ? 'Unmute' : 'Mute');
    volume.value = String(media.muted ? 0 : media.volume);
  });
  volume.addEventListener('input', () => {
    media.volume = Number(volume.value);
    media.muted = Number(volume.value) === 0;
  });

  if (ccBtn) ccBtn.addEventListener('click', toggleCaptions);

  if (pipBtn) {
    pipBtn.addEventListener('click', () => {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else media.requestPictureInPicture().catch(() => {});
    });
  }

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  });
  document.addEventListener('fullscreenchange', () => {
    const full = document.fullscreenElement === root;
    fsBtn.innerHTML = full ? ICONS.collapse : ICONS.expand;
    tracker.track('fullscreen', media.currentTime, { on: full });
  });

  root.addEventListener('keydown', (event) => {
    if (event.target === scrub) return; // the slider handles its own arrows
    const key = event.key;
    const nudge = (delta) => {
      media.currentTime = Math.min(durationOf(), Math.max(0, media.currentTime + delta));
    };
    if (key === ' ' || key === 'k') { event.preventDefault(); toggle(); }
    else if (key === 'ArrowRight') { event.preventDefault(); nudge(5); }
    else if (key === 'ArrowLeft') { event.preventDefault(); nudge(-5); }
    else if (key === 'ArrowUp') { event.preventDefault(); media.volume = Math.min(1, media.volume + 0.1); }
    else if (key === 'ArrowDown') { event.preventDefault(); media.volume = Math.max(0, media.volume - 0.1); }
    else if (key === 'm') media.muted = !media.muted;
    else if (key === 'f') fsBtn.click();
    else if (key === 'c' && captions.length) toggleCaptions();
    else if (/^[0-9]$/.test(key) && durationOf()) media.currentTime = (Number(key) / 10) * durationOf();
  });

  if (options.start) {
    media.addEventListener('loadedmetadata', () => {
      media.currentTime = Number(options.start) || 0;
    }, { once: true });
  }

  // ---- teaser hover preview ----
  if (teaser) {
    let started = false;
    const stopTeaser = () => {
      root.classList.remove('is-teasing');
      teaser.pause();
      try { teaser.currentTime = 0; } catch { /* not loaded yet */ }
    };
    root.addEventListener('pointerenter', () => {
      if (started || !media.paused || media.currentTime > 0) return;
      root.classList.add('is-teasing');
      teaser.play().catch(() => root.classList.remove('is-teasing'));
    });
    root.addEventListener('pointerleave', stopTeaser);
    media.addEventListener('play', () => {
      started = true;
      stopTeaser();
    });
  }

  // ---- autoplay ----
  if (autoplayMode !== 'off') {
    const wantsSound = autoplayMode === 'sound';
    media.addEventListener('canplay', async () => {
      try {
        await media.play();
        // It played with sound, so no affordance is needed.
      } catch {
        // Every browser blocks unmuted autoplay without a prior user gesture.
        // Rather than silently not playing, fall back to muted and offer one
        // tap to restore sound.
        if (!wantsSound) return;
        media.muted = true;
        try {
          await media.play();
          root.classList.add('is-autoplay-muted');
        } catch {
          /* autoplay refused entirely; the poster and play button remain */
        }
      }
    }, { once: true });
  }

  unmute.addEventListener('click', (event) => {
    event.stopPropagation();
    media.muted = false;
    media.volume = media.volume || 1;
    root.classList.remove('is-autoplay-muted');
    media.play().catch(() => {});
    tracker.track('unmute', media.currentTime, { via: 'autoplay-prompt' });
  });

  setPlayIcon();
  renderProgress();
  syncMenu();

  const instance = {
    root,
    media,
    tracker,
    skin,
    controls: showControls,
    viewId: tracker.viewId,
    play: () => media.play(),
    pause: () => media.pause(),
    seek: (sec) => { media.currentTime = sec; },
    setSkin: (next) => {
      if (SKINS.has(next)) root.dataset.skin = next;
    },
    setAccent: (next) => {
      if (/^#[0-9a-f]{6}$/i.test(next || '')) applyAccent(next);
    },
    setPoster: (url) => {
      if (url) media.poster = url;
    },
    identify: (traits) => tracker.identify(traits),
    destroy() {
      tracker.destroy();
      document.removeEventListener('click', closeMenu);
      root.innerHTML = '';
      root.classList.remove('cine', 'cine--fill');
    },
  };

  root.cineHost = instance;
  return instance;
}

/** Auto-mount every [data-cine] element on the page. Used by the script embed. */
export function mountAll(defaults = {}) {
  return Promise.all(
    Array.from(document.querySelectorAll('[data-cine]:not([data-cine-mounted])')).map((node) => {
      node.setAttribute('data-cine-mounted', '');
      return mount(node, {
        ...defaults,
        slug: node.dataset.video,
        color: node.dataset.color || defaults.color,
        skin: node.dataset.skin || defaults.skin,
        autoplay: node.dataset.autoplay === '1',
        muted: node.dataset.muted === '1',
        start: Number(node.dataset.start || 0) || 0,
        controls: node.dataset.controls !== '0',
      }).catch((err) => console.error('[CineHost]', err));
    }),
  );
}

export default { mount, mountAll };
