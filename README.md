# Umbrella

Umbrella helps outdoor event organizers reserve an indoor backup when rain becomes likely. The venue gets paid to set the space aside, and the organizer can decide whether to move closer to the event.

## Why I built it

The [UBC Pickleball Cup](https://luma.com/jcvyakxc) made the problem concrete for me. The tournament was scheduled outdoors at **Whitaker Courts** in Austin. If rain looked likely that evening, how would an organizer find enough indoor courts in time? Paying for the full backup in advance could leave them paying for courts they never used. Waiting could mean the courts were taken. I wanted the organizer to be able to reserve the option early and make the final call closer to play.

## What it would look like

Say indoor courts at **Austin Pickle Ranch** cost **900 USDC** for the evening. These are illustrative prices.

1. The organizer sets aside **900 USDC** and chooses a **70%** rain threshold.
2. If the National Weather Service forecast reaches 70% in any event hour, Umbrella releases **150 USDC** to hold the indoor courts.
3. If the organizer moves the event, the venue receives the remaining **750 USDC**. If the organizer stays outdoors and lets the hold expire, the venue keeps the **150 USDC** hold fee and the organizer gets **750 USDC** back.

## Why Umbrella fits the UBC awards

- **DeFi and Onchain Applications.** The escrow makes a conditional reservation possible. The venue earns a fee for taking courts off the market, and the organizer only commits the balance when they confirm. Real use depends on venue agreement, forecast accuracy, and an authorized signer.
- **Best use of Arc.** The escrow holds and settles native USDC. It enforces the agreed recipient, amounts, deadline, and one-time release. I verified the hold payout on a separate, scaled-down test booking. [Arc Testnet escrow](https://explorer.testnet.arc.io/address/0x5da4E93bB8B36ff909B57B038F94Bb7dE9964097) · [Finalized payout](https://explorer.testnet.arc.io/tx/0xd1682bd673f2bb18e17e660400cbbc4a2637dbf1936595d0fce0f8f8baa2285f)
- **QuickNode Streams.** QuickNode filters **Arc Testnet Logs** for the escrow’s `HoldPaid` event and forwards it to Umbrella’s HTTPS webhook. The venue sees **Room held** only after Umbrella verifies the signed delivery and matches it to a finalized receipt. A signed QuickNode dashboard test delivered the real payout event from block **73209637**.

[Developer setup and verification details](docs/setup.md)
