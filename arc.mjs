import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { formatUnits, parseUnits } from 'ethers';

const CHAIN_ID = 5042002;
const address = /^0x[\da-f]{40}$/i;
const hash = /^0x[\da-f]{64}$/i;
const bytes = /^0x(?:[\da-f]{2})+$/i;
const lower = (value) => typeof value === 'string' ? value.toLowerCase() : '';

export function missingArcSettings(env, booking) {
  const missing = [
    'STANDBY_ARC_RPC_URL', 'STANDBY_ESCROW_ADDRESS', 'STANDBY_PAYMENT_EVENT_ADDRESS', 'STANDBY_PAYMENT_TOPIC0',
    'STANDBY_ESCROW_ABI_PATH', 'STANDBY_ESCROW_ADAPTER', 'STANDBY_SIGNER_PRIVATE_KEY',
  ].filter((name) => !env[name]);
  if (!booking?.arc) missing.push('STANDBY_BOOKING_FILE with funded Arc booking terms');
  return missing;
}

export async function loadArc(env, booking) {
  if (missingArcSettings(env, booking).length) return null;
  const { STANDBY_ARC_RPC_URL: rpcUrl, STANDBY_ESCROW_ADDRESS: escrow,
    STANDBY_PAYMENT_EVENT_ADDRESS: emitter, STANDBY_PAYMENT_TOPIC0: topic,
    STANDBY_ESCROW_ABI_PATH: abiPath, STANDBY_ESCROW_ADAPTER: adapterPath,
    STANDBY_SIGNER_PRIVATE_KEY: signerKey } = env;

  const { bookingId, recipient, asset, decimals } = booking.arc;
  if (new URL(rpcUrl).protocol !== 'https:' || !address.test(escrow) || !address.test(emitter) ||
      !hash.test(topic) || !hash.test(signerKey) || typeof bookingId !== 'string' || !bookingId ||
      !address.test(recipient) || !(asset === 'native' || address.test(asset)) ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('Invalid Arc deployment, signer, or booking configuration');
  }

  const artifact = JSON.parse(await readFile(abiPath, 'utf8'));
  const abi = Array.isArray(artifact) ? artifact : artifact.abi;
  const adapter = await import(pathToFileURL(adapterPath));
  if (!Array.isArray(abi) || !abi.length ||
      !['checkHoldAuthorization', 'signHold', 'decodeHoldPayment'].every((name) => typeof adapter[name] === 'function')) {
    throw new Error('escrow ABI and reviewed Standby adapter are required');
  }

  const amount = parseUnits(String(booking.holdFee), decimals).toString();
  const expected = { bookingId, recipient: lower(recipient), asset: lower(asset), amount };
  const binding = { escrow: lower(escrow), address: lower(emitter), topic: lower(topic) };
  const sameEvent = (log) => lower(log?.address) === binding.address && lower(log?.topics?.[0]) === binding.topic;
  const context = { rpc, abi, escrow: binding.escrow, booking, expected };

  async function rpc(method, params = []) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(7000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Arc RPC unavailable');
    const data = await response.json();
    if (data.error || !Object.hasOwn(data, 'result')) throw new Error('Arc RPC request failed');
    return data.result;
  }

  async function assertNetwork() {
    if (Number(await rpc('eth_chainId')) !== CHAIN_ID) throw new Error('Arc Testnet required');
  }

  async function check() {
    await assertNetwork();
    if (!bytes.test(await rpc('eth_getCode', [binding.escrow, 'latest']))) {
      throw new Error('escrow not deployed');
    }
    if (await adapter.checkHoldAuthorization({ ...context, signerKey }) !== true) {
      throw new Error('escrow hold authorization does not match this booking');
    }
  }

  function checkedSignature(signed) {
    if (!hash.test(signed?.hash) || !bytes.test(signed?.rawTransaction)) {
      throw new Error('Invalid signed transaction');
    }
    return { hash: lower(signed.hash), rawTransaction: signed.rawTransaction };
  }

  const signerContext = { ...context, signerKey, chainId: CHAIN_ID };
  async function prepareHold() {
    await check();
    return checkedSignature(await adapter.signHold(signerContext));
  }

  async function broadcast({ hash: expectedHash, rawTransaction }, deadline) {
    await assertNetwork();
    if (Date.now() >= deadline) throw new Error('Payment authorization window ended');
    if (lower(await rpc('eth_sendRawTransaction', [rawTransaction])) !== expectedHash) {
      throw new Error('Arc returned a different transaction hash');
    }
  }

  async function verify(log, payment) {
    if (!sameEvent(log) || log.removed || lower(log.transactionHash) !== payment.hash ||
        !hash.test(log.blockHash) || !/^0x[\da-f]+$/i.test(log.logIndex)) return false;

    await assertNetwork();
    const receipt = await rpc('eth_getTransactionReceipt', [payment.hash]);
    if (!receipt) throw new Error('Waiting for Arc receipt');
    if (receipt.status !== '0x1' || lower(receipt.transactionHash) !== payment.hash ||
        lower(receipt.to) !== binding.escrow || lower(receipt.blockHash) !== lower(log.blockHash)) return false;

    const [block, finalized] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
      rpc('eth_getBlockByNumber', ['finalized', false]),
    ]);
    if (!block || !finalized || BigInt(finalized.number) < BigInt(receipt.blockNumber)) {
      throw new Error('Waiting for Arc finality');
    }
    const timestamp = Number(block.timestamp) * 1000;
    if (lower(block.hash) !== lower(receipt.blockHash) || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
        timestamp >= Date.parse(booking.cutoff)) return false;

    const canonical = receipt.logs.find((entry) => sameEvent(entry) &&
      lower(entry.logIndex) === lower(log.logIndex) && lower(entry.data) === lower(log.data) &&
      entry.topics.map(lower).join(',') === log.topics.map(lower).join(','));
    if (!canonical) return false;
    const decoded = await adapter.decodeHoldPayment({ ...context, log: canonical, receipt });
    return decoded?.bookingId === expected.bookingId && lower(decoded.recipient) === expected.recipient &&
      lower(decoded.asset) === expected.asset && decoded.amount === expected.amount;
  }

  async function receiptStatus(txHash) {
    const receipt = await rpc('eth_getTransactionReceipt', [txHash]);
    if (!receipt || lower(receipt.transactionHash) !== txHash || lower(receipt.to) !== binding.escrow) return null;
    if (receipt.status === '0x0') return 'reverted';
    return receipt.status === '0x1' ? receipt : null;
  }

  const supportsSettlement = typeof adapter.signSettlement === 'function' && typeof adapter.decodeSettlement === 'function';

  async function prepareSettlement(action) {
    await assertNetwork();
    return checkedSignature(await adapter.signSettlement(signerContext, action));
  }

  async function settleResult(txHash, action) {
    await assertNetwork();
    const receipt = await receiptStatus(txHash);
    if (!receipt || receipt === 'reverted') return receipt;
    const [block, finalized] = await Promise.all([
      rpc('eth_getBlockByNumber', [receipt.blockNumber, false]),
      rpc('eth_getBlockByNumber', ['finalized', false]),
    ]);
    if (!block || !finalized || lower(block.hash) !== lower(receipt.blockHash) ||
        BigInt(finalized.number) < BigInt(receipt.blockNumber)) return null;
    const amount = await adapter.decodeSettlement(signerContext, action, receipt);
    if (amount === null) throw new Error('Missing escrow settlement event');
    return { amount: String(Number(formatUnits(amount, decimals))) };
  }

  return { binding, check, prepareHold, broadcast, verify, receiptStatus, supportsSettlement, prepareSettlement, settleResult };
}

export function transactionLink(hashValue) {
  return hash.test(hashValue) ? 'https://explorer.testnet.arc.io/tx/' + lower(hashValue) : null;
}
