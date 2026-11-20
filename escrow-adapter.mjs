import { Contract, Interface, BrowserProvider, Wallet, keccak256, parseEther } from 'ethers';

function clients({ rpc, abi, escrow, signerKey }) {
  const provider = new BrowserProvider({ request: ({ method, params }) => rpc(method, params) });
  const signer = new Wallet(signerKey, provider);
  return { provider, signer, contract: new Contract(escrow, abi, signer) };
}

export async function checkHoldAuthorization(context) {
  const { provider, signer, contract } = clients(context);
  const { booking, escrow, expected } = context;
  const [organizer, venue, cutoff, hold, remainder, status, funded] = await Promise.all([
    contract.organizer(), contract.venue(), contract.cutoff(),
    contract.HOLD_FEE(), contract.BALANCE_DUE(), contract.status(), provider.getBalance(escrow),
  ]);
  return organizer === signer.address && venue.toLowerCase() === expected.recipient &&
    expected.bookingId === escrow && expected.asset === 'native' &&
    hold.toString() === expected.amount && remainder === parseEther(String(booking.balance)) &&
    cutoff === BigInt(Date.parse(booking.cutoff) / 1000) && status === 1n && funded >= hold + remainder;
}

async function signCall(context, method) {
  const { signer, contract } = clients(context);
  const request = await contract[method].populateTransaction();
  const tx = await signer.populateTransaction({ ...request, chainId: context.chainId });
  const rawTransaction = await signer.signTransaction(tx);
  return { hash: keccak256(rawTransaction), rawTransaction };
}

export function signHold(context) {
  return signCall(context, 'releaseHold');
}

export function decodeHoldPayment({ abi, escrow, log }) {
  const decoded = new Interface(abi).parseLog(log);
  if (decoded?.name !== 'HoldPaid') return null;
  return {
    bookingId: escrow, recipient: decoded.args.recipient,
    asset: 'native', amount: decoded.args.amount.toString(),
  };
}

export function signSettlement(context, action) {
  return signCall(context, action);
}

export function decodeSettlement({ abi, expected, booking, signerKey, escrow }, action, receipt) {
  const event = action === 'confirm' ? 'BookingConfirmed' : 'BookingExpired';
  const iface = new Interface(abi);
  const topic = iface.getEvent(event).topicHash;
  const log = receipt.logs.find((entry) => entry.address.toLowerCase() === escrow && entry.topics[0] === topic);
  if (!log) return null;
  const { amount, recipient } = iface.parseLog(log).args;
  const balance = parseEther(String(booking.balance));
  const refundedOrPaid = amount === balance || (action === 'expire' && amount === balance + BigInt(expected.amount));
  const recipientAddress = action === 'confirm' ? expected.recipient : new Wallet(signerKey).address.toLowerCase();
  return refundedOrPaid && recipient.toLowerCase() === recipientAddress ? amount.toString() : null;
}
