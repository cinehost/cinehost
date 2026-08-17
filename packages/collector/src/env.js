const req = (name, fallback) => {
  const val = process.env[name] ?? fallback;
  if (val === undefined) throw new Error(`Missing required env var ${name}`);
  return val;
};

const list = (name, fallback = '') =>
  (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const env = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: req('DATABASE_URL'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, ''),
  siteKey: req('INGEST_SITE_KEY'),
  serverKey: req('SERVER_API_KEY'),
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  allowedOrigins: list('ALLOWED_ORIGINS'),
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  // Overridable because bot-mitigation in front of the receiver usually needs a
  // concrete string to write a bypass rule against.
  webhookUserAgent: process.env.WEBHOOK_USER_AGENT || 'CineHost/1 (+https://github.com/cinehost/cinehost)',
  webhookThresholds: list('WEBHOOK_THRESHOLDS', '25,50,75,90')
    .map(Number)
    .filter((n) => n > 0 && n <= 100)
    .sort((a, b) => a - b),
  // Hard ceiling on a video's second-array so a bad duration can't allocate
  // gigabytes. 6 hours.
  maxDurationSec: Number(process.env.MAX_DURATION_SEC || 21600),

  // ---- upload + transcode ----
  uploadDir: process.env.UPLOAD_DIR || '/data/uploads',
  workDir: process.env.WORK_DIR || '/data/work',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 ** 3),
  // The box is shared with another service; don't let x264 take every core.
  ffmpegThreads: Number(process.env.FFMPEG_THREADS || 3),
  crf: Number(process.env.FFMPEG_CRF || 21),
  preset: process.env.FFMPEG_PRESET || 'medium',

  mediaBaseUrl: (process.env.MEDIA_BASE_URL || '').replace(/\/$/, ''),
  // Optional: lets a purge actually retract media from Cloudflare's edge.
  cloudflare: {
    zoneId: process.env.CF_ZONE_ID || '',
    purgeToken: process.env.CF_PURGE_TOKEN || '',
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
  },
};

// The service's own origin is always allowed: the iframe embed page is served
// from here, so its beacons are same-origin and must never need configuring.
let selfOrigin = '';
try {
  selfOrigin = new URL(env.publicBaseUrl).origin;
} catch {
  /* leave blank */
}

// Origin allowlist supporting one leading wildcard label: https://*.example.com
export function originAllowed(origin) {
  if (!origin) return false;
  if (selfOrigin && origin === selfOrigin) return true;
  return env.allowedOrigins.some((rule) => {
    if (rule === '*') return true;
    if (rule === origin) return true;
    if (!rule.includes('*')) return false;
    const [scheme, rest] = rule.split('://');
    if (!rest?.startsWith('*.')) return false;
    const suffix = rest.slice(1); // ".example.com"
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return `${parsed.protocol}//`.startsWith(`${scheme}:`) && parsed.host.endsWith(suffix);
  });
}
