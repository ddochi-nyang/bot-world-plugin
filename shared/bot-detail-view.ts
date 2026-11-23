import {
  actorDisplayName,
  actorParentOrSelfBotId,
  extractWorkerSeq,
  resolveHandle,
  summarizeEvent,
} from '../src/events.ts';
import { scrubAll } from '../src/redact.ts';
import { formatTimeHms } from '../src/timeline.ts';
import {
  type ActorRef,
  type BotRpgProfile,
  type BotState,
  type CharacterId,
  type DeskPropId,
  POOL_CHARACTER_IDS,
  type UiLocale,
  type WorldEventRecord,
  type WorldSnapshot,
  botStatusLabel,
  isSafeKey,
  isWorkerActive,
} from '../src/types.ts';
import {
  getCharacterSpec,
  resolveCharacterIdWithPrefs,
  resolveCharacterSpritePath,
} from './assets-catalog.ts';
import {
  DESK_PROP_CATALOG,
  computeBotRpgProfile,
  nextLevelXpThreshold,
  rpgTitleForLevel,
  xpFloorForLevel,
} from './bot-rpg.ts';
import { type DomChild, clearChildren, el } from './dom.ts';
import { localizeBotErrorMessage, tStrings } from './i18n.ts';
import { type OfficeBadgeId, badgeDisplayMeta } from './office-badges.ts';

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join('')}…`;
}

function fillStepClass(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return `bw-fill-step-${Math.round(clamped * 20)}`;
}

function shortIsoHms(iso: string): string {
  const tIdx = iso.indexOf('T');
  if (tIdx >= 0 && iso.length >= tIdx + 6) {
    return iso.slice(tIdx + 1, tIdx + 6);
  }
  return iso.slice(0, 5);
}

function itemStatusLabel(status: string, locale: UiLocale): string {
  const labels = tStrings(locale).itemStatusLabels;
  return Object.hasOwn(labels, status) ? labels[status] : status;
}

function redactActorName(actor: ActorRef, locale: UiLocale): string {
  const s = tStrings(locale);
  switch (actor.kind) {
    case 'Bot':
      return scrubAll(actor.botName);
    case 'Worker':
      return s.workerGeneric;
    case 'BossDesk':
      return s.ownerActor;
    case 'AutomationBoard':
      return s.landmarks.automationBoard;
    case 'OfficeDoor':
      return s.landmarks.officeDoor;
    case 'Unknown':
      return s.privateLabel;
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
    locale?: UiLocale;
    botCount?: number;
    onStartDemo?: () => void;
    badges?: readonly OfficeBadgeId[];
    rpgProfile?: BotRpgProfile | null;
    onEquipProp?: (botId: string, propId: DeskPropId) => void;
    onFocusTerminal?: (terminalId: string) => void;
    onOpenWorkspace?: (workspaceId: string) => void;
  }
): void {
  clearChildren(container);
  const {
    snapshot,
    bot,
    redactMode,
    botAppearances,
    onSelectCharacter,
    onClose,
    locale = 'en',
    botCount,
    onStartDemo,
    badges,
    rpgProfile,
    onEquipProp,
    onFocusTerminal,
    onOpenWorkspace,
  } = options;
  const s = tStrings(locale);

  if (!bot) {
    const resolvedCount = botCount ?? Object.keys(snapshot.bots).length;
    const isZeroBots = resolvedCount === 0;
    container.appendChild(
      el(
        'div',
        { className: 'bw-empty' },
        el('div', { className: 'bw-empty-title' }, isZeroBots ? s.noBotsTitle : s.selectBotTitle),
        el(
          'div',
          { className: 'bw-empty-desc' },
          isZeroBots ? s.selectBotDescEmpty : s.selectBotDescWithBots
        ),
        isZeroBots && onStartDemo
          ? el(
              'button',
              {
                type: 'button',
                className: 'bw-btn bw-btn-primary bw-empty-cta',
                onClick: onStartDemo,
              },
              s.tryDemoOffice
            )
          : null
      )
    );
    return;
  }

  const cleanName = scrubAll(bot.name);
  const cleanAgent = scrubAll(bot.agent);
  const displayAgent = redactMode ? s.privateLabel : cleanAgent;
  const cleanSpecialty = scrubAll(bot.specialty);
  const statusLabel = botStatusLabel(bot.status, locale);
  const activeCharId = resolveCharacterIdWithPrefs(botAppearances, bot.id, bot.name);

  const workers = Object.values(snapshot.workers)
    .filter((w) => w.parentBotId === bot.id || w.parentBotName === bot.name)
    .sort((a, b) => {
      const aAct = Number(isWorkerActive(a));
      const bAct = Number(isWorkerActive(b));
      if (bAct !== aAct) return bAct - aAct;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    })
    .slice(0, 12);

  const jumpWorker =
    workers.find((w) => isWorkerActive(w) && Boolean(w.terminalHandle)) ??
    workers.find((w) => Boolean(w.terminalHandle));
  const jumpTerminalHandle = jumpWorker?.terminalHandle ?? null;

  // Header
  const headerChildren: DomChild[] = [
    el('img', {
      className: 'bw-avatar',
      src: resolveCharacterSpritePath(activeCharId),
      alt: s.avatarAlt(cleanName),
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
          ? el('div', { className: 'bw-detail-specialty' }, s.redactSpecialtyHidden)
          : null,
      jumpTerminalHandle && onFocusTerminal
        ? el(
            'div',
            { className: 'bw-detail-jump-row' },
            el(
              'button',
              {
                type: 'button',
                className: 'bw-btn bw-btn-teleport',
                title: s.teleportTerminalTitle,
                onClick: () => onFocusTerminal(jumpTerminalHandle),
              },
              s.teleportJumpActiveButton
            )
          )
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
          ariaLabel: s.closeDetailAria,
          onClick: onClose,
        },
        '✕'
      )
    );
  }

  container.appendChild(el('div', { className: 'bw-detail-header' }, ...headerChildren));

  const body = el('div', { className: 'bw-detail-body' });

  // Badges (if earned in 24h)
  if (badges && badges.length > 0) {
    const badgeRow = el(
      'div',
      { className: 'bw-badge-strip' },
      ...badges.map((bid) => {
        const meta = badgeDisplayMeta(bid, locale);
        return el(
          'span',
          {
            className: bid === 'mvp' ? 'bw-award-pill bw-award-mvp' : 'bw-award-pill',
            title: meta.subtitle,
          },
          `${meta.emoji} ${meta.label}`
        );
      })
    );
    body.appendChild(
      el(
        'section',
        { className: 'bw-section' },
        el('div', { className: 'bw-section-title' }, s.sectionBadges),
        badgeRow
      )
    );
  }

  // Section 1: Active task
  const taskLine = redactMode
    ? `${cleanName} · ${statusLabel}`
    : bot.status.kind === 'NeedsOwner' && bot.status.prompt
      ? s.needsDecisionPrefix(scrubAll(bot.status.prompt))
      : bot.currentTaskTitle && bot.currentTaskTitle.trim().length > 0
        ? scrubAll(bot.currentTaskTitle)
        : bot.status.kind === 'Error' && bot.status.message && bot.status.message.trim().length > 0
          ? scrubAll(localizeBotErrorMessage(bot.status.message, locale))
          : s.noActiveTask;

  const toolLine =
    !redactMode && bot.currentTool && bot.currentTool.trim().length > 0
      ? s.usingToolPrefix(scrubAll(bot.currentTool))
      : null;

  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, s.sectionActiveTask),
      el(
        'div',
        { className: 'bw-card' },
        el('div', { className: 'bw-card-text' }, taskLine),
        toolLine ? el('div', { className: 'bw-card-sub' }, toolLine) : null
      )
    )
  );

  // Section 1.5: Bot RPG Level & Desk Props
  const resolvedRpg = rpgProfile ?? computeBotRpgProfile(bot.id);
  const levelTitle = rpgTitleForLevel(resolvedRpg.level, locale);
  const lvFloor = xpFloorForLevel(resolvedRpg.level);
  const nextThreshold = nextLevelXpThreshold(resolvedRpg.level);
  const span = Math.max(1, nextThreshold - lvFloor);
  const progressRatio = Math.max(0, Math.min(1, (resolvedRpg.xp - lvFloor) / span));

  const propPills: DomChild[] = [
    el(
      'button',
      {
        type: 'button',
        className:
          resolvedRpg.equippedProp === 'none' ? 'bw-prop-btn bw-prop-btn-active' : 'bw-prop-btn',
        ariaPressed: String(resolvedRpg.equippedProp === 'none'),
        onClick: () => onEquipProp?.(bot.id, 'none'),
      },
      `— ${s.rpgPropLabels.none}`
    ),
    ...DESK_PROP_CATALOG.map((spec) => {
      const unlocked = resolvedRpg.unlockedProps.includes(spec.id);
      const isEquipped = resolvedRpg.equippedProp === spec.id;
      const label = s.rpgPropLabels[spec.id];
      return el(
        'button',
        {
          type: 'button',
          className: isEquipped
            ? 'bw-prop-btn bw-prop-btn-active'
            : unlocked
              ? 'bw-prop-btn'
              : 'bw-prop-btn bw-prop-btn-locked',
          disabled: !unlocked,
          ariaPressed: String(isEquipped),
          title: unlocked ? label : s.rpgPropLockedHint(spec.unlockLevel),
          onClick: () => {
            if (unlocked) onEquipProp?.(bot.id, spec.id);
          },
        },
        unlocked ? `${spec.emoji} ${label}` : `🔒 ${spec.emoji} Lv.${spec.unlockLevel}`
      );
    }),
  ];

  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, s.rpgSectionTitle),
      el(
        'div',
        { className: 'bw-card bw-rpg-card' },
        el(
          'div',
          { className: 'bw-card-meta' },
          el(
            'span',
            { className: 'bw-rpg-level-pill' },
            s.rpgLevelBadge(resolvedRpg.level, levelTitle)
          ),
          el(
            'span',
            { className: 'bw-meta-time' },
            s.rpgXpProgress(resolvedRpg.xp, nextThreshold)
          )
        ),
        el(
          'div',
          { className: 'bw-report-bar-track bw-rpg-progress-track' },
          el('div', {
            className: `bw-report-bar-fill bw-rpg-progress-fill ${fillStepClass(progressRatio)}`,
          })
        ),
        el('div', { className: 'bw-rpg-prop-label' }, s.rpgDeskPropTitle),
        el('div', { className: 'bw-rpg-prop-grid' }, ...propPills)
      )
    )
  );

  // Section 2: Character switcher (10 pool skins)
  const charGrid = el('div', { className: 'bw-char-grid' });
  for (const cid of POOL_CHARACTER_IDS) {
    const spec = getCharacterSpec(cid, locale);
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
      el('div', { className: 'bw-section-title' }, s.sectionSwitchCharacter),
      charGrid
    )
  );

  // Section 3: Recent Requests / Replies
  const msgContainer = el('div', { className: 'bw-list' });
  let msgCount = 0;
  for (let i = snapshot.recentMessages.length - 1; i >= 0 && msgCount < 10; i--) {
    const msg = snapshot.recentMessages[i];
    const fromActor = resolveHandle(msg.fromHandle, msg.runId, snapshot, snapshot, locale);
    const toActor = resolveHandle(msg.toHandle, msg.runId, snapshot, snapshot, locale);
    const related =
      actorParentOrSelfBotId(fromActor) === bot.id ||
      actorParentOrSelfBotId(toActor) === bot.id ||
      msg.fromHandle === bot.id ||
      msg.fromHandle === bot.name ||
      msg.toHandle === bot.id ||
      msg.toHandle === bot.name;
    if (!related) continue;
    msgCount++;

    const fromName = redactMode
      ? redactActorName(fromActor, locale)
      : scrubAll(actorDisplayName(fromActor, locale));
    const toName = redactMode
      ? redactActorName(toActor, locale)
      : scrubAll(actorDisplayName(toActor, locale));
    const typeLabel = Object.hasOwn(s.msgTypeLabels, msg.msgType)
      ? s.msgTypeLabels[msg.msgType]
      : s.msgTypeDefault;

    const summary = redactMode
      ? s.msgRedactedSummary(cleanName, typeLabel)
      : msg.subject.trim().length > 0
        ? truncateChars(scrubAll(msg.subject), 64)
        : s.msgTypeFallback(typeLabel);

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
    msgContainer.appendChild(el('div', { className: 'bw-muted-note' }, s.noRecentMessages));
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, s.sectionRecentMessages),
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
      const rank = (st: string) => (st === 'needs_you' ? 0 : st === 'in_progress' ? 1 : 2);
      return rank(a.status) - rank(b.status) || a.number - b.number;
    });

  const itemContainer = el('div', { className: 'bw-list' });
  if (openItems.length === 0) {
    itemContainer.appendChild(el('div', { className: 'bw-muted-note' }, s.noOpenItems));
  } else {
    for (const it of openItems) {
      const statusText = itemStatusLabel(it.status, locale);
      const isNeeds = it.status === 'needs_you';
      const line = redactMode
        ? `#${it.number} · ${statusText}`
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
              statusText
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
      el('div', { className: 'bw-section-title' }, s.sectionOpenItems),
      itemContainer
    )
  );

  // Section 5: Workers
  const workerContainer = el('div', { className: 'bw-list' });
  if (workers.length === 0) {
    workerContainer.appendChild(el('div', { className: 'bw-muted-note' }, s.noWorkers));
  } else {
    workers.forEach((w, wIdx) => {
      const livenessLabel = s.livenessLabels[w.liveness];
      const stateKey = w.workerState === 'ready' ? w.activity : w.workerState;
      const stateLabel = Object.hasOwn(s.workerStateLabels, stateKey)
        ? s.workerStateLabels[stateKey]
        : w.workerState === 'ready'
          ? scrubAll(w.activity)
          : s.workerStateLabels.exited;
      const workerHeading = redactMode ? s.workerNumbered(wIdx + 1) : scrubAll(w.provider);
      const detailLine = redactMode
        ? s.workerRedactedDetail(cleanName, stateLabel)
        : (() => {
            const title =
              w.taskTitle && w.taskTitle.trim().length > 0
                ? truncateChars(scrubAll(w.taskTitle), 52)
                : s.noTaskDetails;
            return w.toolName && w.toolName.trim().length > 0
              ? `${title} [${scrubAll(w.toolName)}]`
              : title;
          })();

      const termHandle = w.terminalHandle;
      const wsId = w.worktreeId;
      const hasActions = Boolean((termHandle && onFocusTerminal) || (wsId && onOpenWorkspace));

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
          el('div', { className: 'bw-card-sub' }, detailLine),
          hasActions
            ? el(
                'div',
                { className: 'bw-worker-actions' },
                termHandle && onFocusTerminal
                  ? el(
                      'button',
                      {
                        type: 'button',
                        className: 'bw-btn bw-btn-teleport',
                        title: s.teleportTerminalTitle,
                        onClick: () => onFocusTerminal(termHandle),
                      },
                      s.teleportTerminalButton
                    )
                  : null,
                wsId && onOpenWorkspace
                  ? el(
                      'button',
                      {
                        type: 'button',
                        className: 'bw-btn bw-btn-teleport',
                        title: s.teleportWorkspaceTitle,
                        onClick: () => onOpenWorkspace(wsId),
                      },
                      s.teleportWorkspaceButton
                    )
                  : null
              )
            : null
        )
      );
    });
  }
  body.appendChild(
    el(
      'section',
      { className: 'bw-section' },
      el('div', { className: 'bw-section-title' }, s.sectionWorkers),
      workerContainer
    )
  );

  // Section 6: Automations
  const automations = Object.values(snapshot.automations)
    .filter((a) => a.botId === bot.id)
    .sort((a, b) => a.name.localeCompare(b.name, locale, { numeric: true }));

  const autoContainer = el('div', { className: 'bw-list' });
  if (automations.length === 0) {
    autoContainer.appendChild(el('div', { className: 'bw-muted-note' }, s.noAutomations));
  } else {
    automations.forEach((a, idx) => {
      const displayName = redactMode ? s.automationNumbered(idx + 1) : scrubAll(a.name);
      const statusText =
        a.lastRunStatus === 'completed'
          ? a.lastRunNoReply
            ? s.autoCompletedNoReply
            : s.autoCompleted
          : a.lastRunStatus === 'dispatch_failed' || a.lastRunStatus === 'failed'
            ? s.autoFailed
            : a.lastRunStatus
              ? scrubAll(a.lastRunStatus)
              : a.enabled
                ? s.autoIdle
                : s.autoDisabled;
      const errSummary =
        a.lastError && a.lastError.trim().length > 0
          ? redactMode
            ? s.errorHiddenLabel
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
            el('span', { className: 'bw-chip' }, statusText)
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
      el('div', { className: 'bw-section-title' }, s.sectionAutomations),
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
    locale?: UiLocale;
  }
): void {
  clearChildren(container);
  const { events, redactMode, limit = 40, onJumpToTime, locale = 'en' } = options;
  const s = tStrings(locale);
  if (events.length === 0) {
    container.appendChild(el('div', { className: 'bw-muted-note' }, s.noEventsRecorded));
    return;
  }
  const recent = events.slice(-limit).reverse();
  for (const rec of recent) {
    const workerSeq = rec.event ? extractWorkerSeq(rec) : undefined;
    const text = rec.event
      ? summarizeEvent(rec.event, redactMode, locale, workerSeq ?? 1)
      : redactMode
        ? rec.redactedSummary
        : rec.summary;
    container.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'bw-event-row',
          onClick: () => onJumpToTime(rec.timestampMs),
        },
        el('span', { className: 'bw-event-time' }, formatTimeHms(rec.timestampMs, locale)),
        el('span', { className: 'bw-event-text' }, scrubAll(text))
      )
    );
  }
}
