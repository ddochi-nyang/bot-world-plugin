export const TIMELAPSE_DURATION_MS = 10_000;

export type TimelapseStepResult = {
  active: boolean;
  cursorMs: number;
  fraction: number;
  completed: boolean;
};

export class TimelapseController {
  active = false;
  elapsedMs = 0;
  readonly durationMs: number;
  startCursorMs = 0;
  endCursorMs = 0;

  constructor(durationMs: number = TIMELAPSE_DURATION_MS) {
    this.durationMs = Math.max(100, Math.trunc(durationMs));
  }

  start(
    bounds: readonly [number, number] | null,
    fallbackMs: number
  ): { cursorMs: number; fraction: number } {
    const safeFallback =
      typeof fallbackMs === 'number' && Number.isFinite(fallbackMs) && fallbackMs > 0
        ? fallbackMs
        : Date.now();
    const minTs = bounds ? bounds[0] : safeFallback;
    const maxTs = bounds ? Math.max(bounds[0], bounds[1]) : safeFallback;

    this.active = true;
    this.elapsedMs = 0;
    this.startCursorMs = minTs;
    this.endCursorMs = maxTs;
    return { cursorMs: minTs, fraction: 0 };
  }

  stop(): void {
    this.active = false;
  }

  reset(): void {
    this.active = false;
    this.elapsedMs = 0;
    this.startCursorMs = 0;
    this.endCursorMs = 0;
  }

  advance(dtMs: number): TimelapseStepResult {
    if (!this.active) {
      return {
        active: false,
        cursorMs: this.endCursorMs,
        fraction: 1,
        completed: false,
      };
    }
    const safeDt = typeof dtMs === 'number' && Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    this.elapsedMs = Math.min(this.durationMs, this.elapsedMs + safeDt);
    const fraction = Math.max(0, Math.min(1, this.elapsedMs / this.durationMs));
    const span = Math.max(0, this.endCursorMs - this.startCursorMs);
    const cursorMs = Math.round(this.startCursorMs + span * fraction);
    const completed = this.elapsedMs >= this.durationMs;
    if (completed) {
      this.active = false;
    }
    return {
      active: this.active,
      cursorMs,
      fraction,
      completed,
    };
  }

  formatProgress(): string {
    const elapsedSec = Math.min(this.durationMs / 1000, this.elapsedMs / 1000);
    const formatted = elapsedSec.toFixed(1).padStart(4, '0');
    const totalSec = Math.round(this.durationMs / 1000);
    return `${formatted}s / ${totalSec}s`;
  }
}
