import { chmod, readFile, writeFile } from 'node:fs/promises';
import { Wallet, formatEther } from 'ethers';

const path = '.env.local';
const existing = await readFile(path, 'utf8').catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  return '';
});
const names = ['STANDBY_SIGNER_PRIVATE_KEY', 'STANDBY_VENUE_PRIVATE_KEY'];
const additions = [];
const wallets = names.map((name) => {
  if (Object.hasOwn(process.env, name)) return new Wallet(process.env[name]);
  const wallet = Wallet.createRandom();
  additions.push(name + '=' + wallet.privateKey);
  return wallet;
});
if (additions.length) {
  await writeFile(path, [existing.trimEnd(), ...additions].filter(Boolean).join('\n') + '\n', {
    mode: 0o600,
    flag: existing ? 'w' : 'wx',
  });
}
await chmod(path, 0o600).catch((error) => { if (error.code !== 'ENOENT') throw error; });
console.log('Organizer:', wallets[0].address);
console.log('Venue:    ', wallets[1].address);

const url = process.env.STANDBY_ARC_RPC_URL || 'https://rpc.testnet.arc.network';
async function rpc(method, params = []) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
  const { result } = await response.json();
  if (!response.ok || typeof result !== 'string') throw new Error('RPC read failed');
  return BigInt(result);
}
try {
  const chainId = await rpc('eth_chainId');
  if (chainId !== 5042002n) throw new Error('Arc Testnet required');
  const balances = await Promise.all(wallets.map(({ address }) => rpc('eth_getBalance', [address, 'latest'])));
  console.log('Arc Testnet', chainId.toString(), 'balances in test USDC:', balances.map(formatEther).join(', '));
} catch {
  console.error('Could not verify wallet balances on Arc Testnet.');
  process.exitCode = 1;
}
