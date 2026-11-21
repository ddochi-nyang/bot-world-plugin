import { actorDisplayName, actorParentOrSelfBotId, resolveHandle } from '../src/events.ts';
import { scrubAll } from '../src/redact.ts';
import { formatKstHms } from '../src/timeline.ts';
import {
  type ActorRef,
  type BotState,
  type CharacterId,
  POOL_CHARACTER_IDS,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabelKo,
  isSafeKey,
  isWorkerActive,
} from '../src/types.ts';
import {
  CHARACTER_SPECS,
  resolveCharacterIdWithPrefs,
  resolveCharacterSpritePath,
} from './assets-catalog.ts';
import { type DomChild, clearChildren, el } from './dom.ts';

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

function shortIsoHms(iso: string): string {
  const tIdx = iso.indexOf('T');
  if (tIdx >= 0 && iso.length >= tIdx + 6) {
    return iso.slice(tIdx + 1, tIdx + 6);
  }
  return iso.slice(0, 5);
}

function itemStatusKo(status: string): string {
  switch (status) {
    case 'needs_you':
      return '결정 대기';
    case 'in_progress':
      return '진행 중';
    case 'planned':
      return '예정됨';
    case 'done':
      return '완료';
    case 'canceled':
      return '취소됨';
    default:
      return status;
  }
}

function redactActorName(actor: ActorRef): string {
  switch (actor.kind) {
    case 'Bot':
      return scrubAll(actor.botName);
    case 'Worker':
      return '도우미';
    case 'BossDesk':
      return '사장님';
    case 'AutomationBoard':
      return '자동화 보드';
    case 'OfficeDoor':
      return '출입구';
    case 'Unknown':
      return '비공개';
  }
}

export function statusToneClass(bot: BotState): string {
  switch (bot.status.kind) {
    case 'Working':
      return 'bw-badge-working';
    case 'NeedsOwner':
      return 'bw-badge-needs';
    case 'Blocked':
      return 'bw-badge-blocked';
    case 'WaitingAnswer':
      return 'bw-badge-waiting';
    case 'Error':
      return 'bw-badge-error';
    case 'Paused':
      return 'bw-badge-paused';
    case 'Idle':
      return 'bw-badge-idle';
  }
}

export function renderBotDetail(
  container: HTMLElement,
  options: {
    snapshot: WorldSnapshot;
    bot: BotState | null;
    redactMode: boolean;
    botAppearances: Record<string, CharacterId>;
    onSelectCharacter: (botId: string, charId: CharacterId) => void;
    onClose?: () => void;
  }
): void {
  clearChildren(container);
  const { snapshot, bot, redactMode, botAppearances, onSelectCharacter, onClose } = options;

  if (!bot) {
    const botList = Object.values(snapshot.bots);
    container.appendChild(
      el(
        'div',
        { className: 'bw-empty' },
        el('div', { className: 'bw-empty-title' }, '봇을 선택하세요'),
        el(
          'div',
          { className: 'bw-empty-desc' },
          botList.length > 0
            ? '오피스 캔버스에서 봇을 클릭하면 진행 작업, 최근 요청/답변, 열린 항목, 소속 워커와 10종 캐릭터 교체를 볼 수 있습니다.'
            : '표시할 봇이 없습니다. Orca 런타임이 연결되면 봇들이 사무실에 배치됩니다.'
        )
      )
    );
    return;
  }

  const cleanName = scrubAll(bot.name);
  const cleanAgent = scrubAll(bot.agent);
  const displayAgent = redactMode ? '비공개' : cleanAgent;
  const cleanSpecialty = scrubAll(bot.specialty);
  const statusLabel = botStatusLabelKo(bot.status);
  const activeCharId = resolveCharacterIdWithPrefs(botAppearances, bot.id, bot.name);

  // Header
  const headerChildren: DomChild[] = [
    el('img', {
      className: 'bw-avatar',
      src: resolveCharacterSpritePath(activeCharId),
      alt: `${cleanName} 캐릭터`,
    }),
    el(
      'div',
      { className: 'bw-detail-title-col' },
      el(
        'div',
        { className: 'bw-detail-title-row' },
        el('span', { className: 'bw-detail-name' }, cleanName),
        el('span', { className: `bw-badge ${statusToneClass(bot)}` }, statusLabel),
        displayAgent ? el('span', { className: 'bw-chip' }, displayAgent) : null
      ),
      cleanSpecialty && !redactMode
        ? el('div', { className: 'bw-detail-specialty' }, cleanSpecialty)
        : redactMode
          ? el('div', { className: 'bw-detail-specialty' }, '가림 모드 활성: 세부 분야 숨김')
          : null
    ),
  ];

  if (onClose) {
    headerChildren.push(
      el(
        'button',
        {
          className: 'bw-btn bw-btn-ghost',
          type: 'button',
          ariaLabel: '상세 닫기',
          onClick: onClose,
        },
        '✕'
      )
    );
  }

  container.appendChild(el('div', { className: 'bw-detail-header' }, ...headerChildren));

  const body = el('div', { className: 'bw-detail-body' });

  // Section 1: Active task
  const taskLine = redactMode
    ? `${cleanName} · ${statusLabel}`
    : bot.status.kind === 'NeedsOwner' && bot.status.prompt
      ? `결정 필요: ${scrubAll(bot.status.prompt)}`
      : bot.currentTaskTitle && bot.currentTaskTitle.trim().length > 0
        ? scrubAll(bot.currentTaskTitle)
        : '진행 중인 작업 없음';

  const toolLine =
    !redactMode && bot.currentTool && bot.currentTool.trim().length > 0
      ? `사용 도구: ${scrubAll(bot.currentTool)}`
      : null;

  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '진행 중 작업 (읽기 전용)'),
      el(
        'div',
        { className: 'bw-card' },
        el('div', { className: 'bw-card-text' }, taskLine),
        toolLine ? el('div', { className: 'bw-card-sub' }, toolLine) : null
      )
    )
  );

  // Section 2: Character switcher (10 pool skins)
  const charGrid = el('div', { className: 'bw-char-grid' });
  for (const cid of POOL_CHARACTER_IDS) {
    const spec = CHARACTER_SPECS[cid];
    const isActive = cid === activeCharId;
    charGrid.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: isActive ? 'bw-char-btn bw-char-btn-active' : 'bw-char-btn',
          ariaPressed: String(isActive),
          onClick: () => onSelectCharacter(bot.id, cid),
        },
        el('img', {
          className: 'bw-char-thumb',
          src: resolveCharacterSpritePath(cid),
          alt: spec.displayName,
        }),
        el('span', { className: 'bw-char-label' }, spec.shortName)
      )
    );
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '캐릭터 교체 (10종)'),
      charGrid
    )
  );

  // Section 3: Recent Requests / Replies
  const msgContainer = el('div', { className: 'bw-list' });
  let msgCount = 0;
  for (let i = snapshot.recentMessages.length - 1; i >= 0 && msgCount < 10; i--) {
    const msg = snapshot.recentMessages[i];
    const fromActor = resolveHandle(msg.fromHandle, msg.runId, snapshot, snapshot);
    const toActor = resolveHandle(msg.toHandle, msg.runId, snapshot, snapshot);
    const related =
      actorParentOrSelfBotId(fromActor) === bot.id ||
      actorParentOrSelfBotId(toActor) === bot.id ||
      msg.fromHandle === bot.id ||
      msg.fromHandle === bot.name ||
      msg.toHandle === bot.id ||
      msg.toHandle === bot.name;
    if (!related) continue;
    msgCount++;

    const fromName = redactMode ? redactActorName(fromActor) : scrubAll(actorDisplayName(fromActor));
    const toName = redactMode ? redactActorName(toActor) : scrubAll(actorDisplayName(toActor));
    const typeLabel =
      msg.msgType === 'handoff'
        ? '인계'
        : msg.msgType === 'question'
          ? '질문'
          : msg.msgType === 'worker_done'
            ? '완료'
            : msg.msgType === 'escalation'
              ? '개입'
              : msg.msgType === 'approval_closed'
                ? '승인'
                : msg.msgType === 'status'
                  ? '보고/답변'
                  : '메시지';

    const summary = redactMode
      ? `${cleanName} · ${typeLabel} 메시지`
      : msg.subject.trim().length > 0
        ? truncateChars(scrubAll(msg.subject), 64)
        : `${typeLabel} 메시지`;

    const bodyPreview =
      !redactMode && msg.body.trim().length > 0 ? truncateChars(scrubAll(msg.body), 96) : null;

    const timeLabel = msg.createdAt ? shortIsoHms(msg.createdAt) : '--:--';

    msgContainer.appendChild(
      el(
        'div',
        { className: 'bw-card' },
        el(
          'div',
          { className: 'bw-card-meta' },
          el('span', { className: 'bw-meta-dir' }, `${fromName} → ${toName}`),
          el('span', { className: 'bw-meta-time' }, `${typeLabel} · ${timeLabel}`)
        ),
        el('div', { className: 'bw-card-text' }, summary),
        bodyPreview ? el('div', { className: 'bw-card-sub' }, bodyPreview) : null
      )
    );
  }
  if (msgCount === 0) {
    msgContainer.appendChild(el('div', { className: 'bw-muted-note' }, '최근 요청/답변 없음'));
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '최근 요청 / 답변'),
      msgContainer
    )
  );

  // Section 4: Open Items
  const openItems = Object.values(snapshot.items)
    .filter(
      (it) =>
        (it.ownerBotId === bot.id || it.ownerBotName === bot.name) &&
        (it.status === 'needs_you' || it.status === 'in_progress' || it.status === 'planned')
    )
    .sort((a, b) => {
      const rank = (s: string) => (s === 'needs_you' ? 0 : s === 'in_progress' ? 1 : 2);
      return rank(a.status) - rank(b.status) || a.number - b.number;
    });

  const itemContainer = el('div', { className: 'bw-list' });
  if (openItems.length === 0) {
    itemContainer.appendChild(el('div', { className: 'bw-muted-note' }, '열린 항목 없음'));
  } else {
    for (const it of openItems) {
      const statusKo = itemStatusKo(it.status);
      const isNeeds = it.status === 'needs_you';
      const line = redactMode
        ? `#${it.number} · ${statusKo}`
        : `#${it.number} ${scrubAll(it.title)}`;
      const qSummary =
        !redactMode && it.questionPrompt && it.questionPrompt.trim().length > 0
          ? truncateChars(scrubAll(it.questionPrompt), 84)
          : null;

      itemContainer.appendChild(
        el(
          'div',
          { className: isNeeds ? 'bw-card bw-card-warn' : 'bw-card' },
          el(
            'div',
            { className: 'bw-card-meta' },
            el('span', { className: 'bw-card-text' }, line),
            el(
              'span',
              { className: isNeeds ? 'bw-badge bw-badge-needs' : 'bw-chip' },
              statusKo
            )
          ),
          qSummary ? el('div', { className: 'bw-card-sub' }, qSummary) : null
        )
      );
    }
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '열린 항목'),
      itemContainer
    )
  );

  // Section 5: Workers
  const workers = Object.values(snapshot.workers)
    .filter((w) => w.parentBotId === bot.id || w.parentBotName === bot.name)
    .sort((a, b) => {
      const aAct = Number(isWorkerActive(a));
      const bAct = Number(isWorkerActive(b));
      if (bAct !== aAct) return bAct - aAct;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })
    .slice(0, 12);

  const workerContainer = el('div', { className: 'bw-list' });
  if (workers.length === 0) {
    workerContainer.appendChild(el('div', { className: 'bw-muted-note' }, '소속 워커 없음'));
  } else {
    workers.forEach((w, wIdx) => {
      const livenessLabel =
        w.liveness === 'Live' ? '실행 중' : w.liveness === 'Exited' ? '종료' : '미확인';
      const stateLabel =
        w.workerState === 'ready'
          ? w.activity === 'working'
            ? '작업 중'
            : w.activity === 'blocked'
              ? '차단됨'
              : w.activity === 'waiting'
                ? '대기 중'
                : w.activity === 'done'
                  ? '완료'
                  : scrubAll(w.activity)
          : w.workerState === 'succeeded'
            ? '완료'
            : w.workerState === 'failed'
              ? '실패'
              : w.workerState === 'canceled'
                ? '취소'
                : '종료';
      const workerHeading = redactMode ? `도우미 #${wIdx + 1}` : scrubAll(w.provider);
      const detailLine = redactMode
        ? `${cleanName} · 도우미 · ${stateLabel}`
        : (() => {
            const title =
              w.taskTitle && w.taskTitle.trim().length > 0
                ? truncateChars(scrubAll(w.taskTitle), 52)
                : '세부 작업 없음';
            return w.toolName && w.toolName.trim().length > 0
              ? `${title} [${scrubAll(w.toolName)}]`
              : title;
          })();

      workerContainer.appendChild(
        el(
          'div',
          { className: 'bw-card' },
          el(
            'div',
            { className: 'bw-card-meta' },
            el('span', { className: 'bw-meta-dir' }, workerHeading),
            el('span', { className: 'bw-meta-time' }, `${stateLabel} · ${livenessLabel}`)
          ),
          el('div', { className: 'bw-card-sub' }, detailLine)
        )
      );
    });
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '소속 워커'),
      workerContainer
    )
  );

  // Section 6: Automations
  const automations = Object.values(snapshot.automations)
    .filter((a) => a.botId === bot.id)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));

  const autoContainer = el('div', { className: 'bw-list' });
  if (automations.length === 0) {
    autoContainer.appendChild(el('div', { className: 'bw-muted-note' }, '연결된 정기 자동화 없음'));
  } else {
    automations.forEach((a, idx) => {
      const displayName = redactMode ? `정기 자동화 #${idx + 1}` : scrubAll(a.name);
      const statusKo =
        a.lastRunStatus === 'completed'
          ? a.lastRunNoReply
            ? '완료 (이상 없음)'
            : '완료'
          : a.lastRunStatus === 'dispatch_failed' || a.lastRunStatus === 'failed'
            ? '실패'
            : a.lastRunStatus
              ? scrubAll(a.lastRunStatus)
              : a.enabled
                ? '대기'
                : '비활성';
      const errSummary =
        a.lastError && a.lastError.trim().length > 0
          ? redactMode
            ? '오류 상세 가려짐'
            : truncateChars(scrubAll(a.lastError), 64)
          : null;

      autoContainer.appendChild(
        el(
          'div',
          { className: 'bw-card' },
          el(
            'div',
            { className: 'bw-card-meta' },
            el('span', { className: 'bw-card-text' }, displayName),
            el('span', { className: 'bw-chip' }, statusKo)
          ),
          errSummary ? el('div', { className: 'bw-card-sub bw-text-danger' }, errSummary) : null
        )
      );
    });
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, '정기 자동화'),
      autoContainer
    )
  );

  container.appendChild(body);
}

export function renderBotQuickPills(
  container: HTMLElement,
  options: {
    snapshot: WorldSnapshot;
    selectedBotId: string | null;
    onSelectBot: (botId: string) => void;
  }
): void {
  clearChildren(container);
  const { snapshot, selectedBotId, onSelectBot } = options;
  const ids =
    snapshot.botOrder.length > 0
      ? snapshot.botOrder.filter((id) => isSafeKey(id) && Object.hasOwn(snapshot.bots, id))
      : Object.keys(snapshot.bots);

  for (const id of ids) {
    const bot = snapshot.bots[id];
    if (!bot) continue;
    const isSel = id === selectedBotId;
    const label = bot.status.kind === 'NeedsOwner' ? `★ ${scrubAll(bot.name)}` : scrubAll(bot.name);
    container.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: isSel ? 'bw-bot-pill bw-bot-pill-active' : 'bw-bot-pill',
          onClick: () => onSelectBot(id),
        },
        label
      )
    );
  }
}

export function renderEventTimelineList(
  container: HTMLElement,
  options: {
    events: readonly WorldEventRecord[];
    redactMode: boolean;
    limit?: number;
    onJumpToTime: (timestampMs: number) => void;
  }
): void {
  clearChildren(container);
  const { events, redactMode, limit = 40, onJumpToTime } = options;
  if (events.length === 0) {
    container.appendChild(el('div', { className: 'bw-muted-note' }, '아직 기록된 사건이 없습니다.'));
    return;
  }
  const recent = events.slice(-limit).reverse();
  for (const rec of recent) {
    const text = redactMode ? rec.redactedSummary : rec.summary;
    container.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'bw-event-row',
          onClick: () => onJumpToTime(rec.timestampMs),
        },
        el('span', { className: 'bw-event-time' }, formatKstHms(rec.timestampMs)),
        el('span', { className: 'bw-event-text' }, scrubAll(text))
      )
    );
  }
}
