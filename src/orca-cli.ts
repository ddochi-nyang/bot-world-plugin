import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeJsonParse } from './types.ts';

export const TRUSTED_ORCA_PATHS: readonly string[] = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  '/opt/homebrew/bin/orca',
  '/usr/local/bin/orca',
] as const;

const TRUSTED_REALPATH_PREFIXES: readonly string[] = [
  '/Applications/Orca.app/Contents/Resources/bin/',
  '/opt/homebrew/',
  '/usr/local/',
] as const;

const SAFE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
] as const;

export const MAX_CLI_TIMEOUT_MS = 8_000;
export const DEFAULT_CLI_TIMEOUT_MS = 4_000;
export const MAX_CLI_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_CLI = 4;

export type CliEnvelope<T> = {
  id?: string;
  ok: boolean;
  result?: T;
  error?: {
    code?: string;
    message?: string;
  };
  _meta?: {
    runtimeId?: string;
  };
};

export type CliRunnerResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type CliRunner = (
  binaryPath: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    maxBufferBytes: number;
    env: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<CliRunnerResult>;

export class OrcaCliError extends Error {
  readonly code:
    | 'binary_not_found'
    | 'invalid_argument'
    | 'disallowed_command'
    | 'runtime_unavailable'
    | 'timeout'
    | 'output_too_large'
    | 'non_zero_exit'
    | 'json_error'
    | 'stopped';

  constructor(
    code:
      | 'binary_not_found'
      | 'invalid_argument'
      | 'disallowed_command'
      | 'runtime_unavailable'
      | 'timeout'
      | 'output_too_large'
      | 'non_zero_exit'
      | 'json_error'
      | 'stopped',
    message: string
  ) {
    super(message);
    this.name = 'OrcaCliError';
    this.code = code;
  }
}

export function buildMinimalSafeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const val = sourceEnv[key];
    if (typeof val !== 'string' || val.length === 0 || val.includes('\0')) {
      continue;
    }
    if (key === 'PATH') {
      const filtered = val
        .split(path.delimiter)
        .filter((seg) => seg.length > 0 && seg.startsWith('/'));
      if (filtered.length > 0) {
        safe[key] = filtered.join(path.delimiter);
      }
      continue;
    }
    safe[key] = val;
  }
  return safe;
}

function isWorldWritable(mode: number): boolean {
  return (mode & 0o002) !== 0;
}

function isGroupWritable(mode: number): boolean {
  return (mode & 0o020) !== 0;
}

function isExecutable(mode: number): boolean {
  return (mode & 0o111) !== 0;
}

function isTrustedOwnerUid(uid: number): boolean {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid === 0 || (currentUid !== null && uid === currentUid);
}

function isTrustedDirectoryMode(dirPath: string, stat: fs.Stats): boolean {
  if (!stat.isDirectory() || isWorldWritable(stat.mode)) {
    return false;
  }
  if (!isTrustedOwnerUid(stat.uid)) {
    return false;
  }
  if (!isGroupWritable(stat.mode)) {
    return true;
  }
  // Allow macOS system admin (/Applications) or Homebrew (/opt/homebrew) admin-group dirs
  const isSystemAdminGid = stat.gid === 0 || stat.gid === 80;
  if (!isSystemAdminGid) {
    return false;
  }
  if (stat.uid === 0 && (dirPath === '/Applications' || dirPath.startsWith('/Applications/'))) {
    return true;
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    currentUid !== null &&
    stat.uid === currentUid &&
    (dirPath === '/opt/homebrew' || dirPath.startsWith('/opt/homebrew/'))
  ) {
    return true;
  }
  return false;
}

function hasSafeRealpathAncestors(resolvedTargetPath: string): boolean {
  let dir = path.dirname(resolvedTargetPath);
  for (;;) {
    const dirStat = fs.lstatSync(dir);
    if (isWorldWritable(dirStat.mode)) {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return true;
}

export function verifyTrustedBinaryPath(
  candidate: string,
  allowedPaths: readonly string[] = TRUSTED_ORCA_PATHS,
  trustedPrefixes: readonly string[] = TRUSTED_REALPATH_PREFIXES
): string | null {
  if (!allowedPaths.includes(candidate)) {
    return null;
  }
  try {
    const lstat = fs.lstatSync(candidate);
    if (isWorldWritable(lstat.mode) || !isTrustedOwnerUid(lstat.uid)) {
      return null;
    }
    const parentDir = path.dirname(candidate);
    const parentStat = fs.statSync(parentDir);
    if (!isTrustedDirectoryMode(parentDir, parentStat)) {
      return null;
    }

    if (lstat.isSymbolicLink()) {
      if (isGroupWritable(lstat.mode)) {
        return null;
      }
      const resolved = fs.realpathSync(candidate);
      const inTrustedPrefix = trustedPrefixes.some((prefix) => resolved.startsWith(prefix));
      if (!inTrustedPrefix) {
        return null;
      }
      const targetStat = fs.statSync(resolved);
      if (
        !targetStat.isFile() ||
        !isExecutable(targetStat.mode) ||
        isWorldWritable(targetStat.mode) ||
        isGroupWritable(targetStat.mode) ||
        !isTrustedOwnerUid(targetStat.uid)
      ) {
        return null;
      }
      const targetParent = path.dirname(resolved);
      const targetParentStat = fs.statSync(targetParent);
      if (!isTrustedDirectoryMode(targetParent, targetParentStat)) {
        return null;
      }
      if (!hasSafeRealpathAncestors(resolved)) {
        return null;
      }
      return resolved;
    }

    if (!lstat.isFile() || !isExecutable(lstat.mode) || isGroupWritable(lstat.mode)) {
      return null;
    }
    const resolved = fs.realpathSync(candidate);
    if (!hasSafeRealpathAncestors(resolved)) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

export function discoverOrcaBinary(): string | null {
  for (const candidate of TRUSTED_ORCA_PATHS) {
    const verified = verifyTrustedBinaryPath(candidate);
    if (verified) {
      return verified;
    }
  }
  return null;
}

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const QUICK_MESSAGE_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SHELL_META_RE = /[;|&$`<>\\/]/;
export const MAX_QUICK_MESSAGE_CHARS = 500;
export const MAX_ITEM_NUMBER = 999_999_999;

export function validateItemNumber(itemNumber: number): number {
  if (
    typeof itemNumber !== 'number' ||
    !Number.isSafeInteger(itemNumber) ||
    itemNumber < 1 ||
    itemNumber > MAX_ITEM_NUMBER
  ) {
    throw new OrcaCliError(
      'invalid_argument',
      `itemNumber must be an integer between 1 and ${MAX_ITEM_NUMBER}`
    );
  }
  return itemNumber;
}

export function validateBotName(botName: string): string {
  if (typeof botName !== 'string') {
    throw new OrcaCliError('invalid_argument', 'botName must be a string');
  }
  const trimmed = botName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new OrcaCliError('invalid_argument', 'botName length out of bounds');
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    throw new OrcaCliError('invalid_argument', 'botName contains control characters');
  }
  if (SHELL_META_RE.test(trimmed)) {
    throw new OrcaCliError('invalid_argument', 'botName contains disallowed characters');
  }
  if (trimmed.startsWith('-')) {
    throw new OrcaCliError('invalid_argument', 'botName cannot start with "-"');
  }
  return trimmed;
}

export function validateSince(since: string): string {
  if (typeof since !== 'string' || !/^[1-9][0-9]{0,3}[smhd]$/.test(since)) {
    throw new OrcaCliError('invalid_argument', 'since must match ^[1-9][0-9]{0,3}[smhd]$');
  }
  return since;
}

export function clampLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new OrcaCliError('invalid_argument', 'limit must be a finite number');
  }
  const intVal = Math.trunc(limit);
  return Math.max(1, Math.min(200, intVal));
}

const CURSOR_SAFE_RE = /^[A-Za-z0-9_.:=+/-]+$/;

export function validateCursor(cursor: string): string {
  if (typeof cursor !== 'string') {
    throw new OrcaCliError('invalid_argument', 'cursor must be a string');
  }
  const trimmed = cursor.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new OrcaCliError('invalid_argument', 'cursor length out of bounds');
  }
  if (
    CONTROL_CHAR_RE.test(trimmed) ||
    trimmed.startsWith('-') ||
    /\s/.test(trimmed) ||
    !CURSOR_SAFE_RE.test(trimmed)
  ) {
    throw new OrcaCliError('invalid_argument', 'cursor contains invalid characters');
  }
  return trimmed;
}

/**
 * Runtime enforcement of the read-only subcommand allowlist.
 * Rejects any non-read-only command or unexpected argument shape before spawning.
 */
export function assertAllowedSubcommand(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length < 2) {
    throw new OrcaCliError('disallowed_command', 'Command arguments missing');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || CONTROL_CHAR_RE.test(arg)) {
      throw new OrcaCliError('invalid_argument', 'Argument contains control characters');
    }
  }

  // Exact structural match against read-only commands
  const a0 = args[0];
  const a1 = args[1];

  if (a0 === 'status' && args.length === 2 && a1 === '--json') return;

  if (a0 === 'bot' && a1 === 'list' && args.length === 3 && args[2] === '--json') return;

  if (
    a0 === 'bot' &&
    a1 === 'chats' &&
    args.length === 6 &&
    args[2] === '--bot' &&
    args[4] === '--all' &&
    args[5] === '--json'
  ) {
    validateBotName(args[3]);
    return;
  }

  if (a0 === 'bot' && a1 === 'item' && args[2] === 'list' && args[3] === '--bot') {
    if (args.length === 6 && args[5] === '--json') {
      validateBotName(args[4]);
      return;
    }
    if (args.length === 7 && args[5] === '--all' && args[6] === '--json') {
      validateBotName(args[4]);
      return;
    }
  }

  if (
    a0 === 'worktree' &&
    a1 === 'ps' &&
    args.length === 5 &&
    args[2] === '--since' &&
    args[4] === '--json'
  ) {
    validateSince(args[3]);
    return;
  }

  if (
    a0 === 'orchestration' &&
    a1 === 'inbox' &&
    args.length === 6 &&
    args[2] === '--limit' &&
    args[4] === '--full' &&
    args[5] === '--json' &&
    /^[1-9][0-9]*$/.test(args[3])
  ) {
    const n = Number(args[3]);
    if (n >= 1 && n <= 200) return;
  }

  if (a0 === 'orchestration' && a1 === 'worker-list' && args[2] === '--limit') {
    if (
      args.length === 6 &&
      /^[1-9][0-9]*$/.test(args[3]) &&
      Number(args[3]) <= 200 &&
      args[4] === '--full' &&
      args[5] === '--json'
    ) {
      return;
    }
    if (
      args.length === 8 &&
      /^[1-9][0-9]*$/.test(args[3]) &&
      Number(args[3]) <= 200 &&
      args[4] === '--cursor' &&
      args[6] === '--full' &&
      args[7] === '--json'
    ) {
      validateCursor(args[5]);
      return;
    }
  }

  if (
    a0 === 'orchestration' &&
    a1 === 'run-list' &&
    args.length === 4 &&
    args[2] === '--full' &&
    args[3] === '--json'
  ) {
    return;
  }

  if (a0 === 'automations' && a1 === 'list' && args.length === 3 && args[2] === '--json') {
    return;
  }

  if (a0 === 'automations' && a1 === 'runs' && args.length === 3 && args[2] === '--json') {
    return;
  }

  throw new OrcaCliError('disallowed_command', `Command is not in the read-only allowlist: ${a0}`);
}

const defaultExecFileRunner: CliRunner = (binaryPath, args, options) => {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [...args],
      {
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        env: options.env,
        windowsHide: true,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errObj = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
            code?: string | number;
          };
          if (errObj.name === 'AbortError') {
            reject(new OrcaCliError('stopped', 'CLI command aborted'));
            return;
          }
          if (errObj.killed && errObj.signal === 'SIGTERM') {
            reject(new OrcaCliError('timeout', `CLI command timed out after ${options.timeoutMs}ms`));
            return;
          }
          if (errObj.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new OrcaCliError('output_too_large', 'CLI output exceeded 2 MiB limit'));
            return;
          }
          // Non-zero exit code can still carry JSON stdout envelope
          const exitCode = typeof errObj.code === 'number' ? errObj.code : null;
          resolve({
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : errObj.message,
            exitCode,
          });
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          exitCode: 0,
        });
      }
    );
  });
};

export interface OrcaClient {
  isStopped(): boolean;
  status(): Promise<CliEnvelope<unknown>>;
  botList(): Promise<CliEnvelope<unknown>>;
  botChats(botName: string): Promise<CliEnvelope<unknown>>;
  botItemList(botName: string, all: boolean): Promise<CliEnvelope<unknown>>;
  worktreePs(since?: string): Promise<CliEnvelope<unknown>>;
  orchestrationInbox(limit: number): Promise<CliEnvelope<unknown>>;
  orchestrationWorkerList(limit: number, cursor?: string | null): Promise<CliEnvelope<unknown>>;
  orchestrationRunList(): Promise<CliEnvelope<unknown>>;
  automationsList(): Promise<CliEnvelope<unknown>>;
  automationsRuns(): Promise<CliEnvelope<unknown>>;
}

export class OrcaCli implements OrcaClient {
  private readonly binaryPath: string | null;
  private readonly hasCustomRunner: boolean;
  private readonly timeoutMs: number;
  private readonly runner: CliRunner;
  private readonly env: Record<string, string>;
  private stopped = false;
  private activeCount = 0;
  private readonly waiters: Array<(granted: boolean) => void> = [];
  private abortController = new AbortController();

  constructor(options?: {
    binaryPath?: string | null;
    timeoutMs?: number;
    runner?: CliRunner;
    env?: Record<string, string>;
  }) {
    // Only allow custom binaryPath when explicit runner is injected (tests);
    // otherwise strictly use discoverOrcaBinary() allowlist.
    if (options?.runner) {
      this.hasCustomRunner = true;
      this.runner = options.runner;
      this.binaryPath =
        options.binaryPath === undefined ? '/Applications/Orca.app/Contents/Resources/bin/orca' : options.binaryPath;
    } else {
      this.hasCustomRunner = false;
      this.runner = defaultExecFileRunner;
      this.binaryPath = discoverOrcaBinary();
    }
    const rawTimeout = options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    this.timeoutMs = Math.max(100, Math.min(MAX_CLI_TIMEOUT_MS, Math.trunc(rawTimeout)));
    this.env = options?.env ?? buildMinimalSafeEnv();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.(false);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.stopped) {
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
    if (this.activeCount < MAX_CONCURRENT_CLI) {
      this.activeCount++;
      return;
    }
    const granted = await new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
    if (this.stopped || !granted) {
      if (granted) {
        this.releaseSlot();
      }
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next && !this.stopped) {
      next(true);
      return;
    }
    if (next) {
      next(false);
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
  }

  async runEnvelope<T = unknown>(args: readonly string[]): Promise<CliEnvelope<T>> {
    assertAllowedSubcommand(args);
    if (this.stopped) {
      throw new OrcaCliError('stopped', 'Orca CLI stopped');
    }
    const execPath = this.hasCustomRunner ? this.binaryPath : discoverOrcaBinary();
    if (!execPath) {
      throw new OrcaCliError('binary_not_found', 'Trusted Orca CLI binary not found');
    }

    await this.acquireSlot();
    try {
      const res = await this.runner(execPath, args, {
        timeoutMs: this.timeoutMs,
        maxBufferBytes: MAX_CLI_OUTPUT_BYTES,
        env: this.env,
        signal: this.abortController.signal,
      });

      if (Buffer.byteLength(res.stdout, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
        throw new OrcaCliError('output_too_large', 'CLI stdout exceeded 2 MiB');
      }

      if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
        const stderr = res.stderr.trim();
        if (stderr.includes('not reachable') || stderr.includes('runtime_unavailable')) {
          throw new OrcaCliError('runtime_unavailable', stderr || 'Orca runtime unavailable');
        }
        throw new OrcaCliError(
          'non_zero_exit',
          `orca command exited with ${String(res.exitCode)}: ${stderr}`
        );
      }

      let parsed: CliEnvelope<T>;
      try {
        parsed = safeJsonParse<CliEnvelope<T>>(res.stdout, MAX_CLI_OUTPUT_BYTES);
      } catch (err) {
        throw new OrcaCliError(
          'json_error',
          `Failed to parse CLI JSON: ${err instanceof Error ? err.message : 'invalid json'}`
        );
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new OrcaCliError('json_error', 'CLI returned non-object envelope');
      }

      if (!parsed.ok && parsed.error) {
        const code = String(parsed.error.code ?? '');
        const msg = String(parsed.error.message ?? '');
        if (code === 'runtime_unavailable' || msg.includes('not reachable')) {
          throw new OrcaCliError('runtime_unavailable', msg || 'Orca runtime unavailable');
        }
        throw new OrcaCliError('non_zero_exit', `${code}: ${msg}`);
      }

      return parsed;
    } finally {
      this.releaseSlot();
    }
  }

  async status(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['status', '--json']);
  }

  async botList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['bot', 'list', '--json']);
  }

  async botChats(botName: string): Promise<CliEnvelope<unknown>> {
    const clean = validateBotName(botName);
    return this.runEnvelope(['bot', 'chats', '--bot', clean, '--all', '--json']);
  }

  async botItemList(botName: string, all: boolean): Promise<CliEnvelope<unknown>> {
    const clean = validateBotName(botName);
    return this.runEnvelope(
      all
        ? ['bot', 'item', 'list', '--bot', clean, '--all', '--json']
        : ['bot', 'item', 'list', '--bot', clean, '--json']
    );
  }

  async worktreePs(since = '24h'): Promise<CliEnvelope<unknown>> {
    const cleanSince = validateSince(since);
    return this.runEnvelope(['worktree', 'ps', '--since', cleanSince, '--json']);
  }

  async orchestrationInbox(limit: number): Promise<CliEnvelope<unknown>> {
    const clamped = clampLimit(limit);
    return this.runEnvelope(['orchestration', 'inbox', '--limit', String(clamped), '--full', '--json']);
  }

  async orchestrationWorkerList(limit: number, cursor?: string | null): Promise<CliEnvelope<unknown>> {
    const clamped = clampLimit(limit);
    if (cursor !== undefined && cursor !== null && cursor.length > 0) {
      const cleanCursor = validateCursor(cursor);
      return this.runEnvelope([
        'orchestration',
        'worker-list',
        '--limit',
        String(clamped),
        '--cursor',
        cleanCursor,
        '--full',
        '--json',
      ]);
    }
    return this.runEnvelope([
      'orchestration',
      'worker-list',
      '--limit',
      String(clamped),
      '--full',
      '--json',
    ]);
  }

  async orchestrationRunList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['orchestration', 'run-list', '--full', '--json']);
  }

  async automationsList(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['automations', 'list', '--json']);
  }

  async automationsRuns(): Promise<CliEnvelope<unknown>> {
    return this.runEnvelope(['automations', 'runs', '--json']);
  }
}

/**
 * Validates an opt-in Quick Send message body.
 * Rejects NUL and ASCII control characters (normalizing tabs/newlines cleanly) and enforces 1..500 chars.
 */
export function validateQuickMessageBody(rawMessage: string): string {
  if (typeof rawMessage !== 'string') {
    throw new OrcaCliError('invalid_argument', 'message must be a string');
  }
  if (rawMessage.includes('\0') || QUICK_MESSAGE_CONTROL_CHAR_RE.test(rawMessage)) {
    throw new OrcaCliError('invalid_argument', 'message contains disallowed control characters');
  }
  const normalized = rawMessage
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .trim();
  const charCount = Array.from(normalized).length;
  if (charCount === 0 || charCount > MAX_QUICK_MESSAGE_CHARS) {
    throw new OrcaCliError(
      'invalid_argument',
      `message must be 1..${MAX_QUICK_MESSAGE_CHARS} characters`
    );
  }
  return normalized;
}

/**
 * Builds an execFile argument vector for opt-in Quick Send.
 * Kept strictly separate from the read-only `assertAllowedSubcommand()` allowlist.
 */
export function buildQuickSendArgs(botName: string, message: string): string[] {
  const cleanBot = validateBotName(botName);
  const cleanBody = validateQuickMessageBody(message);
  return [
    'orchestration',
    'send',
    '--to',
    `bot:${cleanBot}`,
    '--subject',
    'Bot World Quick Message',
    '--body',
    cleanBody,
    '--json',
  ];
}

/**
 * Builds an execFile argument vector for opt-in Needs You item replies.
 * Kept strictly separate from the read-only `assertAllowedSubcommand()` allowlist.
 */
export function buildItemReplyArgs(
  botName: string,
  itemNumber: number,
  answerText: string
): string[] {
  const cleanBot = validateBotName(botName);
  const cleanNum = validateItemNumber(itemNumber);
  const cleanBody = validateQuickMessageBody(answerText);
  return [
    'orchestration',
    'send',
    '--to',
    `bot:${cleanBot}`,
    '--item',
    String(cleanNum),
    '--subject',
    'Bot World Decision Reply',
    '--body',
    cleanBody,
    '--json',
  ];
}

export type CliWriteOptions = {
  binaryPath?: string | null;
  timeoutMs?: number;
  runner?: CliRunner;
  env?: Record<string, string>;
  signal?: AbortSignal;
};

async function runWriteEnvelope(
  args: readonly string[],
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const hasCustomRunner = Boolean(options?.runner);
  const execPath = hasCustomRunner
    ? options?.binaryPath === undefined
      ? TRUSTED_ORCA_PATHS[0]
      : options.binaryPath
    : discoverOrcaBinary();
  if (!execPath) {
    throw new OrcaCliError('binary_not_found', 'Trusted Orca CLI binary not found');
  }

  const runner = options?.runner ?? defaultExecFileRunner;
  const rawTimeout = options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const timeoutMs = Math.max(100, Math.min(MAX_CLI_TIMEOUT_MS, Math.trunc(rawTimeout)));
  const env = options?.env ?? buildMinimalSafeEnv();

  const res = await runner(execPath, args, {
    timeoutMs,
    maxBufferBytes: MAX_CLI_OUTPUT_BYTES,
    env,
    signal: options?.signal,
  });

  if (Buffer.byteLength(res.stdout, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
    throw new OrcaCliError('output_too_large', 'CLI stdout exceeded 2 MiB');
  }

  if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
    const stderr = res.stderr.trim();
    if (stderr.includes('not reachable') || stderr.includes('runtime_unavailable')) {
      throw new OrcaCliError('runtime_unavailable', stderr || 'Orca runtime unavailable');
    }
    throw new OrcaCliError(
      'non_zero_exit',
      `orca command exited with ${String(res.exitCode)}: ${stderr}`
    );
  }

  let parsed: CliEnvelope<unknown>;
  try {
    parsed = safeJsonParse<CliEnvelope<unknown>>(res.stdout, MAX_CLI_OUTPUT_BYTES);
  } catch (err) {
    throw new OrcaCliError(
      'json_error',
      `Failed to parse CLI JSON: ${err instanceof Error ? err.message : 'invalid json'}`
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new OrcaCliError('json_error', 'CLI returned non-object envelope');
  }

  if (!parsed.ok && parsed.error) {
    const code = String(parsed.error.code ?? '');
    const msg = String(parsed.error.message ?? '');
    if (code === 'runtime_unavailable' || msg.includes('not reachable')) {
      throw new OrcaCliError('runtime_unavailable', msg || 'Orca runtime unavailable');
    }
    throw new OrcaCliError('non_zero_exit', `${code}: ${msg}`);
  }

  return parsed;
}

export async function sendQuickBotMessage(
  botName: string,
  message: string,
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const args = buildQuickSendArgs(botName, message);
  return runWriteEnvelope(args, options);
}

export async function replyNeedsOwnerItem(
  botName: string,
  itemNumber: number,
  answerText: string,
  options?: CliWriteOptions
): Promise<CliEnvelope<unknown>> {
  const args = buildItemReplyArgs(botName, itemNumber, answerText);
  return runWriteEnvelope(args, options);
}
