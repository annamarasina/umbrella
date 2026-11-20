# Developer setup

## Run the demo locally

Use Node.js 22.13 or newer.

```sh
npm ci
npm start
```

- [Event plan](http://127.0.0.1:4173/) shows the live National Weather Service forecast for the Pickleball Cup. **Try rain scenario** simulates a 78% forecast, a court hold, and a venue switch without sending a payment.
- [Escrow demo](http://127.0.0.1:4173/?view=escrow) and [staff view](http://127.0.0.1:4173/?view=venue) show the separate test booking. Its payee and terms belong to the test booking.
- `npm test` covers event-window weather, authorization, one-time release, confirmation, refunds, and webhook replay protection.

## Create a separate Arc Testnet booking

Use `npm run wallets` to create local test wallets. Fund the organizer wallet from [Circle's faucet](https://faucet.circle.com/) on **Arc Testnet**.

```sh
npm run compile
npm test
npm run deploy
npm run fund
node --env-file=.env.local --env-file=.env.arc server.mjs --check-arc
npm start
```

Deployment creates `.env.arc`, the booking configuration, and `.standby/quicknode-filter.js`. Keep `.standby/` for any booking in flight. Keep wallet signing keys and QuickNode credentials in the gitignored `.env.local`.

The [Solidity escrow](../contracts/StandbyEscrow.sol) uses native test USDC with 18 decimals. Arc Testnet chain ID is `5042002`. [Demo deployment](https://explorer.testnet.arc.io/tx/0x689d0d7d55d901143f80b751b8617c8b7b84e111e52f2a06b4a3d76cdf4508bf) · [Funding transaction](https://explorer.testnet.arc.io/tx/0x1129ae3792feef5452326a961fba7ac4bad8ea32586c881921935c92a6ec75cb)

## Connect QuickNode Streams

1. Set a Streams-enabled `QUICKNODE_API_KEY` in `.env.local`.
2. Run `cloudflared tunnel --url http://127.0.0.1:4174` to expose the webhook port. The local app serves its browser views on port 4173.
3. For a paid test booking, run `npm run verify-hold`, then `npm run stream -- prepare https://<tunnel-host>/webhooks/quicknode`. This prepares a paused Arc Testnet **Logs** backfill around the verified hold block. Its filter matches the escrow address and `HoldPaid(address,uint256)` topic. The shared signing token is saved as `STANDBY_QUICKNODE_SECRET` in `.env.local`.
4. Restart the app to load the token, then run `npm run stream -- activate`. The same settings can be entered in the QuickNode dashboard. An accepted delivery verifies the HMAC, booking match, and finalized Arc receipt before updating the staff view.

The verified demo used a dashboard **Send Payload** test for Arc block **73209637**. Umbrella accepted one authenticated delivery and showed **Room held**. The saved Stream completed the **73209637–73209641** backfill without an additional recorded delivery. [QuickNode setup](https://www.quicknode.com/docs/streams/quickstart)

For a new test booking, have a Stream ready before arming Arc replay. `STANDBY_ALLOW_ARC_BACKFILL=1` permits an explicitly armed replay while the Stream is being set up. The venue status stays pending until a signed event arrives.
