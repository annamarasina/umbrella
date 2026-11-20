import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadArc, missingArcSettings, transactionLink } from './arc.mjs';
import { bookingTerms, eventHours, isFresh, MAX_FORECAST_AGE, nwsForecast, replayForecast, weatherJson } from './forecast.mjs';
import { openStore } from './store.mjs';
import { HttpError, verifiedDelivery } from './webhook.mjs';
import { pickleballEvent } from './event.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/assets/pickleball-courts.jpg', ['assets/pickleball-courts.jpg', 'image/jpeg']],
  ['/assets/fonts/cormorant-garamond.woff2', ['assets/fonts/cormorant-garamond.woff2', 'font/woff2']],
  ['/assets/fonts/lora.woff2', ['assets/fonts/lora.woff2', 'font/woff2']],
]);
const WEBHOOK = '/webhooks/quicknode';
const POLL_INTERVAL = 5 * 60_000;

function json(response, status, result) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }).end(JSON.stringify(result));
}

function append(state, text, txUrl) {
  state.activity.push({ text, ...(txUrl && { txUrl }) });
}

function initial(booking, run = 0) {
  return {
    booking, run, mode: 'simulation', phase: 'watching',
    live: { status: 'unchecked', hours: eventHours(booking) },
    replay: null, payment: null,
    activity: [{ text: `Organizer sets the rain trigger to ${booking.threshold}%.` }],
  };
}

function readBookingConfig(env) {
  return env.STANDBY_BOOKING_FILE ? JSON.parse(readFileSync(env.STANDBY_BOOKING_FILE, 'utf8')) : null;
}

export async function checkArcSetup(env, now = Date.now()) {
  const booking = bookingTerms(readBookingConfig(env), now);
  const missing = missingArcSettings(env, booking);
  if (missing.length) return { missing: env.STANDBY_QUICKNODE_SECRET ? missing : [...missing, 'STANDBY_QUICKNODE_SECRET'] };
  if (Date.parse(booking.cutoff) <= now) return { error: 'The booking cutoff has already passed.' };
  try {
    const arc = await loadArc(env, booking);
    await arc.check();
  } catch {
    return { error: 'Arc preflight failed. Check the RPC, deployment and ABI, funded booking, and signer permissions.' };
  }
  return { ready: true, streamReady: Boolean(env.STANDBY_QUICKNODE_SECRET) };
}

export function createStandby({ env = process.env, clock = Date.now, fetchWeather = weatherJson } = {}) {
  const config = readBookingConfig(env);
  const booking = bookingTerms(config, clock());
  const store = openStore(env.STANDBY_DB_PATH || 'standby.sqlite', initial(booking));
  if (config && JSON.stringify(store.read().booking) !== JSON.stringify(booking)) {
    store.close();
    throw new Error('The configured booking differs from the saved booking. Use its original config or a new database.');
  }

  let arc;
  let weatherRequest;
  let holdReceiptCheck;
  let settlementCheck;
  let eventWeatherRequest;
  let eventVersion = 0;
  let eventForecast = { status: 'unchecked', hours: eventHours(pickleballEvent) };
  let lastEventForecast;
  const streamReady = Boolean(env.STANDBY_QUICKNODE_SECRET);
  const replayBackfill = env.STANDBY_ALLOW_ARC_BACKFILL === '1';
  const ready = loadArc(env, store.read().booking).then((connection) => {
    arc = connection;
  }).catch(() => {
    console.error('Arc configuration could not be loaded. Check the booking, deployment, ABI, and adapter settings.');
  });

  // The version check makes each state change conditional on the snapshot it used.
  function change(update) {
    for (;;) {
      const state = store.read();
      const next = update(state);
      if (!next) return null;
      if (store.save(next)) return next;
    }
  }

  function advanceSimulation() {
    change((state) => {
      if (state.mode !== 'simulation') return;
      const now = clock();
      if (state.phase === 'pending' && state.payment.readyAt <= now) {
        if (now >= Date.parse(state.booking.cutoff)) {
          state.phase = 'closed';
          append(state, 'Booking cutoff passed before the simulated hold completed.');
        } else {
          state.phase = 'held';
          append(state, 'Simulated hold fee confirmed. Venue room is held.');
        }
        return state;
      }
      if (state.phase === 'held' && now >= Date.parse(state.booking.cutoff)) {
        return settleSimulation(state, 'expired');
      }
    });
  }

  function publicState() {
    advanceSimulation();
    const { version, booking: { arc: privateTerms, ...terms }, live, lastFreshForecast, replay, phase, mode,
      activity, payment, settlement, settlementAmount } = store.read();
    const forecast = live.status === 'fresh' && !isFresh(live, clock()) ? { ...live, status: 'stale' } : live;
    const cutoffPassed = clock() >= Date.parse(terms.cutoff);
    return {
      version, booking: terms, forecast, lastFreshForecast, replay, phase, mode, activity, cutoffPassed,
      previewPeak: peak(replayForecast(terms, clock())),
      arcReady: Boolean(arc && (streamReady || replayBackfill)),
      streamReady,
      settlementEnabled: Boolean(arc?.supportsSettlement && mode !== 'simulation'),
      settling: settlement?.action ?? null,
      settlementAmount,
      automaticPaymentsEnabled: Boolean(arc && streamReady && mode === 'arc-live' && phase === 'watching' &&
        !cutoffPassed && forecast.status === 'fresh'),
      paymentUncertain: Boolean(payment?.uncertain),
      paymentReceiptSeen: Boolean(payment?.receiptSeen),
    };
  }

  function publicEvent() {
    const { booking: terms, payment, phase } = store.read();
    const receipt = phase !== 'failed' && (payment?.receiptSeen || payment?.streamConfirmed);
    const forecast = eventForecast.status === 'fresh' && !isFresh(eventForecast, clock())
      ? { ...eventForecast, status: 'stale' } : eventForecast;
    return {
      version: eventVersion,
      event: pickleballEvent,
      booking: { startsAt: pickleballEvent.startsAt, endsAt: pickleballEvent.endsAt, threshold: terms.threshold },
      forecast, lastFreshForecast: lastEventForecast,
      previewPeak: peak(replayForecast(pickleballEvent, clock())),
      integration: {
        holdFee: terms.holdFee,
        payoutUrl: receipt ? transactionLink(payment.hash) : null,
        stream: payment?.streamConfirmed ? 'delivered' : streamReady ? 'awaiting' : 'disconnected',
      },
    };
  }

  async function refreshEventForecast() {
    if (!eventWeatherRequest) {
      eventWeatherRequest = nwsForecast(pickleballEvent, fetchWeather, clock, pickleballEvent.coordinates)
        .then((forecast) => {
          if (forecast.status === 'fresh') lastEventForecast = null;
          else if (eventForecast.status === 'fresh') lastEventForecast = eventForecast;
          eventForecast = forecast;
          eventVersion++;
        }).finally(() => { eventWeatherRequest = null; });
    }
    await eventWeatherRequest;
  }

  function peak(forecast) {
    return Math.max(...forecast.hours.map(({ probability }) => probability ?? -1));
  }

  async function releaseArc(run, mode, forecast) {
    const claimed = change((state) => {
      if (!arc || !(streamReady || (mode === 'arc-replay' && replayBackfill)) ||
          state.run !== run || state.phase !== 'watching' || state.mode !== mode ||
          clock() >= Date.parse(state.booking.cutoff) || peak(forecast) < state.booking.threshold) return;
      if (mode === 'arc-live' && (state.live.checkedAt !== forecast.checkedAt ||
          forecast.status !== 'fresh' || !isFresh(forecast, clock()))) return;
      state.payment = { binding: arc.binding };
      state.phase = 'pending';
      if (mode === 'arc-replay') state.replay = forecast;
      const source = mode === 'arc-live' ? 'NWS forecast' : 'Forecast replay';
      append(state, `${source} reaches ${peak(forecast)}% during the event. Preparing Arc testnet hold payment.`);
      return state;
    });
    if (!claimed) return;

    let signed;
    try {
      signed = await arc.prepareHold();
      const deadline = Math.min(Date.parse(claimed.booking.cutoff),
        mode === 'arc-live' ? Date.parse(forecast.updatedAt) + MAX_FORECAST_AGE : Infinity);
      if (clock() >= deadline) throw new Error('Payment authorization window ended');
      // Commit the expected hash before broadcast so an immediate delivery can be matched.
      const recorded = change((state) => {
        if (state.phase !== 'pending' || state.run !== run || state.payment.hash) return;
        state.payment.hash = signed.hash;
        append(state, 'Arc testnet hold transaction signed.');
        return state;
      });
      if (!recorded) return;
      await arc.broadcast(signed, deadline);
      change((state) => {
        if (state.phase !== 'pending' || state.payment.hash !== signed.hash) return;
        append(state, 'Arc testnet transaction submitted. Waiting for the QuickNode Stream.');
        return state;
      });
      await pollHoldReceipt();
    } catch {
      change((state) => {
        if (state.phase !== 'pending' || state.run !== run) return;
        if (state.payment.hash) {
          state.payment.uncertain = true;
          append(state, 'Broadcast result could not be confirmed. Waiting for QuickNode without sending another transaction.');
        } else {
          state.phase = 'failed';
          append(state, 'Arc hold preparation failed. No transaction was broadcast.');
        }
        return state;
      });
    }
  }

  function pollHoldReceipt() {
    const { phase, payment } = store.read();
    if (!arc || phase !== 'pending' || !payment?.hash || payment.receiptSeen || holdReceiptCheck ||
        JSON.stringify(payment.binding) !== JSON.stringify(arc.binding)) return holdReceiptCheck;
    holdReceiptCheck = arc.receiptStatus(payment.hash).then((receipt) => {
      if (!receipt) return;
      change((state) => {
        if (state.phase !== 'pending' || state.payment.hash !== payment.hash || state.payment.receiptSeen) return;
        state.payment.receiptSeen = true;
        state.payment.uncertain = false;
        if (receipt === 'reverted') {
          state.phase = 'failed';
          append(state, 'Arc testnet rejected the hold payment.', transactionLink(payment.hash));
        } else {
          append(state, 'Arc testnet receipt succeeded. Room hold awaits signed QuickNode delivery.');
        }
        return state;
      });
    }).catch(() => {}).finally(() => { holdReceiptCheck = null; });
    return holdReceiptCheck;
  }

  async function refreshForecast() {
    if (weatherRequest) return weatherRequest;
    const { booking: terms, run } = store.read();
    weatherRequest = (async () => {
      const forecast = await nwsForecast(terms, fetchWeather, clock);
      const next = change((state) => {
        if (state.run !== run) return;
        if (forecast.status === 'fresh') state.lastFreshForecast = null;
        else if (state.live.status === 'fresh') state.lastFreshForecast = state.live;
        state.live = forecast;
        return state;
      });
      if (next?.mode === 'arc-live') await releaseArc(run, next.mode, forecast);
    })().finally(() => { weatherRequest = null; });
    return weatherRequest;
  }

  async function replay() {
    const current = store.read();
    const forecast = replayForecast(current.booking, clock());
    if (current.mode === 'arc-replay') {
      await releaseArc(current.run, current.mode, forecast);
      return;
    }
    if (current.mode !== 'simulation') throw new HttpError(409, 'Disarm live monitoring to run a replay');
    change((state) => {
      if (state.phase !== 'watching' || state.mode !== 'simulation' ||
          clock() >= Date.parse(state.booking.cutoff)) return;
      state.replay = forecast;
      state.phase = 'pending';
      state.payment = { readyAt: clock() + 700 };
      append(state, `Forecast replay reaches ${peak(forecast)}% during the event.`);
      append(state, 'Simulated hold fee submitted.');
      return state;
    });
  }

  function settleSimulation(state, phase) {
    state.phase = phase;
    const balance = `${state.booking.balance} USDC`;
    append(state, phase === 'confirmed' ? `Remaining ${balance} payment simulated.`
      : `Hold expired. The hold fee was retained and the ${balance} refund was simulated.`);
    return state;
  }

  async function arm(mode) {
    if (!arc || !(streamReady || (mode === 'arc-replay' && replayBackfill))) {
      throw new HttpError(409, 'Arc testnet setup is incomplete');
    }
    const { version, phase, booking: terms } = store.read();
    if (phase !== 'watching' || clock() >= Date.parse(terms.cutoff)) {
      throw new HttpError(409, 'The booking is unavailable for arming');
    }
    try {
      await arc.check();
    } catch {
      throw new HttpError(409, 'Could not verify escrow permissions and funding for this booking');
    }
    if (!change((state) => {
      if (state.version !== version || clock() >= Date.parse(terms.cutoff)) return;
      state.mode = mode;
      append(state, mode === 'arc-replay' ? 'Arc testnet payment armed for forecast replay.' :
        'Arc testnet payment armed for live NWS forecasts.');
      return state;
    })) throw new HttpError(409, 'Booking changed while arming. Try again.');
  }

  function pollSettlement() {
    const { settlement } = store.read();
    if (!arc?.supportsSettlement || !settlement?.hash || settlementCheck) return settlementCheck;
    settlementCheck = arc.settleResult(settlement.hash, settlement.action).then((result) => {
      if (!result) return;
      change((state) => {
        if (state.settlement?.hash !== settlement.hash) return;
        state.settlement = null;
        if (result === 'reverted') {
          append(state, 'Arc testnet rejected the settlement transaction.', transactionLink(settlement.hash));
          return state;
        }
        const confirmed = settlement.action === 'confirm';
        state.phase = confirmed ? 'confirmed' : 'expired';
        state.settlementAmount = result.amount;
        append(state, confirmed ? `Remaining ${result.amount} USDC paid to the venue on Arc testnet.` :
          `${result.amount} USDC refunded to the organizer on Arc testnet.`, transactionLink(settlement.hash));
        return state;
      });
    }).catch(() => {}).finally(() => { settlementCheck = null; });
    return settlementCheck;
  }

  async function settleArc(action) {
    if (!arc?.supportsSettlement) throw new HttpError(409, 'Escrow settlement is unavailable');
    const claimed = change((state) => {
      if (state.mode === 'simulation' || state.settlement) return;
      const cutoffPassed = clock() >= Date.parse(state.booking.cutoff);
      const confirm = action === 'confirm' && state.phase === 'held' && !cutoffPassed;
      const expire = action === 'expire' && cutoffPassed && ['watching', 'held'].includes(state.phase);
      if (!confirm && !expire) return;
      state.settlement = { action };
      return state;
    });
    if (!claimed) throw new HttpError(409, 'This settlement is unavailable for the current booking');

    let signed;
    try {
      signed = await arc.prepareSettlement(action);
    } catch {
      change((state) => ({ ...state, settlement: null }));
      throw new HttpError(409, 'Could not prepare the escrow settlement. Check its onchain status and cutoff.');
    }
    change((state) => {
      state.settlement.hash = signed.hash;
      append(state, 'Arc testnet settlement signed. Waiting for the confirmed receipt.');
      return state;
    });
    const deadline = action === 'confirm' ? Date.parse(claimed.booking.cutoff) : Infinity;
    try {
      await arc.broadcast(signed, deadline);
    } catch {
      change((state) => {
        append(state, 'Settlement broadcast could not be confirmed. Checking the saved hash.');
        return state;
      });
    }
    await pollSettlement();
  }

  async function action(name) {
    advanceSimulation();
    if (name === 'forecast') return refreshForecast();
    if (name === 'replay') return replay();
    if (name === 'arm-replay') return arm('arc-replay');
    if (name === 'arm-live') return arm('arc-live');
    if (['confirm', 'expire'].includes(name) && store.read().mode !== 'simulation') return settleArc(name);

    if (!['reset', 'disarm', 'confirm', 'expire'].includes(name)) throw new HttpError(404, 'Unknown action');
    if (!change((state) => {
      if (name === 'disarm' && state.phase === 'watching' && state.mode !== 'simulation') {
        state.mode = 'simulation';
        append(state, 'Arc testnet payments disarmed.');
        return state;
      }
      if (state.mode !== 'simulation') return;
      if (name === 'reset') return { ...initial(state.booking, state.run + 1), version: state.version };
      if (state.phase !== 'held') return;
      if (name === 'confirm' && clock() < Date.parse(state.booking.cutoff)) return settleSimulation(state, 'confirmed');
      if (name === 'expire') return settleSimulation(state, 'expired');
    })) throw new HttpError(409, 'This action is unavailable for the current booking');
  }

  async function receive(request) {
    const { nonce, expires, logs } = await verifiedDelivery(request, env.STANDBY_QUICKNODE_SECRET, clock());
    if (store.hasDelivery(nonce)) return 'duplicate-delivery';
    const { phase, mode, payment } = store.read();
    let matched = false;
    if (arc && mode !== 'simulation' && phase === 'pending' && payment?.hash &&
        JSON.stringify(payment.binding) === JSON.stringify(arc.binding)) {
      try {
        for (const log of logs) {
          if (await arc.verify(log, payment)) {
            matched = true;
            break;
          }
        }
      } catch {
        throw new HttpError(503, 'Could not verify the Arc receipt yet');
      }
    }
    return store.recordDelivery(nonce, expires, clock(), () => {
      const state = store.read();
      if (state.mode !== 'simulation' && state.phase === 'held' &&
          logs.some((log) => typeof log?.transactionHash === 'string' && log.transactionHash.toLowerCase() === state.payment.hash)) return 'duplicate-payment';
      if (!matched || state.phase !== 'pending' || state.payment?.hash !== payment.hash) return 'ignored';
      state.phase = 'held';
      state.payment.uncertain = false;
      state.payment.streamConfirmed = true;
      append(state, 'QuickNode Stream delivered the confirmed Arc testnet hold payment.',
        transactionLink(state.payment.hash));
      if (!store.save(state)) throw new Error('Could not save confirmed payment');
      return 'room-held';
    });
  }

  function handler(webhookOnly) {
    return (request, response) => {
      handle().catch((error) => {
        if (!(error instanceof HttpError)) console.error('Umbrella request failed');
        json(response, error.status || 500, { error: error.status ? error.message : 'Umbrella request failed' });
      });

      async function handle() {
        const path = new URL(request.url, 'http://127.0.0.1').pathname;
        if (path === WEBHOOK && request.method === 'GET' && webhookOnly) {
          json(response, 200, { status: 'reachable' });
          return;
        }
        if (path === WEBHOOK && request.method === 'POST') {
          await ready;
          json(response, 200, { result: await receive(request) });
          return;
        }
        if (webhookOnly) throw new HttpError(404, 'Unknown route');
        const host = request.headers.host ?? '';
        if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
          throw new HttpError(403, 'Open the Organizer or Venue view on localhost');
        }
        await ready;
        if (request.method === 'GET' && path === '/api/state') {
          pollHoldReceipt();
          pollSettlement();
          json(response, 200, publicState());
          return;
        }
        if (path === '/api/event' && request.method === 'GET') {
          json(response, 200, publicEvent());
          return;
        }
        if (path === '/api/event/forecast' && request.method === 'POST') {
          if (request.headers.origin !== 'http://' + host) throw new HttpError(403, 'Invalid action origin');
          await refreshEventForecast();
          json(response, 200, publicEvent());
          return;
        }
        if (request.method === 'POST' && path.startsWith('/api/actions/')) {
          if (request.headers.origin !== 'http://' + host) throw new HttpError(403, 'Invalid action origin');
          await action(path.slice('/api/actions/'.length));
          json(response, 200, publicState());
          return;
        }
        const asset = request.method === 'GET' && assets.get(path);
        if (!asset) throw new HttpError(404, 'Unknown route');
        const [file, type] = asset;
        const body = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, {
          'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        }).end(body);
      }
    };
  }

  function tick() {
    advanceSimulation();
    const state = store.read();
    if (arc && state.mode === 'arc-live' && state.phase === 'watching' && clock() < Date.parse(state.booking.cutoff)) {
      refreshForecast().catch(() => console.error('Scheduled forecast check failed'));
    }
  }
  const poll = setInterval(tick, POLL_INTERVAL);
  poll.unref();

  return {
    app: createServer(handler(false)),
    webhook: createServer(handler(true)),
    close: () => { clearInterval(poll); store.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--check-arc') {
  const result = await checkArcSetup(process.env).catch(() => ({ error: 'Could not read valid booking terms.' }));
  if (result.ready) console.log('Escrow booking and signer checks passed. ' + (result.streamReady
    ? 'Verify QuickNode delivery before the demo.' : 'QuickNode is disconnected. Add STANDBY_QUICKNODE_SECRET for signed delivery.'));
  else {
    console.error(result.error ?? 'Missing Arc testnet setup\n' + result.missing.map((name) => '- ' + name).join('\n'));
    process.exitCode = 1;
  }
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, webhook } = createStandby();
  const port = Number(process.env.PORT || 4173);
  app.listen(port, '127.0.0.1', () => console.log(`Umbrella is ready at http://127.0.0.1:${port}`));
  if (process.env.STANDBY_WEBHOOK_PORT) {
    webhook.listen(Number(process.env.STANDBY_WEBHOOK_PORT), '127.0.0.1', () =>
      console.log(`QuickNode-only listener ready on port ${process.env.STANDBY_WEBHOOK_PORT}`));
  }
}
