import { env } from './env.js';

/**
 * Deleting an object from R2 does NOT stop Cloudflare serving it: media is
 * published with `max-age=31536000, immutable`, so an edge copy can outlive the
 * bucket object by a year. A purge is the only thing that actually retracts it.
 *
 * Needs a token with Zone > Cache Purge on the zone that owns MEDIA_BASE_URL.
 * Without it, callers are told the cache was NOT purged rather than being left
 * to assume it was.
 */
export const purgeConfigured = () => Boolean(env.cloudflare.zoneId && env.cloudflare.purgeToken);

export async function purgeUrls(urls) {
  if (!urls.length) return { purged: false, reason: 'nothing to purge' };
  if (!purgeConfigured()) {
    return { purged: false, reason: 'CF_ZONE_ID / CF_PURGE_TOKEN not configured' };
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.cloudflare.zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.cloudflare.purgeToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ files: urls }),
    signal: AbortSignal.timeout(10000),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const reason = body.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    return { purged: false, reason };
  }
  return { purged: true };
}
