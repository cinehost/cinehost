import { timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

const safeEqual = (a, b) => {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

const bearer = (c) => {
  const header = c.req.header('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

const basic = (c) => {
  const header = c.req.header('authorization') || '';
  if (!header.startsWith('Basic ')) return null;
  const [user, ...rest] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return { user, password: rest.join(':') };
};

/** Server-to-server only. Rails calls these. */
export const requireServerKey = async (c, next) => {
  const token = bearer(c) || c.req.header('x-api-key');
  if (!token || !safeEqual(token, env.serverKey)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
};

/**
 * Dashboard + stats. Accepts the server key (so Rails can read aggregates)
 * OR HTTP Basic (so a human can open /app in a browser).
 */
export const requireAdmin = async (c, next) => {
  const token = bearer(c) || c.req.header('x-api-key');
  if (token && safeEqual(token, env.serverKey)) return next();

  const creds = basic(c);
  if (
    env.dashboardPassword &&
    creds &&
    safeEqual(creds.user, env.dashboardUser) &&
    safeEqual(creds.password, env.dashboardPassword)
  ) {
    return next();
  }

  return c.body('Authentication required', 401, {
    'WWW-Authenticate': 'Basic realm="video-hosting"',
  });
};

export const validSiteKey = (key) => Boolean(key) && safeEqual(key, env.siteKey);
