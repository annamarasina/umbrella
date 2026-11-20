const find = (id) => document.getElementById(id);
const view = new URLSearchParams(location.search).get('view');
const staffView = view === 'venue';
const exampleView = !staffView && view !== 'escrow';
const statePath = exampleView ? '/api/event' : '/api/state';
const austinDate = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
});
const austinTime = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});
const checkTime = new Intl.DateTimeFormat('en-US', { timeStyle: 'medium', timeZone: 'America/Chicago' });
const hourLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/Chicago' });
let state;
let runningAction;
let forecastInitialized = false;
let previewOpen = false;
let previewStep = 0;

function displayBookingStatus() {
  const { phase, mode, cutoffPassed, paymentReceiptSeen, paymentUncertain, settling, settlementAmount } = state;
  const simulation = mode === 'simulation';
  if (settling) return ['Settlement pending', 'Waiting for confirmation of your transaction.'];
  switch (phase) {
    case 'watching':
      if (cutoffPassed) return ['Backup offer closed', 'The test booking deadline has passed.'];
      if (staffView) return ['Waiting for a hold', 'Hold the test venue once a verified booking comes through.'];
      return ['Escrow ready for the demo', 'The testnet hold is triggered through the demo controls.'];
    case 'pending':
      if (simulation) return ['Demo hold in progress', 'Waiting for the simulated reservation.'];
      if (paymentReceiptSeen) return ['Hold fee paid', staffView ? 'The testnet payment cleared. The room hold is awaiting a verified booking update.' :
        'The testnet payment cleared. The hold updates when its signed QuickNode event arrives.'];
      if (paymentUncertain) return ['Hold payment awaiting verification', 'Check booking activity for the latest status.'];
      return ['Hold requested', 'Waiting for the hold payment to clear.'];
    case 'held':
      if (cutoffPassed) return ['Hold deadline passed', 'The unpaid balance can be refunded.'];
      return ['Room held', staffView ? (simulation ? 'Demo only. An organizer would now decide whether to book.' :
        'Keep the test venue available until the hold deadline.') :
        (simulation ? 'Confirm the simulated switch to the indoor venue.' :
          'The test venue is held. Confirm to release the remaining testnet balance.')];
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

function renderWeather(forecast, lastFresh, threshold) {
  const latest = forecast.status === 'fresh';
  const reading = latest || (forecast.status === 'stale' && highestRain(forecast.hours) !== null)
    ? forecast : lastFresh;
  const peak = reading ? highestRain(reading.hours) : null;
  const thresholdReached = latest && peak !== null && peak >= threshold;
  const flag = {
    unchecked: 'Waiting for the live forecast',
    unavailable: 'Live forecast unavailable',
    stale: 'Live forecast out of date',
    incomplete: 'Some event hours are missing',
    fresh: thresholdReached ? `At or above the ${threshold}% switch point` : `Below the ${threshold}% switch point`,
  }[forecast.status];
  find('rainValue').textContent = peak === null ? '—' : `${peak}%`;
  find('rainDecision').textContent = flag;
  find('forecastCard').dataset.level = latest ? (thresholdReached ? 'above' : 'below') : 'unknown';
  const updated = reading?.updatedAt && Number.isFinite(Date.parse(reading.updatedAt))
    ? ` · ${austinDate.format(new Date(reading.updatedAt))}, ${austinTime.format(new Date(reading.updatedAt))}` : '';
  find('forecastSource').textContent = latest ? `Live NWS forecast · checked at ${checkTime.format(new Date(forecast.checkedAt))}`
    : peak === null ? 'National Weather Service' : `Last known NWS forecast${updated}`;

  const hours = reading?.hours ?? forecast.hours;
  find('hourlyValues').replaceChildren(...hours.map(({ start, probability }) => {
    const row = document.createElement('li');
    const hour = document.createElement('time');
    hour.dateTime = start;
    hour.textContent = hourLabel.format(new Date(start));
    const chance = document.createElement('strong');
    chance.textContent = probability === null ? 'Unavailable' : `${probability}%`;
    row.append(hour, chance);
    return row;
  }));
}

function renderDemoControls() {
  const { mode, phase, cutoffPassed, arcReady, streamReady, automaticPaymentsEnabled } = state;
  const simulation = mode === 'simulation';
  const canTrigger = phase === 'watching' && !cutoffPassed;
  const replayArmed = mode === 'arc-replay';
  find('mode').textContent = {
    simulation: 'Simulation',
    'arc-live': 'Arc Testnet · live forecast',
    'arc-replay': 'Arc Testnet · illustrative replay',
  }[mode];
  find('replayNote').textContent = {
    simulation: 'The demo replay creates a simulated hold you can reset.',
    'arc-live': automaticPaymentsEnabled ? 'Automatic testnet payments are enabled for fresh live forecasts.' :
      'Automatic payments are paused until a fresh, complete live forecast is available.',
    'arc-replay': phase === 'pending' && !streamReady ?
      'The signed QuickNode backfill is needed to update the venue status.' :
      'The armed replay uses illustrative values and can send a real testnet hold fee once.',
  }[mode];
  find('replay').hidden = !canTrigger || mode === 'arc-live';
  find('replay').textContent = replayArmed ? 'Run replay and pay on Arc Testnet' : 'Run simulated replay';
  find('reset').hidden = !simulation;
  find('armReplay').hidden = !canTrigger || !simulation || !arcReady;
  find('armLive').hidden = !canTrigger || !simulation || !arcReady || !streamReady;
  find('disarm').hidden = !canTrigger || simulation;
  for (const id of ['replay', 'reset', 'armReplay', 'armLive', 'disarm', 'confirm', 'expire']) {
    find(id).disabled = Boolean(runningAction || state.settling);
  }
}

function renderPreview() {
  const { booking, event, previewPeak } = state;
  const crosses = previewPeak >= booking.threshold;
  find('previewButton').disabled = false;
  find('previewButton').setAttribute('aria-expanded', String(previewOpen));
  find('previewButton').firstChild.textContent = previewOpen ? 'Close rain scenario ' : 'Try rain scenario ';
  find('previewResult').hidden = !previewOpen;
  if (!previewOpen) return;
  find('previewValue').textContent = `${previewPeak}%`;
  const stories = [
    `The forecast crossed the ${booking.threshold}% switch point. Umbrella would request a hold at ${event.backup.name}.`,
    `Simulated hold placed. Play is still planned at ${event.outdoor.name} until you confirm the switch.`,
    `Demo switch confirmed. In this rehearsal, play moves indoors to ${event.backup.name}.`,
  ];
  find('previewExplanation').textContent = crosses ? stories[previewStep] :
    `At ${previewPeak}%, play stays at ${event.outdoor.name}. The backup hold starts at ${booking.threshold}%.`;
  find('previewAdvance').hidden = !crosses || previewStep === 2;
  find('previewAdvance').textContent = previewStep === 0 ? 'Simulate court hold' : 'Simulate venue switch';
}

function renderActivity(activity) {
  find('activity').replaceChildren(...activity.map(({ text, txUrl }) => {
    const item = document.createElement('li');
    item.textContent = text;
    if (txUrl) {
      const link = document.createElement('a');
      link.href = txUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View Arc Testnet transaction';
      item.append(' ', link);
    }
    return item;
  }));
}

function render() {
  if (!state) return;
  if (exampleView) {
    renderExample();
    return;
  }
  const { booking, phase, mode, forecast, lastFreshForecast, cutoffPassed } = state;
  const simulation = mode === 'simulation';
  const moved = phase === 'confirmed';
  const [title, description] = displayBookingStatus();
  const windowLabel = formatWindow(booking);
  find('subtitle').textContent = windowLabel;
  find('status').dataset.state = phase === 'watching' && cutoffPassed ? 'closed' : phase;
  if (find('statusTitle').textContent !== title) find('statusTitle').textContent = title;
  find('statusNote').textContent = description;
  find('threshold').textContent = `${booking.threshold}%`;
  find('planIntro').textContent = staffView ? 'Check whether the escrow demo needs the room.' :
    moved ? 'Your indoor venue is confirmed.' : 'Reaching the switch point can reserve the backup. You decide whether to move.';
  find('outdoorCard').dataset.current = String(!moved);
  find('indoorCard').dataset.current = String(moved || staffView);
  find('outdoorRole').textContent = moved ? 'Original venue' : 'Current venue';
  find('indoorRole').textContent = moved ? 'Current venue' : 'Indoor backup';

  const canConfirm = phase === 'held' && (simulation || (state.settlementEnabled && !cutoffPassed));
  const canExpire = (simulation && phase === 'held') ||
    (state.settlementEnabled && cutoffPassed && ['watching', 'held'].includes(phase));
  find('bookingControls').hidden = staffView || (!canConfirm && !canExpire);
  find('confirm').hidden = !canConfirm;
  find('expire').hidden = !canExpire;
  find('expire').textContent = simulation ? 'Simulate expiry' : 'Refund unpaid balance';
  find('holdFee').textContent = `${booking.holdFee} test USDC`;
  find('balance').textContent = `${booking.balance} test USDC`;
  const cutoff = new Date(booking.cutoff);
  find('terms').textContent = `${austinDate.format(cutoff)} at ${austinTime.format(cutoff)} Austin time`;
  renderActivity(state.activity);

  if (staffView) return;
  const checking = runningAction === 'forecast';
  find('forecast').disabled = Boolean(runningAction);
  find('forecast').setAttribute('aria-busy', String(checking));
  find('forecastButtonLabel').textContent = checking ? 'Checking live forecast…' : 'Check live forecast';
  renderWeather(forecast, lastFreshForecast, booking.threshold);
  renderDemoControls();
}

function renderExample() {
  const { booking, event, forecast, lastFreshForecast, integration } = state;
  const checking = runningAction === 'forecast';
  find('heading').textContent = event.title;
  find('subtitle').textContent = `${formatWindow(booking)} · ${event.partner}`;
  find('eventSchedule').textContent = event.schedule;
  find('eventLink').href = event.url;
  find('outdoorName').textContent = event.outdoor.name;
  find('outdoorDetail').textContent = event.outdoor.detail;
  find('outdoorCard').dataset.current = 'true';
  find('indoorName').textContent = event.backup.name;
  find('indoorDetail').textContent = event.backup.detail;
  find('threshold').textContent = `${booking.threshold}%`;
  find('statusTitle').textContent = 'Suggested indoor backup';
  find('statusNote').textContent = 'Demo plan · Court availability unverified';
  find('forecast').disabled = checking;
  find('forecast').setAttribute('aria-busy', String(checking));
  find('forecastButtonLabel').textContent = checking ? 'Checking live forecast…' : 'Check live forecast';
  renderWeather(forecast, lastFreshForecast, booking.threshold);
  renderPreview();

  find('integration').hidden = false;
  find('arcStatus').textContent = integration.payoutUrl ? `Arc Testnet · ${integration.holdFee} USDC released` : 'Arc Testnet · Awaiting verification';
  find('payoutLink').hidden = !integration.payoutUrl;
  if (integration.payoutUrl) find('payoutLink').href = integration.payoutUrl;
  find('streamStatus').textContent = {
    delivered: 'Signed delivery verified', awaiting: 'Awaiting signed delivery', disconnected: 'Stream setup pending',
  }[integration.stream];
}

function accept(next) {
  if (!state || next.version > state.version || (next.version === state.version &&
      (next.cutoffPassed !== state.cutoffPassed || next.forecast.status !== state.forecast.status ||
        next.integration?.stream !== state.integration?.stream || next.integration?.payoutUrl !== state.integration?.payoutUrl))) {
    state = next;
    render();
  }
}

function showMessage(message) {
  find('requestMessage').textContent = message;
  find('requestMessage').hidden = !message;
}

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

async function refresh() {
  try {
    accept(await request(statePath));
    if (find('requestMessage').textContent === 'Could not connect to Umbrella. Try again in a moment.') showMessage('');
    if (!staffView && !forecastInitialized) {
      forecastInitialized = true;
      if (state.forecast.status !== 'fresh') void act('forecast');
    }
  } catch {
    if (!runningAction) showMessage('Could not connect to Umbrella. Try again in a moment.');
  }
}

async function act(action) {
  if (runningAction || (exampleView && action !== 'forecast')) return;
  runningAction = action;
  showMessage('');
  render();
  try {
    const path = exampleView ? '/api/event/forecast' : '/api/actions/' + action;
    accept(await request(path, { method: 'POST' }));
  } catch (error) {
    showMessage(action === 'forecast' ? 'Could not refresh the live forecast. Try again in a moment.' : error.message);
  } finally {
    runningAction = null;
    render();
  }
}

for (const [id, action] of Object.entries({
  forecast: 'forecast', replay: 'replay', reset: 'reset', confirm: 'confirm', expire: 'expire', disarm: 'disarm',
})) {
  find(id).addEventListener('click', () => act(action));
}
find('armReplay').addEventListener('click', () => {
  if (window.confirm('Arm the replay to send a real Arc Testnet hold fee?')) act('arm-replay');
});
find('armLive').addEventListener('click', () => {
  if (window.confirm('Arm live weather payments on Arc Testnet? A fresh forecast at the switch point can send the hold fee.')) act('arm-live');
});
find('previewButton').addEventListener('click', () => {
  if (!state) return;
  previewOpen = !previewOpen;
  previewStep = 0;
  renderPreview();
});
find('previewAdvance').addEventListener('click', () => {
  if (previewStep < 2) previewStep++;
  renderPreview();
});

document.body.dataset.view = exampleView ? 'example' : staffView ? 'venue' : 'escrow';
if (exampleView) {
  find('bookingDetails').hidden = true;
  find('venueFooter').hidden = true;
} else {
  document.title = `${staffView ? 'Venue staff' : 'Arc escrow demo'} · Umbrella`;
  for (const id of ['eventSource', 'preview']) find(id).hidden = true;
  find('organizerNav').hidden = false;
  find('eyebrow').textContent = 'Arc Testnet · Escrow demo';
  find('heading').textContent = staffView ? 'Venue staff' : 'Arc escrow demo';
  find('outdoorName').textContent = 'Outdoor demo site';
  find('outdoorDetail').textContent = 'Test booking';
  find('indoorName').textContent = 'Indoor demo site';
  find('indoorDetail').textContent = 'Test booking';
  if (staffView) {
    for (const id of ['forecastCard', 'outdoorCard', 'switchPoint', 'demoPanel', 'venueFooter']) find(id).hidden = true;
    find('planHeading').textContent = 'Test booking request';
  }
}
refresh();
window.setInterval(refresh, 1250);
