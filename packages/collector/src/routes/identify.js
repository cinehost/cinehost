import { Hono } from 'hono';
import { requireServerKey, validSiteKey } from '../auth.js';
import { originAllowed } from '../env.js';
import { query } from '../db.js';
import { emit } from '../webhooks.js';

export const identify = new Hono();

/**
 * Attach a person to a view. Two doors:
 *
 *   /v1/identify         server key. Rails calls this - trusted, source=server.
 *   /v1/identify/client  site key. An in-player email gate - source=client,
 *                        unverified, treat as a lead hint not an assertion.
 *
 * Either door back-fills every earlier view from the same visitor_id, so an
 * anonymous browse history resolves retroactively the moment someone converts.
 */
async function attach(c, { source }) {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'bad payload' }, 400);

  const { view_id: viewId, visitor_id: visitorId, email, lead_id: leadId, external_id: externalId, traits } = body;
  if (!viewId && !visitorId) return c.json({ error: 'view_id or visitor_id required' }, 400);
  if (!email && !leadId && !externalId) return c.json({ error: 'nothing to identify with' }, 400);

  // Resolve the visitor first so we can stitch the whole history, not one row.
  let visitor = visitorId;
  if (!visitor && viewId) {
    const { rows } = await query('select visitor_id from views where id = $1', [viewId]);
    if (!rows[0]) return c.json({ error: 'unknown view' }, 404);
    visitor = rows[0].visitor_id;
  }

  const { rows } = await query(
    `update views
        set email = coalesce($2, email),
            lead_id = coalesce($3, lead_id),
            external_id = coalesce($4, external_id),
            traits = traits || $5::jsonb,
            identified_at = coalesce(identified_at, now()),
            identity_source = coalesce(identity_source, $6)
      where visitor_id = $1
      returning id`,
    [visitor, email || null, leadId || null, externalId || null, JSON.stringify(traits || {}), source],
  );

  await emit('view.identified', {
    visitor_id: visitor,
    view_id: viewId || null,
    email: email || null,
    lead_id: leadId || null,
    source,
    views_updated: rows.length,
  });

  return c.json({ ok: true, views_updated: rows.length, visitor_id: visitor });
}

identify.post('/identify', requireServerKey, (c) => attach(c, { source: 'server' }));

identify.post('/identify/client', async (c) => {
  const origin = c.req.header('origin');
  if (origin && !originAllowed(origin)) return c.json({ error: 'origin not allowed' }, 403);
  const key = c.req.header('x-site-key');
  if (!validSiteKey(key)) return c.json({ error: 'bad site key' }, 401);
  return attach(c, { source: 'client' });
});
