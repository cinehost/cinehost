import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
};

/**
 * Minimal static file handler with Range support.
 *
 * Range matters: without 206 responses the browser cannot seek an mp4, so the
 * scrub bar silently does nothing. In production R2 + Cloudflare handle this;
 * this exists so a local dev/test run behaves the same.
 */
export function staticHandler(rootDir, { cacheControl = 'public, max-age=300', index = null, prefix = '' } = {}) {
  const root = resolve(rootDir);

  return async (c) => {
    let requested = decodeURIComponent(c.req.path);
    if (prefix && requested.startsWith(prefix)) requested = requested.slice(prefix.length);
    const relative = normalize(requested).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    let filePath = resolve(join(root, relative || '.'));

    if (filePath !== root && !filePath.startsWith(root + sep)) return c.notFound();

    let info;
    try {
      info = await stat(filePath);
      if (info.isDirectory() && index) {
        filePath = join(filePath, index);
        info = await stat(filePath);
      }
    } catch {
      return c.notFound();
    }
    if (!info.isFile()) return c.notFound();

    const type = TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'content-type': type,
      'cache-control': cacheControl,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
    };

    const rangeHeader = c.req.header('range');
    const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const size = info.size;
      let start = match[1] === '' ? size - Number(match[2]) : Number(match[1]);
      let end = match[2] === '' || match[1] === '' ? size - 1 : Number(match[2]);
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end) {
        return c.body(null, 416, { ...headers, 'content-range': `bytes */${size}` });
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
      return c.body(stream, 206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': String(end - start + 1),
      });
    }

    const stream = Readable.toWeb(createReadStream(filePath));
    return c.body(stream, 200, { ...headers, 'content-length': String(info.size) });
  };
}
