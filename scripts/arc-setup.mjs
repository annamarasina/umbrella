import { Wallet, JsonRpcProvider, FetchRequest, getAddress } from 'ethers';

export const CHAIN_ID = 5042002;
export const RPC_URL = 'https://rpc.testnet.arc.network';
export const EXPLORER = 'https://explorer.testnet.arc.io';

export async function connect(rpcUrl = process.env.STANDBY_ARC_RPC_URL || RPC_URL) {
  if (new URL(rpcUrl).protocol !== 'https:') throw new Error('Use an HTTPS Arc Testnet RPC URL');
  const request = new FetchRequest(rpcUrl);
  request.timeout = 12_000;
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) throw new Error('Arc Testnet required');
  const organizer = new Wallet(process.env.STANDBY_SIGNER_PRIVATE_KEY, provider);
  const venue = getAddress(process.env.STANDBY_ESCROW_VENUE || new Wallet(process.env.STANDBY_VENUE_PRIVATE_KEY).address);
  return { provider, organizer, venue, rpcUrl };
}

export async function waitForSuccess(provider, hash) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== 1) throw new Error('Transaction reverted. Check the Arc Testnet explorer.');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Transaction appears pending. Rerun the command to check the saved hash.');
}

export function showTx(label, hash) {
  console.log(label, EXPLORER + '/tx/' + hash);
}
