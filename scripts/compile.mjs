import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const artifactUrl = new URL('../artifacts/StandbyEscrow.json', import.meta.url);

export async function compile() {
  const source = await readFile(new URL('../contracts/StandbyEscrow.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'StandbyEscrow.sol': { content: source } },
    settings: {
      evmVersion: 'shanghai',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length) throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  const { abi, evm } = output.contracts['StandbyEscrow.sol'].StandbyEscrow;
  return { abi, bytecode: '0x' + evm.bytecode.object, compiler: solc.version() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = await compile();
  await mkdir(new URL('.', artifactUrl), { recursive: true });
  await writeFile(artifactUrl, JSON.stringify(artifact, null, 2) + '\n');
  console.log('Compiled StandbyEscrow using Solidity ' + artifact.compiler);
}
