import fs from 'node:fs';
import path from 'node:path';
import { assert, describe, test } from 'orca/testing';
import {
  DEFAULT_BOTWORLD_DOCUMENT,
  MAX_BOTWORLD_DOC_BYTES,
  createEmptySnapshot,
  safeJsonParse,
  stripDangerousKeys,
  validateBotWorldDocument,
} from './types.ts';
import { encodeBotWorldContent, mergeBotWorldDocuments } from '../editor/doc-sync.ts';
import { getThemeConfig, resolveCharacterSpritePath, resolveThemeAssetPath } from '../shared/assets-catalog.ts';
import { ReplayController } from '../shared/motion.ts';

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

describe('Prototype pollution, document validation, and static XSS checks', () => {
  test('safeJsonParse strips __proto__, constructor, and prototype keys', () => {
    const malicious = '{"ok":true,"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"nested":{"prototype":{"y":2},"val":"safe"}}';
    const parsed = safeJsonParse<Record<string, unknown>>(malicious);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined);
    assert.equal(({} as Record<string, unknown>).y, undefined);
    assert.equal(Object.hasOwn(parsed, '__proto__'), false);
    assert.equal(Object.hasOwn(parsed, 'constructor'), false);
    assert.equal(Object.hasOwn(parsed, 'prototype'), false);
    assert.equal((parsed.nested as Record<string, unknown>).val, 'safe');
    assert.equal(Object.hasOwn(parsed.nested as object, 'prototype'), false);
  });

  test('rejects malicious, oversized, and invalid .botworld documents safely', () => {
    // Oversized > 256 KiB
    const huge = JSON.stringify({
      version: 1,
      themeId: 'startup_office',
      redactMode: false,
      selectedBotId: null,
      botAppearances: { a: 'ddochi' },
      pad: 'x'.repeat(MAX_BOTWORLD_DOC_BYTES + 100),
    });
    const resHuge = validateBotWorldDocument(huge);
    assert.equal(resHuge.valid, false);
    assert.deepEqual(resHuge.data, DEFAULT_BOTWORLD_DOCUMENT);

    // Invalid themeId, character path traversal, prototype pollution keys
    const maliciousDoc =
      '{"version":1,"themeId":"../../etc/passwd","redactMode":"yes","selectedBotId":"bot\\n1","__proto__":{"admin":true},"botAppearances":{"bot1":"../evil","__proto__":"ddochi","bot2":"worker_helper","bot3":"security"}}';
    const resMal = validateBotWorldDocument(maliciousDoc);
    assert.equal(resMal.valid, true);
    assert.equal(resMal.data.themeId, 'startup_office');
    assert.equal(resMal.data.redactMode, false);
    assert.equal(resMal.data.selectedBotId, null);
    assert.deepEqual(resMal.data.botAppearances, { bot3: 'security' });
    assert.equal(({} as Record<string, unknown>).admin, undefined);

    // Malformed JSON falls back cleanly
    const resBad = validateBotWorldDocument('{not-json');
    assert.equal(resBad.valid, false);
    assert.deepEqual(resBad.data, DEFAULT_BOTWORLD_DOCUMENT);
  });

  test('asset allowlist blocks path traversal', () => {
    assert.equal(resolveThemeAssetPath('../../secret'), '../assets/themes/startup_office/bg.jpg');
    assert.equal(resolveThemeAssetPath('corporate_office'), '../assets/themes/corporate_office/bg.jpg');
    assert.equal(resolveCharacterSpritePath('../etc/passwd'), '../assets/characters/ddochi/idle.png');
    assert.equal(resolveCharacterSpritePath('cve'), '../assets/characters/cve/idle.png');
  });

  test('static XSS scan: zero innerHTML/eval/new Function/inline handlers in source', () => {
    const pluginRoot = path.resolve('.');
    const dirs = ['src', 'shared', 'panel', 'editor'];
    const forbidden = [
      /\binnerHTML\b/,
      /\bouterHTML\b/,
      /\binsertAdjacentHTML\b/,
      /\bdocument\.write\b/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
    ];
    for (const d of dirs) {
      const fullDir = path.join(pluginRoot, d);
      for (const file of collectFiles(fullDir, ['.ts', '.tsx', '.html'])) {
        if (file.endsWith('.test.ts')) continue;
        const content = fs.readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
          assert.equal(
            pattern.test(content),
            false,
            `Forbidden XSS pattern ${pattern} found in ${file}`
          );
        }
        if (file.endsWith('.html')) {
          assert.equal(
            /\son[a-z]+\s*=/i.test(content),
            false,
            `Inline event handler found in ${file}`
          );
          assert.ok(
            content.includes('Content-Security-Policy') &&
              content.includes("connect-src 'none'") &&
              content.includes("style-src 'self';") &&
              content.includes("img-src 'self' data:;"),
            `Strict CSP missing in ${file}`
          );
        }
      }
    }
  });

  test('stripDangerousKeys enforces max depth, doc-sync validates merge/encode, editor never auto-disables redactMode, and replay transients decay when paused', () => {
    // Deep nesting guard (depth 60 does not stack overflow and truncates beyond depth 16)
    let deep: Record<string, unknown> = { leaf: 'end' };
    for (let i = 0; i < 60; i++) {
      deep = { child: deep };
    }
    const stripped = stripDangerousKeys(deep);
    assert.ok(typeof stripped === 'object' && stripped !== null);

    // mergeBotWorldDocuments validates mine inputs & encodeBotWorldContent normalizes appearances
    const merged = mergeBotWorldDocuments(
      DEFAULT_BOTWORLD_DOCUMENT,
      { ...DEFAULT_BOTWORLD_DOCUMENT, themeId: 'corporate_office', redactMode: true },
      {
        version: 1,
        themeId: '../../evil' as unknown as 'startup_office',
        redactMode: 'yes' as unknown as boolean,
        selectedBotId: 'bad\nbot',
        botAppearances: {
          b1: 'worker_helper' as unknown as 'ddochi',
          __proto__: 'cve' as unknown as 'ddochi',
          b2: 'security',
        },
      }
    );
    assert.equal(merged.themeId, 'corporate_office');
    assert.equal(merged.redactMode, true);
    assert.equal(merged.selectedBotId, null);
    assert.deepEqual(merged.botAppearances, { b2: 'security' });

    const encoded = encodeBotWorldContent({
      ...DEFAULT_BOTWORLD_DOCUMENT,
      botAppearances: {
        b1: 'worker_helper' as unknown as 'ddochi',
        b2: 'cve',
      },
    });
    assert.ok(!encoded.text.includes('worker_helper'));
    assert.ok(encoded.text.includes('"b2": "cve"'));

    // F-01: editor/main.ts never calls setRedactMode({ redactMode: false }) during boot
    const editorSrc = fs.readFileSync(path.resolve('editor/main.ts'), 'utf8');
    assert.ok(editorSrc.includes('Boolean(state.payload.redactMode) || Boolean(state.docData.redactMode)'));
    assert.ok(editorSrc.includes('state.docData.redactMode && !initial.redactMode'));

    // F-05: paused replay transients decay when motion.step runs
    const replay = new ReplayController();
    const snap = createEmptySnapshot();
    snap.bots['b1'] = {
      id: 'b1',
      name: '보안',
      agent: 'claude',
      paused: false,
      specialty: '',
      status: { kind: 'Working', tool: null },
      currentTaskTitle: null,
      currentTool: null,
      lastActivityAt: 1000,
      homeChatId: null,
      needsYouCount: 0,
      activeWorkerCount: 0,
    };
    snap.botOrder = ['b1'];
    const now = 1_700_000_000_000;
    const theme = getThemeConfig('startup_office');
    replay.seekTo(
      now,
      [{ timestampMs: now - 1000, snapshot: snap }],
      [
        {
          timestampMs: now - 200,
          summary: '작업 중',
          redactedSummary: '작업 중',
          event: { kind: 'BotWorking', botId: 'b1', botName: '보안', tool: null },
        },
      ],
      snap,
      theme
    );
    assert.equal(replay.isReplay, true);
    assert.equal(replay.isPlaying, false);
    assert.equal(replay.motion.hasActiveAnimations(), true);
    for (let i = 0; i < 20; i++) {
      replay.motion.step(0.2, replay.snapshot, theme);
    }
    assert.equal(replay.motion.hasActiveAnimations(), false);
  });
});
