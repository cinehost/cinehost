import { createHmac } from 'node:crypto';
import { env } from './env.js';
import { query } from './db.js';

/**
 * Fire-and-log outbound webhooks. Signed so any language can verify with a
 * stdlib HMAC and no SDK: HMAC-SHA256 over "<timestamp>.<raw body>".
 *
 *   X-CineHost-Timestamp: 1770000000
 *   X-CineHost-Signature: sha256=<hex>
 *
 * Verify against the RAW request body, before JSON parsing - a re-serialised
 * body will not match. Reject timestamps older than a few minutes, or a
 * captured delivery stays replayable forever.
 *
 * Deployment note: this is a server-to-server POST with a non-browser user
 * agent. Bot-mitigation in front of the receiving app (Cloudflare Bot Fight
 * Mode being the common one) silently challenges exactly this shape of request,
 * with nothing reaching the origin's logs. If deliveries stall and the receiver
 * shows no sign of them, check the WAF/bot events before debugging here.
 * WEBHOOK_USER_AGENT overrides the UA when a bypass rule needs something to
 * match on.
 */
export async function emit(eventName, payload) {
  if (!env.webhookUrl) return;

  const body = JSON.stringify({ event: eventName, data: payload, sent_at: new Date().toISOString() });

  const { rows } = await query(
    'insert into webhook_deliveries (event, payload) values ($1, $2) returning id',
    [eventName, JSON.stringify(payload)],
  );
  const id = rows[0].id;

  deliver(id, body).catch((err) => console.error('[webhook] delivery crashed', err));
}

async function deliver(id, body, attempt = 1) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = env.webhookSecret
    ? createHmac('sha256', env.webhookSecret).update(`${timestamp}.${body}`).digest('hex')
    : '';

  try {
    const res = await fetch(env.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': env.webhookUserAgent,
        'x-cinehost-timestamp': String(timestamp),
        ...(signature ? { 'x-cinehost-signature': `sha256=${signature}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      await query(
        'update webhook_deliveries set status_code = $2, attempts = $3, delivered_at = now() where id = $1',
        [id, res.status, attempt],
      );
      return;
    }
    await retry(id, body, attempt, `HTTP ${res.status}`, res.status);
  } catch (err) {
    await retry(id, body, attempt, err.message, null);
  }
}

const MAX_ATTEMPTS = 4;

async function retry(id, body, attempt, error, statusCode) {
  await query('update webhook_deliveries set attempts = $2, status_code = $3, error = $4 where id = $1', [
    id,
    attempt,
    statusCode,
    error,
  ]);
  if (attempt >= MAX_ATTEMPTS) return;
  const backoffMs = 2 ** attempt * 1000;
  setTimeout(() => {
    deliver(id, body, attempt + 1).catch(() => {});
  }, backoffMs).unref?.();
}
