/**
 * Unit tests for the Phase-2 agents API helpers. `fetch` is stubbed with
 * `vi.stubGlobal` so the suite runs offline. Pinata file reads hit a real
 * temp file written per-test (no fs mocking — simpler and exercises the
 * Blob/FormData path the way Node actually runs it).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pinDatasetToIpfs,
  registerPodMetadata,
  AGENTS_API_BASE,
  type PodMetadata,
} from './agents.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const META: PodMetadata = {
  txHash: '0xabc',
  subnetId: 'cmnhuowns000bic04e16t6735',
  podName: 'Test pod',
  podDescription: 'desc',
  url: 'https://ipfs.io/ipfs/Qm123',
  platform: 'reppo-cli',
  category: 'Dataset',
  agreeToTerms: true,
  imageURL: '',
  thumbnailURL: '',
  pdfURL: 'https://ipfs.io/ipfs/Qm123',
  videoURL: '',
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'reppo-agents-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('pinDatasetToIpfs', () => {
  it('returns the public-gateway URL on a successful pin', async () => {
    const file = join(tmp, 'data.json');
    writeFileSync(file, JSON.stringify({ rows: 1 }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ IpfsHash: 'QmABC' }))));

    const url = await pinDatasetToIpfs(file, 'jwt-token');
    expect(url).toBe('https://ipfs.io/ipfs/QmABC');
  });

  it('sends the file as multipart with the Bearer JWT', async () => {
    const file = join(tmp, 'data.json');
    writeFileSync(file, JSON.stringify({ rows: 1 }));
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ IpfsHash: 'QmABC' })));
    vi.stubGlobal('fetch', fetchSpy);

    await pinDatasetToIpfs(file, 'jwt-token');
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('throws DATASET_FILE_NOT_FOUND when the file is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(pinDatasetToIpfs(join(tmp, 'nope.json'), 'jwt')).rejects.toMatchObject({
      code: 'DATASET_FILE_NOT_FOUND',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws MISSING_PINATA_JWT when the JWT is empty', async () => {
    const file = join(tmp, 'data.json');
    writeFileSync(file, '{}');
    await expect(pinDatasetToIpfs(file, '')).rejects.toMatchObject({ code: 'MISSING_PINATA_JWT' });
  });

  it('throws IPFS_PIN_FAILED on a 403 with no IpfsHash', async () => {
    const file = join(tmp, 'data.json');
    writeFileSync(file, '{}');
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ error: 'NO_SCOPES_FOUND' }, 403)),
    ));
    await expect(pinDatasetToIpfs(file, 'jwt')).rejects.toMatchObject({ code: 'IPFS_PIN_FAILED' });
  });

  it('throws IPFS_PIN_UNREACHABLE on a network error', async () => {
    const file = join(tmp, 'data.json');
    writeFileSync(file, '{}');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
    await expect(pinDatasetToIpfs(file, 'jwt')).rejects.toMatchObject({ code: 'IPFS_PIN_UNREACHABLE' });
  });
});

describe('registerPodMetadata', () => {
  it('POSTs to /agents/{id}/pods with the Bearer apiKey and JSON body', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }, 201)));
    vi.stubGlobal('fetch', fetchSpy);

    const res = await registerPodMetadata('agent-1', 'key-1', META);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AGENTS_API_BASE}/agents/agent-1/pods`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer key-1');
    expect(JSON.parse(init.body as string)).toMatchObject({
      txHash: '0xabc',
      subnetId: 'cmnhuowns000bic04e16t6735',
    });
  });

  it('returns ok:false with the detail on a non-2xx (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(new Response('Internal Server\nError', { status: 500 })),
    ));
    const res = await registerPodMetadata('agent-1', 'key-1', META);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    // Whitespace collapsed to a single line.
    expect(res.detail).toBe('Internal Server Error');
  });

  it('throws PLATFORM_API_UNREACHABLE on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))));
    await expect(registerPodMetadata('a', 'k', META)).rejects.toMatchObject({
      code: 'PLATFORM_API_UNREACHABLE',
    });
  });

  it('honors a custom apiBase override', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({}, 200)));
    vi.stubGlobal('fetch', fetchSpy);
    await registerPodMetadata('a', 'k', META, 'https://staging.example/api/v1');
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://staging.example/api/v1/agents/a/pods');
  });
});
