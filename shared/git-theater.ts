import {
  POOL_CHARACTER_IDS,
  createEmptySnapshot,
  type BotState,
  type CharacterId,
  type GitCastMember,
  type GitCommitEvent,
  type GitCommitKind,
  type GitRangeDays,
  type GitRepoSummary,
  type GitTheaterReel,
  type ThemeId,
  type UiLocale,
  type WorldSnapshot,
} from '../src/types.ts';
import { scrubAll } from '../src/redact.ts';
import { getThemeConfig, type ThemeConfig } from './assets-catalog.ts';
import type { ViewportTransform } from './camera.ts';
import { clearChildren, el } from './dom.ts';
import { tStrings } from './i18n.ts';
import { setButtonContent } from './icons.ts';
import { setTooltip } from './tooltip.ts';

export const THEATER_DURATION_SECS = 30;
export const THEATER_SPEEDS = [0.5, 1, 2, 4] as const;
export type TheaterSpeed = (typeof THEATER_SPEEDS)[number];

export const MAX_THEATER_BUBBLES = 5;
export const MAX_THEATER_PARCELS = 12;
export const MAX_THEATER_CONFETTI = 48;

export const COMMIT_KIND_COLORS: Readonly<Record<GitCommitKind, string>> = {
  feat: '#38bdf8',
  fix: '#f87171',
  refactor: '#c084fc',
  test: '#4ade80',
  docs: '#fbbf24',
  chore: '#94a3b8',
  merge: '#f472b6',
  other: '#a8a29e',
};

export type TheaterParcel = {
  id: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  ctrlX: number;
  ctrlY: number;
  progress: number;
  durationSecs: number;
  color: string;
  commitKind: GitCommitKind;
  isMilestone: boolean;
  size: number;
};

export type TheaterBubble = {
  id: number;
  botId: string;
  deskIndex: number;
  text: string;
  color: string;
  ageSecs: number;
  ttlSecs: number;
};

export type TheaterConfetti = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  size: number;
  ageSecs: number;
  ttlSecs: number;
};

export type TheaterBanner = {
  text: string;
  color: string;
  ageSecs: number;
  ttlSecs: number;
};

export type TheaterStepEvent = {
  commitIndex: number;
  commit: GitCommitEvent;
};

const DEMO_SPECS: ReadonlyArray<{
  kind: GitCommitKind;
  authorIdx: number;
  area: string;
  en: string;
  ko: string;
  files: number;
  ins: number;
  del: number;
  milestone?: boolean;
}> = [
  { kind: 'chore', authorIdx: 0, area: 'scaffold', en: 'chore: initialize workspace manifest', ko: 'chore: 워크스페이스 매니페스트 초기화', files: 6, ins: 140, del: 12, milestone: true },
  { kind: 'feat', authorIdx: 1, area: 'src/worker', en: 'feat: add agent status snapshot poller', ko: 'feat: 에이전트 상태 스냅샷 폴러 추가', files: 4, ins: 185, del: 20 },
  { kind: 'feat', authorIdx: 2, area: 'shared/stage', en: 'feat: build canvas pixel-art office renderer', ko: 'feat: 캔버스 오피스 스테이지 렌더러 구현', files: 5, ins: 260, del: 18 },
  { kind: 'test', authorIdx: 3, area: 'src/tests', en: 'test: add snapshot normalizer edge cases', ko: 'test: 스냅샷 정규화 경계 테스트 보강', files: 3, ins: 120, del: 8 },
  { kind: 'fix', authorIdx: 1, area: 'src/redact', en: 'fix: tighten token scrubbing patterns', ko: 'fix: 토큰 마스킹 패턴 정확도 개선', files: 2, ins: 64, del: 24 },
  { kind: 'docs', authorIdx: 4, area: 'docs', en: 'docs: document keyboard shortcut matrix', ko: 'docs: 단축키 안내 표 정리', files: 2, ins: 95, del: 10 },
  { kind: 'refactor', authorIdx: 5, area: 'shared/camera', en: 'refactor: extract spotlight camera easing', ko: 'refactor: 스포트라이트 카메라 보간 분리', files: 4, ins: 148, del: 162, milestone: true },
  { kind: 'feat', authorIdx: 0, area: 'shared/sound', en: 'feat: synthesize ambient office soundscape', ko: 'feat: 오피스 환경 효과음 합성기 구현', files: 3, ins: 210, del: 14 },
  { kind: 'fix', authorIdx: 2, area: 'shared/styles', en: 'fix: lock zero-shift toolbar height invariants', ko: 'fix: 툴바 고정 높이 레이아웃 유지 수정', files: 3, ins: 88, del: 42 },
  { kind: 'test', authorIdx: 3, area: 'src/tests', en: 'test: verify zero-shift toolbar pixel budget', ko: 'test: 툴바 픽셀 예산 검증 테스트 추가', files: 2, ins: 130, del: 6 },
  { kind: 'feat', authorIdx: 6, area: 'shared/pet', en: 'feat: launch pocket pet terrarium habitat', ko: 'feat: 포켓 펫 테라리움 기능 추가', files: 6, ins: 290, del: 15 },
  { kind: 'merge', authorIdx: 4, area: 'main', en: 'merge: integrate pocket pet terrarium PR', ko: 'merge: 포켓 펫 테라리움 PR 병합', files: 9, ins: 340, del: 22, milestone: true },
  { kind: 'feat', authorIdx: 7, area: 'shared/raid', en: 'feat: add pomodoro boss raid encounter engine', ko: 'feat: 포모도로 보스 레이드 엔진 추가', files: 5, ins: 275, del: 19 },
  { kind: 'fix', authorIdx: 7, area: 'shared/raid', en: 'fix: prevent double visual stepping at 2x speed', ko: 'fix: 2배속 중복 스텝 방지 수정', files: 2, ins: 48, del: 31 },
  { kind: 'refactor', authorIdx: 5, area: 'shared/chrome', en: 'refactor: unify panel and editor chrome sync', ko: 'refactor: 패널·에디터 툴바 동기화 통합', files: 4, ins: 132, del: 118 },
  { kind: 'test', authorIdx: 3, area: 'src/tests', en: 'test: cover boss raid phase transitions', ko: 'test: 보스 레이드 단계 전환 테스트 추가', files: 2, ins: 165, del: 12 },
  { kind: 'chore', authorIdx: 6, area: 'assets', en: 'chore: compress bundled theme backdrop sheets', ko: 'chore: 테마 배경 스프라이트 시트 최적화', files: 8, ins: 90, del: 180, milestone: true },
  { kind: 'feat', authorIdx: 1, area: 'src/git', en: 'feat: add opaque repoId read-only git reader', ko: 'feat: 불투명 repoId 읽기 전용 Git 수집기 추가', files: 4, ins: 245, del: 10 },
  { kind: 'fix', authorIdx: 0, area: 'src/security', en: 'fix: strip dangerous keys from git RPC args', ko: 'fix: Git RPC 인자 위험 키 제거 보강', files: 2, ins: 58, del: 14 },
  { kind: 'feat', authorIdx: 2, area: 'shared/theater', en: 'feat: build 30s git history theater engine', ko: 'feat: 30초 Git 히스토리 극장 엔진 구현', files: 5, ins: 380, del: 24, milestone: true },
  { kind: 'docs', authorIdx: 4, area: 'shared/i18n', en: 'docs: add EN and KO theater localization strings', ko: 'docs: 극장 모드 한영 다국어 문구 추가', files: 2, ins: 112, del: 16 },
  { kind: 'test', authorIdx: 3, area: 'src/tests', en: 'test: verify redaction leaks across theater views', ko: 'test: 극장 화면 민감정보 마스킹 검증 추가', files: 3, ins: 220, del: 9 },
  { kind: 'other', authorIdx: 5, area: 'shared/styles', en: 'polish: refine cinema marquee frame and scrubber', ko: 'polish: 극장 프레임 및 탐색 막대 다듬기', files: 3, ins: 104, del: 28 },
  { kind: 'feat', authorIdx: 0, area: 'release', en: 'release: v1.0.0 Git History Theater curtain call', ko: 'release: v1.0.0 Git 히스토리 극장 릴리스', files: 10, ins: 410, del: 35, milestone: true },
];

const DEMO_AUTHORS: ReadonlyArray<{ name: string; key: string }> = [
  { name: 'Aria', key: 'author_0001' },
  { name: 'Kai', key: 'author_0002' },
  { name: 'Mina', key: 'author_0003' },
  { name: 'Joon', key: 'author_0004' },
  { name: 'Nora', key: 'author_0005' },
  { name: 'Evan', key: 'author_0006' },
  { name: 'Sora', key: 'author_0007' },
  { name: 'Toby', key: 'author_0008' },
];

export function createDemoGitTheaterReel(
  locale: UiLocale,
  rangeDays: GitRangeDays = 14
): GitTheaterReel {
  const baseMs = 1763900000000;
  const spanMs = rangeDays * 24 * 60 * 60 * 1000;
  const stepMs = Math.floor(spanMs / Math.max(1, DEMO_SPECS.length));
  const counts = new Array<number>(DEMO_AUTHORS.length).fill(0);

  const commits: GitCommitEvent[] = DEMO_SPECS.map((spec, idx) => {
    const author = DEMO_AUTHORS[spec.authorIdx % DEMO_AUTHORS.length];
    counts[spec.authorIdx % DEMO_AUTHORS.length] += 1;
    return {
      shortHash: `d3m0${(idx + 1).toString(16).padStart(3, '0')}`,
      timestampMs: baseMs - spanMs + idx * stepMs,
      authorKey: author.key,
      authorName: author.name,
      subject: locale === 'ko' ? spec.ko : spec.en,
      filesChanged: spec.files,
      insertions: spec.ins,
      deletions: spec.del,
      commitKind: spec.kind,
      topArea: spec.area,
      isMilestone: Boolean(spec.milestone),
    };
  });

  const cast: GitCastMember[] = DEMO_AUTHORS.map((author, idx) => ({
    authorKey: author.key,
    authorName: author.name,
    redactedName: locale === 'ko' ? `작성자 #${idx + 1}` : `Author #${idx + 1}`,
    characterId: POOL_CHARACTER_IDS[idx % POOL_CHARACTER_IDS.length],
    seatSlot: idx,
    commitCount: counts[idx] ?? 0,
  }));

  const totalInsertions = commits.reduce((sum, c) => sum + c.insertions, 0);
  const totalDeletions = commits.reduce((sum, c) => sum + c.deletions, 0);

  return {
    repoId: 'demo',
    repoLabel: 'bot-world-demo',
    branch: 'main',
    rangeDays,
    totalCommits: commits.length,
    totalInsertions,
    totalDeletions,
    cast,
    commits,
    isDemo: true,
    generatedAtMs: baseMs,
  };
}

function extractNumericRepoIndex(repoId: string): number {
  const match = /(\d+)$/.exec(repoId);
  if (!match) return 1;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed + 1 : 1;
}

export function resolveTheaterRepoLabel(
  repo: Pick<GitRepoSummary, 'repoId' | 'repoLabel'>,
  locale: UiLocale,
  redactMode: boolean
): string {
  if (redactMode) {
    const idx = extractNumericRepoIndex(repo.repoId);
    return locale === 'ko' ? `저장소 #${idx}` : `Repo #${idx}`;
  }
  return scrubAll(repo.repoLabel || 'repo');
}

export function resolveTheaterBranchLabel(
  branch: string,
  locale: UiLocale,
  redactMode: boolean
): string {
  if (redactMode) {
    return locale === 'ko' ? '브랜치' : 'branch';
  }
  return scrubAll(branch || 'HEAD');
}

export function resolveTheaterAuthorName(
  member: Pick<GitCastMember, 'authorName' | 'redactedName'> | null,
  fallbackIndex: number,
  locale: UiLocale,
  redactMode: boolean
): string {
  const ordinal = Math.max(1, fallbackIndex + 1);
  if (redactMode) {
    return locale === 'ko' ? `작성자 #${ordinal}` : `Author #${ordinal}`;
  }
  if (!member) {
    return locale === 'ko' ? `작성자 #${ordinal}` : `Author #${ordinal}`;
  }
  return scrubAll(member.authorName);
}

export function resolveTheaterAreaLabel(
  commit: GitCommitEvent,
  commitIndex: number,
  locale: UiLocale,
  redactMode: boolean,
  areaIndexMap?: Map<string, number>
): string {
  if (redactMode) {
    const key = commit.topArea || `a${commitIndex}`;
    let areaNum = areaIndexMap?.get(key);
    if (areaNum === undefined) {
      areaNum = areaIndexMap ? areaIndexMap.size + 1 : (commitIndex % 6) + 1;
      areaIndexMap?.set(key, areaNum);
    }
    return locale === 'ko' ? `모듈-${areaNum}` : `module-${areaNum}`;
  }
  return scrubAll(commit.topArea || 'root');
}

export function resolveTheaterCommitText(
  commit: GitCommitEvent,
  commitIndex: number,
  locale: UiLocale,
  redactMode: boolean
): string {
  if (redactMode) {
    const num = commitIndex + 1;
    const label = locale === 'ko' ? `커밋 #${num}` : `Commit #${num}`;
    return `[${commit.commitKind}] ${label} (+${commit.insertions}/-${commit.deletions})`;
  }
  return scrubAll(commit.subject);
}

export function resolveTheaterCommitHash(
  commit: GitCommitEvent,
  commitIndex: number,
  redactMode: boolean
): string {
  if (redactMode) {
    return `#${commitIndex + 1}`;
  }
  return scrubAll(commit.shortHash);
}

function clampDt(dtSecs: number): number {
  if (typeof dtSecs !== 'number' || !Number.isFinite(dtSecs) || dtSecs <= 0) {
    return 0;
  }
  return dtSecs;
}

function computeCommitTriggers(commits: readonly GitCommitEvent[], durationSecs: number): number[] {
  const count = commits.length;
  if (count === 0) return [];
  if (count === 1) return [0.4];
  const minT = 0.35;
  const maxT = Math.max(minT + 0.5, durationSecs - 1.35);
  const firstTs = commits[0].timestampMs;
  const lastTs = commits[count - 1].timestampMs;
  const tsSpan = Math.max(1, lastTs - firstTs);

  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < count; i += 1) {
    const idxFrac = i / (count - 1);
    const tsFrac = lastTs > firstTs ? (commits[i].timestampMs - firstTs) / tsSpan : idxFrac;
    const blended = idxFrac * 0.85 + tsFrac * 0.15;
    let t = minT + blended * (maxT - minT);
    if (i > 0 && t <= prev) {
      t = Math.min(maxT, prev + 0.05);
    }
    prev = t;
    out.push(t);
  }
  return out;
}

export class GitTheaterEngine {
  private active = false;
  private playing = false;
  private speed: TheaterSpeed = 1;
  private durationSecs = THEATER_DURATION_SECS;
  private playbackSecs = 0;
  private reel: GitTheaterReel | null = null;
  private themeId: ThemeId = 'cozy';
  private locale: UiLocale = 'en';
  private redactMode = false;
  private triggers: number[] = [];
  private nextCommitIndex = 0;
  private currentCommitIndex = -1;
  private parcels: TheaterParcel[] = [];
  private bubbles: TheaterBubble[] = [];
  private confetti: TheaterConfetti[] = [];
  private banner: TheaterBanner | null = null;
  private botPulseRemaining = new Map<string, number>();
  private areaIndexMap = new Map<string, number>();
  private nextVisualId = 1;
  private onCommitListeners = new Set<(event: TheaterStepEvent) => void>();

  isActive(): boolean {
    return this.active;
  }

  isPlaying(): boolean {
    return this.active && this.playing;
  }

  getSpeed(): TheaterSpeed {
    return this.speed;
  }

  getDurationSecs(): number {
    return this.durationSecs;
  }

  getPlaybackSecs(): number {
    return this.playbackSecs;
  }

  getProgressFraction(): number {
    if (this.durationSecs <= 0) return 0;
    return Math.max(0, Math.min(1, this.playbackSecs / this.durationSecs));
  }

  getReel(): GitTheaterReel | null {
    return this.reel;
  }

  getCurrentCommitIndex(): number {
    return this.currentCommitIndex;
  }

  getCurrentCommit(): GitCommitEvent | null {
    if (!this.reel || this.currentCommitIndex < 0) return null;
    return this.reel.commits[this.currentCommitIndex] ?? null;
  }

  getParcels(): readonly TheaterParcel[] {
    return this.parcels;
  }

  getBubbles(): readonly TheaterBubble[] {
    return this.bubbles;
  }

  getConfetti(): readonly TheaterConfetti[] {
    return this.confetti;
  }

  getBanner(): TheaterBanner | null {
    return this.banner;
  }

  hasActiveVisuals(): boolean {
    return (
      this.parcels.length > 0 ||
      this.bubbles.length > 0 ||
      this.confetti.length > 0 ||
      this.banner !== null ||
      this.botPulseRemaining.size > 0
    );
  }

  onCommit(listener: (event: TheaterStepEvent) => void): () => void {
    this.onCommitListeners.add(listener);
    return () => {
      this.onCommitListeners.delete(listener);
    };
  }

  setContext(options: { themeId?: ThemeId; locale?: UiLocale; redactMode?: boolean }): void {
    const prevRedact = this.redactMode;
    const prevLocale = this.locale;
    if (options.themeId) this.themeId = options.themeId;
    if (options.locale) this.locale = options.locale;
    if (typeof options.redactMode === 'boolean') this.redactMode = options.redactMode;
    if (prevRedact !== this.redactMode || prevLocale !== this.locale) {
      // Clear stale unredacted text from active overlays immediately on mode/locale flip.
      this.bubbles = [];
      this.banner = null;
      this.areaIndexMap.clear();
    }
  }

  open(
    reel: GitTheaterReel,
    options?: {
      themeId?: ThemeId;
      locale?: UiLocale;
      redactMode?: boolean;
      autoplay?: boolean;
    }
  ): void {
    if (options) this.setContext(options);
    this.reel = reel;
    this.active = true;
    this.playing = reel.commits.length > 0 && (options?.autoplay ?? true);
    this.durationSecs = THEATER_DURATION_SECS;
    this.triggers = computeCommitTriggers(reel.commits, this.durationSecs);
    this.clearTransients();
    this.playbackSecs = 0;
    this.nextCommitIndex = 0;
    this.currentCommitIndex = -1;
    if (this.triggers.length > 0 && this.triggers[0] <= 0.05) {
      this.fireDueCommits(false);
    }
  }

  exit(): void {
    this.active = false;
    this.playing = false;
    this.reel = null;
    this.triggers = [];
    this.playbackSecs = 0;
    this.nextCommitIndex = 0;
    this.currentCommitIndex = -1;
    this.clearTransients();
  }

  play(): void {
    if (!this.active || !this.reel || this.reel.commits.length === 0) return;
    if (this.playbackSecs >= this.durationSecs) {
      this.restart();
      return;
    }
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  togglePlay(): void {
    if (!this.active) return;
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  restart(): void {
    if (!this.active || !this.reel) return;
    this.clearTransients();
    this.playbackSecs = 0;
    this.nextCommitIndex = 0;
    this.currentCommitIndex = -1;
    this.playing = this.reel.commits.length > 0;
  }

  setSpeed(speed: TheaterSpeed): void {
    if (THEATER_SPEEDS.includes(speed)) {
      this.speed = speed;
    }
  }

  cycleSpeed(): TheaterSpeed {
    const idx = THEATER_SPEEDS.indexOf(this.speed);
    const next = THEATER_SPEEDS[(idx + 1) % THEATER_SPEEDS.length];
    this.speed = next;
    return next;
  }

  seekFraction(fraction: number): void {
    if (!this.active || !this.reel) return;
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
    const targetSecs = clamped * this.durationSecs;
    this.seekSeconds(targetSecs, false);
  }

  prevCommit(): boolean {
    if (!this.active || !this.reel || this.reel.commits.length === 0) return false;
    const targetIdx =
      this.currentCommitIndex <= 0 ? 0 : this.currentCommitIndex - 1;
    const targetTime = this.triggers[targetIdx] ?? 0;
    this.seekSeconds(targetTime + 0.001, true);
    return true;
  }

  nextCommit(): boolean {
    if (!this.active || !this.reel || this.reel.commits.length === 0) return false;
    const maxIdx = this.reel.commits.length - 1;
    const targetIdx = Math.min(maxIdx, this.currentCommitIndex + 1);
    const targetTime = this.triggers[targetIdx] ?? 0;
    this.seekSeconds(targetTime + 0.001, true);
    return true;
  }

  private seekSeconds(targetSecs: number, emitLast: boolean): void {
    if (!this.reel) return;
    this.clearTransients();
    this.playbackSecs = Math.max(0, Math.min(this.durationSecs, targetSecs));
    let countPassed = 0;
    while (
      countPassed < this.triggers.length &&
      this.triggers[countPassed] <= this.playbackSecs + 1e-6
    ) {
      countPassed += 1;
    }
    this.nextCommitIndex = countPassed;
    this.currentCommitIndex = countPassed - 1;
    if (this.currentCommitIndex >= 0) {
      const commit = this.reel.commits[this.currentCommitIndex];
      if (commit) {
        this.spawnVisualsForCommit(commit, this.currentCommitIndex);
        if (emitLast) {
          this.notifyCommit(this.currentCommitIndex, commit);
        }
      }
    }
    if (this.playbackSecs >= this.durationSecs) {
      this.playing = false;
    }
  }

  /**
   * Advances playback clock and triggers commit events ONLY.
   * Must NEVER be called inside StageRenderer.frameLoop (which calls stepVisuals only).
   */
  stepPlayback(dtSecs: number): TheaterStepEvent[] {
    if (!this.active || !this.playing || !this.reel || this.reel.commits.length === 0) {
      return [];
    }
    const dt = clampDt(dtSecs);
    if (dt <= 0) return [];

    this.playbackSecs = Math.min(this.durationSecs, this.playbackSecs + dt * this.speed);
    const events = this.fireDueCommits(true);
    if (this.playbackSecs >= this.durationSecs) {
      this.playing = false;
    }
    return events;
  }

  /**
   * Advances visual transients ONLY (parcels, bubbles, confetti, banner, desk pulse).
   * Safe to call inside StageRenderer.frameLoop without advancing playbackSecs.
   */
  stepVisuals(dtSecs: number): void {
    const dt = clampDt(dtSecs);
    if (dt <= 0) return;

    if (this.parcels.length > 0) {
      const nextParcels: TheaterParcel[] = [];
      for (const p of this.parcels) {
        const nextProgress = p.progress + dt / Math.max(0.15, p.durationSecs);
        if (nextProgress < 1) {
          nextParcels.push({ ...p, progress: nextProgress });
        }
      }
      this.parcels = nextParcels;
    }

    if (this.bubbles.length > 0) {
      const nextBubbles: TheaterBubble[] = [];
      for (const b of this.bubbles) {
        const ageSecs = b.ageSecs + dt;
        if (ageSecs < b.ttlSecs) {
          nextBubbles.push({ ...b, ageSecs });
        }
      }
      this.bubbles = nextBubbles;
    }

    if (this.confetti.length > 0) {
      const nextConfetti: TheaterConfetti[] = [];
      for (const c of this.confetti) {
        const ageSecs = c.ageSecs + dt;
        if (ageSecs < c.ttlSecs) {
          nextConfetti.push({
            ...c,
            x: c.x + c.vx * dt,
            y: c.y + c.vy * dt,
            vy: c.vy + 180 * dt,
            ageSecs,
          });
        }
      }
      this.confetti = nextConfetti;
    }

    if (this.banner) {
      const ageSecs = this.banner.ageSecs + dt;
      this.banner = ageSecs < this.banner.ttlSecs ? { ...this.banner, ageSecs } : null;
    }

    if (this.botPulseRemaining.size > 0) {
      for (const [botId, rem] of this.botPulseRemaining.entries()) {
        const next = rem - dt;
        if (next <= 0) {
          this.botPulseRemaining.delete(botId);
        } else {
          this.botPulseRemaining.set(botId, next);
        }
      }
    }
  }

  /** Convenience helper for unit tests: runs playback clock + visual transients once. */
  step(dtSecs: number): TheaterStepEvent[] {
    const events = this.stepPlayback(dtSecs);
    this.stepVisuals(dtSecs);
    return events;
  }

  private clearTransients(): void {
    this.parcels = [];
    this.bubbles = [];
    this.confetti = [];
    this.banner = null;
    this.botPulseRemaining.clear();
    this.areaIndexMap.clear();
  }

  private fireDueCommits(emitSound: boolean): TheaterStepEvent[] {
    if (!this.reel) return [];
    const events: TheaterStepEvent[] = [];
    while (
      this.nextCommitIndex < this.triggers.length &&
      this.triggers[this.nextCommitIndex] <= this.playbackSecs + 1e-6
    ) {
      const idx = this.nextCommitIndex;
      const commit = this.reel.commits[idx];
      this.nextCommitIndex += 1;
      if (!commit) continue;
      this.currentCommitIndex = idx;
      this.spawnVisualsForCommit(commit, idx);
      const ev: TheaterStepEvent = { commitIndex: idx, commit };
      events.push(ev);
      if (emitSound) {
        this.notifyCommit(idx, commit);
      }
    }
    return events;
  }

  private notifyCommit(commitIndex: number, commit: GitCommitEvent): void {
    for (const listener of this.onCommitListeners) {
      listener({ commitIndex, commit });
    }
  }

  private findCastIndex(authorKey: string): number {
    if (!this.reel || this.reel.cast.length === 0) return 0;
    const idx = this.reel.cast.findIndex((c) => c.authorKey === authorKey);
    return idx >= 0 ? idx : 0;
  }

  private spawnVisualsForCommit(commit: GitCommitEvent, commitIndex: number): void {
    const theme = getThemeConfig(this.themeId, this.locale);
    const castIdx = this.findCastIndex(commit.authorKey);
    const desks = theme.botDesks;
    const desk = desks[castIdx % Math.max(1, desks.length)];
    const deskX = desk ? desk.x : theme.designSize[0] * 0.25;
    const deskY = desk ? desk.y : theme.designSize[1] * 0.65;
    const hubX = theme.designSize[0] * 0.5;
    const hubY = theme.designSize[1] * 0.26;
    const color = COMMIT_KIND_COLORS[commit.commitKind] ?? COMMIT_KIND_COLORS.other;

    const botId = `theater:${castIdx}`;
    this.botPulseRemaining.set(botId, commit.isMilestone ? 1.8 : 1.1);

    // 1. Flying parcel (strict cap MAX_THEATER_PARCELS = 12)
    const arcLift = 95 + (castIdx % 3) * 28;
    const parcel: TheaterParcel = {
      id: this.nextVisualId++,
      fromX: deskX,
      fromY: deskY - 24,
      toX: hubX,
      toY: hubY + 6,
      ctrlX: (deskX + hubX) * 0.5,
      ctrlY: Math.min(deskY, hubY) - arcLift,
      progress: 0,
      durationSecs: commit.isMilestone ? 0.95 : 0.72,
      color,
      commitKind: commit.commitKind,
      isMilestone: commit.isMilestone,
      size: commit.isMilestone ? 8.5 : 5.5,
    };
    const nextParcels = [...this.parcels, parcel];
    if (nextParcels.length > MAX_THEATER_PARCELS) {
      nextParcels.splice(0, nextParcels.length - MAX_THEATER_PARCELS);
    }
    this.parcels = nextParcels;

    // 2. Speech bubble (strict cap MAX_THEATER_BUBBLES = 5)
    const bubbleText = truncateForDisplay(
      resolveTheaterCommitText(commit, commitIndex, this.locale, this.redactMode),
      36
    );
    const bubble: TheaterBubble = {
      id: this.nextVisualId++,
      botId,
      deskIndex: castIdx,
      text: bubbleText,
      color,
      ageSecs: 0,
      ttlSecs: commit.isMilestone ? 2.6 : 1.75,
    };
    const filteredBubbles = this.bubbles.filter((b) => b.botId !== botId);
    filteredBubbles.push(bubble);
    if (filteredBubbles.length > MAX_THEATER_BUBBLES) {
      filteredBubbles.splice(0, filteredBubbles.length - MAX_THEATER_BUBBLES);
    }
    this.bubbles = filteredBubbles;

    // 3. Milestone celebration confetti + marquee banner (strict cap MAX_THEATER_CONFETTI = 48)
    if (commit.isMilestone) {
      const palette = ['#fbbf24', '#38bdf8', '#f472b6', '#4ade80', '#c084fc'];
      const batch: TheaterConfetti[] = [];
      for (let i = 0; i < 16; i += 1) {
        const angle = (Math.PI * 2 * i) / 16 + (commitIndex % 5) * 0.17;
        const speedMag = 65 + (i % 4) * 35;
        batch.push({
          x: hubX,
          y: hubY,
          vx: Math.cos(angle) * speedMag,
          vy: Math.sin(angle) * speedMag - 90,
          color: palette[i % palette.length],
          size: 3 + (i % 3),
          ageSecs: 0,
          ttlSecs: 1.5,
        });
      }
      const combined = [...this.confetti, ...batch];
      if (combined.length > MAX_THEATER_CONFETTI) {
        combined.splice(0, combined.length - MAX_THEATER_CONFETTI);
      }
      this.confetti = combined;

      const s = tStrings(this.locale);
      const bannerTitle = truncateForDisplay(
        resolveTheaterCommitText(commit, commitIndex, this.locale, this.redactMode),
        46
      );
      this.banner = {
        text: `★ ${s.theaterMilestoneTag} · ${bannerTitle}`,
        color,
        ageSecs: 0,
        ttlSecs: 2.8,
      };
    }
  }

  buildCastAppearances(): Record<string, CharacterId> {
    const out: Record<string, CharacterId> = {};
    if (!this.reel) return out;
    const cast = this.reel.cast.slice(0, 12);
    for (let idx = 0; idx < cast.length; idx += 1) {
      const member = cast[idx];
      out[`theater:${idx}`] =
        member.characterId ||
        POOL_CHARACTER_IDS[idx % POOL_CHARACTER_IDS.length];
    }
    return out;
  }

  buildTheaterSnapshot(
    locale: UiLocale,
    redactMode: boolean
  ): WorldSnapshot {
    const base = createEmptySnapshot();
    if (!this.reel) return base;

    const currentCommit = this.getCurrentCommit();
    const cast = this.reel.cast.slice(0, 12);
    const botsRecord: Record<string, BotState> = {};
    const botOrder: string[] = [];

    for (let idx = 0; idx < cast.length; idx += 1) {
      const member = cast[idx];
      const botId = `theater:${idx}`;
      const pulse = this.botPulseRemaining.get(botId) ?? 0;
      const isCurrentAuthor =
        currentCommit !== null && currentCommit.authorKey === member.authorKey;
      const isWorking = pulse > 0 || (this.playing && isCurrentAuthor);
      const authorLabel = resolveTheaterAuthorName(member, idx, locale, redactMode);
      const areaLabel =
        isCurrentAuthor && currentCommit
          ? resolveTheaterAreaLabel(
              currentCommit,
              Math.max(0, this.currentCommitIndex),
              locale,
              redactMode,
              this.areaIndexMap
            )
          : `${member.commitCount} commits`;

      botOrder.push(botId);
      botsRecord[botId] = {
        id: botId,
        name: authorLabel,
        agent: 'git',
        paused: false,
        specialty: member.commitCount > 0 ? `${member.commitCount}c` : 'cast',
        status: isWorking
          ? { kind: 'Working', tool: currentCommit?.commitKind ?? 'git' }
          : { kind: 'Idle' },
        currentTaskTitle:
          isCurrentAuthor && currentCommit
            ? resolveTheaterCommitText(
                currentCommit,
                Math.max(0, this.currentCommitIndex),
                locale,
                redactMode
              )
            : areaLabel,
        currentTool: isWorking && currentCommit ? currentCommit.commitKind : null,
        lastActivityAt: currentCommit?.timestampMs ?? this.reel.generatedAtMs,
        homeChatId: null,
        needsYouCount: isCurrentAuthor && currentCommit?.isMilestone ? 1 : 0,
        activeWorkerCount: 0,
      };
    }

    return {
      ...base,
      capturedAt: this.reel.generatedAtMs,
      runtime: {
        ...base.runtime,
        connected: true,
        reachable: true,
        state: 'ready',
      },
      bots: botsRecord,
      botOrder,
      initialSyncComplete: true,
    };
  }
}

function designToScreen(
  dx: number,
  dy: number,
  vt: ViewportTransform
): [number, number] {
  return [vt.originX + dx * vt.scale, vt.originY + dy * vt.scale];
}

export function truncateForDisplay(text: string, maxLen: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxLen) return text;
  return `${chars.slice(0, Math.max(1, maxLen - 1)).join('')}…`;
}

function drawRoundedPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Draws the Git History Theater cinema overlay inside the canvas viewport.
 * Uses strictly vector primitives without canvas shadow glow or external image URLs.
 */
export function paintGitTheaterLayer(
  ctx: CanvasRenderingContext2D,
  vt: ViewportTransform,
  theme: ThemeConfig,
  engine: GitTheaterEngine,
  options: {
    locale: UiLocale;
    redactMode: boolean;
  }
): void {
  const reel = engine.getReel();
  if (!engine.isActive() || !reel) return;

  const s = tStrings(options.locale);
  const bgX = vt.originX;
  const bgY = vt.originY;
  const bgW = vt.designW * vt.scale;
  const bgH = vt.designH * vt.scale;

  ctx.save();

  // 1. Cinema letterbox marquee frame (strictly vector)
  const barH = Math.max(10, Math.round(bgH * 0.045));
  ctx.fillStyle = 'rgba(12, 10, 9, 0.78)';
  ctx.fillRect(bgX, bgY, bgW, barH);
  ctx.fillRect(bgX, bgY + bgH - barH, bgW, barH);

  ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
  ctx.lineWidth = Math.max(1, vt.scale);
  ctx.strokeRect(bgX + 2, bgY + barH, Math.max(2, bgW - 4), Math.max(2, bgH - barH * 2));

  // Film sprocket notches along top & bottom cinema bars
  const notchStep = Math.max(18, 28 * vt.scale);
  const notchW = Math.max(5, 8 * vt.scale);
  const notchH = Math.max(3, barH * 0.36);
  ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
  for (let nx = bgX + 10; nx < bgX + bgW - notchW; nx += notchStep) {
    ctx.fillRect(nx, bgY + (barH - notchH) * 0.5, notchW, notchH);
    ctx.fillRect(nx, bgY + bgH - barH + (barH - notchH) * 0.5, notchW, notchH);
  }

  // 2. Central Main Branch Hub
  const hubDesignX = theme.designSize[0] * 0.5;
  const hubDesignY = theme.designSize[1] * 0.26;
  const [hubX, hubY] = designToScreen(hubDesignX, hubDesignY, vt);
  const hubR = Math.max(22, 30 * vt.scale);
  const currentCommit = engine.getCurrentCommit();
  const hubAccent = currentCommit
    ? COMMIT_KIND_COLORS[currentCommit.commitKind]
    : '#fbbf24';

  ctx.fillStyle = 'rgba(28, 25, 23, 0.9)';
  ctx.beginPath();
  ctx.arc(hubX, hubY, hubR, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hubAccent;
  ctx.lineWidth = Math.max(2, 2.5 * vt.scale);
  ctx.beginPath();
  ctx.arc(hubX, hubY, hubR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(251, 191, 36, 0.35)';
  ctx.lineWidth = Math.max(1, 1.5 * vt.scale);
  ctx.beginPath();
  ctx.arc(hubX, hubY, hubR + 6 * vt.scale, 0, Math.PI * 2);
  ctx.stroke();

  const branchLabel = truncateForDisplay(
    resolveTheaterBranchLabel(reel.branch || s.theaterMainBranchHub, options.locale, options.redactMode),
    14
  );
  ctx.fillStyle = '#fafaf9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.max(9, Math.round(11 * vt.scale))}px system-ui, sans-serif`;
  ctx.fillText(branchLabel, hubX, hubY - 5 * vt.scale);

  const countText = `${Math.max(0, engine.getCurrentCommitIndex() + 1)}/${reel.commits.length}`;
  ctx.fillStyle = '#fbbf24';
  ctx.font = `600 ${Math.max(8, Math.round(9.5 * vt.scale))}px system-ui, sans-serif`;
  ctx.fillText(countText, hubX, hubY + 9 * vt.scale);

  // 3. Parabolic flying commit parcels
  for (const parcel of engine.getParcels()) {
    const t = Math.max(0, Math.min(1, parcel.progress));
    const oneMinusT = 1 - t;
    const dx =
      oneMinusT * oneMinusT * parcel.fromX +
      2 * oneMinusT * t * parcel.ctrlX +
      t * t * parcel.toX;
    const dy =
      oneMinusT * oneMinusT * parcel.fromY +
      2 * oneMinusT * t * parcel.ctrlY +
      t * t * parcel.toY;
    const [px, py] = designToScreen(dx, dy, vt);
    const pr = Math.max(4, parcel.size * vt.scale);

    ctx.fillStyle = parcel.color;
    ctx.strokeStyle = '#0c0a09';
    ctx.lineWidth = Math.max(1, 1.5 * vt.scale);
    if (parcel.isMilestone) {
      ctx.beginPath();
      ctx.moveTo(px, py - pr * 1.25);
      ctx.lineTo(px + pr * 1.25, py);
      ctx.lineTo(px, py + pr * 1.25);
      ctx.lineTo(px - pr * 1.25, py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(px, py, pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 4. Commit speech bubbles over active author desks
  const desks = theme.botDesks;
  ctx.font = `600 ${Math.max(9, Math.round(10 * vt.scale))}px system-ui, sans-serif`;
  for (const bubble of engine.getBubbles()) {
    const desk = desks[bubble.deskIndex % Math.max(1, desks.length)];
    if (!desk) continue;
    const [bx, by] = designToScreen(desk.x, desk.y - 66, vt);
    const alpha = Math.max(0.15, 1 - Math.max(0, bubble.ageSecs / bubble.ttlSecs - 0.65) * 2.5);
    const textW = Math.min(190 * vt.scale, Math.max(64 * vt.scale, ctx.measureText(bubble.text).width + 16 * vt.scale));
    const boxH = Math.max(18, 22 * vt.scale);
    const rx = bx - textW * 0.5;
    const ry = by - boxH;

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.fillStyle = 'rgba(28, 25, 23, 0.92)';
    drawRoundedPill(ctx, rx, ry, textW, boxH, 6 * vt.scale);
    ctx.fill();
    ctx.strokeStyle = bubble.color;
    ctx.lineWidth = Math.max(1, 1.5 * vt.scale);
    ctx.stroke();

    ctx.fillStyle = '#f5f5f4';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(bubble.text, bx, ry + boxH * 0.5, textW - 10 * vt.scale);
    ctx.restore();
  }

  // 5. Milestone confetti
  for (const c of engine.getConfetti()) {
    const [cx, cy] = designToScreen(c.x, c.y, vt);
    const alpha = Math.max(0, 1 - c.ageSecs / c.ttlSecs);
    const cs = Math.max(2, c.size * vt.scale);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = c.color;
    ctx.fillRect(cx - cs * 0.5, cy - cs * 0.5, cs, cs * 0.75);
    ctx.restore();
  }

  // 6. Milestone marquee banner
  const banner = engine.getBanner();
  if (banner) {
    const alpha = Math.max(0.1, 1 - Math.max(0, banner.ageSecs / banner.ttlSecs - 0.7) * 3.0);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.font = `700 ${Math.max(10, Math.round(11.5 * vt.scale))}px system-ui, sans-serif`;
    const bw = Math.min(bgW * 0.8, Math.max(160 * vt.scale, ctx.measureText(banner.text).width + 26 * vt.scale));
    const bh = Math.max(22, 26 * vt.scale);
    const bx = bgX + (bgW - bw) * 0.5;
    const by = bgY + barH + 8 * vt.scale;
    ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
    drawRoundedPill(ctx, bx, by, bw, bh, 8 * vt.scale);
    ctx.fill();
    ctx.strokeStyle = banner.color;
    ctx.lineWidth = Math.max(1.5, 2 * vt.scale);
    ctx.stroke();

    ctx.fillStyle = '#fef3c7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, bgX + bgW * 0.5, by + bh * 0.5, bw - 16 * vt.scale);
    ctx.restore();
  }

  ctx.restore();
}

export function updateTheaterStageHud(
  topHud: HTMLElement,
  bottomHud: HTMLElement,
  options: {
    engine: GitTheaterEngine;
    locale: UiLocale;
    redactMode: boolean;
    suppressed: boolean;
    onPlayPause: () => void;
    onRestart: () => void;
    onPrevCommit: () => void;
    onNextCommit: () => void;
    onSeekFraction: (fraction: number) => void;
    onCycleSpeed: () => void;
    onOpenSelector: () => void;
    onExit: () => void;
  }
): void {
  const { engine, locale, redactMode, suppressed } = options;
  const reel = engine.getReel();
  const visible = engine.isActive() && reel !== null && !suppressed;

  topHud.classList.toggle('bw-hidden', !visible);
  bottomHud.classList.toggle('bw-hidden', !visible);
  if (!visible || !reel) {
    if (topHud.childNodes.length > 0) clearChildren(topHud);
    if (bottomHud.childNodes.length > 0) clearChildren(bottomHud);
    delete topHud.dataset.renderKey;
    delete bottomHud.dataset.locale;
    return;
  }

  const s = tStrings(locale);
  const rawCommitIdx = engine.getCurrentCommitIndex();
  const currentIdx = Math.max(0, rawCommitIdx);
  const currentCommit = engine.getCurrentCommit();
  const repoDisplay = resolveTheaterRepoLabel(reel, locale, redactMode);
  const branchDisplay = resolveTheaterBranchLabel(reel.branch, locale, redactMode);
  const counterText = s.theaterCommitCounter(
    rawCommitIdx >= 0 ? currentIdx + 1 : 0,
    reel.commits.length
  );

  const commitSummary = currentCommit
    ? `${resolveTheaterCommitHash(currentCommit, currentIdx, redactMode)} · ${resolveTheaterCommitText(
        currentCommit,
        currentIdx,
        locale,
        redactMode
      )}`
    : repoDisplay;

  const statsText = currentCommit
    ? s.theaterStatsLine(currentCommit.filesChanged, currentCommit.insertions, currentCommit.deletions)
    : `${repoDisplay} (${branchDisplay})`;

  const topKey = `${locale}:${redactMode ? 1 : 0}:${reel.repoId}:${reel.rangeDays}:${reel.generatedAtMs}:${rawCommitIdx}:${reel.commits.length}`;
  if (topHud.dataset.renderKey !== topKey) {
    topHud.dataset.renderKey = topKey;
    clearChildren(topHud);
    const switchBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-btn bw-btn-ghost bw-theater-hud-btn',
        onClick: options.onOpenSelector,
      },
      s.theaterSwitchRepo
    );
    const exitBtn = el(
      'button',
      {
        type: 'button',
        className: 'bw-btn bw-btn-ghost bw-theater-hud-btn',
        ariaLabel: s.theaterExitAction,
        onClick: options.onExit,
      },
      '✕'
    );
    setTooltip(exitBtn, s.theaterExitAction);

    topHud.appendChild(
      el(
        'div',
        { className: 'bw-theater-top-inner' },
        el('span', { className: 'bw-theater-badge' }, s.theaterModeActiveBadge),
        el('span', { className: 'bw-theater-repo-pill' }, `${repoDisplay} · ${branchDisplay}`),
        el('span', { className: 'bw-theater-counter' }, counterText),
        el('span', { className: 'bw-theater-commit-line', title: commitSummary }, commitSummary),
        el('span', { className: 'bw-theater-stats' }, statsText),
        switchBtn,
        exitBtn
      )
    );
  }

  const pctValue = Math.round(engine.getProgressFraction() * 1000);
  const speed = engine.getSpeed();
  const elapsed = Math.round(engine.getPlaybackSecs());
  const total = Math.round(engine.getDurationSecs());
  const timeText = `${elapsed}s / ${total}s`;
  const existingSlider = bottomHud.querySelector('.bw-theater-scrubber') as HTMLInputElement | null;
  const existingPlayBtn = bottomHud.querySelector('.bw-theater-play-btn') as HTMLButtonElement | null;
  const existingSpeedBtn = bottomHud.querySelector('.bw-theater-speed-btn') as HTMLButtonElement | null;
  const existingTimeEl = bottomHud.querySelector('.bw-theater-time') as HTMLElement | null;

  if (
    existingSlider &&
    existingPlayBtn &&
    existingSpeedBtn &&
    existingTimeEl &&
    bottomHud.dataset.locale === locale
  ) {
    existingPlayBtn.textContent = engine.isPlaying() ? '⏸' : '▶';
    existingPlayBtn.setAttribute('aria-label', engine.isPlaying() ? s.theaterPause : s.theaterPlay);
    setTooltip(existingPlayBtn, engine.isPlaying() ? s.theaterPause : s.theaterPlay);
    if (typeof document === 'undefined' || document.activeElement !== existingSlider) {
      existingSlider.value = String(pctValue);
    }
    existingSpeedBtn.textContent = `${speed}x`;
    existingSpeedBtn.setAttribute('aria-label', s.theaterSpeedTitle(speed));
    setTooltip(existingSpeedBtn, s.theaterSpeedTitle(speed));
    existingTimeEl.textContent = timeText;
    return;
  }

  bottomHud.dataset.locale = locale;
  clearChildren(bottomHud);

  // Bottom Scrubber & Playback Controls
  const restartBtn = el('button', {
    type: 'button',
    className: 'bw-icon-btn bw-theater-ctrl-btn',
    ariaLabel: s.theaterRestart,
    onClick: options.onRestart,
  });
  setButtonContent(restartBtn, 'refresh-cw');
  setTooltip(restartBtn, s.theaterRestart);

  const prevBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-icon-btn bw-theater-ctrl-btn',
      ariaLabel: s.theaterPrevCommit,
      onClick: options.onPrevCommit,
    },
    '⏮'
  );
  setTooltip(prevBtn, s.theaterPrevCommit);

  const playPauseBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-icon-btn bw-theater-ctrl-btn bw-theater-play-btn',
      ariaLabel: engine.isPlaying() ? s.theaterPause : s.theaterPlay,
      onClick: options.onPlayPause,
    },
    engine.isPlaying() ? '⏸' : '▶'
  );
  setTooltip(playPauseBtn, engine.isPlaying() ? s.theaterPause : s.theaterPlay);

  const nextBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-icon-btn bw-theater-ctrl-btn',
      ariaLabel: s.theaterNextCommit,
      onClick: options.onNextCommit,
    },
    '⏭'
  );
  setTooltip(nextBtn, s.theaterNextCommit);

  const slider = el('input', {
    type: 'range',
    className: 'bw-theater-scrubber',
    min: '0',
    max: '1000',
    step: '1',
    value: String(pctValue),
    ariaLabel: s.theaterScrubLabel,
    onInput: (ev) => {
      const target = ev.target as HTMLInputElement;
      const raw = Number.parseInt(target.value, 10);
      if (Number.isFinite(raw)) {
        options.onSeekFraction(raw / 1000);
      }
    },
  });

  const speedBtn = el(
    'button',
    {
      type: 'button',
      className: 'bw-btn bw-btn-ghost bw-theater-speed-btn',
      ariaLabel: s.theaterSpeedTitle(speed),
      onClick: options.onCycleSpeed,
    },
    `${speed}x`
  );
  setTooltip(speedBtn, s.theaterSpeedTitle(speed));

  const timeEl = el('span', { className: 'bw-theater-time' }, timeText);

  bottomHud.appendChild(
    el(
      'div',
      { className: 'bw-theater-bottom-inner' },
      restartBtn,
      prevBtn,
      playPauseBtn,
      nextBtn,
      slider,
      speedBtn,
      timeEl
    )
  );
}

export function renderGitTheaterModal(
  container: HTMLElement,
  options: {
    open: boolean;
    locale: UiLocale;
    redactMode: boolean;
    loading: boolean;
    errorMessage: string | null;
    repos: readonly GitRepoSummary[];
    selectedRepoId: string;
    rangeDays: GitRangeDays;
    theaterActive: boolean;
    isDemoReelActive: boolean;
    onSelectRepo: (repoId: string) => void;
    onSelectRange: (rangeDays: GitRangeDays) => void;
    onRefreshRepos: () => void;
    onStartRepoTheater: () => void;
    onStartDemoTheater: () => void;
    onExitTheater: () => void;
    onClose: () => void;
  }
): void {
  clearChildren(container);
  container.classList.toggle('bw-hidden', !options.open);
  if (!options.open) return;

  const s = tStrings(options.locale);

  const repoSelect = el('select', {
    className: 'bw-select bw-theater-select',
    ariaLabel: s.theaterRepoLabel,
    onChange: (ev) => {
      options.onSelectRepo((ev.target as HTMLSelectElement).value);
    },
  });

  for (const repo of options.repos) {
    const label = `${resolveTheaterRepoLabel(repo, options.locale, options.redactMode)} (${resolveTheaterBranchLabel(
      repo.branch,
      options.locale,
      options.redactMode
    )})`;
    const opt = el(
      'option',
      {
        value: repo.repoId,
        selected: options.selectedRepoId === repo.repoId,
      },
      label
    );
    repoSelect.appendChild(opt);
  }
  const demoOpt = el(
    'option',
    {
      value: 'demo',
      selected: options.selectedRepoId === 'demo' || options.repos.length === 0,
    },
    s.theaterDemoRepoOption
  );
  repoSelect.appendChild(demoOpt);

  const rangeButtons = ([7, 14, 30] as const).map((days) =>
    el(
      'button',
      {
        type: 'button',
        className:
          options.rangeDays === days
            ? 'bw-btn bw-btn-primary'
            : 'bw-btn bw-btn-ghost',
        ariaPressed: String(options.rangeDays === days),
        onClick: () => options.onSelectRange(days),
      },
      s.theaterRangeOption(days)
    )
  );

  const statusItems: HTMLElement[] = [];
  if (options.loading) {
    statusItems.push(el('div', { className: 'bw-theater-note' }, s.theaterLoading));
  } else if (options.errorMessage) {
    const safeError = options.redactMode ? s.errorHiddenLabel : scrubAll(options.errorMessage);
    statusItems.push(
      el(
        'div',
        { className: 'bw-theater-note bw-theater-note-error' },
        `${s.theaterErrorTitle}: ${safeError}`
      )
    );
  } else if (options.repos.length === 0) {
    statusItems.push(el('div', { className: 'bw-theater-note' }, s.theaterNoReposNote));
  }

  const actionRow = el(
    'div',
    { className: 'bw-theater-actions' },
    el(
      'button',
      {
        type: 'button',
        className: 'bw-btn bw-btn-primary',
        disabled: options.loading,
        onClick:
          options.selectedRepoId === 'demo' || options.repos.length === 0
            ? options.onStartDemoTheater
            : options.onStartRepoTheater,
      },
      options.selectedRepoId === 'demo' || options.repos.length === 0
        ? s.theaterWatchDemoAction
        : s.theaterStartAction
    ),
    options.repos.length > 0 && options.selectedRepoId !== 'demo'
      ? el(
          'button',
          {
            type: 'button',
            className: 'bw-btn bw-btn-ghost',
            disabled: options.loading,
            onClick: options.onStartDemoTheater,
          },
          s.theaterWatchDemoAction
        )
      : null,
    el(
      'button',
      {
        type: 'button',
        className: 'bw-btn bw-btn-ghost',
        disabled: options.loading,
        onClick: options.onRefreshRepos,
      },
      s.theaterRefreshAction
    ),
    options.theaterActive
      ? el(
          'button',
          {
            type: 'button',
            className: 'bw-btn bw-btn-ghost',
            onClick: options.onExitTheater,
          },
          s.theaterExitAction
        )
      : null
  );

  const dialog = el(
    'div',
    {
      className: 'bw-modal-dialog bw-theater-dialog',
      role: 'dialog',
      ariaLabel: s.theaterTitle,
      onClick: (ev) => ev.stopPropagation(),
    },
    el(
      'div',
      { className: 'bw-modal-header' },
      el(
        'div',
        null,
        el('div', { className: 'bw-modal-title' }, s.theaterTitle),
        el('div', { className: 'bw-modal-subtitle' }, s.theaterSubtitle)
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'bw-btn bw-btn-ghost',
          ariaLabel: s.theaterClose,
          onClick: options.onClose,
        },
        '✕'
      )
    ),
    el(
      'div',
      { className: 'bw-theater-body' },
      el(
        'div',
        { className: 'bw-theater-field' },
        el('label', { className: 'bw-theater-field-label' }, s.theaterRepoLabel),
        repoSelect
      ),
      el(
        'div',
        { className: 'bw-theater-field' },
        el('label', { className: 'bw-theater-field-label' }, s.theaterRangeLabel),
        el('div', { className: 'bw-theater-range-row' }, ...rangeButtons)
      ),
      ...statusItems,
      el('div', { className: 'bw-theater-privacy-note' }, s.theaterPrivacyNote),
      actionRow
    )
  );

  container.appendChild(dialog);
}
