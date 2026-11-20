// Set both values from the inspected deployment and payment event before deploying this filter.
function main(stream) {
  const address = 'REPLACE_WITH_PAYMENT_EVENT_EMITTER'.toLowerCase();
  const topic = 'REPLACE_WITH_PAYMENT_EVENT_TOPIC0'.toLowerCase();
  const logs = [];

  // QuickNode's EVM Logs dataset is grouped by block and receipt.
  for (const log of (stream.data ?? []).flat(2)) {
    if (log?.address?.toLowerCase() === address && log.topics?.[0]?.toLowerCase() === topic && !log.removed) {
      logs.push(log);
    }
  }

  return logs.length ? { logs } : null;
}
