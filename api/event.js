import { pickleballEvent } from '../event.mjs';
import { nwsForecast, weatherJson } from '../forecast.mjs';

export async function GET() {
  const forecast = await nwsForecast(pickleballEvent, weatherJson, Date.now, pickleballEvent.coordinates);
  return Response.json({
    event: pickleballEvent,
    booking: { threshold: 70 },
    forecast,
    version: Date.parse(forecast.checkedAt),
  }, {
    headers: {
      'Cache-Control': 'public, max-age=0',
      'Vercel-CDN-Cache-Control': forecast.status === 'fresh' ? 'max-age=30' : 'max-age=5',
    },
  });
}
