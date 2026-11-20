# Umbrella

Umbrella lets outdoor event organizers hold an indoor backup when rain becomes likely. A small escrow payment reserves the space. The organizer can decide later whether to move the event and pay the balance.

The demo uses the [UBC Pickleball Cup](https://luma.com/jcvyakxc) at **Whitaker Courts**, with **Austin Pickle Ranch** as a suggested indoor backup. Umbrella checks the National Weather Service forecast for the event hours against a **70%** rain threshold. The venue switch is simulated, and a separate Arc Testnet booking proves the payment flow.

## Why Umbrella fits the UBC awards

### DeFi and Onchain Applications · Conditional reservation escrow

An organizer pre-funds **0.90 test USDC**. The first authorized hold releases **0.15** to compensate the venue for setting the space aside. The remaining **0.75** stays in escrow until the organizer confirms the booking or the hold expires. On expiry, unpaid funds return to the organizer. This gives the venue a paid commitment and the organizer time to decide. Real bookings depend on venue agreement, forecast accuracy, and an authorized signer.

### Best use of Arc · Enforce the terms and settle in USDC

Arc Testnet holds and pays the funds in native test USDC. Umbrella checks the weather offchain. The deployed escrow enforces the fixed recipient, exact amounts, cutoff, and one-time release. The finalized demo payout sent **0.15 test USDC** and left **0.75** in escrow. [Deployed escrow](https://explorer.testnet.arc.io/address/0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097) · [Finalized payout](https://explorer.testnet.arc.io/tx/0xd1682bd673f2bb18e17e660400cbbc4a2637dbf1936595d0fce0f8f8baa2285f)

### QuickNode Streams · Turn the payment into a venue hold

QuickNode filters **Arc Testnet Logs** for this escrow’s `HoldPaid` event and sends matching logs to Umbrella’s HTTPS webhook. The venue view stays pending until Umbrella verifies the signature and matches the delivery to a finalized Arc receipt. The configured Stream completed a five-block backfill. A signed QuickNode dashboard test delivered the real payout event from block **73209637** and changed the venue view to **Room held**.

[Developer setup and verification details](docs/setup.md)
