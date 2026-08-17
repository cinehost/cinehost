// Dashboard. Fetches /v1 with the browser's Basic auth credentials already in
// place (the whole /app path is behind requireAdmin), so no key handling here.
//
// Colours are Radix scale variables, never literals, so the light/dark swap
// happens in one place (dashboard.css) and the chart follows the page.

const $ = (id) => document.getElementById(id);
const api = (path) => fetch(path, { credentials: 'same-origin' }).then((r) => {
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
});

const INK = {
  grid: 'var(--gray-6)',
  axis: 'var(--gray-8)',
  muted: 'var(--gray-11)',
  panel: 'var(--panel)',
  s1: 'var(--series-1)',
  s2: 'var(--series-2)',
};

const pct = (n) => `${(n * 100).toFixed(n >= 0.995 ? 0 : 1)}%`;
const clock = (secs) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
// pg returns `date` as a UTC-midnight timestamp; parsing that into a local
// Date shifts it back a day for anyone west of UTC. Format the date part
// directly instead of round-tripping through the local timezone.
const shortDay = (value) => {
  const [y, m, d] = String(value).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
};

const escapeHtml = (val) =>
  String(val ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const empty = (msg) => `<p class="py-6 text-center text-sm text-gray-11">${escapeHtml(msg)}</p>`;

const state = { slug: null, days: 30 };

function rangeParams() {
  const to = new Date();
  const from = new Date(to.getTime() - state.days * 864e5);
  return `from=${from.toISOString()}&to=${to.toISOString()}`;
}

// ---------------------------------------------------------------- chart bits

const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

const svgEl = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

const linePath = (points) =>
  points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');

/** Bar with only the data-end rounded, anchored flat on the baseline. */
const barPath = (x, y, w, h, r) => {
  const radius = Math.min(r, w / 2, h);
  return `M${x} ${y + h} L${x} ${y + radius} Q${x} ${y} ${x + radius} ${y} L${x + w - radius} ${y} Q${x + w} ${y} ${x + w} ${y + radius} L${x + w} ${y + h} Z`;
};

const tickLabel = (x, y, text, anchor = 'middle') => {
  const node = svgEl('text', { x, y, 'text-anchor': anchor, fill: INK.muted, 'font-size': 11 });
  node.textContent = text;
  return node;
};

function drawEngagement(data) {
  const svg = $('engagement');
  const tip = $('engagement-tip');
  svg.innerHTML = '';

  const engagement = data.engagement || [];
  const retention = data.retention || [];
  const duration = data.video.duration || engagement.length;

  if (!duration || !data.totals.plays) {
    $('engagement-table').innerHTML = empty('No plays in this range yet.');
    return;
  }

  const W = 900;
  const H = 300;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  const yMax = Math.max(1, ...engagement) * 1.08;
  const x = (sec) => PAD.left + (sec / Math.max(1, duration - 1)) * innerW;
  const y = (val) => PAD.top + innerH - (val / yMax) * innerH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].filter((t) => t <= yMax);
  if (yMax > 1.2) ticks.push(Math.round(yMax * 100) / 100);
  for (const t of ticks) {
    svg.appendChild(svgEl('line', {
      x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), stroke: INK.grid, 'stroke-width': 1,
    }));
    svg.appendChild(tickLabel(PAD.left - 8, y(t) + 4, `${Math.round(t * 100)}%`, 'end'));
  }

  const step = Math.max(1, Math.round(duration / 6));
  for (let sec = 0; sec < duration; sec += step) {
    svg.appendChild(tickLabel(x(sec), H - 8, clock(sec)));
  }
  svg.appendChild(svgEl('line', {
    x1: PAD.left, x2: W - PAD.right, y1: y(0), y2: y(0), stroke: INK.axis, 'stroke-width': 1,
  }));

  const retPoints = retention.map((v, i) => [x(i), y(v)]);
  const engPoints = engagement.map((v, i) => [x(i), y(v)]);

  // Retention as a filled area (the drop-off funnel), engagement as a line
  // (the rewatch spikes). Engagement is drawn FIRST and retention over it:
  // engagement is never below retention, so where nobody rewatched the two
  // lines coincide exactly - drawing engagement last would hide retention for
  // most of the timeline and the chart would look like it has one series.
  svg.appendChild(svgEl('path', {
    d: `${linePath(retPoints)} L${x(duration - 1)} ${y(0)} L${x(0)} ${y(0)} Z`,
    fill: INK.s1, 'fill-opacity': 0.14,
  }));
  svg.appendChild(svgEl('path', {
    d: linePath(engPoints), fill: 'none', stroke: INK.s2, 'stroke-width': 2, 'stroke-linejoin': 'round',
  }));
  svg.appendChild(svgEl('path', {
    d: linePath(retPoints), fill: 'none', stroke: INK.s1, 'stroke-width': 2, 'stroke-linejoin': 'round',
  }));

  const crosshair = svgEl('line', { y1: PAD.top, y2: PAD.top + innerH, stroke: INK.axis, 'stroke-width': 1, opacity: 0 });
  const dot1 = svgEl('circle', { r: 4, fill: INK.s1, stroke: INK.panel, 'stroke-width': 2, opacity: 0 });
  const dot2 = svgEl('circle', { r: 4, fill: INK.s2, stroke: INK.panel, 'stroke-width': 2, opacity: 0 });
  svg.append(crosshair, dot1, dot2);

  const hit = svgEl('rect', { x: PAD.left, y: PAD.top, width: innerW, height: innerH, fill: 'transparent' });
  svg.appendChild(hit);

  hit.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const sec = Math.min(duration - 1, Math.max(0, Math.round(((ratio * W) - PAD.left) / innerW * (duration - 1))));
    const px = x(sec);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', 1);
    dot1.setAttribute('cx', px); dot1.setAttribute('cy', y(retention[sec] || 0)); dot1.setAttribute('opacity', 1);
    dot2.setAttribute('cx', px); dot2.setAttribute('cy', y(engagement[sec] || 0)); dot2.setAttribute('opacity', 1);

    tip.innerHTML = `<div class="mb-1 font-medium tabular-nums">${clock(sec)}</div>
      <div class="flex items-center gap-1.5 text-gray-11"><i class="inline-block size-2 rounded-[2px] bg-series-1"></i> Retention <b class="ml-auto pl-3 tabular-nums text-gray-12">${pct(retention[sec] || 0)}</b></div>
      <div class="flex items-center gap-1.5 text-gray-11"><i class="inline-block size-2 rounded-[2px] bg-series-2"></i> Engagement <b class="ml-auto pl-3 tabular-nums text-gray-12">${pct(engagement[sec] || 0)}</b></div>`;
    tip.style.opacity = 1;
    const left = (px / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 8, Math.max(8, left + 12))}px`;
    tip.style.top = '12px';
  });
  $('engagement-wrap').addEventListener('pointerleave', () => {
    tip.style.opacity = 0;
    crosshair.setAttribute('opacity', 0);
    dot1.setAttribute('opacity', 0);
    dot2.setAttribute('opacity', 0);
  });

  // table view - sampled, a per-second table would be thousands of rows
  const sample = Math.max(1, Math.round(duration / 20));
  const rows = [];
  for (let sec = 0; sec < duration; sec += sample) {
    rows.push(`<tr><td class="tabular-nums">${clock(sec)}</td><td class="num">${pct(retention[sec] || 0)}</td><td class="num">${pct(engagement[sec] || 0)}</td></tr>`);
  }
  $('engagement-table').innerHTML =
    `<table class="rx-table"><thead><tr><th>Time</th><th class="num">Retention</th><th class="num">Engagement</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function drawDaily(daily) {
  const svg = $('daily');
  const tip = $('daily-tip');
  svg.innerHTML = '';
  if (!daily.length) return;

  const W = 900;
  const H = 190;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const yMax = Math.max(1, ...daily.map((d) => d.impressions));
  const band = innerW / daily.length;
  const barW = Math.max(2, band - 2); // 2px surface gap between bars

  for (const t of [0, 0.5, 1]) {
    const yPos = PAD.top + innerH - t * innerH;
    svg.appendChild(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: yPos, y2: yPos, stroke: INK.grid, 'stroke-width': 1 }));
    svg.appendChild(tickLabel(PAD.left - 8, yPos + 4, String(Math.round(t * yMax)), 'end'));
  }

  daily.forEach((d, i) => {
    const xPos = PAD.left + i * band + (band - barW) / 2;
    const impH = (d.impressions / yMax) * innerH;
    const playH = (d.plays / yMax) * innerH;

    svg.appendChild(svgEl('path', {
      d: barPath(xPos, PAD.top + innerH - impH, barW, impH, 4), fill: INK.s1, 'fill-opacity': 0.25,
    }));
    if (playH > 0) {
      svg.appendChild(svgEl('path', { d: barPath(xPos, PAD.top + innerH - playH, barW, playH, 4), fill: INK.s1 }));
    }

    const hit = svgEl('rect', { x: PAD.left + i * band, y: PAD.top, width: band, height: innerH, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      const rect = svg.getBoundingClientRect();
      tip.innerHTML = `<div class="mb-0.5 font-medium">${shortDay(d.day)}</div>
        <div class="text-gray-11">Plays <b class="tabular-nums text-gray-12">${d.plays}</b> of <b class="tabular-nums text-gray-12">${d.impressions}</b></div>`;
      tip.style.opacity = 1;
      tip.style.left = `${Math.min(rect.width - 150, ((PAD.left + i * band) / W) * rect.width)}px`;
      tip.style.top = '8px';
    });
    svg.appendChild(hit);
  });

  $('daily-wrap').addEventListener('pointerleave', () => { tip.style.opacity = 0; });

  svg.appendChild(tickLabel(PAD.left, H - 8, shortDay(daily[0].day), 'start'));
  svg.appendChild(tickLabel(W - PAD.right, H - 8, shortDay(daily[daily.length - 1].day), 'end'));
}

const dimensionTable = (rows, label) =>
  rows.length
    ? `<table class="rx-table"><thead><tr><th>${label}</th><th class="num">Views</th></tr></thead><tbody>${rows
        .map((r) => `<tr><td class="max-w-[220px] truncate" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</td><td class="num">${r.views}</td></tr>`)
        .join('')}</tbody></table>`
    : empty('No data');

function renderTiles(totals) {
  const tiles = [
    { label: 'Impressions', value: totals.impressions, sub: `${totals.visitors} visitors` },
    { label: 'Plays', value: totals.plays, sub: `${pct(totals.play_rate)} play rate` },
    { label: 'Avg watched', value: clock(totals.avg_watched_sec), sub: `${totals.avg_max_pct.toFixed(0)}% reached` },
    { label: 'Completions', value: totals.completions, sub: `${pct(totals.completion_rate)} of plays` },
    { label: 'Identified', value: totals.identified, sub: 'views with a person' },
  ];
  $('tiles').innerHTML = tiles
    .map((t) => `<div class="rx-card px-4 py-3">
      <div class="text-xs text-gray-11">${t.label}</div>
      <div class="mt-0.5 text-[27px] font-semibold leading-tight tracking-tight">${t.value}</div>
      <div class="text-xs text-gray-11">${t.sub}</div>
    </div>`)
    .join('');
}

function renderViews(views) {
  if (!views.length) {
    $('views').innerHTML = empty('No views yet.');
    return;
  }
  const rows = views
    .map((v) => `<tr>
      <td class="whitespace-nowrap text-gray-11">${new Date(v.started_at).toLocaleString()}</td>
      <td>${v.email
        ? `<span class="rx-badge">${escapeHtml(v.email)}</span>`
        : `<span class="text-gray-11">${escapeHtml(v.lead_id || v.visitor_id.slice(0, 8))}</span>`}</td>
      <td class="text-gray-11">${escapeHtml(v.device || '')}${v.country ? ` · ${escapeHtml(v.country)}` : ''}</td>
      <td class="num">${clock(v.watched_sec)}</td>
      <td class="num">${v.max_pct.toFixed(0)}%</td>
      <td>${v.completed ? '<span class="text-success-11">✓</span>' : v.played ? '' : '<span class="text-gray-11">—</span>'}</td>
    </tr>`)
    .join('');
  $('views').innerHTML = `<table class="rx-table">
    <thead><tr><th>When</th><th>Who</th><th>Where</th><th class="num">Watched</th><th class="num">Reached</th><th>Done</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

async function load() {
  if (!state.slug) return;
  const [stats, views] = await Promise.all([
    api(`/v1/videos/${encodeURIComponent(state.slug)}/stats?${rangeParams()}`),
    api(`/v1/videos/${encodeURIComponent(state.slug)}/views?${rangeParams()}&limit=50`),
  ]);

  renderTiles(stats.totals);
  drawEngagement(stats);
  drawDaily(stats.daily);
  $('referrers').innerHTML = dimensionTable(stats.referrers, 'Referrer');
  $('devices').innerHTML = dimensionTable(stats.devices, 'Device');
  $('countries').innerHTML = dimensionTable(stats.countries, 'Country');
  renderViews(views.views);
}

// ------------------------------------------------------------------ library

let config = { publicBaseUrl: location.origin, r2: true, maxUploadBytes: 5 * 1024 ** 3 };

const embedSnippet = (slug) =>
  `<iframe src="${config.publicBaseUrl}/embed/${slug}"\n        allowfullscreen\n        style="border:0;width:100%;aspect-ratio:16/9"></iframe>`;

const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round((n || 0) / 1e6)} MB`);

const STATUS = {
  ready: 'bg-accent-3 text-accent-11',
  processing: 'bg-accent-3 text-accent-11',
  failed: 'bg-gray-4 text-gray-12',
};

function libraryRow(v) {
  const busy = v.status === 'processing';
  const poster = v.poster_url
    ? `<img src="${escapeHtml(v.poster_url)}" alt="" class="h-9 w-16 shrink-0 rounded object-cover" loading="lazy">`
    : '<div class="h-9 w-16 shrink-0 rounded bg-gray-4"></div>';

  const status = busy
    ? `<div class="min-w-[110px]">
         <div class="mb-1 text-xs text-gray-11" data-role="pct">Encoding ${v.progress || 0}%</div>
         <div class="h-1.5 overflow-hidden rounded-full bg-gray-4">
           <div class="h-full rounded-full bg-accent-9 transition-[width] duration-300" data-role="bar" style="width:${v.progress || 0}%"></div>
         </div>
       </div>`
    : v.status === 'failed'
      ? `<span class="rx-badge ${STATUS.failed}" title="${escapeHtml(v.error || '')}">Failed</span>`
      : `<span class="rx-badge">Ready</span>`;

  const actions = v.status === 'ready'
    ? `<button class="rx-button" data-act="open" data-slug="${escapeHtml(v.slug)}">Open</button>
       <button class="rx-button" data-act="copy" data-slug="${escapeHtml(v.slug)}">Copy embed</button>
       <button class="rx-button" data-act="archive" data-slug="${escapeHtml(v.slug)}">Archive</button>`
    : v.status === 'failed'
      ? `<button class="rx-button" data-act="retry" data-slug="${escapeHtml(v.slug)}">Retry</button>
         <button class="rx-button" data-act="archive" data-slug="${escapeHtml(v.slug)}">Remove</button>`
      : '';

  return `<tr data-slug="${escapeHtml(v.slug)}">
    <td>
      <div class="flex items-center gap-3">
        ${poster}
        <div class="min-w-0">
          <div class="truncate font-medium">${escapeHtml(v.title || v.slug)}</div>
          <div class="truncate font-mono text-xs text-gray-11">${escapeHtml(v.slug)}</div>
        </div>
      </div>
    </td>
    <td data-role="status">${status}</td>
    <td class="num text-gray-11">${v.duration_sec ? clock(v.duration_sec) : v.source_bytes ? bytes(v.source_bytes) : '—'}</td>
    <td class="num">${v.status === 'ready' ? v.plays : '—'}</td>
    <td><div class="flex flex-wrap justify-end gap-1.5">${actions}</div></td>
  </tr>`;
}

async function loadLibrary() {
  const { videos } = await api('/v1/admin/videos');
  library = videos;
  $('library-count').textContent = videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'}` : '';

  if (!videos.length) {
    $('library').innerHTML = empty('No videos yet. Hit “Upload video” to add your first one.');
  } else {
    $('library').innerHTML = `<div class="overflow-x-auto"><table class="rx-table">
      <thead><tr><th>Video</th><th>Status</th><th class="num">Length</th><th class="num">Plays</th><th></th></tr></thead>
      <tbody>${videos.map(libraryRow).join('')}</tbody></table></div>`;
  }

  // Anything mid-encode gets a live progress stream, so the row moves without
  // the page polling for it.
  for (const v of videos) if (v.status === 'processing') watchProgress(v.slug);

  const ready = videos.filter((v) => v.status === 'ready');
  $('video').innerHTML = ready
    .map((v) => `<option value="${escapeHtml(v.slug)}">${escapeHtml(v.title || v.slug)}</option>`)
    .join('');
  return ready;
}

const streams = new Map();

function watchProgress(slug, onUpdate) {
  if (streams.has(slug)) {
    streams.get(slug).extra.push(onUpdate);
    return;
  }
  const source = new EventSource(`/v1/videos/${encodeURIComponent(slug)}/events`);
  const entry = { source, extra: onUpdate ? [onUpdate] : [] };
  streams.set(slug, entry);

  source.addEventListener('status', (event) => {
    const data = JSON.parse(event.data);
    const row = document.querySelector(`tr[data-slug="${CSS.escape(slug)}"]`);
    if (row && data.status === 'processing') {
      const bar = row.querySelector('[data-role="bar"]');
      const pct = row.querySelector('[data-role="pct"]');
      if (bar) bar.style.width = `${data.progress || 0}%`;
      if (pct) pct.textContent = `Encoding ${data.progress || 0}%`;
    }
    for (const fn of entry.extra) fn?.(data);
    if (data.status === 'ready' || data.status === 'failed') {
      source.close();
      streams.delete(slug);
      loadLibrary().catch(() => {});
    }
  });

  source.onerror = () => {
    // EventSource reconnects on its own; only give up if the server closed it.
    if (source.readyState === EventSource.CLOSED) streams.delete(slug);
  };
}

$('library').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const { act, slug } = button.dataset;

  if (act === 'copy') {
    await navigator.clipboard.writeText(embedSnippet(slug));
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1400);
    return;
  }
  if (act === 'open') {
    await selectVideo(slug);
    $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (act === 'retry') {
    button.disabled = true;
    await fetch(`/v1/videos/${encodeURIComponent(slug)}/retry`, { method: 'POST', credentials: 'same-origin' });
    await loadLibrary();
    return;
  }
  if (act === 'archive') {
    if (!confirm(`Archive “${slug}”?\n\nExisting embeds of this video will stop working. The file stays in R2.`)) return;
    button.disabled = true;
    await fetch(`/v1/videos/${encodeURIComponent(slug)}`, { method: 'DELETE', credentials: 'same-origin' });
    await boot();
  }
});

// ------------------------------------------------------- detail / preview

const ACCENT_PRESETS = ['#2563eb', '#0090ff', '#7c3aed', '#e11d48', '#f76b15', '#0ca35b', '#111111'];
const DEFAULT_ACCENT = '#2563eb';

let library = [];
let player = null;          // live CineHost instance for the preview
let current = null;         // the selected video record
let saveTimer = null;

const flashSaved = () => {
  const node = $('detail-saved');
  node.style.opacity = '1';
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => { node.style.opacity = '0'; }, 1400);
};

async function patchVideo(patch) {
  const res = await fetch(`/v1/videos/${encodeURIComponent(current.slug)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return;
  const { video } = await res.json();
  Object.assign(current, video);
  flashSaved();
  loadLibrary().catch(() => {});
}

const savePatchSoon = (patch) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => patchVideo(patch), 400);
};

function renderSkinPicker() {
  for (const button of $('skin-picker').querySelectorAll('button')) {
    const active = (current.skin || 'glass') === button.dataset.skin;
    button.classList.toggle('rx-button--solid', active);
  }
}

function renderAccent() {
  const accent = current.accent || DEFAULT_ACCENT;
  $('accent-color').value = accent;
  $('accent-hex').value = accent;
  $('accent-presets').innerHTML = ACCENT_PRESETS
    .map((hex) => `<button type="button" data-hex="${hex}" title="${hex}"
      class="size-6 rounded-md border ${hex === accent ? 'border-gray-12' : 'border-gray-7'}"
      style="background:${hex}"></button>`)
    .join('');
}

/**
 * Mount the real player in the dashboard. `track: false` keeps this preview out
 * of the video's own analytics - otherwise opening a video to change its
 * thumbnail would count as a view of it.
 */
async function mountPreview(video) {
  player?.destroy();
  player = null;
  $('preview-mount').innerHTML = '';

  player = await window.CineHost.mount($('preview-mount'), {
    endpoint: '',
    slug: video.slug,
    track: false,
    skin: video.skin || 'glass',
    color: video.accent || DEFAULT_ACCENT,
    // Never autoplay in the dashboard: opening a video to edit it shouldn't
    // start blasting audio, and the teaser would fight the preview.
    autoplay: 'off',
    teaser: false,
    loop: false,
    // Mirror the real embed so "no controls" is visible here, but keep the
    // play button so the preview stays usable for picking frames.
    controls: video.controls !== false,
  });

  player.media.addEventListener('timeupdate', () => {
    $('detail-time').textContent = `At ${clock(player.media.currentTime)} — “Use current frame” takes this moment`;
  });
}

async function selectVideo(slug) {
  const video = library.find((v) => v.slug === slug);
  if (!video || video.status !== 'ready') return;

  current = { ...video };
  state.slug = slug;
  $('video').value = slug;
  history.replaceState(null, '', `?video=${encodeURIComponent(slug)}`);

  $('detail').classList.remove('hidden');
  $('detail-title').textContent = video.title || video.slug;
  $('detail-meta').textContent = `${video.slug} · ${clock(video.duration_sec)} · ${video.plays} plays`;
  $('detail-poster').src = video.poster_url || '';
  $('detail-embed').textContent = embedSnippet(slug);
  $('detail-open').href = `${config.publicBaseUrl}/embed/${slug}`;
  $('detail-skins').href = `${config.publicBaseUrl}/skins/${slug}`;
  $('poster-note').textContent = '';
  renderSkinPicker();
  renderAccent();
  renderPlayback();
  renderTeaser();

  await mountPreview(video);
  await load();
}

$('skin-picker').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-skin]');
  if (!button || !current) return;
  current.skin = button.dataset.skin;
  player?.setSkin(current.skin);
  renderSkinPicker();
  patchVideo({ skin: current.skin });
});

$('accent-color').addEventListener('input', (event) => {
  const hex = event.target.value;
  $('accent-hex').value = hex;
  player?.setAccent(hex);
  if (current) { current.accent = hex; savePatchSoon({ accent: hex }); }
});

$('accent-hex').addEventListener('input', (event) => {
  const hex = event.target.value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
  $('accent-color').value = hex;
  player?.setAccent(hex);
  if (current) { current.accent = hex; savePatchSoon({ accent: hex }); }
});

$('accent-presets').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-hex]');
  if (!button || !current) return;
  const hex = button.dataset.hex;
  current.accent = hex;
  player?.setAccent(hex);
  renderAccent();
  patchVideo({ accent: hex });
});

// ---- thumbnail ----
$('poster-frame').addEventListener('click', async () => {
  if (!current || !player) return;
  const at = player.media.currentTime;
  const button = $('poster-frame');
  button.disabled = true;
  $('poster-note').textContent = `Grabbing the frame at ${clock(at)}…`;
  try {
    const res = await fetch(`/v1/videos/${encodeURIComponent(current.slug)}/poster/frame`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ at }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    // The URL changes on every poster write (immutable caching), so no bust needed.
    $('detail-poster').src = data.poster;
    player.setPoster(data.poster);
    current.poster_url = data.poster;
    $('poster-note').textContent = `Thumbnail set from ${clock(at)}.`;
    loadLibrary().catch(() => {});
  } catch (err) {
    $('poster-note').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('poster-upload').addEventListener('click', () => $('poster-file').click());

$('poster-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file || !current) return;
  $('poster-note').textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch(`/v1/videos/${encodeURIComponent(current.slug)}/poster/upload`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type },
      body: file,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    $('detail-poster').src = data.poster;
    player.setPoster(data.poster);
    current.poster_url = data.poster;
    $('poster-note').textContent = 'Custom thumbnail set.';
    loadLibrary().catch(() => {});
  } catch (err) {
    $('poster-note').textContent = err.message;
  } finally {
    event.target.value = '';
  }
});

// ---- playback ----
const AUTOPLAY_NOTES = {
  off: '',
  muted: 'Plays on load without sound. The only autoplay browsers reliably allow.',
  sound: 'Browsers block unmuted autoplay unless the viewer has interacted with your site first. When they do, the player falls back to muted and shows a “Tap for sound” button.',
};

function renderPlayback() {
  $('autoplay-mode').value = current.autoplay || 'off';
  $('loop-toggle').checked = Boolean(current.loop);
  $('controls-toggle').checked = current.controls !== false;
  $('autoplay-note').textContent = AUTOPLAY_NOTES[current.autoplay || 'off'];
  renderControlsWarning();
}

/**
 * Hiding the controls is fine for a muted ambient loop. Hiding them on a video
 * that plays audio is an accessibility failure (WCAG 2.2 SC 1.4.2 - audio that
 * plays automatically must be stoppable), so say so rather than shipping it
 * quietly.
 */
function renderControlsWarning() {
  const node = $('controls-warning');
  const bare = current.controls === false;
  const hasSound = (current.autoplay || 'off') === 'sound';

  let message = '';
  if (bare && hasSound) {
    message = 'Autoplaying sound with no controls leaves viewers no way to stop the audio — an accessibility failure (WCAG 1.4.2). Use “Autoplay muted”, or keep the controls.';
  } else if (bare && (current.autoplay || 'off') === 'off') {
    message = 'With no controls and no autoplay, the play button is kept — otherwise nothing could start the video.';
  } else if (bare) {
    message = 'Bare embed: no chrome. Clicking the video still pauses it.';
  }

  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

$('autoplay-mode').addEventListener('change', async (event) => {
  if (!current) return;
  current.autoplay = event.target.value;
  $('autoplay-note').textContent = AUTOPLAY_NOTES[current.autoplay];
  renderControlsWarning();
  await patchVideo({ autoplay: current.autoplay });
  await mountPreview(current); // autoplay only applies at mount
});

$('loop-toggle').addEventListener('change', async (event) => {
  if (!current) return;
  current.loop = event.target.checked;
  await patchVideo({ loop: current.loop });
  if (player) player.media.loop = current.loop;
});

$('controls-toggle').addEventListener('change', async (event) => {
  if (!current) return;
  current.controls = event.target.checked;
  renderControlsWarning();
  await patchVideo({ controls: current.controls });
  await mountPreview(current); // chrome is decided at mount
});

// ---- teaser ----
function renderTeaser() {
  const teaser = current.teaser || {};
  const video = $('teaser-preview');
  if (teaser.mp4) {
    video.src = teaser.mp4;
    video.load();
    video.play().catch(() => {});
    $('teaser-note').textContent = `${teaser.duration}s loop from ${clock(teaser.start)}`
      + (teaser.gif_bytes ? ` · GIF ${Math.round(teaser.gif_bytes / 1e5) / 10} MB` : '');
    $('teaser-gif').disabled = !teaser.gif;
  } else {
    video.removeAttribute('src');
    video.load();
    $('teaser-note').textContent = 'No teaser yet — scrub the preview to a moment and generate one.';
    $('teaser-gif').disabled = true;
  }
}

$('teaser-regen').addEventListener('click', async () => {
  if (!current || !player) return;
  const at = player.media.currentTime;
  const button = $('teaser-regen');
  button.disabled = true;
  $('teaser-note').textContent = `Building a 6s teaser from ${clock(at)}…`;
  try {
    const res = await fetch(`/v1/videos/${encodeURIComponent(current.slug)}/teaser`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: at }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    current.teaser = data.teaser;
    renderTeaser();
    loadLibrary().catch(() => {});
  } catch (err) {
    $('teaser-note').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('teaser-gif').addEventListener('click', async () => {
  if (!current?.teaser?.gif) return;
  await navigator.clipboard.writeText(current.teaser.gif);
  $('teaser-gif').textContent = 'Copied';
  setTimeout(() => { $('teaser-gif').textContent = 'Copy GIF URL'; }, 1400);
});

$('detail-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('detail-embed').textContent);
  $('detail-copy').textContent = 'Copied';
  setTimeout(() => { $('detail-copy').textContent = 'Copy embed code'; }, 1400);
});

// ------------------------------------------------------------------- upload

const dialog = $('upload-dialog');
let pendingFile = null;
let slugTouched = false;

const setStep = (step) => {
  for (const name of ['pick', 'working', 'done']) {
    $(`upload-step-${name}`).classList.toggle('hidden', name !== step);
  }
};

const showUploadError = (msg) => {
  const node = $('upload-error');
  node.textContent = msg;
  node.classList.toggle('hidden', !msg);
};

function resetUpload() {
  pendingFile = null;
  slugTouched = false;
  $('file').value = '';
  $('upload-title').value = '';
  $('upload-slug').value = '';
  $('upload-start').disabled = true;
  $('upload-hint').textContent = 'MP4, MOV, WebM, MKV and friends';
  $('progress-bar').style.width = '0%';
  showUploadError('');
  setStep('pick');
}

const slugify = (value) =>
  String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

const syncSlugPreview = () => {
  const slug = $('upload-slug').value || 'your-video';
  $('slug-preview').textContent = `${config.publicBaseUrl.replace(/^https?:\/\//, '')}/embed/${slug}`;
};

function pickFile(file) {
  if (!file) return;
  if (file.size > config.maxUploadBytes) {
    showUploadError(`That file is ${bytes(file.size)}; the limit is ${bytes(config.maxUploadBytes)}.`);
    return;
  }
  showUploadError('');
  pendingFile = file;
  $('upload-hint').textContent = `${file.name} · ${bytes(file.size)}`;
  if (!$('upload-title').value) $('upload-title').value = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  if (!slugTouched) $('upload-slug').value = slugify($('upload-title').value);
  syncSlugPreview();
  $('upload-start').disabled = false;
}

$('upload-open').addEventListener('click', () => {
  resetUpload();
  if (!config.r2) showUploadError('R2 is not configured on the server, so uploads will fail.');
  dialog.showModal();
});
for (const id of ['upload-close', 'upload-cancel', 'done-close', 'upload-background']) {
  $(id).addEventListener('click', () => dialog.close());
}
$('file').addEventListener('change', (e) => pickFile(e.target.files[0]));
$('upload-title').addEventListener('input', () => {
  if (!slugTouched) $('upload-slug').value = slugify($('upload-title').value);
  syncSlugPreview();
});
$('upload-slug').addEventListener('input', () => {
  slugTouched = true;
  $('upload-slug').value = slugify($('upload-slug').value);
  syncSlugPreview();
});

const dropzone = $('dropzone');
for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('border-accent-9', 'bg-accent-3/40');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, () => dropzone.classList.remove('border-accent-9', 'bg-accent-3/40'));
}
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  pickFile(e.dataTransfer.files[0]);
});

$('upload-start').addEventListener('click', () => {
  if (!pendingFile) return;
  const title = $('upload-title').value.trim() || pendingFile.name;
  const slug = $('upload-slug').value || slugify(title);

  setStep('working');
  showUploadError('');
  $('progress-label').textContent = 'Uploading…';

  const params = new URLSearchParams({ filename: pendingFile.name, title, slug });
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/v1/uploads?${params}`);
  xhr.withCredentials = true;
  xhr.setRequestHeader('content-type', 'application/octet-stream');

  // XHR, not fetch: fetch still cannot report request upload progress.
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('progress-bar').style.width = `${pct}%`;
    $('progress-pct').textContent = `${pct}%`;
  };

  xhr.onload = () => {
    if (xhr.status !== 201) {
      let message = `Upload failed (${xhr.status})`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch { /* keep default */ }
      setStep('pick');
      showUploadError(message);
      return;
    }
    const created = JSON.parse(xhr.responseText).video;
    $('progress-label').textContent = 'Encoding…';
    $('progress-note').textContent = 'Safe to close this window. Progress keeps showing in the library.';
    $('progress-bar').style.width = '0%';
    $('progress-pct').textContent = '0%';
    loadLibrary().catch(() => {});

    watchProgress(created.slug, (data) => {
      if (data.status === 'processing') {
        $('progress-bar').style.width = `${data.progress || 0}%`;
        $('progress-pct').textContent = `${data.progress || 0}%`;
      }
      if (data.status === 'ready') {
        $('done-title').textContent = `“${created.title}” is live`;
        $('done-embed').textContent = embedSnippet(created.slug);
        $('done-preview').dataset.slug = created.slug;
        setStep('done');
      }
      if (data.status === 'failed') {
        setStep('pick');
        showUploadError(data.error || 'Encoding failed. Check the file and try again.');
      }
    });
  };

  xhr.onerror = () => {
    setStep('pick');
    showUploadError('Upload failed — the connection dropped.');
  };

  xhr.send(pendingFile);
});

$('done-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('done-embed').textContent);
  $('done-copy').textContent = 'Copied';
  setTimeout(() => { $('done-copy').textContent = 'Copy embed code'; }, 1400);
});
$('done-preview').addEventListener('click', () => {
  window.open(`${config.publicBaseUrl}/embed/${$('done-preview').dataset.slug}`, '_blank', 'noopener');
});

// --------------------------------------------------------------------- boot

async function boot() {
  config = await api('/v1/config').catch(() => config);
  const ready = await loadLibrary();

  if (!ready.length) {
    renderTiles({ impressions: 0, plays: 0, visitors: 0, completions: 0, identified: 0, avg_watched_sec: 0, avg_max_pct: 0, play_rate: 0, completion_rate: 0 });
    $('views').innerHTML = empty('No published videos yet.');
    return;
  }

  const requested = new URLSearchParams(location.search).get('video');
  await selectVideo(ready.some((v) => v.slug === requested) ? requested : ready[0].slug);
}

$('video').addEventListener('change', (e) => selectVideo(e.target.value));
$('range').addEventListener('change', (e) => {
  state.days = Number(e.target.value);
  load();
});
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('cine-theme', dark ? 'dark' : 'light');
});

boot().catch((err) => {
  $('library').innerHTML = empty(err.message);
});
