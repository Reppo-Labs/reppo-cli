/**
 * Maps Reppo's custom error selectors to stable string codes the CLI emits
 * to stderr. The string codes are the public contract — agent skill
 * recipes match on them.
 *
 * Selectors are extracted via viem's typed error walker (BaseError.walk
 * + ContractFunctionRevertedError) — NOT a regex over the message string.
 * A regex would misread the first 4-byte chunk of any contract address
 * embedded in viem's formatted message (e.g. "Contract Call: address: 0xcfF…")
 * as the custom-error selector and return a bogus UNKNOWN_REVERT code.
 */
import { BaseError, ContractFunctionRevertedError } from 'viem';

interface DecodedError {
  code: string;
  hint?: string;
}

const SELECTORS: Record<string, DecodedError> = {
  '0xcabeb655': {
    code: 'INSUFFICIENT_VOTING_POWER',
    hint: 'Lock REPPO into veReppo first: `reppo lock <amount> --duration <seconds>` (see `reppo lock --help` for the network-specific minimum).',
  },
  '0x5bdedc41': {
    code: 'PUBLISHER_LACKS_SUBNET_ACCESS',
    hint: 'Grant subnet access to the publisher: `reppo grant-access --subnet <id>`.',
  },
  // Voter-vs-publisher revert observed but not yet name-matched. Keep
  // the raw selector here so the hint still helps even without the name.
  '0x11e43eec': {
    code: 'VOTE_REJECTED_PRECONDITION',
    hint: 'Vote was rejected by an unidentified precondition. Common causes: voter is the pod publisher (publishers cannot vote on their own pods), or the voting window has closed for that epoch.',
  },
  '0xfb8f41b2': {
    code: 'INSUFFICIENT_ALLOWANCE',
    hint: 'Approve the spender first. Most write commands handle this automatically once implemented; for the alpha you may need to send approve() manually.',
  },
};

/**
 * Decode a revert from a viem error. Walks the error chain looking for
 * a ContractFunctionRevertedError and pulls the selector from its
 * structured `data` (or `signature`). Returns the known code if we have
 * one for it, else returns UNKNOWN_REVERT_<selector> so agents can still
 * key off the raw selector.
 */
export function decodeRevert(err: unknown): DecodedError {
  const fallback = (msg: string): DecodedError => ({
    code: 'REVERT',
    hint: msg.split('\n')[0] ?? msg,
  });

  if (!(err instanceof BaseError)) {
    return fallback(err instanceof Error ? err.message : String(err));
  }

  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as
    | ContractFunctionRevertedError
    | null;
  if (!reverted) return fallback(err.shortMessage ?? err.message);

  // viem populates `data.errorName` for known errors and `signature` for
  // unknown selectors. We always want the 4-byte selector itself so the
  // SELECTORS map is the single source of truth.
  const data = (reverted as unknown as { data?: { errorName?: string; args?: readonly unknown[] } }).data;
  const sig = (reverted as unknown as { signature?: `0x${string}` }).signature;
  const raw = (reverted as unknown as { raw?: `0x${string}` }).raw;
  const selector = (sig ?? raw?.slice(0, 10) ?? '').toLowerCase();

  if (!selector) {
    return {
      code: data?.errorName ? `REVERT_${data.errorName.toUpperCase()}` : 'REVERT',
      hint: reverted.shortMessage,
    };
  }

  const known = SELECTORS[selector];
  if (known) return known;
  return {
    code: data?.errorName ? `REVERT_${data.errorName.toUpperCase()}` : `UNKNOWN_REVERT_${selector}`,
    hint: reverted.shortMessage,
  };
}
