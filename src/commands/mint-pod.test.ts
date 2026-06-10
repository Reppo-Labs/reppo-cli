/**
 * Unit tests for mint-pod's Phase-2 input validation (`resolvePublishIntent`).
 *
 * This is the load-bearing logic that must fail BEFORE the on-chain mint:
 * the ISS-014 numeric-subnet guard, the ISS-012 length caps, dataset
 * mutual-exclusion, and the credential/agreement gates. The on-chain write
 * path is exercised by the anvil-fork integration suite, not here — these
 * tests stay pure (no chain, no network).
 *
 * `resolvePublishIntent` is private; we reach it through a typed accessor
 * cast (the same direct-instantiation trick used in list/datanets.test.ts,
 * which bypasses clipanion's arg parser so option fields must be set by hand).
 */
import { describe, it, expect } from 'vitest';
import { MintPodCommand } from './mint-pod.js';
import type { Config } from '../config/load.js';

interface PublishIntentShape {
  subnetUuid: string;
  podName: string;
  podDescription: string;
  url: string;
  imageUrl: string;
  category: string;
  platform: string;
  agentId: string;
  agentApiKey: string;
  dataset: { kind: string; path?: string; uri?: string; pinataJwt?: string };
}

/** Option fields resolvePublishIntent reads off `this`. */
interface MintPodFields {
  podName: string | undefined;
  podDescription: string | undefined;
  subnetUuid: string | undefined;
  podUrl: string | undefined;
  imageUrl: string | undefined;
  category: string;
  platform: string;
  dataset: string | undefined;
  datasetUri: string | undefined;
  agreeToTerms: boolean;
  resolvePublishIntent(cfg: Config): PublishIntentShape | null;
}

function makeCmd(overrides: Partial<MintPodFields> = {}): MintPodFields {
  const cmd = new MintPodCommand() as unknown as MintPodFields;
  cmd.podName = overrides.podName;
  cmd.podDescription = overrides.podDescription;
  cmd.subnetUuid = overrides.subnetUuid;
  cmd.podUrl = overrides.podUrl;
  cmd.imageUrl = overrides.imageUrl;
  cmd.category = overrides.category ?? 'Dataset';
  cmd.platform = overrides.platform ?? 'reppo-cli';
  cmd.dataset = overrides.dataset;
  cmd.datasetUri = overrides.datasetUri;
  cmd.agreeToTerms = overrides.agreeToTerms ?? false;
  return cmd;
}

function cfg(overrides: Partial<Config> = {}): Config {
  return {
    network: 'mainnet',
    rpcUrl: undefined,
    apiUrl: undefined,
    apiKey: undefined,
    privateKey: undefined,
    voterPrivateKey: undefined,
    agentId: 'agent-123',
    agentApiKey: 'key-abc',
    pinataJwt: undefined,
    ...overrides,
  };
}

/** A fully-valid publishing setup; individual tests knock out one field. */
function validCmd(overrides: Partial<MintPodFields> = {}): MintPodFields {
  return makeCmd({
    podName: 'My Strategy Pod',
    podDescription: 'A short description.',
    subnetUuid: 'cmnhuowns000bic04e16t6735',
    agreeToTerms: true,
    ...overrides,
  });
}

describe('resolvePublishIntent — opt-in', () => {
  it('returns null when --pod-name is absent (Phase 2 disabled)', () => {
    expect(makeCmd().resolvePublishIntent(cfg())).toBeNull();
  });

  it('returns null when --pod-name is blank/whitespace', () => {
    expect(makeCmd({ podName: '   ' }).resolvePublishIntent(cfg())).toBeNull();
  });
});

describe('resolvePublishIntent — field validation', () => {
  it('rejects a pod name over 50 chars', () => {
    expect(() => validCmd({ podName: 'x'.repeat(51) }).resolvePublishIntent(cfg())).toThrow(
      expect.objectContaining({ code: 'INVALID_POD_NAME' }),
    );
  });

  it('rejects a description over 200 chars', () => {
    expect(() =>
      validCmd({ podDescription: 'y'.repeat(201) }).resolvePublishIntent(cfg()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_POD_DESCRIPTION' }));
  });

  it('requires --subnet-uuid', () => {
    expect(() => validCmd({ subnetUuid: undefined }).resolvePublishIntent(cfg())).toThrow(
      expect.objectContaining({ code: 'MISSING_SUBNET_UUID' }),
    );
  });

  it('rejects a numeric subnet id (ISS-014: must be the platform UUID)', () => {
    expect(() => validCmd({ subnetUuid: '9' }).resolvePublishIntent(cfg())).toThrow(
      expect.objectContaining({ code: 'INVALID_SUBNET_UUID' }),
    );
  });

  it('requires --agree-to-terms', () => {
    expect(() => validCmd({ agreeToTerms: false }).resolvePublishIntent(cfg())).toThrow(
      expect.objectContaining({ code: 'MISSING_AGREEMENT' }),
    );
  });
});

describe('resolvePublishIntent — credentials', () => {
  it('requires REPPO_AGENT_ID', () => {
    expect(() => validCmd().resolvePublishIntent(cfg({ agentId: undefined }))).toThrow(
      expect.objectContaining({ code: 'MISSING_AGENT_ID' }),
    );
  });

  it('requires an agent apiKey', () => {
    expect(() => validCmd().resolvePublishIntent(cfg({ agentApiKey: undefined }))).toThrow(
      expect.objectContaining({ code: 'MISSING_AGENT_API_KEY' }),
    );
  });
});

describe('resolvePublishIntent — dataset modes', () => {
  it('rejects --dataset and --dataset-uri together', () => {
    expect(() =>
      validCmd({ dataset: '/tmp/x.json', datasetUri: 'ipfs://Qm' }).resolvePublishIntent(cfg()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_DATASET_ARGS' }));
  });

  it('rejects a --dataset path that does not exist on disk', () => {
    expect(() =>
      validCmd({ dataset: '/tmp/does-not-exist-xyz.json' }).resolvePublishIntent(cfg()),
    ).toThrow(expect.objectContaining({ code: 'DATASET_FILE_NOT_FOUND' }));
  });

  it('resolves a dataset-uri intent with kind "uri"', () => {
    const intent = validCmd({ datasetUri: 'https://ipfs.io/ipfs/QmABC' }).resolvePublishIntent(cfg());
    expect(intent?.dataset).toEqual({ kind: 'uri', uri: 'https://ipfs.io/ipfs/QmABC' });
  });

  it('resolves a no-dataset intent with kind "none" and trims fields', () => {
    const intent = validCmd({ podName: '  Padded Name  ' }).resolvePublishIntent(cfg());
    expect(intent?.podName).toBe('Padded Name');
    expect(intent?.dataset).toEqual({ kind: 'none' });
    expect(intent?.subnetUuid).toBe('cmnhuowns000bic04e16t6735');
    expect(intent?.agentId).toBe('agent-123');
  });

  it('carries a trimmed --image-url and --url through the intent', () => {
    const intent = validCmd({
      podUrl: '  https://news.example/article  ',
      imageUrl: '  https://news.example/og.jpg  ',
    }).resolvePublishIntent(cfg());
    expect(intent?.url).toBe('https://news.example/article')
    expect(intent?.imageUrl).toBe('https://news.example/og.jpg')
  });
});
