# Umbrella

A rain forecast can change in minutes. An organizer needs time to secure indoor space and decide whether to move. Umbrella splits that decision into two steps. A weather threshold can release a small reservation fee from escrow. The organizer confirms the move separately and releases the balance.

The event example is the **UBC Pickleball Cup with Meteora**, Friday, November 20, 2026, **6:00–9:30 p.m. Austin time**. Open play starts at 6 p.m. and the Cup begins at 7 p.m. [Luma event](https://luma.com/jcvyakxc)

- **Current venue** — Whitaker Courts, UT Austin. [UT RecSports](https://www.utrecsports.org/facilities/facility/whitaker-courts)
- **Suggested indoor backup** — Austin Pickle Ranch, Braker location. This is a demo option with unverified availability. [Venue information](https://austinpickleranch.com/plan-a-visit/braker)

## Run locally

Use Node.js 22.13 or newer.

```sh
npm ci
npm start
```

- [Event plan](http://127.0.0.1:4173/) shows the live NWS rain chance for the hours overlapping the Cup, including the final partial hour. **Try rain scenario** walks through a simulated **78%** forecast, court hold and venue switch. It has no booking or payment side effects.
- [Arc escrow demo](http://127.0.0.1:4173/?view=escrow) shows the separate test booking, demo controls, escrow terms and activity. The [staff view](http://127.0.0.1:4173/?view=venue) shows when that test booking is held. Neither the test booking nor its payee represents the Cup or Austin Pickle Ranch.
- **Check live forecast** refreshes NWS. If it fails, prior complete data stays labeled as the last known forecast when available. Forecasts older than six hours or missing an event-hour probability cannot trigger automatic payments. [NWS API](https://www.weather.gov/documentation/services-web-api)

## Architecture and economics

For the event example, the browser requests weather from Umbrella's Node server, which calls the NWS points and hourly endpoints for Whitaker. The rain figure is the maximum hourly probability across the event window. The rain scenario runs in the browser. The live test booking uses a separate SQLite record.

In the test booking, the organizer prepays **0.90 test USDC** on Arc Testnet. The first authorized hold releases **0.15** to the fixed recipient. **0.75** stays in escrow until confirmation or expiry. The hold fee compensates the venue for taking the space off the market. The organizer risks the hold fee and locks the rest of the deposit. If the organizer lets the hold expire, expiry returns the unpaid balance. If no hold was paid, expiry returns the entire deposit.

The server connects fresh weather or an explicitly armed replay to a signed transaction. The escrow enforces the recipient, amount, cutoff and one-time release. A filtered Stream webhook is designed to update the staff view only after signature, booking match and finalized Arc receipt checks. SQLite tracks attempts and deduplicates deliveries. The test relies on a single authorized server signer. Forecasts can be wrong, QuickNode delivery can lag or fail, and an onchain payment confirms a test escrow transfer rather than a real venue agreement. The demo assumes that a real venue would separately agree to the availability, fee and expiry terms.

## Arc Testnet proof

| Value | Verified deployment |
| --- | --- |
| Network | Arc Testnet, chain ID `5042002`, RPC `https://rpc.testnet.arc.network` |
| Organizer and signer | `0x5FEFdFbBf1FeF3E4e072ca055DC125E59b6bf775` |
| Fixed test payee | `0xF9EdE43A313751eAD60c7f57180DC15C1812E45b` |
| Escrow | [0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097](https://explorer.testnet.arc.io/address/0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097) |
| Cutoff | November 21, 2026 at noon Austin time |
| Deploy | [Arc receipt](https://explorer.testnet.arc.io/tx/0x689d0d7d55d901143f80b751b8617c8b7b84e111e52f2a06b4a3d76cdf4508bf) |
| Fund | [0.90 test USDC](https://explorer.testnet.arc.io/tx/0x1129ae3792feef5452326a961fba7ac4bad8ea32586c881921935c92a6ec75cb) |
| Hold payout | [0.15 test USDC at block 73209637](https://explorer.testnet.arc.io/tx/0xd1682bd673f2bb18e17e660400cbbc4a2637dbf1936595d0fce0f8f8baa2285f) |

The deployed source is [StandbyEscrow.sol](contracts/StandbyEscrow.sol). Its existing artifact and transaction identities predate the Umbrella brand. It uses Arc native test USDC with 18 decimals. The finalized payout, venue balance and remaining escrow balance were verified against Arc RPC. Confirmation and expiry/refunds passed local EVM tests. A read-only check against Arc confirmed that a second hold reverts.

To set up a new test booking in a fresh workspace, run `npm run wallets`, fund the organizer with [Circle's faucet](https://faucet.circle.com/) on Arc Testnet, then run:

```sh
npm run compile
npm test
npm run deploy
npm run fund
node --env-file=.env.local --env-file=.env.arc server.mjs --check-arc
npm start
```

Deploy generates `.env.arc`, the booking config, and `.standby/quicknode-filter.js`. Preserve `.standby/` for a booking in flight. Keep `STANDBY_SIGNER_PRIVATE_KEY`, `STANDBY_VENUE_PRIVATE_KEY`, `QUICKNODE_API_KEY` and `STANDBY_QUICKNODE_SECRET` in private, gitignored `.env.local`. Run `npm run verify-hold` to verify the finalized payout and save the backfill block.

## QuickNode Streams

**Signed delivery verified from the QuickNode dashboard.** The **Send Payload** test delivered the filtered onchain event from block **73209637** through the HTTPS tunnel. Umbrella verified the QuickNode signature and finalized Arc receipt, recorded the delivery, and moved the escrow demo to **Room held**. The saved Arc Testnet Logs Stream used the same filter and destination and reached **Completed** for blocks **73209637–73209641**. Umbrella recorded one authenticated delivery from the dashboard test. The saved backfill produced no additional recorded delivery.

1. Add a Streams-enabled API key as `QUICKNODE_API_KEY` in `.env.local`.
2. Start a temporary tunnel with `cloudflared tunnel --url http://127.0.0.1:4174`. This port serves only the webhook. The organizer app stays on port 4173.
3. Run `npm run verify-hold`, then `npm run stream -- prepare https://<tunnel-host>/webhooks/quicknode`. This tests the filter and prepares a paused backfill on **Arc Testnet**, dataset **Logs**, blocks **73209637–73209641**. The filter selects the escrow's `HoldPaid(address,uint256)` event and sends matching logs to the webhook. The Stream token is saved locally.
4. Restart the app to load the token and run `npm run stream -- activate`. The signed event should update the escrow demo and staff view to **Room held** and add the explorer link. The same settings can be entered in the QuickNode dashboard. [QuickNode Streams quickstart](https://www.quicknode.com/docs/streams/quickstart) · [Signature verification](https://www.quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages)

For a new test booking, start its Stream before arming the Arc replay. `STANDBY_ALLOW_ARC_BACKFILL=1` permits an explicitly armed replay before QuickNode is connected. Venue status remains pending until signed backfill delivery.

## Submission focus

Choose **DeFi and Onchain Applications** and **Best use of Arc**. The escrow and payout are verifiable on Arc Testnet. The **QuickNode Streams** bounty requires a configured Stream with a filter and destination as a core data source. Save and run the Stream, and show the signed delivery in the demo. Devpost allows exactly one main track and one optional chain award. A complete submission also needs a public hackathon repository, a working demo, a 2–3 minute accessible video and the requested writeup. [Devpost submission requirements](https://ubc-hackathon-2026.devpost.com/) · [Official rules](https://ubc-hackathon-2026.devpost.com/rules)

### Two-minute demo

1. **0:00–0:30** Set the scene. The Pickleball Cup expects to play outdoors at Whitaker. Open the plan, check the live forecast, and point out the 70% switch point and suggested indoor backup.
2. **0:30–1:15** Open **Try rain scenario**. Cross 70%, simulate the hold and then simulate confirming the move. Explain why reserving the backup and moving the event are separate.
3. **1:15–2:00** Open the live Arc payout beside the escrow terms. Show the 0.15 USDC payment and 0.75 escrow balance. Show the QuickNode-backed **Room held** update in the staff view and explain that the dashboard test replayed a real Arc event.

The [venue art](assets/pickleball-courts.jpg) was created with built-in image generation for illustration.

> Create one photorealistic two-part venue diptych for Umbrella, a pickleball rain-plan web demo. Landscape 3:2 canvas overall, exactly equal left and right photographs with a hard vertical seam halfway, edge to edge, no border. Left is a representative outdoor UT Austin pickleball court complex at Whitaker Courts: blue-green court surface, clear white court lines, a regulation low pickleball net, chain-link fences, trees and tall sports lights, late-afternoon Austin cloudy daylight. Right is a representative indoor pickleball court at an Austin sports venue: blue courts and green surrounds, clear white regulation lines, white top band on low black net, warmly lit athletic warehouse with high exposed steel roof, composed from near court level. Center each scene for separate wide web-card crops. Empty courts, realistic architecture photography, no rain effects, no text, signage, emblems or branding.
