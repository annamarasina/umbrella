import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { replayForecast } from '../forecast.mjs';

const output = new URL('../public/', import.meta.url);
await mkdir(output, { recursive: true });
const source = new URL('../', import.meta.url);

// Only browser assets and public, previously verified transaction evidence go into the site output.
for (const file of ['style.css', 'app.js']) {
  await copyFile(new URL(file, source), new URL(file, output));
}
const html = await readFile(new URL('index.html', source), 'utf8');
await writeFile(new URL('index.html', output), html.replace('<head>', '<head>\n  <meta name="umbrella-hosted" content="true">'));
await cp(new URL('assets/', source), new URL('assets/', output), { recursive: true });

const booking = {
  startsAt: '2026-11-21T20:00:00.000Z',
  endsAt: '2026-11-21T23:00:00.000Z',
  cutoff: '2026-11-21T18:00:00.000Z',
  threshold: 70,
  holdFee: 0.15,
  balance: 0.75,
};
const { hours } = replayForecast(booking, Date.now());
await writeFile(new URL('testnet-demo.json', output), JSON.stringify({
  version: 1,
  booking,
  forecast: { status: 'replay', hours },
  mode: 'arc-replay',
  phase: 'held',
  paymentReceiptSeen: true,
  activity: [
    { text: 'Illustrative forecast replay reached 78%, crossing the 70% switch point.' },
    { text: 'Arc Testnet finalized the 0.15 test USDC hold payout.' },
    {
      text: 'A signed QuickNode Streams dashboard test delivered the matching HoldPaid event. Umbrella marked the room held.',
      txUrl: 'https://explorer.testnet.arc.io/tx/0xd1682bd673f2bb18e17e660400cbbc4a2637dbf1936595d0fce0f8f8baa2285f',
    },
  ],
}));
