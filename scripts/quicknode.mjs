import { randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile } from 'node:fs/promises';

const base = 'https://api.quicknode.com/streams/rest/v1/streams';
const apiKey = process.env.QUICKNODE_API_KEY;
const streamFile = '.standby/quicknode-stream.json';

async function call(path, method = 'GET', body) {
  const response = await fetch(base + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = String(result?.error?.message ?? result?.message ?? response.statusText)
      .replaceAll(apiKey, '[redacted]');
    throw new Error(`QuickNode returned ${response.status}. ${detail}`);
  }
  return result;
}

async function prepare(destination) {
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.pathname !== '/webhooks/quicknode' ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Provide the HTTPS tunnel URL ending in /webhooks/quicknode.');
  }
  const [hold, filter] = await Promise.all([
    readFile('.standby/hold.json', 'utf8').then(JSON.parse),
    readFile('.standby/quicknode-filter.js'),
  ]);
  const filterFunction = filter.toString('base64');
  const test = await call('/test_filter', 'POST', {
    network: 'arc-testnet', dataset: 'logs', block: String(hold.block), filter_function: filterFunction,
  });
  const output = typeof test.result === 'string' ? JSON.parse(test.result) : test.result;
  if (!output?.logs?.some((log) => log.transactionHash?.toLowerCase() === hold.hash)) {
    throw new Error('QuickNode filter did not select the saved hold-payment transaction.');
  }
  console.log('QuickNode filter matched the Arc hold transaction in block', hold.block);

  let secret = process.env.STANDBY_QUICKNODE_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    await appendFile('.env.local', '\nSTANDBY_QUICKNODE_SECRET=' + secret + '\n', { mode: 0o600 });
  }
  const stream = await call('', 'POST', {
    name: 'Standby demo hold backfill',
    external_id: 'standby-hold-' + hold.hash.slice(2),
    network: 'arc-testnet',
    dataset: 'logs',
    region: 'usa_east',
    start_range: hold.block,
    end_range: hold.block + 4,
    dataset_batch_size: 1,
    elastic_batch_enabled: true,
    filter_function: filterFunction,
    status: 'paused',
    destination: 'webhook',
    destination_attributes: {
      url: url.href, compression: 'none', max_retry: 12, retry_interval_sec: 5, post_timeout_sec: 25,
      security_token: secret,
    },
  });
  if (!stream?.id || stream.destination_attributes?.url !== url.href) {
    throw new Error('The existing QuickNode Stream points to another destination.');
  }
  if (stream.destination_attributes?.security_token && stream.destination_attributes.security_token !== secret) {
    throw new Error('The existing QuickNode Stream uses another security token.');
  }
  await writeFile(streamFile, JSON.stringify({ id: stream.id, status: stream.status, destination: url.href }) + '\n');
  console.log('QuickNode Stream:', stream.id, stream.status);
  console.log('Restart the local app to load the Stream token before activating.');
}

async function main() {
  if (!apiKey) throw new Error('Set QUICKNODE_API_KEY in the local environment.');
  const [action, destination] = process.argv.slice(2);
  if (action === 'prepare') return prepare(destination);
  if (!['activate', 'status'].includes(action)) throw new Error('Use prepare <webhook URL>, activate, or status.');
  const { id } = JSON.parse(await readFile(streamFile, 'utf8'));
  if (action === 'activate') await call('/' + id + '/activate', 'POST');
  const stream = await call('/' + id);
  console.log('QuickNode Stream:', stream.id, stream.status);
}

main().catch((error) => {
  let message = error.message;
  for (const secret of [apiKey, process.env.STANDBY_QUICKNODE_SECRET].filter(Boolean)) {
    message = message.replaceAll(secret, '[redacted]');
  }
  console.error(message);
  process.exitCode = 1;
});
