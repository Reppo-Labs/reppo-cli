/**
 * Maps Reppo's custom error selectors to stable string codes the CLI emits
 * to stderr. These are documented selectors discovered via on-chain trace
 * + brute-force keccak match. The string codes are the public contract —
 * agent skill recipes match on them.
 */

interface DecodedError {
  code: string;
  hint?: string;
}

const SELECTORS: Record<string, DecodedError> = {
  '0xcabeb655': {
    code: 'INSUFFICIENT_VOTING_POWER',
    hint: 'The voter must lock REPPO into veReppo first. Run `reppo lock <amount> --duration 7200`.',
  },
  '0x5bdedc41': {
    code: 'PUBLISHER_LACKS_SUBNET_ACCESS',
    hint: 'Grant subnet access to the publisher: `reppo grant-access --subnet <id>`.',
  },
  // Voter-vs-publisher revert observed but not yet name-matched. Keep the
  // raw selector here so the hint still helps even without the name.
  '0x11e43eec': {
    code: 'VOTE_REJECTED_PRECONDITION',
    hint: 'Vote was rejected by an unidentified precondition. Common causes: voter is the pod publisher (publishers cannot vote on their own pods), or voting window has closed for that epoch.',
  },
  '0xfb8f41b2': {
    code: 'INSUFFICIENT_ALLOWANCE',
    hint: 'Approve the spender first. The CLI normally handles this — re-run with --debug to inspect.',
  },
};

/**
 * Decode a custom error from a viem revert message. Returns the structured
 * code if known, else returns the raw selector as the code so agents can
 * still match on it.
 */
export function decodeRevert(err: unknown): DecodedError {
  const msg = err instanceof Error ? err.message : String(err);
  const firstLine = msg.split('\n')[0] ?? msg;
  const match = msg.match(/0x[0-9a-fA-F]{8}/);
  const selector = match?.[0]?.toLowerCase();
  if (!selector) {
    return { code: 'REVERT', hint: firstLine };
  }
  const known = SELECTORS[selector];
  if (known) return known;
  return { code: `UNKNOWN_REVERT_${selector}`, hint: firstLine };
}
