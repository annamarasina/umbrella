const AUSTIN = 'America/Chicago';
const HOUR = 3_600_000;
export const MAX_FORECAST_AGE = 6 * HOUR;
const austinDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: AUSTIN, year: 'numeric', month: '2-digit', day: '2-digit',
});
const austinOffset = new Intl.DateTimeFormat('en-US', {
  timeZone: AUSTIN, timeZoneName: 'longOffset',
});

export function sampleWindow(now) {
  const next = new Date(austinDate.format(now) + 'T12:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  const date = next.toISOString().slice(0, 10);
  const offset = austinOffset.formatToParts(next).find(({ type }) => type === 'timeZoneName').value.slice(3);
  return {
    startsAt: date + 'T14:00:00' + offset,
    endsAt: date + 'T17:00:00' + offset,
    cutoff: date + 'T12:00:00' + offset,
  };
}

export function bookingTerms(config, now) {
  const terms = config ?? sampleWindow(now);
  const timestamps = [terms.cutoff, terms.startsAt, terms.endsAt];
  if (!timestamps.every((value) =>
    typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  )) throw new Error('Booking timestamps require ISO 8601 dates with explicit offsets');
  const [cutoff, start, end] = timestamps.map(Date.parse);
  if (cutoff > start || end <= start || end - start > 24 * HOUR) {
    throw new Error('Booking requires cutoff ≤ start < end and at most 24 event hours');
  }
  const holdFee = terms.holdFee ?? 0.15;
  const balance = terms.balance ?? 0.75;
  if (![holdFee, balance].every((amount) => Number.isFinite(amount) && amount > 0)) {
    throw new Error('Booking amounts must be positive USDC values');
  }
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    cutoff: new Date(cutoff).toISOString(),
    threshold: 70,
    holdFee,
    balance,
    arc: terms.arc ?? null,
  };
}

export function eventHours(booking, valueForHour = () => null) {
  const firstHour = Math.floor(Date.parse(booking.startsAt) / HOUR) * HOUR;
  const hours = [];
  for (let time = firstHour; time < Date.parse(booking.endsAt); time += HOUR) {
    hours.push({ start: new Date(time).toISOString(), probability: valueForHour(time, hours.length) });
  }
  return hours;
}

export function replayForecast(booking, now) {
  const probabilities = [54, 78, 72];
  const hours = eventHours(booking, (_, i) => probabilities.length > i ? probabilities[i] : 54);
  if (hours.length === 1) hours[0].probability = 78;
  return { status: 'replay', hours, checkedAt: new Date(now).toISOString() };
}

export function isFresh(forecast, now) {
  const age = now - Date.parse(forecast.updatedAt);
  return age >= 0 && age <= MAX_FORECAST_AGE;
}

export async function nwsForecast(booking, fetchJson, clock = Date.now, coordinates = [30.2672, -97.7431]) {
  try {
    const point = await fetchJson(`https://api.weather.gov/points/${coordinates.join(',')}`);
    const url = new URL(point.properties.forecastHourly);
    if (url.origin !== 'https://api.weather.gov') throw new Error('Unexpected forecast host');
    const { properties } = await fetchJson(url);
    const now = clock();
    const periods = new Map((properties?.periods ?? []).map((period) => [Date.parse(period.startTime), period]));
    const hours = eventHours(booking, (time) => {
      const period = periods.get(time);
      const value = period?.probabilityOfPrecipitation?.value;
      const requiredEnd = Math.min(time + HOUR, Date.parse(booking.endsAt));
      return Date.parse(period?.endTime) >= requiredEnd && Number.isFinite(value) && value >= 0 && value <= 100
        ? value : null;
    });
    const updatedAt = properties?.updateTime ?? properties?.updated ?? null;
    const forecast = { hours, updatedAt, checkedAt: new Date(now).toISOString() };
    const status = !isFresh(forecast, now) ? 'stale'
      : hours.some(({ probability }) => probability === null) ? 'incomplete' : 'fresh';
    return { ...forecast, status };
  } catch {
    return { status: 'unavailable', hours: eventHours(booking), checkedAt: new Date(clock()).toISOString() };
  }
}

export async function weatherJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/geo+json',
      'User-Agent': process.env.STANDBY_NWS_USER_AGENT || 'Umbrella/0.3 (UBC hackathon prototype)',
    },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('NWS request failed');
  return response.json();
}
