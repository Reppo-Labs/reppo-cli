/**
 * `reppo query datanet <datanetId> [--for <address>]` — show whether a
 * datanet exists, its REPPO access fee, and (optionally) whether a given
 * address has access.
 *
 * "Datanet" is Reppo's user-facing term; on-chain the same concept is
 * called a "subnet" (SubnetManager, validSubnet, hasSubnetAccess). The
 * CLI uses the user-facing term at its surface and translates internally.
 *
 * Resolution order for the access check:
 *   1. --for <addr>            (explicit, no key needed)
 *   2. REPPO_PRIVATE_KEY       (derived from env)
 *   3. neither set              → callerAccess omitted from output
 *
 * If subnet manager is TBD on the chosen network (mainnet today), every
 * field emits `{ unavailable: "<reason>" }` rather than a misleading
 * default.
 */
import { Option } from 'clipanion';
import { formatUnits, isAddress, type Address } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { BaseCommand } from '../_base.js';
import { cliError, emit } from '../../output/format.js';
import { createReadClient } from '../../chain/clients.js';
import { trySubnetManager, tryVeReppo, erc20 } from '../../chain/contracts.js';
import { DEFAULT_PUBLIC_API_URL } from '../../api/public.js';
import { fetchSubnetByTokenId, numericToString, type RawSubnet } from '../../api/subnets.js';

type Numeric = { raw: string; formatted: string } | { unavailable: string };

/** Off-chain catalog metadata, or a reason it couldn't be resolved. */
type Metadata =
  | {
      subnetUuid: string;
      name: string;
      description: string;
      status: string;
      nativeToken: { address: string; symbol: string; decimals: number };
      emissionsPerEpochREPPO: string;
      emissionsPerEpochPrimaryToken: string;
      upVoteVolume: string;
      downVoteVolume: string;
      onboardingPublishers: string;
      onboardingVoters: string;
      thumbnailUrl: string;
      isABTestingSubnet: boolean;
    }
  | { unavailable: string };

function unavailable(reason: string): { unavailable: string } {
  return { unavailable: reason };
}

export class QueryDatanetCommand extends BaseCommand {
  static override paths = [['query', 'datanet']];

  static override usage = BaseCommand.Usage({
    description: 'Show datanet validity, REPPO access fee, and (optionally) whether an address has access.',
    examples: [
      ['Inspect datanet 19',
        'reppo query datanet 19'],
      ['Check whether a specific address has access',
        'reppo query datanet 19 --for 0x726c…E31d'],
      ['JSON output for an agent',
        'reppo query datanet 19 --json'],
    ],
  });

  datanet = Option.String({ required: true });
  for_ = Option.String('--for', { description: 'Address to check access for (defaults to address derived from REPPO_PRIVATE_KEY)' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();

      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      // Off-chain catalog metadata (name, description, token, emissions,
      // onboarding). Best-effort: a catalog outage or a datanet absent from
      // the public catalog must NOT break the authoritative on-chain answer.
      const metadata = await this.fetchMetadata(datanetId.toString());

      const client = createReadClient({ network: cfg.network, ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}) });
      const sm = trySubnetManager(cfg.network);

      if (!sm) {
        const reason = `Datanet manager address not configured for ${cfg.network}.`;
        emit(
          {
            datanetId: datanetId.toString(),
            network: cfg.network,
            valid: unavailable(reason),
            accessFeeREPPO: unavailable(reason),
            metadata,
          },
          [
            `Datanet:       ${datanetId}`,
            `Network:       ${cfg.network}`,
            `(on-chain unavailable: ${reason})`,
            ...this.metadataLines(metadata),
          ],
        );
        return 0;
      }

      // On-chain function names use the legacy "subnet" naming; CLI surface uses datanet.
      const valid: boolean = await client.readContract({ ...sm, functionName: 'validSubnet', args: [datanetId] });

      // Best-effort current epoch (veReppo is the protocol's epoch time-base).
      // Surfaced so callers don't need a second `query epoch` round-trip; a
      // null here never affects the authoritative validity/fee answer.
      const ve = tryVeReppo(cfg.network);
      let currentEpoch: number | null = null;
      if (ve) {
        try {
          const e = await client.readContract({ ...ve, functionName: 'currentEpoch' });
          currentEpoch = typeof e === 'bigint' ? Number(e) : null;
        } catch {
          // leave null — on-chain validity/fee are the authoritative fields
        }
      }

      // Skip the fee read on invalid datanets — getAccessFeeREPPO is likely
      // to revert (or return 0) for non-existent datanets, and either way
      // the answer is "no fee because there is no datanet", not "fee is 0".
      const accessFeeREPPO: Numeric = valid
        ? await client.readContract({ ...sm, functionName: 'getAccessFeeREPPO', args: [datanetId] })
            .then((v) => ({ raw: v.toString(), formatted: formatUnits(v, 18) }))
        : unavailable('datanet does not exist');

      // Primary-token access fee — for datanets that charge access in their own
      // token rather than REPPO. Best-effort and decimals-aware: a revert here
      // (or a datanet with no primary token) must NOT break the REPPO answer.
      let accessFeePrimaryToken: Numeric = unavailable('not read');
      let primaryToken: { address: string; symbol: string; decimals: number } | undefined;
      if (valid) {
        try {
          const primaryAddr = await client.readContract({
            ...sm, functionName: 'getSubnetPrimaryToken', args: [datanetId],
          });
          // getSubnetPrimaryToken returns address(0) for REPPO-only datanets.
          // Short-circuit BEFORE touching the token (mirrors grant-access.ts's
          // guard): no decimals()/symbol()/fee read, and primaryToken stays
          // undefined. The wording is DISTINCT from a read failure so callers
          // can tell "this datanet has no primary token" apart from a transport
          // error.
          if (BigInt(primaryAddr) === 0n) {
            accessFeePrimaryToken = unavailable('datanet has no primary token');
          } else {
            const ft = erc20(primaryAddr);
            const [dec, sym, pFee] = await Promise.all([
              client.readContract({ ...ft, functionName: 'decimals' }),
              // symbol is cosmetic — best-effort: bytes32/non-standard tokens fail
              // to decode against the `string` ABI; fall back to '' rather than abort.
              client.readContract({ ...ft, functionName: 'symbol' }).catch(() => ''),
              client.readContract({ ...sm, functionName: 'getAccessFeePrimaryToken', args: [datanetId] }),
            ]);
            const decimals = Number(dec);
            primaryToken = { address: primaryAddr, symbol: sym, decimals };
            accessFeePrimaryToken = { raw: pFee.toString(), formatted: formatUnits(pFee, decimals) };
          }
        } catch {
          // The read failed (transport, or a non-standard token's decimals()/fee
          // getter reverted). Best-effort — never break the REPPO answer above.
          // Wording is distinct from the no-primary-token case above.
          accessFeePrimaryToken = unavailable('primary-token access fee read failed');
        }
      }

      // Optional caller-access check.
      const callerAddr = this.resolveCallerAddress(cfg.privateKey);
      const callerAccess = callerAddr && valid
        ? {
            address: callerAddr,
            hasAccess: await client.readContract({
              ...sm, functionName: 'hasSubnetAccess', args: [datanetId, callerAddr],
            }),
          }
        : undefined;

      const result = {
        datanetId: datanetId.toString(),
        network: cfg.network,
        valid,
        currentEpoch,
        accessFeeREPPO,
        accessFeePrimaryToken,
        ...(primaryToken ? { primaryToken } : {}),
        ...(callerAccess ? { callerAccess } : {}),
        metadata,
      };

      const feeFmt = 'unavailable' in accessFeeREPPO
        ? `(unavailable: ${accessFeeREPPO.unavailable})`
        : `${accessFeeREPPO.formatted} REPPO`;

      const lines = [
        `Datanet:       ${datanetId}`,
        `Network:       ${cfg.network}`,
        `Valid:         ${valid}`,
        `Current epoch: ${currentEpoch ?? '(unavailable)'}`,
        `Access fee:    ${feeFmt}`,
      ];
      // Primary-token access fee — shown only when the datanet actually has a
      // primary token (primaryToken present implies accessFeePrimaryToken is numeric).
      if (primaryToken && 'formatted' in accessFeePrimaryToken) {
        lines.push(
          `Access fee (primary): ${accessFeePrimaryToken.formatted} ${primaryToken.symbol} ` +
            `(${primaryToken.address}, ${primaryToken.decimals} dp)`,
        );
      }
      if (callerAccess) {
        lines.push(`Caller:        ${callerAccess.address}`);
        lines.push(`Caller access: ${callerAccess.hasAccess}`);
      }
      lines.push(...this.metadataLines(metadata));

      emit(result, lines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  private resolveCallerAddress(pk: `0x${string}` | undefined): Address | undefined {
    if (this.for_) {
      if (!isAddress(this.for_)) {
        throw cliError('INVALID_ADDRESS', `Invalid --for address: ${this.for_}`);
      }
      return this.for_;
    }
    if (pk) return privateKeyToAddress(pk);
    return undefined;
  }

  /**
   * Resolve the off-chain catalog row for this datanet by its on-chain id
   * (`tokenId`). Best-effort: returns `{ unavailable }` on a catalog outage
   * or a no-match, never throwing — the on-chain answer is authoritative and
   * must survive a flaky platform API.
   */
  private async fetchMetadata(tokenId: string): Promise<Metadata> {
    const baseUrl = process.env.REPPO_PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL;
    try {
      const row = await fetchSubnetByTokenId(baseUrl, tokenId);
      if (!row) return unavailable('datanet not found in the public catalog');
      return this.toMetadata(row);
    } catch (e) {
      return unavailable(`catalog fetch failed: ${(e as Error).message}`);
    }
  }

  private toMetadata(s: RawSubnet): Metadata {
    return {
      subnetUuid: s.id ?? '',
      name: s.subnetName ?? '',
      description: s.subnetDescription ?? '',
      status: s.status ?? 'UNKNOWN',
      nativeToken: {
        address: s.nativeTokenAddress ?? '',
        symbol: s.nativeTokenSymbol ?? '',
        decimals: typeof s.nativeTokenDecimals === 'number' ? s.nativeTokenDecimals : 0,
      },
      emissionsPerEpochREPPO: numericToString(s.emissionsPerEpochREPPO),
      emissionsPerEpochPrimaryToken: numericToString(s.emissionsPerEpochPrimaryToken),
      upVoteVolume: numericToString(s.upVoteVolume),
      downVoteVolume: numericToString(s.downVoteVolume),
      onboardingPublishers: s.onboardingPublishers ?? '',
      onboardingVoters: s.onboardingVoters ?? '',
      thumbnailUrl: s.thumbnailUrl ?? '',
      isABTestingSubnet: s.isABTestingSubnet ?? false,
    };
  }

  /** Human-mode lines for the catalog metadata block. */
  private metadataLines(m: Metadata): string[] {
    if ('unavailable' in m) {
      return [`Metadata:      (unavailable: ${m.unavailable})`];
    }
    const lines = [
      ``,
      `Name:          ${m.name}`,
      `Status:        ${m.status}`,
      `Token:         ${m.nativeToken.symbol} (${m.nativeToken.decimals} decimals) ${m.nativeToken.address}`,
      `Emissions:     ${m.emissionsPerEpochREPPO} REPPO/epoch` +
        (m.emissionsPerEpochPrimaryToken !== '0' ? ` + ${m.emissionsPerEpochPrimaryToken} primary/epoch` : ''),
      `Votes:         ↑${m.upVoteVolume} / ↓${m.downVoteVolume}`,
      `Subnet UUID:   ${m.subnetUuid}  (use as --subnet-uuid for mint-pod publishing)`,
    ];
    if (m.description.trim()) {
      lines.push(``, `Description:`, m.description.trim());
    }
    if (m.onboardingPublishers.trim()) {
      lines.push(``, `Onboarding — publishers:`, m.onboardingPublishers.trim());
    }
    if (m.onboardingVoters.trim()) {
      lines.push(``, `Onboarding — voters:`, m.onboardingVoters.trim());
    }
    return lines;
  }
}
