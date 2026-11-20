import { createHmac, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const MAX_BYTES = 256 * 1024;
const MAX_AGE = 5 * 60_000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rawBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > MAX_BYTES) throw new HttpError(413, 'Payload too large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const encoding = request.headers['content-encoding'];
  if (!encoding || encoding === 'identity') return body;
  if (encoding !== 'gzip') throw new HttpError(415, 'Unsupported encoding');
  try {
    return gunzipSync(body, { maxOutputLength: MAX_BYTES });
  } catch {
    throw new HttpError(400, 'Invalid gzip payload');
  }
}

export async function verifiedDelivery(request, secret, now) {
  const { 'x-qn-nonce': nonce, 'x-qn-timestamp': timestamp, 'x-qn-signature': signature } = request.headers;
  if (!secret) throw new HttpError(503, 'QuickNode Stream is not configured');
  if (!/^[\x21-\x7e]{1,128}$/.test(nonce ?? '') || !/^(?:\d{10}|\d{13})$/.test(timestamp ?? '') ||
      !/^[\da-f]{64}$/i.test(signature ?? '')) {
    throw new HttpError(401, 'Invalid Stream signature headers');
  }
  const signedAt = Number(timestamp) * (timestamp.length === 10 ? 1000 : 1);
  if (Math.abs(now - signedAt) > MAX_AGE) throw new HttpError(401, 'Expired Stream signature');
  const payload = await rawBody(request);
  const digest = createHmac('sha256', secret).update(nonce + timestamp).update(payload).digest();
  if (!timingSafeEqual(digest, Buffer.from(signature, 'hex'))) {
    throw new HttpError(401, 'Invalid Stream signature');
  }

  let data;
  try {
    data = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON payload');
  }
  const batches = Array.isArray(data?.data) ? data.data : [data?.data ?? data];
  if (!batches.length || !batches.every((batch) => Array.isArray(batch?.logs))) {
    throw new HttpError(400, 'Expected filtered Stream logs');
  }
  return { nonce, expires: signedAt + MAX_AGE, logs: batches.flatMap(({ logs }) => logs) };
}
