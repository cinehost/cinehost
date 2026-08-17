import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';

/**
 * R2 writes. Only the transcode job uses this - playback reads never come
 * through the service, they go straight from Cloudflare's edge to the viewer.
 */
let client = null;

function s3() {
  if (client) return client;
  if (!env.r2.accountId || !env.r2.accessKeyId || !env.r2.secretAccessKey || !env.r2.bucket) {
    throw new Error('R2 is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET)');
  }
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.r2.accessKeyId,
      secretAccessKey: env.r2.secretAccessKey,
    },
  });
  return client;
}

export const r2Configured = () =>
  Boolean(env.r2.accountId && env.r2.accessKeyId && env.r2.secretAccessKey && env.r2.bucket);

export async function putObject(key, body, contentType, contentLength) {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: contentLength,
      // Keys are per-slug and a republish replaces them in place, so the long
      // TTL is safe only because the dashboard purges nothing - if you ever add
      // in-place re-encoding under the same slug, add a cache-busting suffix.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

export async function deleteObjects(keys) {
  if (!keys.length) return;
  await s3().send(
    new DeleteObjectsCommand({
      Bucket: env.r2.bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
}
