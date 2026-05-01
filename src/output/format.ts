/**
 * Output formatting for the CLI. Two modes:
 *   - human (default): printed via console.log, friendly multi-line
 *   - json: single JSON object on stdout per command
 *
 * Errors ALWAYS emit JSON on stderr regardless of mode, with a stable
 * `code` field agents can match on. Human mode also prints a friendly
 * line to stderr above the JSON for terminal users.
 */

export type OutputMode = 'human' | 'json';

export interface CliError {
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export interface FormatContext {
  mode: OutputMode;
}

let activeMode: OutputMode = 'human';

export function setOutputMode(mode: OutputMode): void {
  activeMode = mode;
}

export function getOutputMode(): OutputMode {
  return activeMode;
}

/** Emit a successful command result. */
export function emit(payload: Record<string, unknown>, humanLines?: string[]): void {
  if (activeMode === 'json') {
    process.stdout.write(JSON.stringify(payload) + '\n');
    return;
  }
  if (humanLines) {
    for (const line of humanLines) process.stdout.write(line + '\n');
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
}

/**
 * Emit a structured error to stderr and exit non-zero. Always JSON on
 * stderr — agents reading stderr always get parseable output, regardless
 * of mode.
 */
export function fail(err: CliError, exitCode = 1): never {
  if (activeMode === 'human') {
    process.stderr.write(`✗ ${err.code}: ${err.message}\n`);
    if (err.hint) process.stderr.write(`  hint: ${err.hint}\n`);
  }
  process.stderr.write(JSON.stringify({ error: err }) + '\n');
  process.exit(exitCode);
}
