import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { Interface, formatEther, parseEther } from 'ethers';
import { connect, showTx } from './arc-setup.mjs';

async function verifyHold() {
  const { provider, venue } = await connect();
  const db = new DatabaseSync(process.env.STANDBY_DB_PATH, { readOnly: true });
  const { payment } = JSON.parse(db.prepare('SELECT state FROM booking WHERE id = 1').get().state);
  db.close();
  if (!payment?.hash) throw new Error('No signed hold transaction in the booking database');

  const escrow = process.env.STANDBY_ESCROW_ADDRESS;
  const receipt = await provider.getTransactionReceipt(payment.hash);
  if (!receipt || receipt.status !== 1 || receipt.to?.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error('No successful receipt for this escrow hold');
  }
  const [canonical, finalized] = await Promise.all([
    provider.getBlock(receipt.blockNumber), provider.getBlock('finalized'),
  ]);
  if (!canonical || !finalized || canonical.hash !== receipt.blockHash || finalized.number < receipt.blockNumber) {
    throw new Error('The escrow hold receipt is awaiting finality');
  }

  const { abi } = JSON.parse(await readFile(process.env.STANDBY_ESCROW_ABI_PATH, 'utf8'));
  const iface = new Interface(abi);
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === escrow.toLowerCase() &&
    entry.topics[0] === iface.getEvent('HoldPaid').topicHash);
  const event = log && iface.parseLog(log);
  if (!event || event.args.recipient !== venue || event.args.amount !== parseEther('0.15')) {
    throw new Error('Receipt does not contain the exact venue hold payment');
  }
  const result = {
    hash: payment.hash,
    status: receipt.status,
    block: receipt.blockNumber,
    escrow,
    event: event.name,
    recipient: venue,
    amount: formatEther(event.args.amount),
    venueBalance: formatEther(await provider.getBalance(venue)),
    escrowBalance: formatEther(await provider.getBalance(escrow)),
  };
  await writeFile('.standby/hold.json', JSON.stringify(result, null, 2) + '\n');
  showTx('Hold payment:', result.hash);
  console.log('Arc block', result.block, '· venue balance', result.venueBalance, '· escrow balance', result.escrowBalance);
}

verifyHold().catch((error) => {
  console.error(error.code ? 'Read-only Arc verification failed (' + error.code + ').' : error.message);
  process.exitCode = 1;
});
