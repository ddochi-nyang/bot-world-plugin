import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, mockHost, mountWorker, test } from 'orca/testing';
import { getThemeConfig } from '../shared/assets-catalog.ts';
import { BossRaidEngine, resolveRaidSuppressionReason } from '../shared/boss-raid.ts';
import {
  COMMIT_KIND_COLORS,
  GitTheaterEngine,
  MAX_THEATER_BUBBLES,
  MAX_THEATER_CONFETTI,
  MAX_THEATER_PARCELS,
  THEATER_DURATION_SECS,
  THEATER_SPEEDS,
  createDemoGitTheaterReel,
  paintGitTheaterLayer,
  renderGitTheaterModal,
  resolveTheaterAreaLabel,
  resolveTheaterAuthorName,
  resolveTheaterBranchLabel,
  resolveTheaterCommitHash,
  resolveTheaterCommitText,
  resolveTheaterRepoLabel,
  truncateForDisplay,
  updateTheaterStageHud,
} from '../shared/git-theater.ts';
import { tStrings } from '../shared/i18n.ts';
import { mapKeyToShortcutAction, shouldIgnoreShortcutEvent } from '../shared/shortcuts.ts';
import { type AudioContextLike, SoundscapeEngine } from '../shared/soundscape.ts';
import {
  GIT_LOG_PRETTY_FORMAT,
  GitHistoryError,
  GitRepoRegistry,
  type GitExecRunner,
  assertAllowedGitArgs,
  classifyCommitKind,
  isMilestoneCommit,
  normalizeCommitSubject,
  parseGitLogOutput,
  redactGitRepoSummaries,
  redactGitTheaterReel,
  summarizeGitFailure,
  validateGetGitHistoryReelInput,
} from './git-history.ts';
import type { OrcaClient } from './orca-cli.ts';
import { type BotState, type WorldSnapshot, createEmptySnapshot } from './types.ts';
import * as workerModule from './worker.ts';
import { MAX_IPC_PAYLOAD_BYTES } from './worker.ts';

function makeMinimalClient(): OrcaClient {
  return {
    isStopped: () => false,
    status: async () => ({
      ok: true,
      result: {
        runtime: { state: 'ready', reachable: true, runtimeId: 'rt-git', appVersion: '1.4.267' },
      },
    }),
    botList: async () => ({ ok: true, result: { bots: [] } }),
    botChats: async () => ({ ok: true, result: { bot: 'b', chats: [] } }),
    botItemList: async () => ({ ok: true, result: { botId: 'b', botName: 'b', items: [] } }),
    worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
    orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
    orchestrationWorkerList: async () => ({ ok: true, result: { workers: [] } }),
    orchestrationList: async () => ({ ok: true, result: { dispatches: [] } }),
    automationList: async () => ({ ok: true, result: { automations: [] } }),
    terminalList: async () => ({ ok: true, result: { terminals: [] } }),
    sendChatMessage: async () => ({ ok: true, result: { sent: true } }),
    terminalFocus: async () => ({ ok: true, result: { focused: true } }),
    workspaceOpen: async () => ({ ok: true, result: { opened: true } }),
  };
}

class LocalFakeElement {
  readonly tagName: string;
  className = '';
  id = '';
  title = '';
  type = '';
  min = '';
  max = '';
  step = '';
  value = '';
  selected = false;
  disabled = false;
  placeholder = '';
  maxLength = 0;
  textContent = '';
  dataset: Record<string, string> = {};
  readonly children: LocalFakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  readonly style: Record<string, string> = {};
  readonly classList = {
    toggle: (cls: string, force?: boolean): boolean => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      const next = force === undefined ? !parts.has(cls) : force;
      if (next) parts.add(cls);
      else parts.delete(cls);
      this.className = Array.from(parts).join(' ');
      return next;
    },
    contains: (cls: string): boolean => this.className.split(/\s+/).filter(Boolean).includes(cls),
    add: (...classes: string[]): void => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of classes) parts.add(c);
      this.className = Array.from(parts).join(' ');
    },
    remove: (...classes: string[]): void => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const c of classes) parts.delete(c);
      this.className = Array.from(parts).join(' ');
    },
  };

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get childNodes(): LocalFakeElement[] {
    return this.children;
  }

  get firstChild(): LocalFakeElement | null {
    return this.children[0] ?? null;
  }

  appendChild(child: LocalFakeElement): LocalFakeElement {
    this.children.push(child);
    return child;
  }

  removeChild(child: LocalFakeElement): LocalFakeElement {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(name: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  querySelector(selector: string): LocalFakeElement | null {
    const cls = selector.startsWith('.') ? selector.slice(1) : selector;
    for (const child of this.children) {
      if (child.classList.contains(cls)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  contains(): boolean {
    return false;
  }
}

function collectElementText(node: LocalFakeElement): string {
  const parts: string[] = [];
  if (node.textContent) parts.push(node.textContent);
  for (const ch of node.children) {
    const sub = collectElementText(ch);
    if (sub) parts.push(sub);
  }
  return parts.join(' ');
}

function withFakeDom<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const prevDoc = g.document;
  const prevNode = g.Node;
  const prevInput = g.HTMLInputElement;
  const prevSelect = g.HTMLSelectElement;
  const prevImg = g.HTMLImageElement;
  g.Node = LocalFakeElement;
  g.HTMLInputElement = LocalFakeElement;
  g.HTMLSelectElement = LocalFakeElement;
  g.HTMLImageElement = LocalFakeElement;
  g.document = {
    activeElement: null,
    createElement: (tag: string) => new LocalFakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new LocalFakeElement(tag),
    createTextNode: (text: string) => {
      const node = new LocalFakeElement('#text');
      node.textContent = text;
      return node;
    },
  };
  try {
    return fn();
  } finally {
    g.document = prevDoc;
    g.Node = prevNode;
    g.HTMLInputElement = prevInput;
    g.HTMLSelectElement = prevSelect;
    g.HTMLImageElement = prevImg;
  }
}

function createFakeAudioContext(): { ctx: AudioContextLike; oscCount: () => number } {
  let oscs = 0;
  const ctx: AudioContextLike = {
    state: 'running',
    currentTime: 10,
    sampleRate: 44100,
    destination: {},
    resume: async () => {},
    createOscillator: () => {
      oscs += 1;
      return {
        type: 'sine',
        frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        connect: () => {},
        start: () => {},
        stop: () => {},
      };
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
    }),
    createBiquadFilter: () => ({
      type: 'lowpass',
      frequency: { setValueAtTime: () => {} },
      Q: { setValueAtTime: () => {} },
      connect: () => {},
    }),
    createBuffer: (_ch: number, len: number) => ({
      getChannelData: () => new Float32Array(len),
    }),
    createBufferSource: () => ({
      buffer: null,
      loop: false,
      connect: () => {},
      start: () => {},
      stop: () => {},
      onended: null,
    }),
  };
  return { ctx, oscCount: () => oscs };
}

function createMockCanvasCtx(): {
  ctx: CanvasRenderingContext2D;
  texts: string[];
  hasShadowBlurAccess: () => boolean;
} {
  const texts: string[] = [];
  let shadowBlurTouched = false;
  const noop = () => {};
  const obj: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string) => {
      texts.push(t);
    },
  };
  Object.defineProperty(obj, 'shadowBlur', {
    get: () => 0,
    set: () => {
      shadowBlurTouched = true;
    },
  });
  return {
    ctx: obj as unknown as CanvasRenderingContext2D,
    texts,
    hasShadowBlurAccess: () => shadowBlurTouched,
  };
}

describe('Git History Theater Collector & Security', () => {
  test('parses git log chronologically, handles binary numstat/renames, scrubs secrets, excludes emails, and maps cast', () => {
    assert.equal(GIT_LOG_PRETTY_FORMAT.includes('%ae'), false);
    assert.equal(GIT_LOG_PRETTY_FORMAT.includes('%ce'), false);

    // Git outputs newest first; parser must sort oldest -> newest
    const secretToken = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const rawStdout = [
      `__BW_COMMIT__\x1fb2c4d5e\x1f1763902000\x1fAlice <alice@corp.local>\x1ffeat(auth): rotate ${secretToken} multiline note\x1e`,
      '-\t-\tassets/logo.png',
      '42\t8\tsrc/{old => new}/auth.ts',
      '300\t12\tsrc/auth/session.ts',
      '',
      `__BW_COMMIT__\x1fa1b2c3d\x1f1763901000\x1fBob\x1ffix: normalize user@example.com lookup\x1e`,
      '10\t2\tshared/util.ts',
    ].join('\n');

    const reel = parseGitLogOutput(rawStdout, {
      repoId: 'repo_0',
      repoLabel: 'secret-repo',
      branch: 'main',
      rangeDays: 14,
      nowMs: 1763905000000,
      locale: 'en',
    });

    assert.equal(reel.totalCommits, 2);
    assert.equal(reel.commits[0].shortHash, 'a1b2c3d');
    assert.equal(reel.commits[1].shortHash, 'b2c4d5e');
    assert.equal(reel.commits[0].commitKind, 'fix');
    assert.equal(reel.commits[1].commitKind, 'feat');
    assert.equal(reel.commits[0].isMilestone, true); // first commit
    assert.equal(reel.commits[1].isMilestone, true); // >= 300 lines + last commit
    assert.equal(reel.commits[1].filesChanged, 3);
    assert.equal(reel.commits[1].insertions, 342);
    assert.equal(reel.commits[1].deletions, 20);
    assert.equal(reel.commits[1].topArea, 'src');
    assert.equal(reel.commits[0].subject.includes('user@example.com'), false);
    assert.equal(reel.commits[1].subject.includes(secretToken), false);
    assert.equal(reel.commits[1].subject.includes('\n'), false);
    assert.ok(reel.commits[1].subject.length <= 96);
    assert.equal(reel.cast.length, 2);
    assert.ok(reel.cast[0].characterId.length > 0);
    assert.ok(!JSON.stringify(reel).includes('alice@corp.local'));

    // Single-line truncation helper
    const longLine = normalizeCommitSubject('feat: line1\nline2 ' + 'x'.repeat(180));
    assert.equal(longLine.includes('\n'), false);
    assert.ok(longLine.length <= 96);
    assert.equal(classifyCommitKind('Merge pull request #42'), 'merge');
    assert.equal(classifyCommitKind('refactor(core): tidy cache'), 'refactor');
    assert.equal(classifyCommitKind('test: cover edge case'), 'test');
    assert.equal(classifyCommitKind('docs: update readme'), 'docs');
    assert.equal(isMilestoneCommit({ filesChanged: 8, insertions: 1, deletions: 1, subject: 'x' }, 1, 5), true);
    assert.equal(isMilestoneCommit({ filesChanged: 1, insertions: 1, deletions: 1, subject: 'release: v1.0.0' }, 1, 5), true);
  });

  test('assertAllowedGitArgs rejects mutating subcommands, email formats, control chars, and invalid bounds', () => {
    assert.doesNotThrow(() =>
      assertAllowedGitArgs(['rev-parse', '--is-inside-work-tree'])
    );
    assert.doesNotThrow(() =>
      assertAllowedGitArgs(['rev-parse', '--abbrev-ref', 'HEAD'])
    );
    assert.doesNotThrow(() =>
      assertAllowedGitArgs([
        'log',
        '--no-color',
        '--date=unix',
        '--numstat',
        '--max-count=60',
        '--since=14.days',
        `--pretty=format:${GIT_LOG_PRETTY_FORMAT}`,
      ])
    );

    const badArgs: string[][] = [
      ['commit', '-m', 'nope'],
      ['push', 'origin', 'main'],
      ['status'],
      ['log', '--pretty=format:%h %ae'],
      ['log', '--since=365.days'],
      ['log', '--max-count=999'],
      ['log', '--no-color', '--exec=sh'],
      ['rev-parse', 'HEAD\n--flag'],
    ];
    for (const vec of badArgs) {
      assert.throws(() => assertAllowedGitArgs(vec), GitHistoryError);
    }

    assert.throws(() => validateGetGitHistoryReelInput({ repoId: '/etc/passwd' }), GitHistoryError);
    assert.throws(() => validateGetGitHistoryReelInput({ repoId: '../secret' }), GitHistoryError);
    assert.throws(() => validateGetGitHistoryReelInput({ repoId: 'repo_0', rangeDays: 3 }), GitHistoryError);
  });

  test('worker enforces opaque repoId, read-only git, zero storage writes, redact mode, and payload budget', async () => {
    const repoPath = process.cwd();
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const mockGitExec: GitExecRunner = async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'feature/secret-alpha\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'log') {
        const lines: string[] = [];
        for (let i = 0; i < 6; i += 1) {
          lines.push(
            `__BW_COMMIT__\x1fa00000${i}\x1f${1763900000 + i * 100}\x1fRealAlice\x1ffeat: top secret feature ${i} ${'z'.repeat(140)}\x1e`,
            '12\t4\tsensitive_dir/module.ts'
          );
        }
        return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
    };

    const host = mockHost();
    let controller: workerModule.BotWorldWorkerController | null = null;
    const worker = await mountWorker(
      {
        default: async (orca) => {
          controller = new workerModule.BotWorldWorkerController(orca, makeMinimalClient(), {
            localRepoRoots: [{ path: repoPath, hostId: 'local' }],
            gitExec: mockGitExec,
          });
          await controller.init({ disableAutoLoop: true });
        },
        deactivate: async () => {
          controller?.dispose();
        },
      },
      { host }
    );

    try {
      const listRes = (await worker.request('botWorld.listGitRepos')) as {
        repos: Array<{ repoId: string; repoLabel: string; branch: string }>;
      };
      assert.equal(listRes.repos.length, 1);
      assert.equal(listRes.repos[0].repoId, 'repo_0');
      assert.equal(listRes.repos[0].repoLabel, path.basename(repoPath));
      assert.equal(listRes.repos[0].branch, 'feature/secret-alpha');
      assert.equal(JSON.stringify(listRes).includes(repoPath), false);

      // Path traversal or unknown repoId must fail cleanly
      await assert.rejects(() =>
        worker.request('botWorld.getGitHistoryReel', { repoId: repoPath, rangeDays: 14 })
      );
      await assert.rejects(() =>
        worker.request('botWorld.getGitHistoryReel', { repoId: 'repo_99', rangeDays: 14 })
      );

      // Normal reel fetch
      const reel = (await worker.request('botWorld.getGitHistoryReel', {
        repoId: 'repo_0',
        rangeDays: 14,
        maxCommits: 60,
      })) as ReturnType<typeof parseGitLogOutput>;
      assert.equal(reel.repoId, 'repo_0');
      assert.equal(reel.totalCommits, 6);
      assert.ok(Buffer.byteLength(JSON.stringify(reel), 'utf8') <= MAX_IPC_PAYLOAD_BYTES);

      // Zero storage:own writes of commits, authors, or paths
      const storageDump = JSON.stringify(host.data().storage);
      assert.equal(storageDump.includes('top secret feature'), false);
      assert.equal(storageDump.includes('RealAlice'), false);
      assert.equal(storageDump.includes(repoPath), false);

      // Enable Redact mode and verify zero leakage across listGitRepos & getGitHistoryReel
      await worker.request('botWorld.setRedactMode', { redactMode: true });
      const redactedList = (await worker.request('botWorld.listGitRepos')) as {
        repos: Array<{ repoId: string; repoLabel: string; branch: string }>;
      };
      const redactedReel = (await worker.request('botWorld.getGitHistoryReel', {
        repoId: 'repo_0',
        rangeDays: 14,
        locale: 'ko',
      })) as ReturnType<typeof parseGitLogOutput>;

      const redactedDump = JSON.stringify({ redactedList, redactedReel });
      assert.equal(redactedDump.includes(path.basename(repoPath)), false);
      assert.equal(redactedDump.includes('feature/secret-alpha'), false);
      assert.equal(redactedDump.includes('RealAlice'), false);
      assert.equal(redactedDump.includes('top secret feature'), false);
      assert.equal(redactedDump.includes('sensitive_dir'), false);
      assert.equal(redactedDump.includes('a000001'), false);

      // Verify every spawned git invocation was strictly read-only
      for (const c of calls) {
        assert.doesNotThrow(() => assertAllowedGitArgs(c.args));
      }
    } finally {
      await worker.deactivate();
    }
  });
});

describe('30s Office Theater Engine, Single-Clock, Mutual Exclusion & Render', () => {
  test('Demo reel runs 24 commits with 0 git calls, 30s playback, speed multipliers, and single clock separation', () => {
    const reel = createDemoGitTheaterReel('en', 14);
    assert.equal(reel.isDemo, true);
    assert.equal(reel.commits.length, 24);
    assert.ok(reel.commits.some((c) => c.isMilestone));

    const engine = new GitTheaterEngine();
    const firedCues: string[] = [];
    engine.onCommit((ev) => {
      firedCues.push(ev.commit.isMilestone ? 'theater_milestone' : 'theater_commit');
    });

    engine.open(reel, { themeId: 'startup_office', locale: 'en', redactMode: false, autoplay: true });
    assert.equal(engine.isActive(), true);
    assert.equal(engine.isPlaying(), true);
    assert.equal(engine.getDurationSecs(), THEATER_DURATION_SECS);
    assert.deepEqual([...THEATER_SPEEDS], [0.5, 1, 2, 4]);

    // stepVisuals MUST NOT advance playbackSecs or fire commits (single clock invariant)
    engine.stepVisuals(5);
    assert.equal(engine.getPlaybackSecs(), 0);
    assert.equal(firedCues.length, 0);

    // 1x speed: 15s -> 50% progress
    engine.stepPlayback(15);
    assert.equal(engine.getPlaybackSecs(), 15);
    assert.ok(Math.abs(engine.getProgressFraction() - 0.5) < 1e-6);
    assert.ok(firedCues.length > 0);
    assert.ok(firedCues.includes('theater_commit'));
    assert.ok(firedCues.includes('theater_milestone'));

    // 2x speed: 7.5s * 2 = +15s -> reaches 30s end cleanly & pauses
    engine.setSpeed(2);
    engine.stepPlayback(7.5);
    assert.equal(engine.getPlaybackSecs(), 30);
    assert.equal(engine.isPlaying(), false);
    assert.equal(firedCues.length, 24);

    // Prev / Next / Seek / Restart
    assert.equal(engine.prevCommit(), true);
    const afterPrev = engine.getCurrentCommitIndex();
    assert.ok(afterPrev < 23);
    assert.equal(engine.nextCommit(), true);
    assert.equal(engine.getCurrentCommitIndex(), afterPrev + 1);
    engine.seekFraction(0.25);
    assert.ok(Math.abs(engine.getPlaybackSecs() - 7.5) < 1e-6);
    engine.restart();
    assert.equal(engine.getPlaybackSecs(), 0);
    assert.equal(engine.isPlaying(), true);

    // Transient caps enforced across rapid firing
    for (let i = 0; i < 30; i += 1) {
      engine.stepPlayback(1);
    }
    assert.ok(engine.getBubbles().length <= MAX_THEATER_BUBBLES);
    assert.ok(engine.getParcels().length <= MAX_THEATER_PARCELS);
    assert.ok(engine.getConfetti().length <= MAX_THEATER_CONFETTI);

    // Canvas paint uses zero shadowBlur
    const fakeCanvas = createMockCanvasCtx();
    const theme = getThemeConfig('startup_office', 'en');
    paintGitTheaterLayer(
      fakeCanvas.ctx,
      { originX: 0, originY: 0, scale: 1, designW: 1376, designH: 768 },
      theme,
      engine,
      { locale: 'en', redactMode: false }
    );
    assert.equal(fakeCanvas.hasShadowBlurAccess(), false);
    assert.ok(fakeCanvas.texts.length > 0);

    // Exit clears all transients
    engine.exit();
    assert.equal(engine.isActive(), false);
    assert.equal(engine.hasActiveVisuals(), false);
  });

  test('Redact mode prevents leaking real repo, branch, author, subject, hash, or area across HUD and canvas', () => {
    const rawReel = parseGitLogOutput(
      [
        '__BW_COMMIT__\x1ff9a8b7c\x1f1763900000\x1fSecretEngineer\x1ffeat: launch secret_project_xyz\x1e',
        '15\t2\tprivate_vault/keys.ts',
      ].join('\n'),
      {
        repoId: 'repo_2',
        repoLabel: 'top-secret-repo',
        branch: 'release/v9-hidden',
        rangeDays: 7,
        locale: 'en',
      }
    );

    const engine = new GitTheaterEngine();
    engine.open(rawReel, { themeId: 'cozy', locale: 'en', redactMode: true, autoplay: true });
    engine.step(2);

    const snap = engine.buildTheaterSnapshot('en', true);
    const snapJson = JSON.stringify(snap);
    assert.equal(snapJson.includes('SecretEngineer'), false);
    assert.equal(snapJson.includes('top-secret-repo'), false);
    assert.equal(snapJson.includes('release/v9-hidden'), false);
    assert.equal(snapJson.includes('secret_project_xyz'), false);
    assert.equal(snapJson.includes('private_vault'), false);
    assert.equal(snapJson.includes('f9a8b7c'), false);

    assert.equal(resolveTheaterRepoLabel(rawReel, 'en', true), 'Repo #3');
    assert.equal(resolveTheaterRepoLabel(rawReel, 'ko', true), '저장소 #3');
    assert.equal(resolveTheaterBranchLabel(rawReel.branch, 'en', true), 'branch');
    assert.equal(resolveTheaterBranchLabel(rawReel.branch, 'ko', true), '브랜치');
    assert.equal(resolveTheaterAuthorName(rawReel.cast[0], 0, 'en', true), 'Author #1');
    assert.equal(resolveTheaterAuthorName(rawReel.cast[0], 0, 'ko', true), '작성자 #1');
    assert.ok(!resolveTheaterAreaLabel(rawReel.commits[0], 0, 'en', true).includes('private_vault'));
    assert.ok(!resolveTheaterCommitText(rawReel.commits[0], 0, 'en', true).includes('secret_project_xyz'));
    assert.equal(resolveTheaterCommitHash(rawReel.commits[0], 0, true), '#1');

    // Canvas paint in redact mode must not emit raw strings
    const fakeCanvas = createMockCanvasCtx();
    paintGitTheaterLayer(
      fakeCanvas.ctx,
      { originX: 0, originY: 0, scale: 1, designW: 1376, designH: 768 },
      getThemeConfig('cozy', 'en'),
      engine,
      { locale: 'en', redactMode: true }
    );
    const painted = fakeCanvas.texts.join(' ');
    assert.equal(painted.includes('release/v9-hidden'), false);
    assert.equal(painted.includes('secret_project_xyz'), false);

    // DOM HUD + Modal in redact mode (KO) must not leak raw strings
    withFakeDom(() => {
      const topHud = new LocalFakeElement('div') as unknown as HTMLElement;
      const bottomHud = new LocalFakeElement('div') as unknown as HTMLElement;
      const backdrop = new LocalFakeElement('div') as unknown as HTMLElement;
      updateTheaterStageHud(topHud, bottomHud, {
        engine,
        locale: 'ko',
        redactMode: true,
        suppressed: false,
        onPlayPause: () => {},
        onRestart: () => {},
        onPrevCommit: () => {},
        onNextCommit: () => {},
        onSeekFraction: () => {},
        onCycleSpeed: () => {},
        onOpenSelector: () => {},
        onExit: () => {},
      });
      const redactedSummaries = redactGitRepoSummaries(
        [{ repoId: 'repo_2', repoLabel: 'top-secret-repo', branch: 'release/v9-hidden' }],
        'ko'
      );
      const redactedReel = redactGitTheaterReel(rawReel, 'ko');
      assert.equal(redactedSummaries[0].repoLabel, '저장소 #1');
      assert.equal(redactedReel.branch, '브랜치');
      renderGitTheaterModal(backdrop, {
        open: true,
        locale: 'ko',
        redactMode: true,
        loading: false,
        errorMessage: null,
        repos: [{ repoId: 'repo_2', repoLabel: 'top-secret-repo', branch: 'release/v9-hidden' }],
        selectedRepoId: 'repo_2',
        rangeDays: 7,
        theaterActive: true,
        isDemoReelActive: false,
        onSelectRepo: () => {},
        onSelectRange: () => {},
        onRefreshRepos: () => {},
        onStartRepoTheater: () => {},
        onStartDemoTheater: () => {},
        onExitTheater: () => {},
        onClose: () => {},
      });
      const domText =
        collectElementText(topHud as unknown as LocalFakeElement) +
        ' ' +
        collectElementText(backdrop as unknown as LocalFakeElement);
      assert.equal(domText.includes('top-secret-repo'), false);
      assert.equal(domText.includes('release/v9-hidden'), false);
      assert.equal(domText.includes('secret_project_xyz'), false);
      assert.equal(domText.includes('f9a8b7c'), false);
    });
  });

  test('Mode mutual exclusion, soundscape cues, shortcut Y, EN/KO strings, and security invariants hold', () => {
    assert.equal(
      resolveRaidSuppressionReason({
        isReplay: false,
        viewMode: 'office',
        bossRaidMode: 'auto',
        isTheater: true,
      }),
      'theater'
    );

    assert.equal(mapKeyToShortcutAction('y', { isEditor: false, modalOpen: false }), 'toggleTheater');
    assert.equal(mapKeyToShortcutAction('Y', { isEditor: true, modalOpen: true }), 'toggleTheater');
    assert.equal(
      shouldIgnoreShortcutEvent({ key: 'y', target: null } as unknown as KeyboardEvent, {
        modalOpen: true,
      }),
      false
    );

    const { ctx, oscCount } = createFakeAudioContext();
    const soundscape = new SoundscapeEngine({ createAudioContext: () => ctx });
    soundscape.unlockFromUserGesture();
    soundscape.setMode('sfx', { fromUserGesture: true });
    soundscape.playCue('theater_commit', { suppressed: false });
    soundscape.playCue('theater_milestone', { suppressed: false });
    assert.ok(oscCount() >= 2);
    soundscape.dispose();

    for (const loc of ['en', 'ko'] as const) {
      const s = tStrings(loc);
      assert.ok(s.shortcutToggleTheater.length > 0);
      assert.ok(s.toolbarTheaterTitle.length > 0);
      assert.ok(s.raidSuppressedNote('theater').length > 0);
      assert.ok(s.theaterCommitCounter(1, 24).includes('1/24'));
    }

    assert.ok(Object.keys(COMMIT_KIND_COLORS).length >= 8);

    // Static verification: no shadowBlur, no innerHTML/outerHTML, shell:false in git collector, single clock in StageRenderer
    const rootDir = process.cwd();
    const theaterSrc = fs.readFileSync(path.join(rootDir, 'shared/git-theater.ts'), 'utf8');
    const gitHistorySrc = fs.readFileSync(path.join(rootDir, 'src/git-history.ts'), 'utf8');
    const stageRendererSrc = fs.readFileSync(path.join(rootDir, 'shared/stage-renderer.ts'), 'utf8');

    assert.equal(theaterSrc.includes('shadowBlur'), false);
    assert.equal(theaterSrc.includes('innerHTML'), false);
    assert.equal(theaterSrc.includes('outerHTML'), false);
    assert.equal(gitHistorySrc.includes('shell: false'), true);
    assert.equal(stageRendererSrc.includes('stepVisuals(dtSecs)'), true);
    assert.equal(stageRendererSrc.includes('stepPlayback('), false);
  });

  test('BossRaidEngine suppresses threat spawn, damage, pomodoro DPS/sound, practice summon, and sound cues when isTheater is true', () => {
    const theme = getThemeConfig('startup_office', 'en');
    const makeTestSnap = (status: BotState['status']): WorldSnapshot => {
      const snap = createEmptySnapshot(10_000);
      snap.runtime.connected = true;
      snap.initialSyncComplete = true;
      snap.bots.b1 = {
        id: 'b1',
        name: 'Alpha',
        agent: 'claude',
        paused: false,
        specialty: 'Engineering',
        status,
        unreadCount: 0,
        lastActivityAt: 10_000,
        deskIndex: 0,
      };
      snap.botOrder.push('b1');
      return snap;
    };
    const errorSnap = makeTestSnap({ kind: 'Error', message: 'boom' });
    const calmSnap = makeTestSnap({ kind: 'Idle' });
    const sounds: string[] = [];
    const onSoundCue = (cue: string) => {
      sounds.push(cue);
    };

    const engine = new BossRaidEngine();
    // 1. Threat spawn suppressed while theater active
    engine.syncState({
      snapshot: errorSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: true,
      nowMs: 1_000,
      onSoundCue,
    });
    assert.equal(engine.isSuppressed(), true);
    assert.equal(engine.getSuppressionReason(), 'theater');
    assert.equal(engine.activeBoss, null);
    assert.deepEqual(sounds, []);

    // 2. Practice boss summon suppressed while theater active
    const practiceKind = engine.summonPracticeBoss('error_blob', {
      nowMs: 1_200,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: true,
      onSoundCue,
    });
    assert.equal(practiceKind, null);
    assert.equal(engine.activeBoss, null);
    assert.deepEqual(sounds, []);

    // 3. Pomodoro start suppressed (no boss spawn, no spawn sound) while theater active
    engine.startPomodoro(15, {
      currentStreak: 0,
      nowMs: 1_400,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: true,
      onSoundCue,
    });
    assert.equal(engine.activeBoss, null);
    assert.deepEqual(sounds, []);
    engine.abandonPomodoro({ demoMode: true });

    // 4. Existing boss damage, pomodoro DPS tick, owner strike, and sound suppressed when entering theater
    const summoned = engine.summonPracticeBoss('stall_golem', {
      nowMs: 2_000,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: false,
      onSoundCue,
    });
    assert.equal(summoned, 'stall_golem');
    assert.deepEqual(sounds, ['raid_spawn']);
    const initialHp = engine.activeBoss?.hp ?? 0;
    assert.ok(initialHp > 0);

    // Activate pomodoro outside theater, then step inside theater
    engine.startPomodoro(15, {
      currentStreak: 0,
      nowMs: 2_100,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: false,
    });
    const hpBeforeTheater = engine.activeBoss?.hp ?? 0;
    const eventDmg = engine.onEvents(
      [{ kind: 'ItemDone', botId: 'b1', itemTitle: 'ship' }],
      {
        snapshot: calmSnap,
        theme,
        bossRaidMode: 'auto',
        viewMode: 'office',
        isReplay: false,
        isTheater: true,
        nowMs: 3_000,
        onSoundCue,
      }
    );
    assert.equal(eventDmg, 0);
    assert.equal(engine.activeBoss?.hp, hpBeforeTheater);

    engine.stepPomodoro(5, {
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: true,
      nowMs: 8_000,
      onSoundCue,
    });
    assert.equal(engine.activeBoss?.hp, hpBeforeTheater);

    const struck = engine.strikeFromOwner({
      snapshot: calmSnap,
      theme,
      bossRaidMode: 'auto',
      viewMode: 'office',
      isReplay: false,
      isTheater: true,
      nowMs: 9_000,
      onSoundCue,
    });
    assert.equal(struck, false);
    assert.equal(engine.activeBoss?.hp, hpBeforeTheater);
    // Only the initial raid_spawn before theater was emitted
    assert.deepEqual(sounds, ['raid_spawn']);
  });

  test('updateTheaterStageHud updates -1 -> 0 first commit on 1-commit reel and re-renders cleanly on re-entry', () => {
    const oneCommitReel = parseGitLogOutput(
      [
        '__BW_COMMIT__\x1f1122334\x1f1763900000\x1fAlice\x1ffeat: initial commit\x1e',
        '5\t1\tsrc/index.ts',
      ].join('\n'),
      {
        repoId: 'repo_0',
        repoLabel: 'alpha-repo',
        branch: 'main',
        rangeDays: 14,
        nowMs: 1763905000000,
        locale: 'en',
      }
    );

    const engine = new GitTheaterEngine();
    engine.open(oneCommitReel, { themeId: 'cozy', locale: 'en', redactMode: false, autoplay: true });
    assert.equal(engine.getCurrentCommitIndex(), -1);

    withFakeDom(() => {
      const topHud = new LocalFakeElement('div') as unknown as HTMLElement;
      const bottomHud = new LocalFakeElement('div') as unknown as HTMLElement;
      const hudOpts = (suppressed: boolean) => ({
        engine,
        locale: 'en' as const,
        redactMode: false,
        suppressed,
        onPlayPause: () => {},
        onRestart: () => {},
        onPrevCommit: () => {},
        onNextCommit: () => {},
        onSeekFraction: () => {},
        onCycleSpeed: () => {},
        onOpenSelector: () => {},
        onExit: () => {},
      });

      // Initial render at commitIndex === -1
      updateTheaterStageHud(topHud, bottomHud, hudOpts(false));
      const beforeText = collectElementText(topHud as unknown as LocalFakeElement);
      assert.ok(beforeText.includes('0/1 commits'));

      // Advance past 0.4s trigger -> -1 -> 0 transition MUST update topHud
      engine.stepPlayback(0.5);
      assert.equal(engine.getCurrentCommitIndex(), 0);
      updateTheaterStageHud(topHud, bottomHud, hudOpts(false));
      const afterFirstText = collectElementText(topHud as unknown as LocalFakeElement);
      assert.ok(afterFirstText.includes('1/1 commits'));
      assert.ok(afterFirstText.includes('1122334'));

      // Hide/exit HUD clears children AND dataset keys
      engine.exit();
      updateTheaterStageHud(topHud, bottomHud, hudOpts(false));
      assert.equal((topHud as unknown as LocalFakeElement).children.length, 0);
      assert.equal((bottomHud as unknown as LocalFakeElement).children.length, 0);
      assert.equal((topHud as unknown as LocalFakeElement).dataset.renderKey, undefined);
      assert.equal((bottomHud as unknown as LocalFakeElement).dataset.locale, undefined);

      // Re-open exact same reel -> topHud & bottomHud MUST render again
      engine.open(oneCommitReel, { themeId: 'cozy', locale: 'en', redactMode: false, autoplay: true });
      engine.stepPlayback(0.5);
      updateTheaterStageHud(topHud, bottomHud, hudOpts(false));
      assert.ok((topHud as unknown as LocalFakeElement).children.length > 0);
      assert.ok((bottomHud as unknown as LocalFakeElement).children.length > 0);
      const reenteredText = collectElementText(topHud as unknown as LocalFakeElement);
      assert.ok(reenteredText.includes('1/1 commits'));
    });
  });

  test('GitTheaterEngine.open() with 0-commit reel keeps isPlaying() false', () => {
    const emptyReel = parseGitLogOutput('', {
      repoId: 'repo_0',
      repoLabel: 'empty-repo',
      branch: 'main',
      rangeDays: 7,
      nowMs: 1763905000000,
      locale: 'en',
    });
    assert.equal(emptyReel.commits.length, 0);

    const engine = new GitTheaterEngine();
    engine.open(emptyReel, { themeId: 'cozy', locale: 'en', redactMode: false, autoplay: true });
    assert.equal(engine.isActive(), true);
    assert.equal(engine.isPlaying(), false);
  });

  test('renderGitTheaterModal hides raw errorMessage in redactMode and GitRepoRegistry strips raw paths/stderr on failure', async () => {
    withFakeDom(() => {
      for (const locale of ['en', 'ko'] as const) {
        const backdrop = new LocalFakeElement('div') as unknown as HTMLElement;
        renderGitTheaterModal(backdrop, {
          open: true,
          locale,
          redactMode: true,
          loading: false,
          errorMessage: 'fatal: /Users/alice/secret-workspace/repo-x failed on feature/top-secret',
          repos: [{ repoId: 'repo_0', repoLabel: 'secret-repo', branch: 'feature/top-secret' }],
          selectedRepoId: 'repo_0',
          rangeDays: 14,
          theaterActive: false,
          isDemoReelActive: false,
          onSelectRepo: () => {},
          onSelectRange: () => {},
          onRefreshRepos: () => {},
          onStartRepoTheater: () => {},
          onStartDemoTheater: () => {},
          onExitTheater: () => {},
          onClose: () => {},
        });
        const text = collectElementText(backdrop as unknown as LocalFakeElement);
        assert.equal(text.includes('/Users/alice'), false);
        assert.equal(text.includes('secret-workspace'), false);
        assert.equal(text.includes('feature/top-secret'), false);
        assert.ok(text.includes(tStrings(locale).errorHiddenLabel));
      }
    });

    assert.equal(
      summarizeGitFailure('Command failed: git log in /Users/alice/secret-repo ETIMEDOUT'),
      'git command timed out'
    );
    assert.equal(
      summarizeGitFailure('ERR_CHILD_PROCESS_STDIO_MAXBUFFER at C:\\Users\\alice\\repo'),
      'git output exceeded limit'
    );
    assert.equal(
      summarizeGitFailure('spawn git ENOENT in /Users/alice/repo'),
      'git binary unavailable'
    );
    assert.equal(
      summarizeGitFailure('fatal: /Users/alice/top-secret-repo: bad revision feature/xyz'),
      'git log failed'
    );

    const repoPath = process.cwd();
    const failingRunner: GitExecRunner = async (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { stdout: 'secret-branch\n', stderr: '', exitCode: 0 };
      }
      return {
        stdout: '',
        stderr: `fatal: ${repoPath}/secret-branch failed`,
        exitCode: 128,
      };
    };

    const registry = new GitRepoRegistry({ execRunner: failingRunner });
    await registry.refreshFromCandidates([{ path: repoPath, hostId: 'local' }]);
    await assert.rejects(
      () =>
        registry.getHistoryReel({
          repoId: 'repo_0',
          rangeDays: 14,
          maxCommits: 60,
        }),
      (err: unknown) => {
        assert.ok(err instanceof GitHistoryError);
        assert.equal(err.message, 'git log failed');
        assert.equal(err.message.includes(repoPath), false);
        assert.equal(err.message.includes('secret-branch'), false);
        return true;
      }
    );
  });

  test('truncateForDisplay preserves emoji UTF-16 surrogate pairs without splitting codepoints', () => {
    const emojiStr = '🚀🔥✨🎉💡';
    const truncated = truncateForDisplay(emojiStr, 4);
    assert.equal(truncated, '🚀🔥✨…');
    assert.equal(Array.from(truncated).length, 4);
    assert.equal(/[\uD800-\uDFFF]/.test(truncated.replace(/\p{Emoji}/gu, '')), false);
    assert.equal(Buffer.from(truncated, 'utf8').toString('utf8'), truncated);

    const mixed = 'feat: 🚀🔥✨🎉';
    const mixedTruncated = truncateForDisplay(mixed, 8);
    assert.equal(mixedTruncated, 'feat: 🚀…');
    assert.equal(Array.from(mixedTruncated).length, 8);
    assert.equal(truncateForDisplay(emojiStr, 5), emojiStr);
  });
});
