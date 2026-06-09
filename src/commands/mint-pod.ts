/**
 * `reppo mint-pod` — mint a pod NFT into a datanet on PodManager V2.
 *
 * V2 unified both networks behind the same call shape:
 *   - `mintPodWithREPPO(to, subnetId)`          (default, `--token reppo`)
 *   - `mintPodWithPrimaryToken(to, subnetId)`   (`--token primary`)
 *
 * The pre-V2 mainnet path `mintPod(to, emissionSharePercent)` and the
 * `publishingFee()` getter are gone — fee logic moved to SubnetManager.
 * Fee/balance/allowance pre-flight is intentionally skipped here: the
 * contract reverts with structured errors (decoded via decodeRevert)
 * if balance/allowance/fee constraints are violated, and any client-
 * side estimate is duplicate logic that drifts.
 *
 * Pre-flight (both networks):
 *   - MISSING_DATANET / INVALID_DATANET_ID
 *   - INVALID_TOKEN (--token must be "reppo" or "primary")
 *   - INVALID_ADDRESS (--to)
 *   - DATANET_NOT_FOUND
 *
 * Two-phase write protocol via peekIdempotent.
 */
import { existsSync } from 'node:fs';
import { Option } from 'clipanion';
import { isAddress, type Address } from 'viem';
import { BaseCommand } from './_base.js';
import { cliError, emit } from '../output/format.js';
import { createClients, nextNonce } from '../chain/clients.js';
import { podManager, subnetManager } from '../chain/contracts.js';
import { decodeRevert } from '../chain/errors.js';
import { handleSubmittedCacheDecision } from './write-cache.js';
import { waitForWriteReceipt, receiptGasEth } from '../chain/receipt.js';
import { begin, markSubmitted, markConfirmed, markFailed, peekIdempotent } from '../state/idempotency.js';
import {
  pinDatasetToIpfs,
  registerPodMetadata,
  POD_NAME_MAX,
  POD_DESCRIPTION_MAX,
  type PodMetadata,
} from '../api/agents.js';
import type { Config } from '../config/load.js';

const COMMAND = 'mint-pod';

/**
 * Resolved, fully-validated Phase-2 intent. Produced by
 * `resolvePublishIntent` BEFORE the on-chain mint so bad metadata config
 * fails fast (before gas), never after the irreversible write.
 */
interface PublishIntent {
  subnetUuid: string;
  podName: string;
  podDescription: string;
  url: string;
  category: string;
  platform: string;
  agentId: string;
  agentApiKey: string;
  /** Dataset source: pin a local file, use a URL as-is, or none. */
  dataset:
    | { kind: 'pin'; path: string; pinataJwt: string }
    | { kind: 'uri'; uri: string }
    | { kind: 'none' };
}

/** Structured outcome of Phase 2; embedded in the command's JSON result. */
interface Phase2Result {
  published: boolean;
  stage: 'ipfs-pin' | 'register';
  httpStatus?: number;
  datasetUri?: string;
  error?: { code: string; message: string };
}

export class MintPodCommand extends BaseCommand {
  static override paths = [['mint-pod']];

  static override usage = BaseCommand.Usage({
    description: 'Mint a pod NFT into a datanet. Required: --datanet <id>. Optional: --token reppo|primary, --to <addr>.',
    examples: [
      ['Mint a pod into datanet 19, paid in REPPO',
        'reppo mint-pod --datanet 19'],
      ['Mint into testnet datanet 19',
        'reppo mint-pod --datanet 19 --network testnet'],
      ['Pay the mint with the datanet primary token instead',
        'reppo mint-pod --datanet 19 --token primary'],
      ['Mint to a different address',
        'reppo mint-pod --datanet 19 --to 0x726c…E31d'],
    ],
  });

  datanet = Option.String('--datanet', { description: 'Datanet (subnet) id to mint into' });
  token = Option.String('--token', 'reppo', { description: 'Fee asset — "reppo" (default) or "primary"' });
  to = Option.String('--to', { description: 'Address to mint the pod to (defaults to caller)' });
  idempotencyKey = Option.String('--idempotency-key');
  dryRun = Option.Boolean('--dry-run', false);

  // ── Phase-2 metadata publishing (optional) ───────────────────────────
  // Providing --pod-name turns on Phase 2: after the on-chain mint, register
  // the pod's metadata with the Reppo platform so the UI surfaces it.
  podName = Option.String('--pod-name', { description: `Pod display name (≤${POD_NAME_MAX} chars). Providing it enables Phase-2 metadata publishing.` });
  podDescription = Option.String('--pod-description', { description: `Pod description (≤${POD_DESCRIPTION_MAX} chars)` });
  subnetUuid = Option.String('--subnet-uuid', { description: 'Platform subnet UUID (cuid, e.g. cmnhuowns…) — NOT the on-chain --datanet id. Required for publishing.' });
  podUrl = Option.String('--url', { description: 'Primary content URL for the pod (overridden by the dataset URI when a dataset is pinned/provided)' });
  category = Option.String('--category', 'Dataset', { description: 'Pod category label (default "Dataset")' });
  platform = Option.String('--platform', 'reppo-cli', { description: 'Publishing platform label (default "reppo-cli")' });
  dataset = Option.String('--dataset', { description: 'Local dataset file to pin to IPFS (needs PINATA_JWT). Mutually exclusive with --dataset-uri.' });
  datasetUri = Option.String('--dataset-uri', { description: 'Pre-built dataset URL to register as-is (no pinning). Mutually exclusive with --dataset.' });
  agreeToTerms = Option.Boolean('--agree-to-terms', false, { description: 'Required to publish metadata — confirms you accept the Reppo platform terms.' });

  async execute(): Promise<number> {
    try {
      const cfg = this.loadConfig();
      const pk = cfg.privateKey;
      if (!pk) {
        throw cliError(
          'MISSING_PRIVATE_KEY',
          'No signing key available.',
          'Set REPPO_PRIVATE_KEY in env.',
        );
      }

      if (this.datanet === undefined) {
        throw cliError(
          'MISSING_DATANET',
          '--datanet is required.',
          'Pass --datanet <id> to choose which datanet to mint into.',
        );
      }
      let datanetId: bigint;
      try {
        datanetId = BigInt(this.datanet);
      } catch {
        throw cliError('INVALID_DATANET_ID', `Datanet id must be a non-negative integer; got "${this.datanet}".`);
      }

      if (this.token !== 'reppo' && this.token !== 'primary') {
        throw cliError(
          'INVALID_TOKEN',
          `--token must be "reppo" or "primary"; got "${this.token}".`,
        );
      }
      const functionName = this.token === 'reppo' ? 'mintPodWithREPPO' : 'mintPodWithPrimaryToken';

      // Validate Phase-2 metadata config NOW, before any on-chain write, so
      // bad config (missing UUID, over-length name, numeric subnet id) fails
      // fast instead of after an irreversible mint. Returns null when
      // --pod-name is absent (publishing is opt-in).
      const publish = this.resolvePublishIntent(cfg);

      const clients = createClients({
        network: cfg.network,
        privateKey: pk,
        ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
      });

      const target: Address = this.to
        ? (isAddress(this.to)
            ? this.to
            : (() => { throw cliError('INVALID_ADDRESS', `Invalid --to address: ${this.to}`); })())
        : clients.account.address;

      const args = { datanetId: datanetId.toString(), token: this.token, to: target.toLowerCase() };

      const decision = await peekIdempotent<Record<string, unknown>>(
        this.idempotencyKey, COMMAND, args, this.dryRun,
      );
      if (decision.kind === 'return-confirmed') {
        // The mint is already durable on-chain. If Phase-2 publishing was
        // requested, (re-)run it now against the cached txHash — this is the
        // path the "retry with the same --idempotency-key" hint relies on,
        // since a failed metadata POST never reopens the confirmed mint.
        const cachedTx = decision.txHash;
        const lines = [`(cached, confirmed) tx: ${cachedTx ?? 'n/a'}`];
        const payload: Record<string, unknown> = { ...decision.result, idempotent: true, status: 'confirmed' };
        if (publish && cachedTx) {
          const metadata = await this.runPhase2(publish, cachedTx as `0x${string}`);
          payload.metadata = metadata;
          lines.push(...this.phase2HumanLines(publish, metadata));
        }
        emit(payload, lines);
        return 0;
      }
      if (decision.kind === 'return-submitted') {
        const clients = createClients({
          network: cfg.network,
          privateKey: pk,
          ...(cfg.rpcUrl ? { rpcUrl: cfg.rpcUrl } : {}),
        });
        return handleSubmittedCacheDecision(decision, {
          idempotencyKey: this.idempotencyKey,
          command: COMMAND,
          args,
          network: cfg.network,
          publicClient: clients.publicClient,
          buildResult: () => ({ datanetId: datanetId.toString(), token: this.token, to: target }),
        });
      }

      const pm = podManager(cfg.network);
      const sm = subnetManager(cfg.network);

      // Pre-flight: validate the datanet exists. The contract would
      // revert with InvalidSubnet otherwise; failing fast here gives a
      // cleaner error.
      const valid = await clients.publicClient.readContract({
        address: sm.address, abi: sm.abi, functionName: 'validSubnet', args: [datanetId],
      });
      if (!valid) {
        throw cliError(
          'DATANET_NOT_FOUND',
          `Datanet ${datanetId} does not exist on ${cfg.network}.`,
          `Verify the id; check \`reppo query datanet ${datanetId}\` before minting.`,
        );
      }

      const basescanUrlFor = (tx: `0x${string}`) =>
        cfg.network === 'mainnet'
          ? `https://basescan.org/tx/${tx}`
          : `https://sepolia.basescan.org/tx/${tx}`;

      if (this.dryRun) {
        const sim = await clients.publicClient.simulateContract({
          address: pm.address, abi: pm.abi, functionName,
          args: [target, datanetId], account: clients.account,
        }).catch((e) => {
          const decoded = decodeRevert(e);
          throw cliError(decoded.code, 'Simulation reverted', decoded.hint);
        });
        emit({
          simulated: true,
          datanetId: datanetId.toString(),
          token: this.token,
          to: target,
          predictedPodId: sim.result.toString(),
          gas: sim.request.gas?.toString() ?? null,
          // Preview Phase 2 without pinning or POSTing — config already
          // validated above; this just shows what would be published.
          metadata: publish
            ? {
                wouldPublish: true,
                subnetId: publish.subnetUuid,
                podName: publish.podName,
                dataset: publish.dataset.kind,
              }
            : { wouldPublish: false },
        });
        return 0;
      }

      if (this.idempotencyKey) await begin(this.idempotencyKey, COMMAND, args);

      let tx: `0x${string}`;
      try {
        const nonce = await nextNonce(clients.publicClient, clients.account.address);
        tx = await clients.walletClient.writeContract({
          address: pm.address, abi: pm.abi, functionName,
          args: [target, datanetId],
          chain: clients.walletClient.chain, account: clients.account, nonce,
        });
      } catch (e) {
        const decoded = decodeRevert(e);
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, decoded.code);
        throw cliError(decoded.code, 'mint-pod tx failed to submit', decoded.hint);
      }

      if (this.idempotencyKey) {
        await markSubmitted(this.idempotencyKey, COMMAND, args, tx, {
          datanetId: datanetId.toString(),
          token: this.token,
          to: target,
        });
      }

      const receipt = await waitForWriteReceipt(clients.publicClient, tx);
      if (receipt.status === 'reverted') {
        if (this.idempotencyKey) await markFailed(this.idempotencyKey, COMMAND, args, 'TX_REVERTED', tx);
        throw cliError('TX_REVERTED', `mint-pod tx reverted: ${tx}`);
      }

      const basescanUrl = basescanUrlFor(tx);
      const result: Record<string, unknown> = {
        txHash: tx,
        gasEth: receiptGasEth(receipt),
        datanetId: datanetId.toString(),
        token: this.token,
        to: target,
        block: receipt.blockNumber.toString(),
        basescanUrl,
      };
      // Mark the on-chain mint confirmed BEFORE Phase 2. The tx is durable;
      // a later Phase-2 failure must never reopen the mint for re-broadcast.
      if (this.idempotencyKey) await markConfirmed(this.idempotencyKey, COMMAND, args, result, tx);

      const humanLines = [
        `✓ Minted pod into datanet ${datanetId} (paid in ${this.token})`,
        `  to: ${target}`,
        `  tx: ${basescanUrl}`,
        `  block: ${receipt.blockNumber}`,
        `  (new podId: check the explorer or run \`reppo query pod <id>\` to verify)`,
      ];

      // ── Phase 2: pin dataset (optional) + register metadata ──────────
      // Decoupled from the mint: runPhase2 never throws, so a pin/POST
      // failure leaves the mint reported as success with metadata.published
      // = false. The agent re-runs with the same --idempotency-key to retry
      // (the return-confirmed branch above re-runs Phase 2 against the
      // cached txHash).
      if (publish) {
        const metadata = await this.runPhase2(publish, tx);
        result.metadata = metadata;
        humanLines.push(...this.phase2HumanLines(publish, metadata));
      }

      emit(result, humanLines);
      return 0;
    } catch (err) {
      this.handleError(err);
    }
  }

  /**
   * Validate Phase-2 metadata flags and produce a resolved `PublishIntent`,
   * or `null` when --pod-name is absent (publishing is opt-in). Throws
   * `cliError` on any invalid/incomplete config so the caller fails BEFORE
   * the on-chain mint. Does no network I/O.
   */
  private resolvePublishIntent(cfg: Config): PublishIntent | null {
    const name = this.podName?.trim();
    if (!name) return null;

    if (name.length > POD_NAME_MAX) {
      throw cliError('INVALID_POD_NAME', `--pod-name must be ≤${POD_NAME_MAX} chars; got ${name.length}.`);
    }
    const description = (this.podDescription ?? '').trim();
    if (description.length > POD_DESCRIPTION_MAX) {
      throw cliError(
        'INVALID_POD_DESCRIPTION',
        `--pod-description must be ≤${POD_DESCRIPTION_MAX} chars; got ${description.length}.`,
      );
    }

    const subnetUuid = this.subnetUuid?.trim();
    if (!subnetUuid) {
      throw cliError(
        'MISSING_SUBNET_UUID',
        '--subnet-uuid is required to publish pod metadata.',
        'Pass the platform subnet UUID (cuid like cmnhuowns…), visible in the datanet URL — NOT the on-chain --datanet id.',
      );
    }
    // The platform metadata API needs the subnet UUID (cuid), not the numeric
    // on-chain id. A numeric value passes the platform's Zod schema but 500s
    // in the downstream UUID lookup — reject it loudly up front.
    if (/^[0-9]+$/.test(subnetUuid)) {
      throw cliError(
        'INVALID_SUBNET_UUID',
        `--subnet-uuid "${subnetUuid}" looks like an on-chain datanet id, not a platform UUID.`,
        'The platform metadata API needs the subnet UUID (cuid like cmnhuowns…). The numeric id passes validation but fails downstream with HTTP 500.',
      );
    }

    if (!this.agreeToTerms) {
      throw cliError(
        'MISSING_AGREEMENT',
        'Publishing pod metadata requires --agree-to-terms.',
        'Pass --agree-to-terms to confirm you accept the Reppo platform terms.',
      );
    }

    const agentId = cfg.agentId?.trim();
    if (!agentId) {
      throw cliError(
        'MISSING_AGENT_ID',
        'REPPO_AGENT_ID is required to publish pod metadata.',
        'Run `reppo register-agent` to obtain an agent id + apiKey, then set REPPO_AGENT_ID.',
      );
    }
    const agentApiKey = cfg.agentApiKey?.trim();
    if (!agentApiKey) {
      throw cliError(
        'MISSING_AGENT_API_KEY',
        'REPPO_AGENT_API_KEY (or REPPO_API_KEY) is required to publish pod metadata.',
        'Use the apiKey returned by `reppo register-agent`.',
      );
    }

    const hasDataset = this.dataset !== undefined && this.dataset.trim() !== '';
    const hasDatasetUri = this.datasetUri !== undefined && this.datasetUri.trim() !== '';
    if (hasDataset && hasDatasetUri) {
      throw cliError(
        'INVALID_DATASET_ARGS',
        '--dataset and --dataset-uri are mutually exclusive.',
        'Pass --dataset <file> to pin a local dataset, or --dataset-uri <url> to register an existing URL.',
      );
    }

    let dataset: PublishIntent['dataset'];
    if (hasDataset) {
      const path = this.dataset!.trim();
      if (!existsSync(path)) {
        throw cliError('DATASET_FILE_NOT_FOUND', `Dataset file not found: ${path}`);
      }
      const pinataJwt = cfg.pinataJwt?.trim();
      if (!pinataJwt) {
        throw cliError(
          'MISSING_PINATA_JWT',
          'PINATA_JWT is required to pin a --dataset file.',
          'Set PINATA_JWT, or pass --dataset-uri <url> to register an existing URL without pinning.',
        );
      }
      dataset = { kind: 'pin', path, pinataJwt };
    } else if (hasDatasetUri) {
      dataset = { kind: 'uri', uri: this.datasetUri!.trim() };
    } else {
      dataset = { kind: 'none' };
    }

    return {
      subnetUuid,
      podName: name,
      podDescription: description,
      url: (this.podUrl ?? '').trim(),
      category: this.category,
      platform: this.platform,
      agentId,
      agentApiKey,
      dataset,
    };
  }

  /** Human-readable summary lines for a Phase-2 outcome (success or failure). */
  private phase2HumanLines(intent: PublishIntent, metadata: Phase2Result): string[] {
    if (metadata.published) {
      const lines = [`✓ Registered pod metadata "${intent.podName}" (subnet ${intent.subnetUuid})`];
      if (metadata.datasetUri) lines.push(`  dataset: ${metadata.datasetUri}`);
      return lines;
    }
    return [
      `⚠ Metadata NOT published (${metadata.stage}): ${metadata.error?.code ?? 'UNKNOWN'} — mint is durable on-chain.`,
      `  Re-run with the same --idempotency-key to retry Phase 2.`,
    ];
  }

  /**
   * Execute Phase 2: pin the dataset (if any), then POST metadata. NEVER
   * throws — returns a structured result so a Phase-2 failure can't crash
   * the command after a durable on-chain mint. `published` is true only on a
   * 2xx registration response.
   */
  private async runPhase2(intent: PublishIntent, txHash: `0x${string}`): Promise<Phase2Result> {
    let datasetUri = '';
    try {
      if (intent.dataset.kind === 'pin') {
        datasetUri = await pinDatasetToIpfs(intent.dataset.path, intent.dataset.pinataJwt);
      } else if (intent.dataset.kind === 'uri') {
        datasetUri = intent.dataset.uri;
      }
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        published: false,
        stage: 'ipfs-pin',
        error: { code: err.code ?? 'IPFS_PIN_FAILED', message: err.message ?? String(e) },
      };
    }

    // The dataset URI, when present, is the pod's primary content link and
    // its downloadable-file slot (mirrors the aeon postprocess body).
    const body: PodMetadata = {
      txHash,
      subnetId: intent.subnetUuid,
      podName: intent.podName,
      podDescription: intent.podDescription,
      url: datasetUri || intent.url,
      platform: intent.platform,
      category: intent.category,
      agreeToTerms: true,
      imageURL: '',
      thumbnailURL: '',
      pdfURL: datasetUri || '',
      videoURL: '',
    };

    const datasetField = datasetUri ? { datasetUri } : {};
    try {
      const res = await registerPodMetadata(intent.agentId, intent.agentApiKey, body);
      if (res.ok) {
        return { published: true, stage: 'register', httpStatus: res.status, ...datasetField };
      }
      return {
        published: false,
        stage: 'register',
        httpStatus: res.status,
        error: { code: 'PLATFORM_API_ERROR', message: res.detail || `HTTP ${res.status}` },
        ...datasetField,
      };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return {
        published: false,
        stage: 'register',
        error: { code: err.code ?? 'PLATFORM_API_UNREACHABLE', message: err.message ?? String(e) },
        ...datasetField,
      };
    }
  }
}
