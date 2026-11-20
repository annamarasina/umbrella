# Umbrella

**Hold an indoor backup before you decide to move your outdoor event.**

Umbrella watches the forecast during your event hours. When rain reaches your threshold, the organizer's authorized escrow can pay a small fee to hold an indoor venue. The organizer decides whether to move and pay the balance.

Our example is the [UBC Pickleball Cup](https://luma.com/jcvyakxc) at **Whitaker Courts**. Umbrella shows a **70%** rain threshold and suggests **Austin Pickle Ranch** as an indoor backup. The venue switch is simulated.

## How it works

1. **Forecast.** Umbrella uses the National Weather Service hourly forecast. An incomplete or stale forecast pauses automatic payments.
2. **Escrow.** A separate Arc Testnet booking holds **0.90 test USDC**. A one-time hold pays **0.15** to the fixed recipient before the cutoff. Confirming pays the remaining **0.75**. Expiry returns any unpaid funds to the organizer.
3. **Confirmation.** QuickNode Streams filters Arc Testnet **Logs** for the escrow's `HoldPaid` event. Umbrella verifies the signed webhook and finalized Arc receipt before showing **Room held**.

The hold fee compensates the venue for setting space aside. Real use relies on an authorized signer, forecast accuracy, and prior agreement with the venue.

## Verified on testnet

- **Arc escrow** — [0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097](https://explorer.testnet.arc.io/address/0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097) · [Finalized hold payout](https://explorer.testnet.arc.io/tx/0xd1682bd673f2bb18e17e660400cbbc4a2637dbf1936595d0fce0f8f8baa2285f)
- **QuickNode** — A signed dashboard test forwarded that real payout event and switched Umbrella to **Room held**.

[Developer setup](docs/setup.md)
