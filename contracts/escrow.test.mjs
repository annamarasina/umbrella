import assert from 'node:assert/strict';
import { test } from 'node:test';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { compile } from '../scripts/compile.mjs';

const HOLD = parseEther('0.15');
const BALANCE = parseEther('0.75');
const TOTAL = HOLD + BALANCE;
const artifact = await compile();

async function fixture(t) {
  const chain = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } });
  t.after(() => chain.disconnect());
  const provider = new BrowserProvider(chain, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  const [organizer, venue, caller] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const latest = await provider.getBlock('latest');
  const cutoff = latest.timestamp + 300;
  const escrow = await new ContractFactory(artifact.abi, artifact.bytecode, organizer).deploy(venue.address, cutoff);
  await escrow.waitForDeployment();
  const balance = async (address) => BigInt(await provider.send('eth_getBalance', [address, 'latest']));
  const advanceToCutoff = async () => {
    await provider.send('evm_setTime', [cutoff * 1000]);
    await provider.send('evm_mine', []);
    assert.equal((await provider.getBlock('latest')).timestamp, cutoff);
  };
  const fund = async () => (await escrow.fund({ value: TOTAL })).wait();
  return { escrow, organizer, venue, caller, balance, fund, advanceToCutoff };
}

test('only the organizer can fund and release one fixed hold, then confirm the remaining balance', async (t) => {
  const { escrow, venue, caller, balance, fund } = await fixture(t);
  const address = await escrow.getAddress();
  const before = await balance(venue.address);
  await assert.rejects(escrow.releaseHold.staticCall());
  await assert.rejects(escrow.confirm.staticCall());
  await assert.rejects(escrow.connect(caller).fund.staticCall({ value: TOTAL }));
  await assert.rejects(escrow.fund.staticCall({ value: TOTAL - 1n }));
  await fund();
  assert.equal(await balance(address), TOTAL);
  await assert.rejects(escrow.fund.staticCall({ value: TOTAL }));
  await assert.rejects(escrow.connect(caller).releaseHold.staticCall());
  await assert.rejects(escrow.expire.staticCall());
  const receipt = await (await escrow.releaseHold()).wait();
  const event = escrow.interface.parseLog(receipt.logs[0]);
  assert.equal(event.name, 'HoldPaid');
  assert.equal(event.args.recipient, venue.address);
  assert.equal(event.args.amount, HOLD);
  assert.equal(await balance(venue.address), before + HOLD);
  assert.equal(await balance(address), BALANCE);
  await assert.rejects(escrow.releaseHold.staticCall());
  await assert.rejects(escrow.connect(caller).confirm.staticCall());
  await (await escrow.confirm()).wait();
  assert.equal(await balance(venue.address), before + TOTAL);
  assert.equal(await balance(address), 0n);
  await assert.rejects(escrow.confirm.staticCall());
});

for (const held of [false, true]) {
  test(held ? 'expiry keeps the paid hold and refunds only the unpaid balance' : 'expiry refunds the full amount before a hold', async (t) => {
    const { escrow, organizer, venue, caller, balance, fund, advanceToCutoff } = await fixture(t);
    const venueBefore = await balance(venue.address);
    await fund();
    if (held) await (await escrow.releaseHold()).wait();
    await advanceToCutoff();
    await assert.rejects(escrow.releaseHold.staticCall());
    await assert.rejects(escrow.confirm.staticCall());
    const beforeRefund = await balance(organizer.address);
    const receipt = await (await escrow.connect(caller).expire()).wait();
    const event = escrow.interface.parseLog(receipt.logs[0]);
    assert.equal(event.name, 'BookingExpired');
    assert.equal(event.args.recipient, organizer.address);
    assert.equal(event.args.amount, held ? BALANCE : TOTAL);
    assert.equal(await balance(organizer.address), beforeRefund + (held ? BALANCE : TOTAL));
    assert.equal(await balance(venue.address), venueBefore + (held ? HOLD : 0n));
    assert.equal(await balance(await escrow.getAddress()), 0n);
    await assert.rejects(escrow.expire.staticCall());
  });
}
