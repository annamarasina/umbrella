import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ContractFactory, Interface, getCreateAddress, parseEther, keccak256 } from 'ethers';
import { sampleWindow } from '../forecast.mjs';
import { artifactUrl } from './compile.mjs';
import { CHAIN_ID, EXPLORER, connect, showTx, waitForSuccess } from './arc-setup.mjs';

const directory = '.standby';
const intentPath = directory + '/deployment.json';

async function deploy() {
  const [connection, artifactText] = await Promise.all([connect(), readFile(artifactUrl, 'utf8')]);
  const { provider, organizer, venue, rpcUrl } = connection;
  const { abi, bytecode } = JSON.parse(artifactText);
  const organizerBalance = await provider.getBalance(organizer.address);
  let deployment;
  try {
    deployment = JSON.parse(await readFile(intentPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!deployment) {
    if (organizerBalance <= parseEther('0.90')) throw new Error('Fund the organizer with Arc Testnet USDC for the deposit and gas.');
    const window = sampleWindow(Date.now());
    window.cutoff = process.env.STANDBY_ESCROW_CUTOFF || window.cutoff;
    const cutoff = Date.parse(window.cutoff);
    if (!Number.isFinite(cutoff) || cutoff <= Date.now() || cutoff > Date.parse(window.startsAt) || cutoff % 1000) {
      throw new Error('Set a future cutoff before the event starts, with second precision.');
    }
    const nonce = await provider.getTransactionCount(organizer.address, 'pending');
    const factory = new ContractFactory(abi, bytecode, organizer);
    const request = await factory.getDeployTransaction(venue, cutoff / 1000);
    const transaction = await organizer.populateTransaction({ ...request, nonce, chainId: CHAIN_ID });
    if (organizerBalance < parseEther('0.90') + transaction.gasLimit * (transaction.maxFeePerGas ?? transaction.gasPrice)) {
      throw new Error('Organizer balance is too low for the deposit and estimated deployment gas.');
    }
    const raw = await organizer.signTransaction(transaction);
    deployment = {
      chainId: CHAIN_ID, organizer: organizer.address, venue, window,
      address: getCreateAddress({ from: organizer.address, nonce }),
      hash: keccak256(raw),
      holdTopic: new Interface(abi).getEvent('HoldPaid').topicHash,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(intentPath, JSON.stringify(deployment, null, 2) + '\n', { flag: 'wx' });
    showTx('Deployment transaction:', deployment.hash);
    await provider.broadcastTransaction(raw);
  }
  if (deployment.organizer !== organizer.address || deployment.venue !== venue) {
    throw new Error('The saved deployment belongs to different wallets.');
  }
  const receipt = await waitForSuccess(provider, deployment.hash);
  if (receipt.contractAddress !== deployment.address) throw new Error('Unexpected deployed contract address');
  const booking = {
    ...deployment.window, holdFee: 0.15, balance: 0.75,
    arc: { bookingId: deployment.address.toLowerCase(), recipient: venue, asset: 'native', decimals: 18 },
  };
  await writeFile(directory + '/booking.json', JSON.stringify(booking, null, 2) + '\n');
  await writeFile('.env.arc', [
    'STANDBY_ARC_RPC_URL=' + rpcUrl,
    'STANDBY_ESCROW_ADDRESS=' + deployment.address,
    'STANDBY_ESCROW_ABI_PATH=artifacts/StandbyEscrow.json',
    'STANDBY_ESCROW_ADAPTER=escrow-adapter.mjs',
    'STANDBY_PAYMENT_EVENT_ADDRESS=' + deployment.address,
    'STANDBY_PAYMENT_TOPIC0=' + deployment.holdTopic,
    'STANDBY_BOOKING_FILE=' + directory + '/booking.json',
    'STANDBY_DB_PATH=' + directory + '/arc.sqlite',
    'STANDBY_WEBHOOK_PORT=4174',
  ].join('\n') + '\n', { mode: 0o600 });
  const filter = await readFile('stream-filter.js', 'utf8');
  await writeFile(directory + '/quicknode-filter.js', filter
    .replace('REPLACE_WITH_PAYMENT_EVENT_EMITTER', deployment.address)
    .replace('REPLACE_WITH_PAYMENT_EVENT_TOPIC0', deployment.holdTopic));
  console.log('Escrow:', deployment.address, EXPLORER + '/address/' + deployment.address);
  showTx('Deployment confirmed:', deployment.hash);
  console.log('QuickNode filter:', directory + '/quicknode-filter.js');
}

deploy().catch((error) => {
  console.error(error.code ? 'Deployment stopped (' + error.code + '). Check wallet funding and any saved deployment transaction.' : error.message);
  process.exitCode = 1;
});
