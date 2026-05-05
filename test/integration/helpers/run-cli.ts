import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the local CLI via tsx (no build step required). Inherits the parent
 * process env so REPPO_RPC_URL set by globalSetup flows through.
 *
 * Never throws on non-zero exit — tests should assert against exitCode
 * directly so the structured stderr JSON can be parsed even on failure.
 */
export async function runCli(args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'npx',
      ['tsx', 'src/bin.ts', ...args],
      { cwd: REPO_ROOT, env: process.env },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
  }
}
