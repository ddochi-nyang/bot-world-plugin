import { assert, describe, test } from 'orca/testing';
import { createEventRecord } from './events.ts';
import { redactLabel, scrubAll, scrubSecrets } from './redact.ts';
import { createEmptySnapshot } from './types.ts';
import { formatStatusBarParams, prepareSnapshotForUi } from './worker.ts';

describe('Secret & PII scrubbing and redactMode', () => {
  test('scrubs AWS keys, Slack/GitHub/Bearer tokens, webhooks, and PEM private keys', () => {
    const awsKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const awsTemp = 'ASIA' + '1234567890ABCDEF';
    const slackToken = ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnop'].join('-');
    const ghToken = 'ghp' + '_1234567890abcdefghijklmnopqrstuvwxyz';
    const ghPat = 'github_pat' + '_1234567890abcdef1234567890abcdef';
    const jwt = 'eyJhbGci' + 'OiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const slackHook =
      'https://hooks.slack.com/' + ['services', 'T00000000', 'B00000000', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('/');
    const pemHeader = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
    const pemFooter = '-----END ' + 'RSA PRIVATE KEY-----';

    const sample = [
      `key=${awsKey}`,
      `temp=${awsTemp}`,
      `slack=${slackToken}`,
      `gh=${ghToken}`,
      `pat=${ghPat}`,
      `auth=Bearer ${jwt}`,
      `hook=${slackHook}`,
      'discord=https://discord.com/api/webhooks/123456/abcdef',
      'teams=https://contoso.webhook.office.com/webhookb2/abc/IncomingWebhook/def/ghi',
      `pem=${pemHeader}\nMIIEowIBAAKCAQEA\n${pemFooter}`,
    ].join(' ');

    const cleaned = scrubSecrets(sample);
    assert.ok(!cleaned.includes(awsKey));
    assert.ok(!cleaned.includes(awsTemp));
    assert.ok(!cleaned.includes('xoxb' + '-'));
    assert.ok(!cleaned.includes('ghp' + '_'));
    assert.ok(!cleaned.includes('github_pat' + '_'));
    assert.ok(!cleaned.includes('eyJhbGci' + 'Oi'));
    assert.ok(!cleaned.includes('hooks.slack.com/services'));
    assert.ok(!cleaned.includes('discord.com/api/webhooks'));
    assert.ok(!cleaned.includes('webhook.office.com'));
    assert.ok(!cleaned.includes('BEGIN ' + 'RSA PRIVATE KEY'));
    assert.ok(!cleaned.includes('MIIEowIBAAKCAQEA'));

    assert.ok(cleaned.includes('key=[REDACTED_TOKEN]'));
    assert.ok(cleaned.includes('auth=Bearer [REDACTED_TOKEN]'));
    assert.ok(cleaned.includes('hook=[REDACTED_WEBHOOK]'));
    assert.ok(cleaned.includes('pem=[REDACTED_PRIVATE_KEY]'));
  });

  test('scrubs emails, payment cards, and 12-digit AWS account IDs while preserving Korean, UUIDs, and epoch ms', () => {
    const pii =
      '담당자: alice.kim@example.com, 카드1: 4111-1111-1111-1111, 카드2: 5500 0000 0000 0004, 카드3: 4111111111111111, 아멕스: 3412-345678-90123, 계정: 123456789012, ARN: arn:aws:iam::210987654321:role/demo, 시각: 1795185500000';
    const cleaned = scrubAll(pii);
    assert.ok(!cleaned.includes('alice.kim@example.com'));
    assert.ok(!cleaned.includes('4111-1111-1111-1111'));
    assert.ok(!cleaned.includes('5500 0000 0000 0004'));
    assert.ok(!cleaned.includes('4111111111111111'));
    assert.ok(!cleaned.includes('3412-345678-90123'));
    assert.ok(!cleaned.includes('123456789012'));
    assert.ok(!cleaned.includes('210987654321'));
    assert.ok(cleaned.includes('ARN: arn:aws:iam::[REDACTED_PII]:role/demo'));
    assert.ok(cleaned.includes('시각: 1795185500000'));

    const safe =
      '보안 봇이 ~/projects/demo/bot-world 에서 작업 중 (ts=1795185500000, id=550e8400-e29b-41d4-a716-446655440000, numericUuid=550e8400-e29b-41d4-a716-123456789012, date=2026-11-21).';
    assert.equal(scrubAll(safe), safe);
  });

  test('redactMode hides tasks, tools, messages, event details, and statusBar details', () => {
    const snap = createEmptySnapshot();
    snap.runtime.connected = true;
    snap.runtime.reachable = true;
    snap.runtime.errorMessage = 'secret internal error ' + 'AKIA' + 'IOSFODNN7EXAMPLE';
    snap.bots['bot-1'] = {
      id: 'bot-1',
      name: '보안',
      agent: 'claude',
      paused: false,
      specialty: '인증·보안·패치',
      status: { kind: 'Working', tool: 'run_command' },
      currentTaskTitle: '비밀 토큰 점검 ' + 'AKIA' + 'IOSFODNN7EXAMPLE',
      currentTool: 'run_command',
      lastActivityAt: 1795185500000,
      homeChatId: 'chat-1',
      needsYouCount: 0,
      activeWorkerCount: 1,
    };
    snap.workers['d-1'] = {
      dispatchId: 'd-1',
      taskId: 't-1',
      runId: null,
      parentBotId: 'bot-1',
      parentBotName: '보안',
      provider: 'claude',
      model: 'claude-opus-5-5',
      workerState: 'ready',
      dispatchStatus: 'dispatched',
      terminalState: 'attached',
      terminalHandle: 'term_1',
      worktreeId: 'wt-secret-branch',
      liveness: 'Live',
      activity: 'working',
      toolName: 'edit_file',
      taskTitle: '시크릿 수정',
      updatedAt: 1795185500000,
    };
    snap.recentMessages.push({
      id: 'm1',
      sequence: 1,
      msgType: 'question',
      fromHandle: 'bot-1',
      toHandle: 'external:alice@example.com',
      runId: null,
      subject: '비밀 질문 내용',
      body: '본문 세부 사항',
      createdAt: null,
      threadId: 'thread-secret',
      payload: '{"secret":true}',
    });

    const redactedSnap = prepareSnapshotForUi(snap, true, 'en');
    assert.equal(redactedSnap.runtime.errorMessage, 'Error details hidden');
    assert.equal(redactedSnap.bots['bot-1'].agent, 'Private');
    assert.equal(redactedSnap.bots['bot-1'].currentTool, null);
    assert.equal(redactedSnap.bots['bot-1'].status.kind, 'Working');
    if (redactedSnap.bots['bot-1'].status.kind === 'Working') {
      assert.equal(redactedSnap.bots['bot-1'].status.tool, null);
    }
    assert.equal(redactedSnap.bots['bot-1'].currentTaskTitle, redactLabel('보안', 'Working'));
    assert.equal(redactedSnap.workers['d-1'].provider, 'Worker #1');
    assert.equal(redactedSnap.workers['d-1'].model, null);
    assert.equal(redactedSnap.workers['d-1'].worktreeId, null);
    assert.equal(redactedSnap.recentMessages[0].fromHandle, 'bot-1');
    assert.equal(redactedSnap.recentMessages[0].toHandle, 'Private');
    assert.equal(redactedSnap.recentMessages[0].subject, '');
    assert.equal(redactedSnap.recentMessages[0].body, '');
    assert.equal(redactedSnap.recentMessages[0].payload, null);
    assert.equal(redactedSnap.recentMessages[0].threadId, null);

    const redactedSnapKo = prepareSnapshotForUi(snap, true, 'ko');
    assert.equal(redactedSnapKo.runtime.errorMessage, '오류 상세 가려짐');
    assert.equal(redactedSnapKo.bots['bot-1'].agent, '비공개');
    assert.equal(redactedSnapKo.bots['bot-1'].currentTaskTitle, redactLabel('보안', '작업 중'));
    assert.equal(redactedSnapKo.workers['d-1'].provider, '도우미 #1');
    assert.equal(redactedSnapKo.recentMessages[0].toHandle, '비공개');

    const evRec = createEventRecord(
      { kind: 'BotWorking', botId: 'bot-1', botName: '보안', tool: 'run_command' },
      1795185500000,
      1,
      'en'
    );
    assert.equal(evRec.summary, 'Working (run_command)');
    assert.equal(evRec.redactedSummary, 'Working');

    const evRecKo = createEventRecord(
      { kind: 'BotWorking', botId: 'bot-1', botName: '보안', tool: 'run_command' },
      1795185500000,
      1,
      'ko'
    );
    assert.equal(evRecKo.summary, '작업 중 (run_command)');
    assert.equal(evRecKo.redactedSummary, '작업 중');

    const sbRedacted = formatStatusBarParams(snap, true, 'en');
    assert.ok(!sbRedacted.text.includes('보안'));
    assert.ok(sbRedacted.text.includes('Redacted'));
    assert.ok(!sbRedacted.tooltip.includes('보안'));

    const sbRedactedKo = formatStatusBarParams(snap, true, 'ko');
    assert.ok(!sbRedactedKo.text.includes('보안'));
    assert.ok(sbRedactedKo.text.includes('가림'));
    assert.ok(!sbRedactedKo.tooltip.includes('보안'));
  });

  test('handles new secret patterns, truncated PEM bodies, and O(N) card matching without false positives', () => {
    const xappTok = ['xapp', '1', 'A0000000000', '0000000000000', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const jwtTok = 'eyJhbGci' + 'OiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const antTok = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const openaiTok = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
    const googleTok = 'AIza' + 'SyDummyGoogleApiKey1234567890abcd';
    const gitlabTok = 'glpat' + '-abcdefghijklmnop1234';
    const npmTok = 'npm' + '_abcdefghijklmnopqrstuvwxyz123456';
    const pypiTok = 'pypi' + '-AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWpr';
    const ecPemHeader = '-----BEGIN ' + 'EC PRIVATE KEY-----';

    const sample = [
      `xapp=${xappTok}`,
      `multi=Bearer   ${jwtTok}`,
      'basic=Basic  dXNlcjpwYXNzd29yZDEyMw==',
      'tok=Token  deadbeef12345678',
      `ant=${antTok}`,
      `openai=${openaiTok}`,
      `google=${googleTok}`,
      `gitlab=${gitlabTok}`,
      `npm=${npmTok}`,
      `pypi=${pypiTok}`,
      'url=https://alice:s3cr3tPass!@git.example.com/org/repo.git',
      `truncPem=${ecPemHeader}\nMHQCAQEEIB1234567890abcdef+/\nYWJjZGVmZ2hpams=\n다음 정상 문장`,
    ].join(' ');

    const cleaned = scrubAll(sample);
    assert.ok(!cleaned.includes('xapp' + '-1-'));
    assert.ok(!cleaned.includes('eyJhbGci' + 'Oi'));
    assert.ok(!cleaned.includes('dXNlcjpwYXNzd29yZDEyMw=='));
    assert.ok(!cleaned.includes('deadbeef12345678'));
    assert.ok(!cleaned.includes('sk-' + 'ant-api03'));
    assert.ok(!cleaned.includes('sk-' + 'proj-'));
    assert.ok(!cleaned.includes('AIza' + 'SyDummy'));
    assert.ok(!cleaned.includes('glpat' + '-'));
    assert.ok(!cleaned.includes('npm' + '_abcd'));
    assert.ok(!cleaned.includes('pypi' + '-AgEI'));
    assert.ok(!cleaned.includes('s3cr3tPass!'));
    assert.ok(!cleaned.includes('MHQCAQEEIB1234567890abcdef'));
    assert.ok(!cleaned.includes('YWJjZGVmZ2hpams='));
    assert.ok(cleaned.includes('https://[REDACTED_TOKEN]@git.example.com/org/repo.git'));
    assert.ok(cleaned.includes('다음 정상 문장'));

    // Non-false-positives: Korean text, English prose, UUID, epoch ms
    const benign =
      '한국어 문장 basic authentication and token validation id=550e8400-e29b-41d4-a716-446655440000 ts=1795185500000';
    assert.equal(scrubAll(benign), benign);

    // O(N) performance guard against long repeated "1-1-1-..." input
    const longNumeric = '1-'.repeat(40_000) + '1';
    const t0 = performance.now();
    const out = scrubAll(longNumeric);
    const elapsedMs = performance.now() - t0;
    assert.equal(out, longNumeric);
    assert.ok(elapsedMs < 500, `Expected linear-time card scan, took ${elapsedMs}ms`);
  });
});
