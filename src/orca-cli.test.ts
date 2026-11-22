import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, test } from 'orca/testing';
import {
  MAX_CLI_OUTPUT_BYTES,
  MAX_CLI_TIMEOUT_MS,
  OrcaCli,
  OrcaCliError,
  assertAllowedSubcommand,
  buildMinimalSafeEnv,
  clampLimit,
  validateBotName,
  validateCursor,
  validateSince,
  verifyTrustedBinaryPath,
} from './orca-cli.ts';
import { PollerSession } from './poller.ts';

const isOrcaCliError = (err: unknown): boolean => err instanceof OrcaCliError;

describe('OrcaCli security & argument validation', () => {
  test('blocks command injection, flag injection, and control chars in botName', () => {
    for (const bad of [
      '',
      '   ',
      '-evil-flag',
      '--json',
      '; rm -rf /',
      'bot|cat',
      'bot$(id)',
      'bot\0name',
      'bot\nname',
      'bot\rname',
      'x'.repeat(129),
    ]) {
      assert.throws(() => validateBotName(bad), isOrcaCliError);
    }
    assert.equal(validateBotName('Ops Lead'), 'Ops Lead');
    assert.equal(validateBotName('클라우드 운영'), '클라우드 운영');
    assert.equal(validateBotName('bot_world-1'), 'bot_world-1');
  });

  test('validates since and clamps limit strictly', () => {
    assert.equal(validateSince('24h'), '24h');
    assert.equal(validateSince('30m'), '30m');
    assert.throws(() => validateSince('-24h'), isOrcaCliError);
    assert.throws(() => validateSince('24h;rm'), isOrcaCliError);
    assert.throws(() => validateSince('0h'), isOrcaCliError);

    assert.equal(clampLimit(0), 1);
    assert.equal(clampLimit(-50), 1);
    assert.equal(clampLimit(30), 30);
    assert.equal(clampLimit(9999), 200);
    assert.throws(() => clampLimit(Number.NaN), isOrcaCliError);
  });

  test('enforces read-only subcommand allowlist at runtime', () => {
    assertAllowedSubcommand(['status', '--json']);
    assertAllowedSubcommand(['bot', 'list', '--json']);
    assertAllowedSubcommand(['bot', 'chats', '--bot', 'Ops Lead', '--all', '--json']);
    assertAllowedSubcommand(['bot', 'item', 'list', '--bot', 'Ops Lead', '--json']);
    assertAllowedSubcommand(['bot', 'item', 'list', '--bot', 'Ops Lead', '--all', '--json']);
    assertAllowedSubcommand(['worktree', 'ps', '--since', '24h', '--json']);
    assertAllowedSubcommand(['orchestration', 'inbox', '--limit', '30', '--full', '--json']);
    assertAllowedSubcommand(['orchestration', 'worker-list', '--limit', '100', '--full', '--json']);
    assertAllowedSubcommand(['orchestration', 'run-list', '--full', '--json']);
    assertAllowedSubcommand(['automations', 'list', '--json']);
    assertAllowedSubcommand(['automations', 'runs', '--json']);

    for (const disallowed of [
      ['terminal', 'send', '--text', 'rm -rf /'],
      ['bot', 'send', '--bot', 'Ops Lead', '--text', 'hi'],
      ['orchestration', 'send', '--body', 'x'],
      ['agent', 'launch', '--agent', 'claude'],
      ['automations', 'create', '--name', 'evil'],
      ['bot', 'chats', '--bot', '--flag-inject', '--all', '--json'],
      ['bot', 'chats', '--bot', 'Ops Lead;id', '--all', '--json'],
    ]) {
      assert.throws(() => assertAllowedSubcommand(disallowed), isOrcaCliError);
    }
  });

  test('scrubs sensitive session & credential environment variables', () => {
    const env = buildMinimalSafeEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      TMPDIR: '/tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      USER: 'tester',
      ORCA_BOT_TOOLS_TOKEN: 'secret-bot-token',
      ORCA_AGENT_SESSION_ID: 'sess-123',
      ORCA_SESSION_ID: 'orca-sess',
      ORCA_TERMINAL_ID: 'term-1',
      ORCA_PANE_KEY: 'pane-1',
      ORCA_CHAT_ID: 'chat-1',
      ANTHROPIC_API_KEY: 'sk-' + 'ant-secret',
      OPENAI_API_KEY: 'sk-' + 'openai-secret',
      GEMINI_API_KEY: 'AIza' + '-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      GITHUB_TOKEN: 'ghp' + '_secret',
      GH_TOKEN: 'gho' + '_secret',
      SLACK_BOT_TOKEN: 'xoxb' + '-secret',
    });

    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'USER']);
    assert.equal(env.ORCA_BOT_TOOLS_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  });

  test('rejects world-writable binaries and untrusted symlinks', () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-test-'));
    try {
      const goodBin = path.join(tmpDir, 'orca');
      fs.writeFileSync(goodBin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(goodBin, 0o755);

      // Untrusted path not in allowlist
      assert.equal(verifyTrustedBinaryPath(goodBin), null);

      // Allowed path check with explicit allowlist & prefix
      assert.equal(verifyTrustedBinaryPath(goodBin, [goodBin], [tmpDir + '/']), goodBin);

      // World-writable binary must be rejected
      fs.chmodSync(goodBin, 0o777);
      assert.equal(verifyTrustedBinaryPath(goodBin, [goodBin], [tmpDir + '/']), null);
      fs.chmodSync(goodBin, 0o755);

      // Binary or symlink target under a world-writable ancestor directory must be rejected
      const wwAncestor = path.join(tmpDir, 'ww-ancestor');
      fs.mkdirSync(wwAncestor);
      fs.chmodSync(wwAncestor, 0o777);
      const safeChildDir = path.join(wwAncestor, 'bin');
      fs.mkdirSync(safeChildDir);
      fs.chmodSync(safeChildDir, 0o755);
      const nestedBin = path.join(safeChildDir, 'orca');
      fs.writeFileSync(nestedBin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(nestedBin, 0o755);
      assert.equal(verifyTrustedBinaryPath(nestedBin, [nestedBin], [tmpDir + '/']), null);

      const nestedLink = path.join(tmpDir, 'orca-ww-ancestor-link');
      fs.symlinkSync(nestedBin, nestedLink);
      assert.equal(verifyTrustedBinaryPath(nestedLink, [nestedLink], [tmpDir + '/']), null);

      // Symlink pointing outside trusted prefix must be rejected
      const outsideDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-outside-'));
      try {
        const outsideTarget = path.join(outsideDir, 'orca');
        fs.writeFileSync(outsideTarget, '#!/bin/sh\necho evil\n');
        fs.chmodSync(outsideTarget, 0o755);
        const symlinkPath = path.join(tmpDir, 'orca-link');
        fs.symlinkSync(outsideTarget, symlinkPath);
        assert.equal(verifyTrustedBinaryPath(symlinkPath, [symlinkPath], [tmpDir + '/']), null);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('clamps timeout <= 8000ms and rejects oversized stdout > 2 MiB', async () => {
    let seenTimeout = 0;
    let seenEnvKeys: string[] = [];
    const cli = new OrcaCli({
      timeoutMs: 99_999,
      env: buildMinimalSafeEnv({ PATH: '/usr/bin', AWS_SECRET_ACCESS_KEY: 'secret' }),
      runner: async (_bin, _args, opts) => {
        seenTimeout = opts.timeoutMs;
        seenEnvKeys = Object.keys(opts.env);
        return { stdout: JSON.stringify({ ok: true, result: { bots: [] } }), stderr: '', exitCode: 0 };
      },
    });
    await cli.botList();
    assert.equal(seenTimeout, MAX_CLI_TIMEOUT_MS);
    assert.deepEqual(seenEnvKeys, ['PATH']);

    const bigCli = new OrcaCli({
      runner: async () => ({
        stdout: 'x'.repeat(MAX_CLI_OUTPUT_BYTES + 10),
        stderr: '',
        exitCode: 0,
      }),
    });
    await assert.rejects(() => bigCli.status(), (err: unknown) => {
      return err instanceof OrcaCliError && err.code === 'output_too_large';
    });
  });

  test('rejects botName containing shell metacharacters or control sequences via runner', async () => {
    const cli = new OrcaCli({
      runner: async () => ({ stdout: '{}', stderr: '', exitCode: 0 }),
    });
    await assert.rejects(() => cli.botChats('; rm -rf /'), isOrcaCliError);
    await assert.rejects(() => cli.botChats('-flag'), isOrcaCliError);
    await assert.rejects(() => cli.botItemList('bot\x00evil', false), isOrcaCliError);
  });

  test('enforces group-writable check, PATH sanitization, strict cursor validation, and concurrency cap <= 4', async () => {
    // PATH strips empty segments and relative paths
    const env = buildMinimalSafeEnv({
      PATH: '/usr/bin::.:../bin:/bin:relative/dir',
      HOME: '/Users/tester',
    });
    assert.equal(env.PATH, '/usr/bin:/bin');

    // validateCursor trims and blocks flags/spaces/disallowed chars
    assert.equal(validateCursor('  cur_123:abc  '), 'cur_123:abc');
    for (const badCursor of ['', '   ', '-flag', ' --evil', 'cur sor', 'cur;id', 'cur\n1']) {
      assert.throws(() => validateCursor(badCursor), isOrcaCliError);
    }

    // group-writable binary is rejected
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-cli-gw-test-'));
    try {
      const bin = path.join(tmpDir, 'orca');
      fs.writeFileSync(bin, '#!/bin/sh\necho ok\n');
      fs.chmodSync(bin, 0o775);
      assert.equal(verifyTrustedBinaryPath(bin, [bin], [tmpDir + '/']), null);
      fs.chmodSync(bin, 0o755);
      assert.equal(verifyTrustedBinaryPath(bin, [bin], [tmpDir + '/']), bin);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Slot hand-off keeps activeCount <= 4 even under 12 simultaneous requests
    let currentConcurrent = 0;
    let maxObservedConcurrent = 0;
    const cli = new OrcaCli({
      runner: async () => {
        currentConcurrent++;
        if (currentConcurrent > maxObservedConcurrent) {
          maxObservedConcurrent = currentConcurrent;
        }
        await new Promise((r) => setTimeout(r, 15));
        currentConcurrent--;
        return { stdout: JSON.stringify({ ok: true, result: { bots: [] } }), stderr: '', exitCode: 0 };
      },
    });
    await Promise.all(Array.from({ length: 12 }, () => cli.botList()));
    assert.ok(maxObservedConcurrent <= 4, `Expected max 4 concurrent, saw ${maxObservedConcurrent}`);

    // Poller type guards survive malformed CLI items/page fields
    const session = new PollerSession();
    const malformedClient = {
      isStopped: () => false,
      status: async () => ({
        ok: true,
        result: { runtime: { state: 'ready', reachable: true, runtimeId: 'rt-g' } },
      }),
      botList: async () => ({
        ok: true,
        result: { bots: [{ id: 'b1', name: 'Ops Lead', agent: 'claude', paused: false }] },
      }),
      botChats: async () => ({ ok: true, result: { bot: 'Ops Lead', chats: [] } }),
      botItemList: async () => ({
        ok: true,
        result: { botId: 'b1', botName: 'Ops Lead', items: 'not-an-array' },
      }),
      worktreePs: async () => ({ ok: true, result: { worktrees: [] } }),
      orchestrationInbox: async () => ({ ok: true, result: { messages: [] } }),
      orchestrationWorkerList: async () => ({
        ok: true,
        result: { workers: [], page: { hasMore: true, nextCursor: '-bad-flag' } },
      }),
      orchestrationRunList: async () => ({ ok: true, result: { runs: [] } }),
      automationsList: async () => ({ ok: true, result: { automations: [] } }),
      automationsRuns: async () => ({ ok: true, result: { runs: [] } }),
    };
    await session.step(malformedClient, { forceFull: true });
    assert.equal(session.snapshot.runtime.connected, true);
  });
});
