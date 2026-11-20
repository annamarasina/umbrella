import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { MAX_FORECAST_AGE, bookingTerms, eventHours, nwsForecast } from './forecast.mjs';
import { checkArcSetup, createStandby } from './server.mjs';
import { pickleballEvent } from './event.mjs';

const HOUR = 3_600_000;
const point = { properties: { forecastHourly: 'https://api.weather.gov/fixture' } };

function weatherFixture(booking, now, probabilities) {
  return { properties: {
    updateTime: new Date(now).toISOString(),
    periods: eventHours(booking).map(({ start }, i) => ({
      startTime: start,
      endTime: new Date(Date.parse(start) + HOUR).toISOString(),
      probabilityOfPrecipitation: { value: probabilities[i] },
    })),
  } };
}

test('NWS uses the configured hours, handles partial hours and distinguishes unsafe forecasts', async () => {
  const now = Date.parse('2026-11-20T15:00:00Z');
  const booking = bookingTerms({
    startsAt: '2026-11-21T16:30:00-06:00', endsAt: '2026-11-21T18:15:00-06:00',
    cutoff: '2026-11-21T12:00:00-06:00',
  }, now);
  let hourly = weatherFixture(booking, now, [63, 70, 42]);
  hourly.properties.periods.unshift({
    startTime: '2026-11-21T21:00:00Z', endTime: '2026-11-21T22:00:00Z',
    probabilityOfPrecipitation: { value: 100 },
  });
  const get = (url) => String(url).endsWith('/fixture') ? hourly : point;
  const fresh = await nwsForecast(booking, get, () => now);
  assert.equal(fresh.status, 'fresh');
  assert.deepEqual(fresh.hours.map(({ probability }) => probability), [63, 70, 42]);
  assert.equal((await nwsForecast(booking, get, () => now + MAX_FORECAST_AGE + 1)).status, 'stale');
  hourly.properties.periods.pop();
  const incomplete = await nwsForecast(booking, get, () => now);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.hours[2].probability, null);
  const unavailable = await nwsForecast(booking, () => { throw new Error('Fixture: timeout'); }, () => now);
  assert.equal(unavailable.status, 'unavailable');
  assert.ok(unavailable.hours.every(({ probability }) => probability === null));
});

async function withServer(options) {
  const standby = createStandby(options);
  standby.app.listen(0, '127.0.0.1');
  await once(standby.app, 'listening');
  const origin = 'http://127.0.0.1:' + standby.app.address().port;
  return {
    get: async () => (await fetch(origin + '/api/state')).json(),
    event: async () => (await fetch(origin + '/api/event')).json(),
    forecastEvent: async () => (await fetch(origin + '/api/event/forecast', { method: 'POST', headers: { origin } })).json(),
    act: (action) => fetch(origin + '/api/actions/' + action, { method: 'POST', headers: { origin } }),
    deliver: (options) => fetch(origin + '/webhooks/quicknode', { method: 'POST', ...options }),
    close: async () => {
      const closed = once(standby.app, 'close');
      standby.app.close();
      await closed;
      standby.close();
    },
  };
}

test('pickleball example has its own Whitaker forecast and leaves escrow state alone', async (t) => {
  const now = Date.parse('2026-11-20T16:00:00Z');
  const requested = [];
  const server = await withServer({ env: { STANDBY_DB_PATH: ':memory:' }, clock: () => now,
    fetchWeather: (url) => {
      requested.push(String(url));
      return String(url).endsWith('/fixture') ? weatherFixture(pickleballEvent, now, [12, 28, 30, 22]) : point;
    },
  });
  t.after(() => server.close());
  assert.equal((await server.event()).forecast.status, 'unchecked');
  const result = await server.forecastEvent();
  assert.equal(requested[0], 'https://api.weather.gov/points/30.3143,-97.7279');
  assert.equal(result.event.outdoor.name, 'Whitaker Courts');
  assert.equal(result.booking.endsAt, '2026-11-21T03:30:00.000Z');
  assert.deepEqual(result.forecast.hours.map(({ probability }) => probability), [12, 28, 30, 22]);
  assert.equal(result.previewPeak, 78);
  assert.equal(result.integration.payoutUrl, null);
  assert.equal((await server.get()).forecast.status, 'unchecked');
});

test('simulation is shared, survives restart, and one request wins a repeat trigger', async (t) => {
  const { missing } = await checkArcSetup({});
  assert.ok(missing.includes('STANDBY_ESCROW_ABI_PATH'));
  assert.ok(missing.includes('STANDBY_QUICKNODE_SECRET'));
  const dir = await mkdtemp(join(tmpdir(), 'standby-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  let forecastUnavailable = true;
  const forecastBooking = bookingTerms(null, now);
  const options = {
    env: { STANDBY_DB_PATH: join(dir, 'demo.sqlite') },
    clock: () => now,
    fetchWeather: async (url) => {
      if (forecastUnavailable) throw new Error('Fixture: timeout');
      return String(url).endsWith('/fixture') ? weatherFixture(forecastBooking, now, [0, 0, 0]) : point;
    },
  };
  let server = await withServer(options);
  t.after(() => server.close());
  assert.equal((await server.act('arm-replay')).status, 409);
  await server.act('forecast');
  let state = await server.get();
  assert.equal(state.forecast.status, 'unavailable');
  assert.equal(state.phase, 'watching');
  assert.equal(state.automaticPaymentsEnabled, false);
  assert.equal(state.previewPeak, 78);
  forecastUnavailable = false;
  state = await (await server.act('forecast')).json();
  assert.equal(state.forecast.status, 'fresh');
  assert.deepEqual(state.forecast.hours.map(({ probability }) => probability), [0, 0, 0]);
  forecastUnavailable = true;
  state = await (await server.act('forecast')).json();
  assert.equal(state.forecast.status, 'unavailable');
  assert.equal(state.automaticPaymentsEnabled, false);
  assert.deepEqual(state.lastFreshForecast.hours.map(({ probability }) => probability), [0, 0, 0]);
  await Promise.all(Array.from({ length: 6 }, () => server.act('replay')));
  assert.equal((await server.get()).phase, 'pending');
  await server.close();
  server = await withServer(options);
  now += 800;
  state = await server.get();
  assert.equal(state.phase, 'held');
  assert.deepEqual(state.replay.hours.map(({ probability }) => probability), [54, 78, 72]);
  assert.equal(state.activity.filter(({ text }) => text === 'Simulated hold fee submitted.').length, 1);
  assert.equal(state.activity.some(({ txUrl }) => txUrl), false);
  assert.equal((await server.act('confirm')).status, 200);
  assert.equal((await server.get()).phase, 'confirmed');
  await server.act('reset');
  await server.act('replay');
  now += 800;
  assert.equal((await server.act('expire')).status, 200);
  assert.equal((await server.get()).phase, 'expired');
});

const fixtureHash = (name) => '0x' + createHash('sha256').update(name).digest('hex');
const fixtureAddress = (name) => fixtureHash(name).slice(0, 42);
const asHex = (n) => '0x' + n.toString(16);

test('signed fixture Stream only holds the room for the matching finalized payment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'standby-arc-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.now();
  const terms = {
    startsAt: new Date(Math.ceil(now / HOUR) * HOUR + 6 * HOUR).toISOString(),
    endsAt: new Date(Math.ceil(now / HOUR) * HOUR + 8 * HOUR).toISOString(),
    cutoff: new Date(now + HOUR).toISOString(),
    arc: { bookingId: 'fixture-booking', recipient: fixtureAddress('recipient'), asset: 'native', decimals: 6 },
  };
  const booking = bookingTerms(terms, now);
  const escrow = fixtureAddress('escrow');
  const eventAddress = fixtureAddress('emitter');
  const topic0 = fixtureHash('fixture-topic');
  const transactionHash = fixtureHash('fixture-transaction');
  const settlementHash = fixtureHash('fixture-settlement');
  const secret = 'fixture-stream-token';
  const env = {
    STANDBY_DB_PATH: join(dir, 'arc.sqlite'),
    STANDBY_BOOKING_FILE: join(dir, 'booking.json'),
    STANDBY_ESCROW_ABI_PATH: join(dir, 'fixture-artifact.json'),
    STANDBY_ESCROW_ADAPTER: join(dir, 'fixture-adapter.mjs'),
    STANDBY_ARC_RPC_URL: 'https://arc.fixture.invalid',
    STANDBY_ESCROW_ADDRESS: escrow,
    STANDBY_PAYMENT_EVENT_ADDRESS: eventAddress,
    STANDBY_PAYMENT_TOPIC0: topic0,
    STANDBY_SIGNER_PRIVATE_KEY: fixtureHash('fixture-only-never-used-to-sign'),
    STANDBY_QUICKNODE_SECRET: secret,
  };
  await Promise.all([
    writeFile(env.STANDBY_BOOKING_FILE, JSON.stringify(terms)),
    writeFile(env.STANDBY_ESCROW_ABI_PATH, JSON.stringify([{ type: 'constructor', inputs: [] }])),
    writeFile(env.STANDBY_ESCROW_ADAPTER, `
      export const checkHoldAuthorization = () => true;
      export const signHold = () => ({ hash: '${transactionHash}', rawTransaction: '0x01' });
      export const decodeHoldPayment = ({ log }) => JSON.parse(Buffer.from(log.data.slice(2), 'hex'));
      export const signSettlement = () => ({ hash: '${settlementHash}', rawTransaction: '0x02' });
      export const decodeSettlement = () => '750000';
    `),
  ]);

  const encodeFixture = (amount) => '0x' + Buffer.from(JSON.stringify({ ...terms.arc, amount })).toString('hex');
  const log = {
    address: eventAddress, topics: [topic0], data: encodeFixture('150000'),
    transactionHash, blockHash: fixtureHash('fixture-block'), logIndex: '0x0',
  };
  const receipt = { to: escrow, status: '0x1', transactionHash, blockHash: log.blockHash, blockNumber: '0x2', logs: [log] };
  const block = { hash: log.blockHash, number: receipt.blockNumber, timestamp: asHex(Math.floor(now / 1000)) };
  let finalized = false;
  let broadcasts = 0;
  let settlementBroadcasts = 0;
  const fetchHttp = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url !== env.STANDBY_ARC_RPC_URL) return fetchHttp(url, options);
    const { method, params } = JSON.parse(options.body);
    const results = {
      eth_chainId: asHex(5042002),
      eth_getCode: '0x01',
      eth_sendRawTransaction: params[0] === '0x02' ? settlementHash : transactionHash,
      eth_getTransactionReceipt: params[0] === settlementHash ? { ...receipt, transactionHash: settlementHash } : receipt,
      eth_getBlockByNumber: params[0] === 'finalized' && !finalized ? { number: '0x1' } : block,
    };
    assert.ok(Object.hasOwn(results, method));
    if (method === 'eth_sendRawTransaction') {
      if (params[0] === '0x02') settlementBroadcasts++;
      else broadcasts++;
    }
    return Promise.resolve(Response.json({ result: results[method] }));
  });
  assert.deepEqual(await checkArcSetup(env, now), { ready: true, streamReady: true });
  assert.equal(broadcasts, 0);

  const fixture = weatherFixture(booking, now, [70, 20]);
  fixture.properties.periods.pop();
  let weatherUnavailable = true;
  const options = {
    env,
    clock: () => now,
    fetchWeather: (url) => {
      if (weatherUnavailable) throw new Error('Fixture: unavailable');
      return String(url).endsWith('/fixture') ? fixture : point;
    },
  };
  const server = await withServer(options);
  t.after(() => server.close());
  await server.act('arm-live');
  for (const status of ['unavailable', 'incomplete', 'stale']) {
    const state = await (await server.act('forecast')).json();
    assert.equal(state.forecast.status, status);
    assert.equal(state.automaticPaymentsEnabled, false);
    assert.equal(state.phase, 'watching');
    weatherUnavailable = false;
    if (status === 'incomplete') fixture.properties.updateTime = new Date(now - MAX_FORECAST_AGE - 1).toISOString();
  }
  assert.equal(broadcasts, 0);
  await server.act('disarm');
  await server.act('arm-replay');
  await Promise.all([server.act('replay'), server.act('replay'), server.act('replay')]);
  assert.equal(broadcasts, 1);
  assert.equal((await server.get()).phase, 'pending');
  assert.equal((await server.act('reset')).status, 409);

  const filter = (await readFile(new URL('./stream-filter.js', import.meta.url), 'utf8'))
    .replace('REPLACE_WITH_PAYMENT_EVENT_EMITTER', eventAddress)
    .replace('REPLACE_WITH_PAYMENT_EVENT_TOPIC0', topic0);
  const main = runInNewContext(filter + '\nmain');
  assert.equal(main({ data: [[[{ ...log, removed: true }]]] }), null);
  const { logs } = main({ data: [[[log, { ...log, address: escrow }]]] });
  assert.equal(logs.length, 1);

  function send(nonce, logsToSend, { gzip = false, tamper = false, signedAt = now } = {}) {
    const timestamp = String(Math.floor(signedAt / 1000));
    const body = JSON.stringify({ logs: logsToSend });
    const signature = createHmac('sha256', secret).update(nonce + timestamp + (tamper ? '{}' : body)).digest('hex');
    return server.deliver({
      body: gzip ? gzipSync(body) : body,
      headers: {
        'x-qn-nonce': nonce, 'x-qn-timestamp': timestamp, 'x-qn-signature': signature,
        ...(gzip && { 'content-encoding': 'gzip' }),
      },
    });
  }
  assert.equal((await send('tampered', logs, { tamper: true })).status, 401);
  assert.equal((await send('expired', logs, { signedAt: now - 600_000 })).status, 401);
  assert.equal((await send('await-finality', logs)).status, 503);
  assert.equal((await server.get()).phase, 'pending');
  finalized = true;
  const wrong = { ...log, data: encodeFixture('150001') };
  receipt.logs = [wrong];
  assert.equal((await (await send('wrong-amount', [wrong])).json()).result, 'ignored');
  assert.equal((await server.get()).phase, 'pending');
  receipt.logs = [log];
  assert.equal((await (await send('await-finality', logs, { gzip: true })).json()).result, 'room-held');
  assert.equal((await (await send('await-finality', logs)).json()).result, 'duplicate-delivery');
  assert.equal((await (await send('new-nonce', logs)).json()).result, 'duplicate-payment');
  const state = await server.get();
  assert.equal(state.phase, 'held');
  const confirmations = state.activity.filter(({ text }) => text.startsWith('QuickNode Stream delivered'));
  assert.equal(confirmations.length, 1);
  assert.ok(confirmations[0].txUrl.endsWith(transactionHash));
  assert.equal(broadcasts, 1);

  const confirmResponses = await Promise.all([server.act('confirm'), server.act('confirm')]);
  assert.deepEqual(confirmResponses.map(({ status }) => status).sort(), [200, 409]);
  const confirmed = await server.get();
  assert.equal(confirmed.phase, 'confirmed');
  assert.equal(confirmed.settlementAmount, '0.75');
  assert.equal(settlementBroadcasts, 1);

  const liveServer = await withServer({ ...options, env: { ...env, STANDBY_DB_PATH: join(dir, 'arc-live.sqlite') } });
  t.after(() => liveServer.close());
  assert.equal((await liveServer.act('arm-live')).status, 200);
  fixture.properties = weatherFixture(booking, now, [69, 20]).properties;
  assert.equal((await (await liveServer.act('forecast')).json()).phase, 'watching');
  assert.equal(broadcasts, 1);
  fixture.properties.periods[0].probabilityOfPrecipitation.value = 70;
  assert.equal((await (await liveServer.act('forecast')).json()).phase, 'pending');
  assert.equal(broadcasts, 2);
});
