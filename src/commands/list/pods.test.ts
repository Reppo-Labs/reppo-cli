/**
 * Unit tests for `reppo list pods`.
 *
 * Strategy: mock the two platform-API helpers (`getOrRefreshSession` and
 * `platformGet`) and instantiate `ListPodsCommand` directly. Avoids
 * spawning the CLI binary — that path is covered by the existing
 * pre-flight error-path suite in src/__tests__/command-error-paths.test.ts.
 *
 * The state/db saveSession() side of getOrRefreshSession is short-
 * circuited by mocking, so these tests don't touch ~/.reppo/cli-state.json.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted so the ListPodsCommand import below sees them.
const getOrRefreshSession = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const platformGet = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../api/platform.js', () => ({
  getOrRefreshSession: (...args: unknown[]): Promise<unknown> => getOrRefreshSession(...args),
  platformGet: (...args: unknown[]): Promise<unknown> => platformGet(...args),
}));

// ── Output-shape contract (mirrors src/commands/list/pods.ts emit). ────
interface Wei { raw: string; formatted: string }
interface PodOut {
  podId: string;
  subnetId?: string;
  mintedAt?: string;
  unclaimedEmissionsREPPO?: Wei;
  emissionsError?: { code: string; message: string };
}
interface ListPodsResult {
  address: string;
  network: string;
  pods: PodOut[];
  count: number;
  totalUnclaimedREPPO?: Wei;
}

function parseOk(raw: string | undefined): ListPodsResult {
  if (!raw) throw new Error('no JSON captured on stdout');
  return JSON.parse(raw) as ListPodsResult;
}

function parseErr(raw: string | undefined): { code: string; message: string; hint?: string } {
  if (!raw) throw new Error('no JSON captured on stderr');
  return (JSON.parse(raw) as { error: { code: string; message: string; hint?: string } }).error;
}

// Synthetic — never derives a funded address.
const FAKE_PK = '0x' + '11'.repeat(32);
const FAKE_ADDR = '0x0000000000000000000000000000000000001234';

// Capture emit() / fail() output without writing to real stdio.
let capturedJson: string | undefined;
let capturedErrorJson: string | undefined;
let exitCode: number | undefined;

beforeEach(() => {
  capturedJson = undefined;
  capturedErrorJson = undefined;
  exitCode = undefined;
  getOrRefreshSession.mockReset();
  platformGet.mockReset();

  // Swallow writes to stdout; capture JSON lines for assertions.
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    if (s.startsWith('{')) capturedJson = s;
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
    if (s.startsWith('{')) capturedErrorJson = s;
    return true;
  });
  // fail() calls process.exit; intercept rather than terminate the test runner.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit_${exitCode}__`);
  }) as never);
});

afterEach(() => {
  // Undo any vi.stubGlobal('fetch', ...) from --all tests.
  vi.unstubAllGlobals();
});

// Import AFTER mocks are wired so the command picks them up.
const { ListPodsCommand } = await import('./pods.js');

// ── Helpers ────────────────────────────────────────────────────────────

interface CommandLike {
  network: string | undefined;
  rpcUrl: string | undefined;
  json: boolean;
  all: boolean;
  includeEmissions: boolean;
  datanet: string | undefined;
  limit: string | undefined;
  context: unknown;
  cli: unknown;
}

function makeCommand(opts: {
  pk?: string | undefined;
  network?: string;
  apiUrl?: string;
  json?: boolean;
  all?: boolean;
  includeEmissions?: boolean;
  datanet?: string;
  limit?: string;
} = {}): { cmd: InstanceType<typeof ListPodsCommand>; restoreEnv: () => void } {
  const origPk = process.env.REPPO_PRIVATE_KEY;
  const origNetwork = process.env.REPPO_NETWORK;
  const origApi = process.env.REPPO_API_URL;

  if ('pk' in opts) {
    if (opts.pk === undefined) delete process.env.REPPO_PRIVATE_KEY;
    else process.env.REPPO_PRIVATE_KEY = opts.pk;
  } else {
    process.env.REPPO_PRIVATE_KEY = FAKE_PK;
  }
  if (opts.network) process.env.REPPO_NETWORK = opts.network;
  else delete process.env.REPPO_NETWORK;
  if (opts.apiUrl) process.env.REPPO_API_URL = opts.apiUrl;
  else delete process.env.REPPO_API_URL;

  // Direct instantiation leaves clipanion's `Option.*` fields holding
  // sentinel objects rather than parsed values, so every option field
  // must be explicitly reset to a real value — including BaseCommand's
  // --network / --rpc-url, otherwise loadConfig fires INVALID_NETWORK
  // on the truthy sentinel.
  const cmd = new ListPodsCommand() as unknown as CommandLike;
  cmd.network = undefined;
  cmd.rpcUrl = undefined;
  cmd.json = opts.json ?? true;
  cmd.all = opts.all ?? false;
  cmd.includeEmissions = opts.includeEmissions ?? false;
  cmd.datanet = opts.datanet;
  cmd.limit = opts.limit;
  // Clipanion injects these at runtime; stub minimal values for direct invocation.
  cmd.context = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, colorDepth: 1 };
  cmd.cli = {};

  return {
    cmd: cmd as unknown as InstanceType<typeof ListPodsCommand>,
    restoreEnv: () => {
      if (origPk === undefined) delete process.env.REPPO_PRIVATE_KEY;
      else process.env.REPPO_PRIVATE_KEY = origPk;
      if (origNetwork === undefined) delete process.env.REPPO_NETWORK;
      else process.env.REPPO_NETWORK = origNetwork;
      if (origApi === undefined) delete process.env.REPPO_API_URL;
      else process.env.REPPO_API_URL = origApi;
    },
  };
}

function defaultSession(): { accessToken: string; walletAddress: string; expiresAt: number; createdAt: number } {
  return {
    accessToken: 'tok_test_123',
    walletAddress: FAKE_ADDR,
    expiresAt: Date.now() + 60 * 60 * 1000,
    createdAt: Date.now(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('list pods', () => {
  it('returns pods for the authenticated wallet', async () => {
    const { cmd, restoreEnv } = makeCommand();
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: {
          pods: [
            { id: '42', podId: '42', subnetId: '19', mintedAt: '2026-04-12T10:00:00Z' },
            { id: '43', podId: '43', subnetId: '7' },
          ],
        },
      });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.address).toBe(FAKE_ADDR);
      expect(out.count).toBe(2);
      expect(out.pods).toHaveLength(2);
      expect(out.pods[0]).toMatchObject({ podId: '42', subnetId: '19', mintedAt: '2026-04-12T10:00:00Z' });
      expect(out.pods[1]).toMatchObject({ podId: '43', subnetId: '7' });
      expect(out.totalUnclaimedREPPO).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it('handles flat-envelope { pods: [...] } responses too', async () => {
    const { cmd, restoreEnv } = makeCommand();
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        pods: [{ podId: '99' }],
      });
      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(1);
      expect(out.pods[0]!.podId).toBe('99');
    } finally {
      restoreEnv();
    }
  });

  it('emits empty pods array + count 0 when wallet owns nothing', async () => {
    const { cmd, restoreEnv } = makeCommand();
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({ data: { pods: [] } });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(0);
      expect(out.pods).toEqual([]);
    } finally {
      restoreEnv();
    }
  });

  it('does NOT call /pods/{id}/emissions without --include-emissions', async () => {
    const { cmd, restoreEnv } = makeCommand({ includeEmissions: false });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: { pods: [{ podId: '1' }, { podId: '2' }, { podId: '3' }] },
      });

      await cmd.execute();
      // Exactly one platformGet call: the /pods listing. No per-pod emissions.
      expect(platformGet).toHaveBeenCalledTimes(1);
      expect(platformGet.mock.calls[0]?.[1]).toBe('/pods');
    } finally {
      restoreEnv();
    }
  });

  it('calls /pods/{id}/emissions once per pod when --include-emissions is set', async () => {
    const { cmd, restoreEnv } = makeCommand({ includeEmissions: true });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet
        // /pods
        .mockResolvedValueOnce({
          data: { pods: [{ podId: '1' }, { podId: '2' }, { podId: '3' }] },
        })
        // /pods/1/emissions
        .mockResolvedValueOnce({ data: { totalClaimable: '1000000000000000000' } })
        // /pods/2/emissions
        .mockResolvedValueOnce({ data: { totalClaimable: '2000000000000000000' } })
        // /pods/3/emissions
        .mockResolvedValueOnce({ data: { totalClaimable: '500000000000000000' } });

      const code = await cmd.execute();
      expect(code).toBe(0);

      // 1 listing + 3 emissions = 4 calls.
      expect(platformGet).toHaveBeenCalledTimes(4);
      const paths = platformGet.mock.calls.map((c) => c[1] as string);
      expect(paths).toContain('/pods');
      expect(paths).toContain('/pods/1/emissions');
      expect(paths).toContain('/pods/2/emissions');
      expect(paths).toContain('/pods/3/emissions');

      const out = parseOk(capturedJson);
      expect(out.totalUnclaimedREPPO!.raw).toBe('3500000000000000000');
      expect(out.totalUnclaimedREPPO!.formatted).toBe('3.5');
      expect(out.pods[0]!.unclaimedEmissionsREPPO!.formatted).toBe('1');
      expect(out.pods[1]!.unclaimedEmissionsREPPO!.formatted).toBe('2');
      expect(out.pods[2]!.unclaimedEmissionsREPPO!.formatted).toBe('0.5');
    } finally {
      restoreEnv();
    }
  });

  it('continues when one per-pod emissions call fails (records emissionsError)', async () => {
    const { cmd, restoreEnv } = makeCommand({ includeEmissions: true });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet
        .mockResolvedValueOnce({ data: { pods: [{ podId: '1' }, { podId: '2' }] } })
        .mockResolvedValueOnce({ data: { totalClaimable: '1000000000000000000' } })
        .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'PLATFORM_API_ERROR' }));

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.pods[0]!.unclaimedEmissionsREPPO!.formatted).toBe('1');
      expect(out.pods[1]!.emissionsError!.code).toBe('PLATFORM_API_ERROR');
      // Only the successful pod contributes to total.
      expect(out.totalUnclaimedREPPO!.formatted).toBe('1');
    } finally {
      restoreEnv();
    }
  });

  it('--limit 2 returns at most 2 rows', async () => {
    const { cmd, restoreEnv } = makeCommand({ limit: '2' });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: {
          pods: [
            { podId: '1' }, { podId: '2' }, { podId: '3' }, { podId: '4' }, { podId: '5' },
          ],
        },
      });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(2);
      expect(out.pods.map((p: { podId: string }) => p.podId)).toEqual(['1', '2']);
    } finally {
      restoreEnv();
    }
  });

  it('--limit only fetches emissions for the truncated subset', async () => {
    const { cmd, restoreEnv } = makeCommand({ limit: '2', includeEmissions: true });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet
        .mockResolvedValueOnce({
          data: { pods: [{ podId: '1' }, { podId: '2' }, { podId: '3' }] },
        })
        .mockResolvedValueOnce({ data: { totalClaimable: '0' } })
        .mockResolvedValueOnce({ data: { totalClaimable: '0' } });

      await cmd.execute();
      // 1 listing + 2 emissions (NOT 3 — pod 3 was truncated by --limit).
      expect(platformGet).toHaveBeenCalledTimes(3);
    } finally {
      restoreEnv();
    }
  });

  it('rejects --limit "abc" with INVALID_LIMIT before any network call', async () => {
    const { cmd, restoreEnv } = makeCommand({ limit: 'abc' });
    try {
      await expect(cmd.execute()).rejects.toThrow(/__exit_/);
      expect(getOrRefreshSession).not.toHaveBeenCalled();
      const err = parseErr(capturedErrorJson);
      expect(err.code).toBe('INVALID_LIMIT');
      expect(exitCode).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  it('returns MISSING_PRIVATE_KEY when REPPO_PRIVATE_KEY is unset', async () => {
    const { cmd, restoreEnv } = makeCommand({ pk: undefined });
    try {
      await expect(cmd.execute()).rejects.toThrow(/__exit_/);
      expect(getOrRefreshSession).not.toHaveBeenCalled();
      const err = parseErr(capturedErrorJson);
      expect(err.code).toBe('MISSING_PRIVATE_KEY');
      expect(exitCode).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  it('passes cfg.network (mainnet default) into getOrRefreshSession', async () => {
    const { cmd, restoreEnv } = makeCommand();
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({ data: { pods: [] } });

      await cmd.execute();
      expect(getOrRefreshSession).toHaveBeenCalledTimes(1);
      // signature: (network, apiUrl, privateKey)
      expect(getOrRefreshSession.mock.calls[0]?.[0]).toBe('mainnet');
      expect(getOrRefreshSession.mock.calls[0]?.[1]).toBe('https://api.reppo.xyz');
      expect(getOrRefreshSession.mock.calls[0]?.[2]).toBe(FAKE_PK);
    } finally {
      restoreEnv();
    }
  });

  it('passes cfg.network=testnet through when REPPO_NETWORK=testnet', async () => {
    const { cmd, restoreEnv } = makeCommand({
      network: 'testnet',
      apiUrl: 'https://testnet-api.example',
    });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({ data: { pods: [] } });

      await cmd.execute();
      expect(getOrRefreshSession.mock.calls[0]?.[0]).toBe('testnet');
      expect(getOrRefreshSession.mock.calls[0]?.[1]).toBe('https://testnet-api.example');
    } finally {
      restoreEnv();
    }
  });

  it('--datanet 19 returns only pods belonging to that subnet', async () => {
    const { cmd, restoreEnv } = makeCommand({ datanet: '19' });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: {
          pods: [
            { podId: '42', subnetId: '19' },
            { podId: '43', subnetId: '7' },
            { podId: '44', subnetId: '19' },
            { podId: '45' }, // no subnetId — must NOT match
          ],
        },
      });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(2);
      expect(out.pods.map((p: { podId: string }) => p.podId)).toEqual(['42', '44']);
    } finally {
      restoreEnv();
    }
  });

  it('--datanet 19 filter applies before --limit (cap is on filtered set, not raw API page)', async () => {
    const { cmd, restoreEnv } = makeCommand({ datanet: '19', limit: '1' });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: {
          pods: [
            { podId: '1', subnetId: '7' },  // filtered out
            { podId: '2', subnetId: '19' }, // first match — kept
            { podId: '3', subnetId: '19' }, // second match — would be kept but --limit caps at 1
            { podId: '4', subnetId: '99' },
          ],
        },
      });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(1);
      expect(out.pods[0]!.podId).toBe('2');
    } finally {
      restoreEnv();
    }
  });

  it('--datanet with no matches emits count 0 (not the "no pods" message) when wallet owns other pods', async () => {
    const { cmd, restoreEnv } = makeCommand({ datanet: '99' });
    try {
      getOrRefreshSession.mockResolvedValueOnce(defaultSession());
      platformGet.mockResolvedValueOnce({
        data: { pods: [{ podId: '1', subnetId: '19' }, { podId: '2', subnetId: '7' }] },
      });

      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = parseOk(capturedJson);
      expect(out.count).toBe(0);
      expect(out.pods).toEqual([]);
    } finally {
      restoreEnv();
    }
  });

  it('rejects --datanet "abc" with INVALID_DATANET before any network call', async () => {
    const { cmd, restoreEnv } = makeCommand({ datanet: 'abc' });
    try {
      await expect(cmd.execute()).rejects.toThrow(/__exit_/);
      expect(getOrRefreshSession).not.toHaveBeenCalled();
      const err = parseErr(capturedErrorJson);
      expect(err.code).toBe('INVALID_DATANET');
      expect(exitCode).toBe(1);
    } finally {
      restoreEnv();
    }
  });
});

// ── --all (community scope) ─────────────────────────────────────────────
//
// `--all` switches to the public, unauthenticated API. publicGet uses the
// global `fetch`, so these tests stub `fetch` (not platformGet) and route
// the two endpoints (/subnets, /pods) by URL substring.

interface CommunityPodOut {
  podId: string;
  name: string;
  description: string;
  creator: string;
  datanetId: string | null;
  upVotes: string;
  downVotes: string;
  mediaUrl?: string;
}
interface CommunityResult {
  scope: string;
  network: string;
  datanet?: string;
  pods: CommunityPodOut[];
  count: number;
}

function communityPod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'A community pod',
    tokenId: 325,
    privateSubnetId: 'cuid-default',
    url: 'https://example.com/pod',
    podValidityEpoch: 94,
    cumulativeUpVotesVolume: 57882,
    cumulativeDownVotesVolume: 0,
    creator: { username: 'someone' },
    ...overrides,
  };
}

/** Route the two public endpoints `--all` hits, by URL substring. */
function stubPublicApi(opts: {
  pods: Record<string, unknown>[];
  subnets?: { id: string; tokenId: string }[];
  podsStatus?: number;
}): void {
  const subnets = opts.subnets ?? [{ id: 'cuid-default', tokenId: '19' }];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = url.includes('/subnets')
      ? { data: { subnets } }
      : { data: { pods: opts.pods } };
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: url.includes('/subnets') ? 200 : (opts.podsStatus ?? 200),
      headers: { 'Content-Type': 'application/json' },
    }));
  }));
}

describe('list pods --all (community scope)', () => {
  it('lists pods from any wallet via the public API — no private key needed', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true, pk: undefined });
    try {
      stubPublicApi({
        pods: [
          communityPod({ tokenId: 1, name: 'One' }),
          communityPod({ tokenId: 2, name: 'Two' }),
        ],
      });
      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.scope).toBe('community');
      expect(out.count).toBe(2);
      expect(out.pods.map((p) => p.podId)).toEqual(['1', '2']);
      // Owner-scope platform calls must NOT happen in --all mode.
      expect(getOrRefreshSession).not.toHaveBeenCalled();
      expect(platformGet).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it('surfaces the full pod description and a media url for voter scoring', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true });
    try {
      stubPublicApi({
        pods: [communityPod({
          tokenId: 42,
          description: 'ArAIstotle YES 0.45 | mkt 0.605 | full analysis with sources…',
          imageUrl: 'https://cdn.example/chart.png',
        })],
      });
      await cmd.execute();
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.pods[0]!.description).toContain('full analysis with sources');
      expect(out.pods[0]!.mediaUrl).toBe('https://cdn.example/chart.png');
    } finally {
      restoreEnv();
    }
  });

  it('defaults description to "" and omits mediaUrl when the API row lacks them', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true });
    try {
      stubPublicApi({ pods: [communityPod({ tokenId: 1 })] }); // fixture has no description/media
      await cmd.execute();
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.pods[0]!.description).toBe('');
      expect(out.pods[0]!.mediaUrl).toBeUndefined();
    } finally {
      restoreEnv();
    }
  });

  it('maps privateSubnetId CUID to a numeric datanetId', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true });
    try {
      stubPublicApi({
        pods: [communityPod({ tokenId: 7, privateSubnetId: 'cuid-A' })],
        subnets: [{ id: 'cuid-A', tokenId: '19' }],
      });
      await cmd.execute();
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.pods[0]!.datanetId).toBe('19');
    } finally {
      restoreEnv();
    }
  });

  it('--all --datanet 19 returns only pods in that datanet', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true, datanet: '19' });
    try {
      stubPublicApi({
        pods: [
          communityPod({ tokenId: 1, privateSubnetId: 'cuid-A' }),
          communityPod({ tokenId: 2, privateSubnetId: 'cuid-B' }),
          communityPod({ tokenId: 3, privateSubnetId: 'cuid-A' }),
        ],
        subnets: [
          { id: 'cuid-A', tokenId: '19' },
          { id: 'cuid-B', tokenId: '20' },
        ],
      });
      const code = await cmd.execute();
      expect(code).toBe(0);
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.datanet).toBe('19');
      expect(out.pods.map((p) => p.podId)).toEqual(['1', '3']);
    } finally {
      restoreEnv();
    }
  });

  it('--all --datanet with an unknown id exits DATANET_NOT_FOUND', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true, datanet: '999' });
    try {
      stubPublicApi({ pods: [communityPod()], subnets: [{ id: 'cuid-A', tokenId: '19' }] });
      await expect(cmd.execute()).rejects.toThrow(/__exit_/);
      expect(parseErr(capturedErrorJson).code).toBe('DATANET_NOT_FOUND');
    } finally {
      restoreEnv();
    }
  });

  it('--all with --include-emissions exits INCOMPATIBLE_FLAGS before any fetch', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true, includeEmissions: true });
    try {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(cmd.execute()).rejects.toThrow(/__exit_/);
      expect(parseErr(capturedErrorJson).code).toBe('INCOMPATIBLE_FLAGS');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
    }
  });

  it('--all emits vote volumes as strings and podId from the on-chain tokenId', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true });
    try {
      stubPublicApi({
        pods: [communityPod({ tokenId: 325, cumulativeUpVotesVolume: 57882, cumulativeDownVotesVolume: 12 })],
      });
      await cmd.execute();
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.pods[0]!.podId).toBe('325');
      expect(out.pods[0]!.upVotes).toBe('57882');
      expect(out.pods[0]!.downVotes).toBe('12');
    } finally {
      restoreEnv();
    }
  });

  it('--all --limit caps the result set', async () => {
    const { cmd, restoreEnv } = makeCommand({ all: true, limit: '2' });
    try {
      stubPublicApi({
        pods: Array.from({ length: 5 }, (_, i) => communityPod({ tokenId: i + 1 })),
      });
      await cmd.execute();
      const out = JSON.parse(capturedJson!) as CommunityResult;
      expect(out.count).toBe(2);
    } finally {
      restoreEnv();
    }
  });
});
