const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_PARENT_EXIT_CODE = 1;

export interface ParentPidWatcherOptions {
  parentPid: number;
  pollIntervalMs?: number;
  onParentGone: () => void;
}

function assertValidParentPid(parentPid: number): void {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new Error("Parent PID must be a positive integer.");
  }
}

function assertValidPollInterval(pollIntervalMs: number): void {
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("Poll interval must be a positive number.");
  }
}

function isParentAlive(parentPid: number): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }

    if (code === "EPERM") {
      return true;
    }

    return true;
  }
}

export class ParentPidWatcher {
  private readonly parentPid: number;
  private readonly pollIntervalMs: number;
  private readonly onParentGone: () => void;

  private interval: ReturnType<typeof setInterval> | null = null;
  private shouldMonitorPpidDrift = false;

  constructor(options: ParentPidWatcherOptions) {
    this.parentPid = options.parentPid;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onParentGone = options.onParentGone;
  }

  start(): void {
    if (this.interval) {
      return;
    }

    assertValidParentPid(this.parentPid);
    assertValidPollInterval(this.pollIntervalMs);

    this.shouldMonitorPpidDrift = process.ppid === this.parentPid;

    this.interval = setInterval(() => {
      if (this.shouldMonitorPpidDrift && process.ppid !== this.parentPid) {
        this.handleParentGone();
        return;
      }

      if (!isParentAlive(this.parentPid)) {
        this.handleParentGone();
      }
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
    this.shouldMonitorPpidDrift = false;
  }

  private handleParentGone(): void {
    this.stop();
    this.onParentGone();
  }
}

export function watchParentAndExit(parentPid: number, exitCode = DEFAULT_PARENT_EXIT_CODE): ParentPidWatcher {
  return new ParentPidWatcher({
    parentPid,
    onParentGone: () => {
      process.exit(exitCode);
    },
  });
}
