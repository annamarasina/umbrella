import { readFile, writeFile } from 'node:fs/promises';
import { Contract, parseEther, keccak256 } from 'ethers';
import { CHAIN_ID, connect, showTx, waitForSuccess } from './arc-setup.mjs';

async function fund() {
  const { provider, organizer, venue } = await connect();
  const { address, hash, window } = JSON.parse(await readFile('.standby/deployment.json', 'utf8'));
  const receipt = await waitForSuccess(provider, hash);
  if (receipt.contractAddress !== address) throw new Error('Unexpected deployed contract address');
  const { abi } = JSON.parse(await readFile(process.env.STANDBY_ESCROW_ABI_PATH, 'utf8'));
  const escrow = new Contract(address, abi, organizer);
  if (await escrow.organizer() !== organizer.address || await escrow.venue() !== venue ||
      await escrow.cutoff() !== BigInt(Date.parse(window.cutoff) / 1000) || await escrow.TOTAL() !== parseEther('0.90')) {
    throw new Error('Onchain escrow terms differ from the saved booking');
  }
  const path = '.standby/funding.json';
  const saved = await readFile(path, 'utf8').then(JSON.parse, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  let fundingHash = saved?.hash;
  if (!fundingHash) {
    if (await escrow.status() !== 0n) throw new Error('Escrow is already funded or settled');
    const funded = await escrow.fund.populateTransaction({ value: parseEther('0.90') });
    const transaction = await organizer.populateTransaction({ ...funded, chainId: CHAIN_ID });
    const raw = await organizer.signTransaction(transaction);
    fundingHash = keccak256(raw);
    await writeFile(path, JSON.stringify({ hash: fundingHash }) + '\n', { flag: 'wx' });
    showTx('Funding transaction:', fundingHash);
    await provider.broadcastTransaction(raw);
  }
  const fundingReceipt = await waitForSuccess(provider, fundingHash);
  const event = fundingReceipt.logs.find((log) => log.address === address &&
    log.topics[0] === escrow.interface.getEvent('Funded').topicHash);
  if (fundingReceipt.to !== address || !event || escrow.interface.parseLog(event).args.amount !== parseEther('0.90')) {
    throw new Error('Could not verify the exact escrow deposit');
  }
  showTx('Funding confirmed:', fundingHash);
  console.log('Escrow balance in native units:', (await provider.getBalance(address)).toString());
}

fund().catch((error) => {
  console.error(error.code ? 'Funding stopped (' + error.code + '). Check wallet funding and any saved funding transaction.' : error.message);
  process.exitCode = 1;
});
