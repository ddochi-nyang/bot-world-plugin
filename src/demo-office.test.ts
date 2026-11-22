import { assert, describe, test } from 'orca/testing';
import { deskPosition, getThemeConfig, resolveCharacterId } from '../shared/assets-catalog.ts';
import { renderBotDetail } from '../shared/bot-detail-view.ts';
import { DemoOfficeSession, createDemoOfficeSession } from '../shared/demo-office.ts';
import { createEmptySnapshot } from './types.ts';

describe('DemoOfficeSession, character keyword priority, overflow grid, and 0-bot onboarding', () => {
  test('createDemoOfficeSession builds realistic initial payload with 8 bots, live workers, items, and 4 keyframes', () => {
    const t0 = 1_700_000_000_000;
    const session = createDemoOfficeSession(t0);
    assert.ok(session instanceof DemoOfficeSession);

    const payloadEn = session.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: { 'demo-ops-lead': 'bot_world' },
    });

    assert.equal(payloadEn.snapshot.runtime.connected, true);
    assert.equal(payloadEn.snapshot.botOrder.length, 8);
    assert.equal(Object.keys(payloadEn.snapshot.bots).length, 8);
    assert.equal(Object.keys(payloadEn.snapshot.workers).length, 4);
    assert.ok(Object.values(payloadEn.snapshot.items).some((it) => it.status === 'needs_you'));
    assert.ok(Object.keys(payloadEn.snapshot.automations).length >= 3);
    assert.ok(payloadEn.snapshot.recentMessages.length >= 3);
    assert.ok(payloadEn.events.length >= 6);
    assert.equal(payloadEn.keyframes.length, 4);
    assert.equal(
      payloadEn.keyframes[3].timestampMs - payloadEn.keyframes[0].timestampMs,
      120 * 60_000
    );
    assert.deepEqual(payloadEn.botAppearances, { 'demo-ops-lead': 'bot_world' });

    const payloadKo = session.getPayload({
      themeId: 'corporate_office',
      redactMode: false,
      locale: 'ko',
      languageSetting: 'ko',
      botAppearances: {},
    });
    assert.equal(payloadKo.activeTheme, 'corporate_office');
    assert.equal(payloadKo.locale, 'ko');
    assert.equal(
      payloadKo.snapshot.bots['demo-ops-lead'].specialty,
      '팀 조율 · 업무 분류'
    );
  });

  test('tick() advances rotating scenario and generates all expected WorldEvent kinds', () => {
    const t0 = 1_700_000_000_000;
    const session = createDemoOfficeSession(t0);
    const seenKinds = new Set<string>();

    for (let i = 0; i < 8; i++) {
      const evs = session.tick();
      for (const ev of evs) {
        seenKinds.add(ev.kind);
      }
    }

    for (const expected of [
      'Handoff',
      'WorkerStart',
      'BotWorking',
      'ToolChanged',
      'ItemNeedsYou',
      'AutomationRun',
      'Reply',
      'BotIdle',
    ]) {
      assert.ok(seenKinds.has(expected), `Expected DemoOfficeSession.tick() to emit ${expected}`);
    }

    const payload = session.getPayload({
      themeId: 'startup_office',
      redactMode: false,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    assert.ok(payload.snapshot.capturedAt > t0);
    assert.ok(payload.keyframes.length > 4);
  });

  test('redactMode: true strictly masks task titles, tools, messages, items, workers, automations, and events in en & ko', () => {
    const t0 = 1_700_000_000_000;
    const session = createDemoOfficeSession(t0);
    session.tick(t0 + 2_600);
    session.tick(t0 + 5_200);

    const redEn = session.getPayload({
      themeId: 'startup_office',
      redactMode: true,
      locale: 'en',
      languageSetting: 'en',
      botAppearances: {},
    });
    const jsonEn = JSON.stringify(redEn);
    assert.equal(redEn.snapshot.recentMessages.length, 0);
    assert.ok(!jsonEn.includes('Triage incoming PR reviews'));
    assert.ok(!jsonEn.includes('read_file'));
    assert.ok(!jsonEn.includes('run_command'));
    assert.ok(!jsonEn.includes('Staging IAM policy'));
    assert.ok(!jsonEn.includes('Hourly Dependency Advisory Check'));
    assert.equal(redEn.snapshot.bots['demo-ops-lead'].agent, 'Private');
    assert.equal(redEn.snapshot.bots['demo-ops-lead'].currentTool, null);
    assert.equal(redEn.snapshot.workers['demo-w-1'].provider, 'Worker #1');
    assert.equal(redEn.snapshot.workers['demo-w-1'].model, null);
    assert.equal(redEn.snapshot.items['demo-item-14'].title, 'Private Item #14');
    assert.deepEqual(
      Object.values(redEn.snapshot.automations)
        .map((a) => a.name)
        .sort(),
      ['Automation #1', 'Automation #2', 'Automation #3', 'Automation #4']
    );
    assert.equal(redEn.keyframes[0].snapshot.recentMessages.length, 0);
    assert.equal(redEn.keyframes[0].snapshot.bots['demo-ops-lead'].currentTool, null);

    const redKo = session.getPayload({
      themeId: 'startup_office',
      redactMode: true,
      locale: 'ko',
      languageSetting: 'ko',
      botAppearances: {},
    });
    assert.equal(redKo.snapshot.recentMessages.length, 0);
    assert.equal(redKo.snapshot.bots['demo-ops-lead'].agent, '비공개');
    assert.equal(redKo.snapshot.workers['demo-w-1'].provider, '도우미 #1');
    assert.equal(redKo.snapshot.items['demo-item-14'].title, '비공개 작업 #14');
    assert.deepEqual(
      Object.values(redKo.snapshot.automations)
        .map((a) => a.name)
        .sort(),
      ['정기 자동화 #1', '정기 자동화 #2', '정기 자동화 #3', '정기 자동화 #4']
    );
  });

  test('resolveCharacterId handles null/undefined safely and enforces keyword priority', () => {
    // Runtime null/undefined/non-string safety
    const r1 = resolveCharacterId(undefined as unknown as string, undefined as unknown as string);
    const r2 = resolveCharacterId(null as unknown as string, null as unknown as string);
    const r3 = resolveCharacterId(123 as unknown as string, { bad: true } as unknown as string);
    assert.equal(typeof r1, 'string');
    assert.equal(r1, r2);
    assert.equal(r2, r3);
    assert.notEqual(r1, 'worker_helper');

    // Keyword priority checks
    assert.equal(resolveCharacterId('b1', 'Cost Guard'), 'cost');
    assert.equal(resolveCharacterId('b2', 'Ops Lead'), 'ddochi');
    assert.equal(resolveCharacterId('b3', 'Infra Ops'), 'iac');
    assert.equal(resolveCharacterId('b4', 'CVE Watch'), 'cve');
    assert.equal(resolveCharacterId('b5', 'Security'), 'security');
    assert.equal(resolveCharacterId('b6', 'Cloud Ops'), 'cloud_ops');
    assert.equal(resolveCharacterId('b7', 'Dev Tools'), 'internal_tools');
    assert.equal(resolveCharacterId('b8', 'Doc Review'), 'doc_review');
    assert.equal(resolveCharacterId('b9', 'Assistant'), 'personal_assist');
    assert.equal(resolveCharacterId('b10', 'Bot World'), 'bot_world');
  });

  test('deskPosition for indices 14..35 stays in safe bounds, clear of HUD/landmarks, and >= 72px from regular slots 0..13', () => {
    for (const themeId of ['startup_office', 'corporate_office'] as const) {
      const theme = getThemeConfig(themeId, 'en');
      const [designW, designH] = theme.designSize;
      assert.ok(theme.overflowGrid.stepX >= 124, `${themeId} overflowGrid.stepX must be >= 124`);

      const overflowPositions: Array<[number, number]> = [];
      for (let idx = 14; idx <= 35; idx++) {
        const [x, y] = deskPosition(theme, idx);
        assert.ok(
          x >= 95 && x <= designW - 95,
          `${themeId} overflow[${idx}] x=${x} out of [${95}, ${designW - 95}]`
        );
        assert.ok(
          y >= 120 && y <= designH - 72,
          `${themeId} overflow[${idx}] y=${y} out of [${120}, ${designH - 72}]`
        );
        assert.equal(
          x < 260 && y > designH - 110,
          false,
          `${themeId} overflow[${idx}] (${x}, ${y}) overlapped bottom-left HUD`
        );

        for (const desk of theme.botDesks) {
          const d = Math.hypot(x - desk.x, y - desk.y);
          assert.ok(
            d >= 72,
            `${themeId} overflow[${idx}] (${x}, ${y}) collided with regular desk[${desk.slot}] (${desk.x}, ${desk.y}), dist=${d}`
          );
        }
        for (const lm of [theme.officeDoor, theme.bossDesk, theme.automationBoard]) {
          const d = Math.hypot(x - lm.x, y - lm.y);
          assert.ok(
            d >= 72,
            `${themeId} overflow[${idx}] (${x}, ${y}) collided with landmark (${lm.x}, ${lm.y}), dist=${d}`
          );
        }
        for (const [ox, oy] of overflowPositions) {
          const d = Math.hypot(x - ox, y - oy);
          assert.ok(
            d >= 72,
            `${themeId} overflow[${idx}] (${x}, ${y}) collided with peer overflow (${ox}, ${oy}), dist=${d}`
          );
        }
        overflowPositions.push([x, y]);
      }
    }
  });

  test('renderBotDetail shows 0-bot onboarding title and Try Demo Office button when botCount === 0', () => {
    const g = globalThis as Record<string, unknown>;
    const prevDoc = g.document;
    const prevNode = g.Node;
    const prevHtmlInput = g.HTMLInputElement;
    const prevHtmlImg = g.HTMLImageElement;

    class FakeNode {
      childNodes: FakeNode[] = [];
      textContent = '';
      get firstChild(): FakeNode | null {
        return this.childNodes[0] ?? null;
      }
      appendChild(child: FakeNode): FakeNode {
        this.childNodes.push(child);
        return child;
      }
      removeChild(child: FakeNode): FakeNode {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        return child;
      }
      collectText(): string {
        if (this.childNodes.length === 0) return this.textContent;
        return this.childNodes.map((c) => c.collectText()).join('');
      }
    }
    class FakeElement extends FakeNode {
      className = '';
      type = '';
      listeners = new Map<string, Array<() => void>>();
      constructor(public tagName: string) {
        super();
      }
      setAttribute(): void {}
      addEventListener(ev: string, cb: () => void): void {
        const list = this.listeners.get(ev) ?? [];
        list.push(cb);
        this.listeners.set(ev, list);
      }
      findByTag(tag: string): FakeElement[] {
        const out: FakeElement[] = [];
        if (this.tagName === tag) out.push(this);
        for (const c of this.childNodes) {
          if (c instanceof FakeElement) out.push(...c.findByTag(tag));
        }
        return out;
      }
    }
    class FakeHtmlInput extends FakeElement {}
    class FakeHtmlImage extends FakeElement {
      src = '';
      alt = '';
    }
    g.Node = FakeNode;
    g.HTMLInputElement = FakeHtmlInput;
    g.HTMLImageElement = FakeHtmlImage;
    g.document = {
      createElement: (tag: string) =>
        tag === 'img'
          ? new FakeHtmlImage(tag)
          : tag === 'input'
            ? new FakeHtmlInput(tag)
            : new FakeElement(tag),
      createTextNode: (text: string) => {
        const n = new FakeNode();
        n.textContent = text;
        return n;
      },
    };

    try {
      const container = new FakeElement('div');
      let demoStarted = 0;
      renderBotDetail(container as unknown as HTMLElement, {
        snapshot: createEmptySnapshot(),
        bot: null,
        redactMode: false,
        botAppearances: {},
        botCount: 0,
        locale: 'en',
        onSelectCharacter: () => {},
        onStartDemo: () => {
          demoStarted++;
        },
      });
      const textEn = container.collectText();
      assert.ok(textEn.includes('No bots active yet'));
      assert.ok(textEn.includes('Try Demo Office'));
      const buttons = container.findByTag('button');
      assert.equal(buttons.length, 1);
      buttons[0].listeners.get('click')?.[0]?.();
      assert.equal(demoStarted, 1);

      renderBotDetail(container as unknown as HTMLElement, {
        snapshot: createEmptySnapshot(),
        bot: null,
        redactMode: false,
        botAppearances: {},
        botCount: 0,
        locale: 'ko',
        onSelectCharacter: () => {},
        onStartDemo: () => {},
      });
      const textKo = container.collectText();
      assert.ok(textKo.includes('아직 활성 봇이 없습니다'));
      assert.ok(textKo.includes('데모 오피스 체험'));
    } finally {
      g.document = prevDoc;
      g.Node = prevNode;
      g.HTMLInputElement = prevHtmlInput;
      g.HTMLImageElement = prevHtmlImg;
    }
  });
});
