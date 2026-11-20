const find = (id) => document.getElementById(id);
const view = new URLSearchParams(location.search).get('view');
const staffView = view === 'venue';
const exampleView = !staffView && view !== 'escrow';
const hosted = Boolean(document.querySelector('meta[name="umbrella-hosted"]'));
const statePath = exampleView ? '/api/event' : hosted ? '/testnet-demo.json' : '/api/state';
const austinDate = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
});
const austinTime = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const checkTime = new Intl.DateTimeFormat('en-US', { timeStyle: 'medium', timeZone: 'America/Chicago' });
const hourLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/Chicago' });

const scenarioRain = [52, 78, 71, 58];
const exampleAmounts = { holdFee: 150, balance: 750 };
const stepIndex = { watching: 0, pending: 1, held: 2, confirmed: 3, expired: 3, closed: 3, failed: 1 };
let state;
let runningAction;
let forecastInitialized = false;
let rainScenario = false;
let scenarioPhase = 'watching';
let holdTimer;
let chartSlots = [];

function setText(id, text) {
  const element = find(id);
  if (element.textContent !== text) element.textContent = text;
}

function formatWindow(booking) {
  const start = new Date(booking.startsAt);
  const end = new Date(booking.endsAt);
  const endDate = austinDate.format(end);
  return austinDate.format(start) + ' · ' + austinTime.format(start) + '–' +
    (austinDate.format(start) === endDate ? '' : endDate + ', ') + austinTime.format(end) + ' Austin time';
}

function highestRain(hours) {
  return hours.length && hours.every(({ probability }) => Number.isFinite(probability))
    ? Math.max(...hours.map(({ probability }) => probability)) : null;
}

function prepareWeatherArt() {
  const svgNS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 12; i++) {
    const ray = document.createElementNS(svgNS, 'path');
    ray.setAttribute('d', i % 2 ? 'M24 9.5v-3' : 'M24 9.5v-6.5');
    ray.setAttribute('transform', `rotate(${i * 30} 24 24)`);
    ray.style.setProperty('--delay', `${i * 0.2}s`);
    find('sunRays').append(ray);
  }
  const rain = document.createDocumentFragment();
  const spread = (index, multiplier) => ((index * multiplier) % 97) / 97;
  for (let i = 0; i < 70; i++) {
    const drop = document.createElement('span');
    drop.style.left = `${spread(i, 37) * 108 - 2}%`;
    drop.style.height = `${18 + spread(i, 53) * 26}px`;
    drop.style.setProperty('--duration', `${0.9 + spread(i, 71) * 0.9}s`);
    drop.style.setProperty('--delay', `${-spread(i, 29) * 2}s`);
    rain.append(drop);
  }
  find('rainSky').append(rain);
}

function renderChart(hours, threshold) {
  if (hours.length !== chartSlots.length) {
    chartSlots = hours.map(() => {
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      const value = document.createElement('span');
      bar.append(value);
      const hour = document.createElement('time');
      return { bar, value, hour };
    });
    find('chartBars').replaceChildren(...chartSlots.map(({ bar }) => bar));
    find('chartHours').replaceChildren(...chartSlots.map(({ hour }) => hour));
    find('rainChart').style.setProperty('--hour-count', hours.length);
    find('chartHours').style.setProperty('--hour-count', hours.length);
  }
  find('rainChart').style.setProperty('--threshold', `${threshold}%`);
  setText('chartThreshold', `Switch point ${threshold}%`);
  hours.forEach(({ start, probability }, index) => {
    const { bar, value, hour } = chartSlots[index];
    const known = Number.isFinite(probability);
    const label = hourLabel.format(new Date(start));
    bar.style.setProperty('--chance', `${probability ?? 0}%`);
    bar.toggleAttribute('data-crossed', known && probability >= threshold);
    bar.toggleAttribute('data-missing', !known);
    value.textContent = known ? `${probability}%` : '—';
    hour.dateTime = start;
    hour.textContent = label;
    hour.setAttribute('aria-label', `${label}, ${known ? `${probability}% chance of rain` : 'rain chance unavailable'}`);
  });
}

function renderWeather() {
  const { forecast, lastFreshForecast, booking } = state;
  const { threshold } = booking;
  const latest = forecast.status === 'fresh';
  const illustrative = exampleView && rainScenario;
  const recorded = hosted && !exampleView;
  const saved = forecast.status === 'stale' && highestRain(forecast.hours) !== null ? forecast : lastFreshForecast;
  const reading = latest ? forecast : saved;
  const hours = illustrative ? forecast.hours.map((hour, i) => ({ ...hour, probability: scenarioRain[i] })) :
    (reading?.hours ?? forecast.hours);
  const peak = highestRain(hours);
  const crosses = (illustrative || latest || recorded) && peak !== null && peak >= threshold;
  const comparison = crosses ? 'At or above' : 'Below';
  const flags = {
    unchecked: 'Waiting for the live forecast',
    unavailable: 'Live forecast unavailable',
    stale: 'Live forecast out of date',
    incomplete: 'Some event hours are missing',
  };
  setText('rainValue', peak === null ? '—' : `${peak}%`);
  setText('rainDecision', illustrative || latest || recorded ? `${comparison} the ${threshold}% switch point` : flags[forecast.status]);
  find('rainDecision').className = crosses ? 'tag tag-accent' : 'tag tag-neutral';
  find('sunIcon').toggleAttribute('hidden', crosses);
  find('rainIcon').toggleAttribute('hidden', !crosses);
  find('sunSky').hidden = crosses;
  find('rainSky').hidden = !crosses;

  const checked = reading?.checkedAt ? checkTime.format(new Date(reading.checkedAt)) : '';
  let source = 'National Weather Service · hourly forecast';
  if (illustrative) source = 'Illustrative forecast · no payment is sent';
  else if (recorded) source = 'Illustrative forecast · recorded Arc Testnet replay';
  else if (latest) source = `Live NWS forecast · checked at ${checked}`;
  else if (forecast.status !== 'unchecked') source = saved ?
    'Last known NWS forecast · automatic payments paused' : 'National Weather Service · automatic payments paused';
  setText('forecastSource', source);
  const checking = runningAction === 'forecast';
  find('forecast').disabled = Boolean(runningAction) || illustrative;
  find('forecast').setAttribute('aria-busy', String(checking));
  setText('forecastButtonLabel', checking ? 'Checking live forecast…' : 'Check live forecast');
  renderChart(hours, threshold);
}

function renderSteps(phase, hold, balance, simulated) {
  const index = stepIndex[phase] ?? 0;
  const steps = document.querySelectorAll('.booking-steps li');
  steps.forEach((step, i) => {
    step.toggleAttribute('data-complete', i < index);
    if (i === index) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
  const expired = phase === 'expired';
  setText('holdStep', `${hold} from escrow`);
  setText('roomStep', simulated && phase !== 'watching' ? 'Simulated booking update' : 'Signed event verified');
  setText('decisionStep', expired ? 'Hold expired' : 'Your decision');
  setText('decisionNote', expired ? `${balance} returned` :
    phase === 'confirmed' ? (simulated ? 'Moved indoors' : 'Booking confirmed') : 'Move or stay');
}

function renderActivity(activity) {
  find('activity').replaceChildren(...activity.map(({ text, txUrl }, i) => {
    const item = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'activity-number';
    number.textContent = String(i + 1).padStart(2, '0');
    const description = document.createElement('span');
    description.textContent = text;
    if (txUrl) {
      const link = document.createElement('a');
      link.href = txUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View Arc Testnet transaction';
      description.append(' ', link);
    }
    item.append(number, description);
    return item;
  }));
}

function showStatus(id, title, note, paid) {
  find(id).toggleAttribute('data-paid', paid);
  if (id === 'staffStatus') {
    setText('staffTitle', title);
    setText('staffNote', note);
  } else {
    setText('statusTitle', title);
    setText('statusNote', note);
  }
}

function showTag(id, label, paid) {
  setText(id, label);
  find(id).className = paid ? 'tag tag-accent' : 'tag tag-neutral';
}

function renderAmounts(phase, hold, balance, paid, holdRetained) {
  const holdState = paid ? 'Paid to venue' : phase === 'pending' ? 'Clearing' :
    phase === 'expired' && !holdRetained ? 'Returned to organizer' : 'In escrow';
  const balanceState = phase === 'confirmed' ? 'Paid to venue' :
    phase === 'expired' ? 'Returned to organizer' : 'In escrow';
  if (staffView) {
    setText('staffHoldFee', hold);
    setText('staffBalance', balance);
    showTag('staffHoldState', holdState, paid);
    showTag('staffBalanceState', balanceState, phase === 'confirmed');
    return;
  }
  setText('holdFee', hold);
  setText('balance', balance);
  showTag('holdState', holdState, paid);
  showTag('balanceState', balanceState, phase === 'confirmed');
  find('holdMeter').dataset.state = paid ? 'paid' : phase === 'expired' && !holdRetained ? 'refunded' : '';
  find('balanceMeter').dataset.state = phase === 'confirmed' ? 'paid' : phase === 'expired' ? 'refunded' : '';
}

function renderVenuePlan(moved) {
  find('outdoorCard').dataset.current = String(!moved);
  find('indoorCard').dataset.current = String(moved);
  setText('outdoorRole', moved ? 'Original venue' : 'Current venue');
  setText('indoorRole', moved ? 'Current venue' : 'Indoor backup');
  setText('planIntro', moved ? 'Your indoor venue is confirmed.' :
    'Reaching the switch point can reserve the backup. You decide whether to move.');
}

function renderExample() {
  const { booking: { threshold }, event, forecast } = state;
  const phase = scenarioPhase;
  const held = phase === 'held';
  const moved = phase === 'confirmed';
  const expired = phase === 'expired';
  const paid = held || moved || expired;
  const hold = `${exampleAmounts.holdFee} USDC`;
  const balance = `${exampleAmounts.balance} USDC`;
  const livePeak = highestRain(forecast.hours);
  const known = forecast.status === 'fresh' || rainScenario;
  const peak = rainScenario ? Math.max(...scenarioRain) : livePeak;
  let watching = `Play is planned at ${event.outdoor.name}. Automatic payments are paused.`;
  if (known) watching = peak >= threshold ?
    `At or above the ${threshold}% switch point. The indoor backup can be reserved in the rain scenario.` :
    `Below the ${threshold}% switch point. Play stays at ${event.outdoor.name}.`;

  const status = {
    watching: ['Watching the forecast', watching],
    pending: ['Hold requested', 'Waiting for the simulated hold payment to clear.'],
    held: ['Room held', `In this scenario, play stays at ${event.outdoor.name} until you confirm the switch.`],
    confirmed: ['Booking confirmed', `Play moves indoors to ${event.backup.name} in this scenario.`],
    expired: ['Backup hold expired', `${balance} went back to the organizer in this scenario.`],
  }[phase];

  setText('heading', event.title);
  find('rainMode').disabled = false;
  setText('outdoorName', event.outdoor.name);
  setText('outdoorDetail', event.outdoor.detail);
  setText('indoorName', event.backup.name);
  setText('indoorDetail', event.backup.detail);
  renderVenuePlan(moved);
  renderSteps(phase, hold, balance, true);
  renderAmounts(phase, hold, balance, paid, paid);
  showStatus('status', ...status, paid && !expired);
  find('bookingControls').hidden = !held;
  find('scenarioReset').hidden = !moved && !expired;

  const activity = [{ text: 'Illustrative escrow funded with 900 USDC.' }];
  if (phase !== 'watching') activity.push({ text: `Rain scenario reached ${Math.max(...scenarioRain)}%. Simulated hold requested.` });
  if (paid) activity.push(
    { text: `Hold fee of ${hold} paid in the simulation.` },
    { text: 'Simulated booking update received. Room held.' },
  );
  if (moved) activity.push({ text: `Organizer confirmed. Remaining ${balance} released in the simulation.` });
  if (expired) activity.push({ text: `Hold expired. ${balance} returned in the simulation.` });
  renderActivity(activity);
}

function bookingStatus() {
  const { phase, mode, cutoffPassed, paymentReceiptSeen, paymentUncertain, settling, settlementAmount } = state;
  const simulation = mode === 'simulation';
  if (settling) return ['Settlement pending', 'Waiting for confirmation of your transaction.'];
  switch (phase) {
    case 'watching':
      if (cutoffPassed) return ['Backup offer closed', 'The test booking deadline has passed.'];
      return staffView ? ['Waiting for a hold', 'Hold the test venue once a verified booking comes through.'] :
        ['Escrow ready for the demo', 'Use the demo controls to trigger the hold.'];
    case 'pending':
      if (simulation) return ['Demo hold in progress', 'Waiting for the simulated reservation.'];
      if (paymentReceiptSeen) return ['Hold fee paid', 'The testnet payment cleared. The room hold is awaiting a signed QuickNode event.'];
      if (paymentUncertain) return ['Hold payment awaiting verification', 'Check booking activity for the latest status.'];
      return ['Hold requested', 'Waiting for the hold payment to clear.'];
    case 'held':
      if (cutoffPassed) return ['Hold deadline passed', 'The unpaid balance can be refunded.'];
      if (simulation) return ['Room held', 'Simulated booking. The organizer can decide whether to book.'];
      if (hosted) return ['Room held', 'A signed QuickNode delivery matched the finalized Arc Testnet payout. This is the recorded test booking.'];
      return ['Room held', staffView ? 'Keep the test venue available until the hold deadline.' :
        'Confirm to release the remaining testnet balance.'];
    case 'confirmed':
      return ['Test booking confirmed', simulation ? 'The venue switch was simulated.' :
        'The remaining balance settled on Arc Testnet.'];
    case 'expired':
      return ['Backup hold expired', simulation ? 'The refund was simulated.' :
        `${settlementAmount} test USDC went back to the organizer.`];
    case 'closed':
      return ['Backup offer closed', 'The deadline passed before the hold completed.'];
    case 'failed':
      return ['Hold payment failed', 'See booking activity for the failed transaction.'];
  }
}

function renderDemoControls() {
  const { mode, phase, cutoffPassed, arcReady, streamReady, automaticPaymentsEnabled } = state;
  const simulation = mode === 'simulation';
  const canTrigger = phase === 'watching' && !cutoffPassed;
  const replayArmed = mode === 'arc-replay';
  setText('mode', {
    simulation: 'Simulation',
    'arc-live': 'Arc Testnet · live forecast',
    'arc-replay': 'Arc Testnet · illustrative replay',
  }[mode]);
  setText('replayNote', {
    simulation: 'The demo replay creates a simulated hold you can reset.',
    'arc-live': automaticPaymentsEnabled ? 'Automatic testnet payments are enabled for fresh live forecasts.' :
      'Automatic payments are paused when no fresh, complete forecast is available.',
    'arc-replay': phase === 'pending' && !streamReady ? 'The signed QuickNode backfill is needed to update the venue status.' :
      'The armed replay uses illustrative values and can send a real testnet hold fee once.',
  }[mode]);
  find('replay').hidden = !canTrigger || mode === 'arc-live';
  setText('replay', replayArmed ? 'Run replay and pay on Arc Testnet' : 'Run simulated replay');
  find('reset').hidden = !simulation;
  find('armReplay').hidden = !canTrigger || !simulation || !arcReady;
  find('armLive').hidden = !canTrigger || !simulation || !arcReady || !streamReady;
  find('disarm').hidden = !canTrigger || simulation;
  for (const id of ['replay', 'reset', 'armReplay', 'armLive', 'disarm', 'confirm', 'expire']) {
    find(id).disabled = Boolean(runningAction || state.settling);
  }
}

function renderEscrow() {
  const { booking, phase, mode, cutoffPassed, paymentReceiptSeen, settlementEnabled, settlementAmount } = state;
  const simulation = mode === 'simulation';
  const hold = `${booking.holdFee} test USDC`;
  const balance = `${booking.balance} test USDC`;
  const retained = phase === 'expired' && (simulation || Number(settlementAmount) === booking.balance);
  const paid = paymentReceiptSeen || phase === 'held' || phase === 'confirmed' || retained;
  renderSteps(phase, hold, balance, simulation);
  renderAmounts(phase, hold, balance, paid, retained);
  showStatus(staffView ? 'staffStatus' : 'status', ...bookingStatus(), paid && phase !== 'expired');
  if (staffView) return;

  const windowLabel = formatWindow(booking);
  setText('subtitle', hosted ? 'Verified payout from a separate test booking · ' + windowLabel : windowLabel);
  renderVenuePlan(phase === 'confirmed');
  setText('escrowIntro', simulation ? 'Simulated testnet booking.' : 'Test booking on Arc Testnet.');
  const cutoff = new Date(booking.cutoff);
  setText('cutoff', `Hold deadline · ${austinDate.format(cutoff)} at ${austinTime.format(cutoff)} Austin time`);
  find('cutoff').hidden = false;
  find('holdMeter').style.width = `${booking.holdFee / (booking.holdFee + booking.balance) * 100}%`;
  renderActivity(state.activity);
  if (hosted) return;

  const canConfirm = phase === 'held' && (simulation || (settlementEnabled && !cutoffPassed));
  const canExpire = (simulation && phase === 'held') ||
    (settlementEnabled && cutoffPassed && ['watching', 'held'].includes(phase));
  find('bookingControls').hidden = !canConfirm && !canExpire;
  find('confirm').hidden = !canConfirm;
  find('expire').hidden = !canExpire;
  setText('confirm', simulation ? 'Simulate booking confirmation' : `Confirm booking · ${balance}`);
  setText('expire', simulation ? 'Simulate expiry' : 'Refund unpaid balance');
  renderDemoControls();
}

function render() {
  if (!state) return;
  setText('threshold', `${state.booking.threshold}%`);
  if (!staffView) renderWeather();
  if (exampleView) renderExample();
  else renderEscrow();
}

function selectForecast(rain) {
  rainScenario = rain;
  clearTimeout(holdTimer);
  if (!rain && scenarioPhase === 'pending') scenarioPhase = 'watching';
  if (rain && scenarioPhase === 'watching' && state && Math.max(...scenarioRain) >= state.booking.threshold) {
    scenarioPhase = 'pending';
    holdTimer = setTimeout(() => {
      scenarioPhase = 'held';
      render();
    }, 1800);
  }
  render();
}

function accept(next) {
  if (!state || next.version > state.version || (next.version === state.version &&
      (next.cutoffPassed !== state.cutoffPassed || next.forecast.status !== state.forecast.status))) {
    if (hosted && exampleView && next.forecast.status !== 'fresh') {
      next.lastFreshForecast = state?.forecast.status === 'fresh' ? state.forecast : state?.lastFreshForecast;
    }
    state = next;
    render();
  }
}

function showMessage(message) {
  setText('requestMessage', message);
  find('requestMessage').hidden = !message;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

const connectionError = 'Could not connect to Umbrella. Try again in a moment.';
async function refresh() {
  try {
    accept(await request(statePath));
    if (find('requestMessage').textContent === connectionError) showMessage('');
    if (!hosted && !staffView && !forecastInitialized) {
      forecastInitialized = true;
      if (state.forecast.status !== 'fresh') void act('forecast');
    }
  } catch {
    if (!runningAction) showMessage(connectionError);
  }
}

async function act(action) {
  if (runningAction || (exampleView && action !== 'forecast')) return;
  runningAction = action;
  showMessage('');
  render();
  try {
    const path = hosted ? '/api/event' : exampleView ? '/api/event/forecast' : '/api/actions/' + action;
    accept(await request(path, { method: hosted ? 'GET' : 'POST', cache: 'no-cache' }));
  } catch (error) {
    showMessage(action === 'forecast' ? 'Could not refresh the live forecast. Try again in a moment.' : error.message);
  } finally {
    runningAction = null;
    render();
  }
}

find('forecast').addEventListener('click', () => act('forecast'));
if (exampleView) {
  find('liveMode').addEventListener('change', () => selectForecast(false));
  find('rainMode').addEventListener('change', () => selectForecast(true));
  find('confirm').addEventListener('click', () => {
    if (scenarioPhase !== 'held') return;
    scenarioPhase = 'confirmed';
    render();
  });
  find('expire').addEventListener('click', () => {
    if (scenarioPhase !== 'held') return;
    scenarioPhase = 'expired';
    render();
  });
  find('resetExample').addEventListener('click', () => {
    scenarioPhase = 'watching';
    find('liveMode').checked = true;
    selectForecast(false);
    find('liveMode').focus();
  });
} else {
  find('planNav').removeAttribute('aria-current');
  find(staffView ? 'staffNav' : 'escrowNav').setAttribute('aria-current', 'page');
  setText('eyebrow', 'Arc Testnet · Escrow demo');
  const heading = staffView ? 'Venue staff' : hosted ? 'Arc Testnet proof' : 'Arc escrow demo';
  setText('heading', heading);
  document.title = `${heading} · Umbrella`;
  if (staffView) {
    find('planColumns').hidden = true;
    find('organizerEscrow').hidden = true;
    find('howItWorks').hidden = true;
    find('staffPanel').hidden = false;
    if (hosted) setText('staffIntro', 'See the venue’s view of the verified test booking.');
  } else {
    find('forecastModes').hidden = true;
    find('demoPanel').hidden = hosted;
    find('forecast').hidden = hosted;
    setText('subtitle', 'Loading test booking…');
    setText('outdoorName', 'Outdoor demo site');
    setText('outdoorDetail', 'Test booking');
    setText('indoorName', 'Indoor demo site');
    setText('indoorDetail', 'Test booking');
    for (const action of ['replay', 'reset', 'confirm', 'expire', 'disarm']) {
      find(action).addEventListener('click', () => act(action));
    }
    find('armReplay').addEventListener('click', () => {
      if (window.confirm('Arm the replay to send a real Arc Testnet hold fee?')) act('arm-replay');
    });
    find('armLive').addEventListener('click', () => {
      if (window.confirm('Arm live weather payments on Arc Testnet? A fresh forecast at the switch point can send the hold fee.')) act('arm-live');
    });
  }
}

prepareWeatherArt();
refresh();
if (!hosted) window.setInterval(refresh, 1250);
