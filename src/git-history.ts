import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildMinimalSafeEnv } from './orca-cli.ts';
import { scrubAll } from './redact.ts';
import {
  type CharacterId,
  type GitCastMember,
  type GitCommitEvent,
  type GitCommitKind,
  type GitRangeDays,
  type GitRepoSummary,
  type GitTheaterReel,
  POOL_CHARACTER_IDS,
  type UiLocale,
  isValidGitRangeDays,
  stripDangerousKeys,
} from './types.ts';

export const GIT_EXEC_TIMEOUT_MS = 5_000;
export const GIT_MAX_BUFFER_BYTES = 512 * 1024;
export const MAX_GIT_REPOS = 32;
export const MIN_GIT_MAX_COMMITS = 10;
export const MAX_GIT_MAX_COMMITS = 120;
export const DEFAULT_GIT_MAX_COMMITS = 60;
export const DEFAULT_GIT_RANGE_DAYS: GitRangeDays = 14;
export const MAX_GIT_SUBJECT_CHARS = 96;
export const MAX_GIT_CAST = 12;

export const GIT_LOG_PRETTY_FORMAT = '__BW_COMMIT__%x1f%h%x1f%at%x1f%an%x1f%s%x1e';
const COMMIT_PREFIX = '__BW_COMMIT__\x1f';
const REPO_ID_RE = /^repo_\d+$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,6}$/;
const ALLOWED_RPC_INPUT_KEYS = new Set(['repoId', 'rangeDays', 'maxCommits', 'locale']);

export type GitExecOptions = {
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
  env: Record<string, string>;
};

export type GitExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type GitExecRunner = (
  args: readonly string[],
  options: GitExecOptions
) => Promise<GitExecResult>;

export type LocalRepoCandidate = {
  path: string;
  hostId?: string | null;
};

export type VerifiedGitRepo = {
  repoId: string;
  verifiedPath: string;
  repoLabel: string;
  branch: string;
};

export class GitHistoryError extends Error {
  readonly code: 'invalid_params' | 'disallowed_command' | 'git_failed';

  constructor(code: 'invalid_params' | 'disallowed_command' | 'git_failed', message: string) {
    super(message);
    this.name = 'GitHistoryError';
    this.code = code;
  }
}

export function buildMinimalGitEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return {
    ...buildMinimalSafeEnv(sourceEnv),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C.UTF-8',
  };
}

/**
 * Strictly validates read-only git argument vectors before spawning.
 * Rejects write commands, arbitrary flags, shell metacharacters, or email placeholders.
 */
export function assertAllowedGitArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length < 2) {
    throw new GitHistoryError('disallowed_command', 'Git command arguments missing');
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || CONTROL_CHAR_RE.test(arg)) {
      throw new GitHistoryError('disallowed_command', 'Git argument contains control characters');
    }
  }

  if (
    args.length === 2 &&
    args[0] === 'rev-parse' &&
    args[1] === '--is-inside-work-tree'
  ) {
    return;
  }

  if (
    args.length === 3 &&
    args[0] === 'rev-parse' &&
    args[1] === '--abbrev-ref' &&
    args[2] === 'HEAD'
  ) {
    return;
  }

  if (
    args.length === 7 &&
    args[0] === 'log' &&
    args[1] === '--no-color' &&
    args[2] === '--date=unix' &&
    args[3] === '--numstat'
  ) {
    const maxMatch = /^--max-count=(\d+)$/.exec(args[4]);
    const sinceMatch = /^--since=(7|14|30)\.days$/.exec(args[5]);
    const fmt = args[6];
    if (
      maxMatch &&
      sinceMatch &&
      fmt === `--pretty=format:${GIT_LOG_PRETTY_FORMAT}` &&
      !fmt.includes('%ae') &&
      !fmt.includes('%ce') &&
      !fmt.includes('%aE') &&
      !fmt.includes('%cE')
    ) {
      const count = Number(maxMatch[1]);
      if (
        Number.isSafeInteger(count) &&
        count >= MIN_GIT_MAX_COMMITS &&
        count <= MAX_GIT_MAX_COMMITS
      ) {
        return;
      }
    }
  }

  throw new GitHistoryError('disallowed_command', 'Git command is not in the read-only allowlist');
}

export function summarizeGitFailure(rawMessage?: string): string {
  const lower = (rawMessage ?? '').toLowerCase();
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('spawn git')) {
    return 'git binary unavailable';
  }
  if (
    lower.includes('err_child_process_stdio_maxbuffer') ||
    lower.includes('maxbuffer') ||
    lower.includes('max buffer')
  ) {
    return 'git output exceeded limit';
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return 'git command timed out';
  }
  if (lower.includes('not a git repository')) {
    return 'not a git repository';
  }
  return 'git log failed';
}

export const defaultGitExecRunner: GitExecRunner = (args, options) => {
  assertAllowedGitArgs(args);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        shell: false,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        env: options.env,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const errObj = error as NodeJS.ErrnoException & {
            killed?: boolean;
            code?: string | number;
          };
          if (errObj.code === 'ENOENT') {
            reject(new GitHistoryError('git_failed', 'git binary unavailable'));
            return;
          }
          if (errObj.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new GitHistoryError('git_failed', 'git output exceeded limit'));
            return;
          }
          if (errObj.killed || errObj.code === 'ETIMEDOUT') {
            reject(new GitHistoryError('git_failed', 'git command timed out'));
            return;
          }
          const exitCode = typeof errObj.code === 'number' ? errObj.code : null;
          resolve({
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: summarizeGitFailure(typeof stderr === 'string' && stderr.trim() ? stderr : errObj.message),
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

export function clampGitMaxCommits(raw: unknown): number {
  if (raw === undefined) return DEFAULT_GIT_MAX_COMMITS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    throw new GitHistoryError('invalid_params', 'maxCommits must be a positive finite number');
  }
  return Math.max(MIN_GIT_MAX_COMMITS, Math.min(MAX_GIT_MAX_COMMITS, Math.trunc(raw)));
}

export function validateGetGitHistoryReelInput(raw: unknown): {
  repoId: string;
  rangeDays: GitRangeDays;
  maxCommits: number;
  locale?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new GitHistoryError('invalid_params', 'input must be an object');
  }
  const rawObj = raw as Record<string, unknown>;
  for (const key of Object.keys(rawObj)) {
    if (!ALLOWED_RPC_INPUT_KEYS.has(key)) {
      throw new GitHistoryError('invalid_params', `Unsupported field: ${key}`);
    }
  }
  const clean = stripDangerousKeys(rawObj);
  const rawRepoId = clean.repoId;
  if (
    typeof rawRepoId !== 'string' ||
    CONTROL_CHAR_RE.test(rawRepoId) ||
    !REPO_ID_RE.test(rawRepoId)
  ) {
    throw new GitHistoryError('invalid_params', 'Invalid repoId');
  }

  let rangeDays: GitRangeDays = DEFAULT_GIT_RANGE_DAYS;
  if (clean.rangeDays !== undefined) {
    if (!isValidGitRangeDays(clean.rangeDays)) {
      throw new GitHistoryError('invalid_params', 'rangeDays must be 7, 14, or 30');
    }
    rangeDays = clean.rangeDays;
  }

  const maxCommits = clampGitMaxCommits(clean.maxCommits);

  let locale: string | undefined;
  if (clean.locale !== undefined && clean.locale !== null) {
    if (
      typeof clean.locale !== 'string' ||
      clean.locale.length > 64 ||
      CONTROL_CHAR_RE.test(clean.locale) ||
      !LOCALE_TAG_RE.test(clean.locale.trim())
    ) {
      throw new GitHistoryError('invalid_params', 'Invalid locale');
    }
    locale = clean.locale.trim();
  }

  return { repoId: rawRepoId, rangeDays, maxCommits, locale };
}

function truncateCodePoints(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

export function normalizeCommitSubject(raw: string): string {
  const singleLine = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const scrubbed = scrubAll(singleLine);
  return truncateCodePoints(scrubbed || 'Commit', MAX_GIT_SUBJECT_CHARS);
}

export function deriveAuthorKey(rawAuthorName: string): string {
  const normalized = rawAuthorName.trim().toLowerCase() || 'unknown';
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `a_${digest.slice(0, 12)}`;
}

export function classifyCommitKind(subject: string): GitCommitKind {
  const trimmed = subject.trim();
  if (/^merge\b/i.test(trimmed)) {
    return 'merge';
  }
  const conv = /^(feat|fix|refactor|test|docs|chore|perf|style|build|ci|revert)(\([^)]*\))?!?:\s*/i.exec(
    trimmed
  );
  if (conv) {
    const tag = conv[1].toLowerCase();
    switch (tag) {
      case 'feat':
        return 'feat';
      case 'fix':
        return 'fix';
      case 'refactor':
      case 'perf':
      case 'style':
        return 'refactor';
      case 'test':
        return 'test';
      case 'docs':
        return 'docs';
      case 'chore':
      case 'build':
      case 'ci':
      case 'revert':
        return 'chore';
    }
  }
  return 'other';
}

export function isReleaseSubject(subject: string): boolean {
  const trimmed = subject.trim();
  return (
    /^release[:\s]/i.test(trimmed) ||
    /^chore\(release\):/i.test(trimmed) ||
    /\bv\d+\.\d+\.\d+\b/i.test(trimmed)
  );
}

export function isMilestoneCommit(
  commit: Pick<GitCommitEvent, 'filesChanged' | 'insertions' | 'deletions' | 'subject'>,
  index: number,
  total: number
): boolean {
  if (index === 0 || index === total - 1) return true;
  if (commit.filesChanged >= 8 || commit.insertions + commit.deletions >= 300) return true;
  if (isReleaseSubject(commit.subject)) return true;
  return false;
}

function extractAreaFromNumstatPath(rawFilePath: string): string {
  let cleaned = rawFilePath.trim();
  // Normalize git rename format: "prefix/{old => new}/file" or "old => new"
  const braceRename = /^(.*)\{[^}]*\s=>\s([^}]*)\}(.*)$/.exec(cleaned);
  if (braceRename) {
    cleaned = `${braceRename[1]}${braceRename[2]}${braceRename[3]}`.replace(/\/+/g, '/');
  } else if (cleaned.includes(' => ')) {
    const parts = cleaned.split(' => ');
    cleaned = (parts[parts.length - 1] ?? cleaned).trim();
  }
  cleaned = cleaned.replace(/^\/+/, '');
  if (!cleaned) return 'repo';
  const slashIdx = cleaned.indexOf('/');
  const segment = slashIdx >= 0 ? cleaned.slice(0, slashIdx) : cleaned;
  const scrubbed = scrubAll(segment).trim();
  return truncateCodePoints(scrubbed || 'repo', 40);
}

function clampNonNegInt(raw: string): number {
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

function deterministicCharacterForAuthor(authorKey: string): CharacterId {
  let hash = 2166136261;
  for (let i = 0; i < authorKey.length; i++) {
    hash ^= authorKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const idx = (hash >>> 0) % POOL_CHARACTER_IDS.length;
  return POOL_CHARACTER_IDS[idx];
}

function formatRedactedAuthorName(index1Based: number, locale: UiLocale): string {
  return locale === 'ko' ? `작성자 #${index1Based}` : `Author #${index1Based}`;
}

export function parseGitLogOutput(
  stdout: string,
  opts: {
    repoId: string;
    repoLabel: string;
    branch: string;
    rangeDays: GitRangeDays;
    nowMs?: number;
    locale?: UiLocale;
  }
): GitTheaterReel {
  const locale: UiLocale = opts.locale === 'ko' ? 'ko' : 'en';
  const nowMs =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) && opts.nowMs > 0
      ? Math.trunc(opts.nowMs)
      : Date.now();

  type DraftCommit = {
    shortHash: string;
    timestampMs: number;
    authorKey: string;
    authorName: string;
    subject: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    commitKind: GitCommitKind;
    areaWeights: Map<string, number>;
    rawOrder: number;
  };

  const drafts: DraftCommit[] = [];
  let current: DraftCommit | null = null;
  const lines = stdout.split(/\r?\n/);

  for (const rawLine of lines) {
    if (rawLine.startsWith(COMMIT_PREFIX)) {
      const endTrimmed = rawLine.endsWith('\x1e') ? rawLine.slice(0, -1) : rawLine;
      const fields = endTrimmed.slice(COMMIT_PREFIX.length).split('\x1f');
      const rawHash = (fields[0] ?? '').trim();
      const rawSec = (fields[1] ?? '').trim();
      const rawAuthor = fields[2] ?? '';
      const rawSubject = fields.slice(3).join(' ');

      const cleanHash = truncateCodePoints(
        scrubAll(rawHash.replace(/[^0-9a-fA-F]/g, '').slice(0, 12) || '0000000'),
        12
      );
      const unixSec = /^\d+$/.test(rawSec) ? Number(rawSec) : 0;
      const timestampMs =
        Number.isSafeInteger(unixSec) && unixSec > 0 ? unixSec * 1000 : nowMs;
      const authorKey = deriveAuthorKey(rawAuthor);
      const authorName = truncateCodePoints(scrubAll(rawAuthor.trim()) || 'Author', 48);
      const subject = normalizeCommitSubject(rawSubject);
      const commitKind = classifyCommitKind(subject);

      current = {
        shortHash: cleanHash,
        timestampMs,
        authorKey,
        authorName,
        subject,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        commitKind,
        areaWeights: new Map<string, number>(),
        rawOrder: drafts.length,
      };
      drafts.push(current);
      continue;
    }

    if (!current || rawLine.trim().length === 0) continue;
    const tabParts = rawLine.split('\t');
    if (tabParts.length < 3) continue;
    const insRaw = tabParts[0].trim();
    const delRaw = tabParts[1].trim();
    const filePath = tabParts.slice(2).join('\t');
    const ins = insRaw === '-' ? 0 : clampNonNegInt(insRaw);
    const del = delRaw === '-' ? 0 : clampNonNegInt(delRaw);
    current.filesChanged += 1;
    current.insertions += ins;
    current.deletions += del;

    const area = extractAreaFromNumstatPath(filePath);
    const weight = 1 + Math.min(200, ins + del);
    current.areaWeights.set(area, (current.areaWeights.get(area) ?? 0) + weight);
  }

  // Sort oldest -> newest (preserving git log reverse position on identical timestamps)
  drafts.sort((a, b) => a.timestampMs - b.timestampMs || b.rawOrder - a.rawOrder);

  const boundedDrafts = drafts.slice(-MAX_GIT_MAX_COMMITS);
  const total = boundedDrafts.length;

  const commits: GitCommitEvent[] = boundedDrafts.map((d, idx) => {
    let topArea = 'repo';
    let bestWeight = -1;
    for (const [area, w] of d.areaWeights.entries()) {
      if (w > bestWeight || (w === bestWeight && area.localeCompare(topArea) < 0)) {
        bestWeight = w;
        topArea = area;
      }
    }
    const baseCommit = {
      shortHash: d.shortHash,
      timestampMs: d.timestampMs,
      authorKey: d.authorKey,
      authorName: d.authorName,
      subject: d.subject,
      filesChanged: Math.max(0, Math.trunc(d.filesChanged)),
      insertions: Math.max(0, Math.trunc(d.insertions)),
      deletions: Math.max(0, Math.trunc(d.deletions)),
      commitKind: d.commitKind,
      topArea,
    };
    return {
      ...baseCommit,
      isMilestone: isMilestoneCommit(baseCommit, idx, total),
    };
  });

  // Build deterministic cast (top 12 authors by commitCount desc, authorKey asc)
  const authorCounts = new Map<string, { authorName: string; count: number }>();
  for (const c of commits) {
    const prev = authorCounts.get(c.authorKey);
    if (prev) {
      prev.count += 1;
    } else {
      authorCounts.set(c.authorKey, { authorName: c.authorName, count: 1 });
    }
  }
  const sortedCast = Array.from(authorCounts.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, MAX_GIT_CAST);

  const cast: GitCastMember[] = sortedCast.map(([authorKey, info], idx) => ({
    authorKey,
    authorName: info.authorName,
    redactedName: formatRedactedAuthorName(idx + 1, locale),
    commitCount: info.count,
    characterId: deterministicCharacterForAuthor(authorKey),
    seatSlot: idx,
  }));

  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const c of commits) {
    totalInsertions += c.insertions;
    totalDeletions += c.deletions;
  }

  return {
    repoId: opts.repoId,
    repoLabel: truncateCodePoints(scrubAll(opts.repoLabel) || 'repo', 64),
    branch: truncateCodePoints(scrubAll(opts.branch) || 'HEAD', 64),
    rangeDays: opts.rangeDays,
    generatedAtMs: nowMs,
    isDemo: false,
    cast,
    commits,
    totalCommits: commits.length,
    totalInsertions,
    totalDeletions,
  };
}

export function redactGitRepoSummaries(
  repos: readonly GitRepoSummary[],
  locale: UiLocale = 'en'
): GitRepoSummary[] {
  return repos.map((repo, idx) => ({
    repoId: repo.repoId,
    repoLabel: locale === 'ko' ? `저장소 #${idx + 1}` : `Repo #${idx + 1}`,
    branch: locale === 'ko' ? '브랜치' : 'branch',
    ...(repo.isDemo ? { isDemo: true } : {}),
  }));
}

export function redactGitTheaterReel(
  reel: GitTheaterReel,
  locale: UiLocale = 'en',
  repoIndex1Based = 1
): GitTheaterReel {
  const authorAliasByKey = new Map<string, string>();
  const cast: GitCastMember[] = reel.cast.map((member, idx) => {
    const alias = formatRedactedAuthorName(idx + 1, locale);
    authorAliasByKey.set(member.authorKey, alias);
    return {
      ...member,
      authorName: alias,
      redactedName: alias,
    };
  });

  const areaAliasMap = new Map<string, string>();
  const resolveAreaAlias = (area: string): string => {
    const existing = areaAliasMap.get(area);
    if (existing) return existing;
    const idx = areaAliasMap.size + 1;
    const alias = locale === 'ko' ? `모듈-${idx}` : `module-${idx}`;
    areaAliasMap.set(area, alias);
    return alias;
  };

  let nextAuthorNum = cast.length + 1;
  const commits: GitCommitEvent[] = reel.commits.map((c, idx) => {
    let authorAlias = authorAliasByKey.get(c.authorKey);
    if (!authorAlias) {
      authorAlias = formatRedactedAuthorName(nextAuthorNum++, locale);
      authorAliasByKey.set(c.authorKey, authorAlias);
    }
    const commitLabel = locale === 'ko' ? '커밋' : 'Commit';
    return {
      ...c,
      shortHash: `#${idx + 1}`,
      authorName: authorAlias,
      subject: `[${c.commitKind}] ${commitLabel} #${idx + 1} (+${c.insertions}/-${c.deletions})`,
      topArea: resolveAreaAlias(c.topArea),
    };
  });

  return {
    ...reel,
    repoLabel: locale === 'ko' ? `저장소 #${repoIndex1Based}` : `Repo #${repoIndex1Based}`,
    branch: locale === 'ko' ? '브랜치' : 'branch',
    cast,
    commits,
  };
}

export class GitRepoRegistry {
  private readonly reposById = new Map<string, VerifiedGitRepo>();
  private readonly execRunner: GitExecRunner;
  private readonly env: Record<string, string>;

  constructor(options?: { execRunner?: GitExecRunner; env?: Record<string, string> }) {
    this.execRunner = options?.execRunner ?? defaultGitExecRunner;
    this.env = options?.env ?? buildMinimalGitEnv();
  }

  private async runGit(verifiedPath: string, args: readonly string[]): Promise<GitExecResult> {
    assertAllowedGitArgs(args);
    return this.execRunner(args, {
      cwd: verifiedPath,
      timeoutMs: GIT_EXEC_TIMEOUT_MS,
      maxBufferBytes: GIT_MAX_BUFFER_BYTES,
      env: this.env,
    });
  }

  async refreshFromCandidates(candidates: readonly LocalRepoCandidate[]): Promise<GitRepoSummary[]> {
    const nextMap = new Map<string, VerifiedGitRepo>();
    const seenRealPaths = new Set<string>();
    const summaries: GitRepoSummary[] = [];

    for (const candidate of candidates) {
      if (nextMap.size >= MAX_GIT_REPOS) break;
      if (!candidate || typeof candidate.path !== 'string') continue;
      if (
        candidate.hostId !== undefined &&
        candidate.hostId !== null &&
        candidate.hostId !== 'local'
      ) {
        continue;
      }
      const trimmedPath = candidate.path.trim();
      if (trimmedPath.length === 0 || CONTROL_CHAR_RE.test(trimmedPath)) continue;

      let resolvedPath: string;
      try {
        resolvedPath = fs.realpathSync(trimmedPath);
        const st = fs.statSync(resolvedPath);
        if (!st.isDirectory()) continue;
        if (!fs.existsSync(path.join(resolvedPath, '.git'))) continue;
      } catch {
        continue;
      }

      if (seenRealPaths.has(resolvedPath)) continue;

      try {
        const insideRes = await this.runGit(resolvedPath, ['rev-parse', '--is-inside-work-tree']);
        if (insideRes.exitCode !== 0 || insideRes.stdout.trim() !== 'true') {
          continue;
        }
        const branchRes = await this.runGit(resolvedPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const rawBranch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : 'HEAD';
        const branch = truncateCodePoints(scrubAll(rawBranch || 'HEAD'), 64);
        const baseName = path.basename(resolvedPath) || 'repo';
        const repoLabel = truncateCodePoints(scrubAll(baseName) || 'repo', 64);
        const repoId = `repo_${nextMap.size}`;

        seenRealPaths.add(resolvedPath);
        nextMap.set(repoId, {
          repoId,
          verifiedPath: resolvedPath,
          repoLabel,
          branch,
        });
        summaries.push({ repoId, repoLabel, branch });
      } catch {
        // Skip repositories that fail read-only verification
      }
    }

    this.reposById.clear();
    for (const [id, repo] of nextMap.entries()) {
      this.reposById.set(id, repo);
    }
    return summaries;
  }

  listSummaries(): GitRepoSummary[] {
    return Array.from(this.reposById.values()).map((r) => ({
      repoId: r.repoId,
      repoLabel: r.repoLabel,
      branch: r.branch,
    }));
  }

  getVerifiedRepo(repoId: string): VerifiedGitRepo | null {
    if (!REPO_ID_RE.test(repoId)) return null;
    return this.reposById.get(repoId) ?? null;
  }

  getRepoIndex1Based(repoId: string): number {
    const keys = Array.from(this.reposById.keys());
    const idx = keys.indexOf(repoId);
    return idx >= 0 ? idx + 1 : 1;
  }

  async getHistoryReel(opts: {
    repoId: string;
    rangeDays: GitRangeDays;
    maxCommits: number;
    nowMs?: number;
    locale?: UiLocale;
  }): Promise<GitTheaterReel> {
    const repo = this.getVerifiedRepo(opts.repoId);
    if (!repo) {
      throw new GitHistoryError('invalid_params', 'Unknown or disallowed repoId');
    }

    const args = [
      'log',
      '--no-color',
      '--date=unix',
      '--numstat',
      `--max-count=${opts.maxCommits}`,
      `--since=${opts.rangeDays}.days`,
      `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
    ] as const;

    const res = await this.runGit(repo.verifiedPath, args);
    if (res.exitCode !== 0 && res.stdout.trim().length === 0) {
      throw new GitHistoryError('git_failed', summarizeGitFailure(res.stderr));
    }

    return parseGitLogOutput(res.stdout, {
      repoId: repo.repoId,
      repoLabel: repo.repoLabel,
      branch: repo.branch,
      rangeDays: opts.rangeDays,
      nowMs: opts.nowMs,
      locale: opts.locale,
    });
  }
}
