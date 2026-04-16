const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BAR_WIDTH = 30;

interface ProgressStream {
    write(chunk: string): boolean;
    isTTY?: boolean;
    columns?: number;
}

function getStream(): ProgressStream {
    return process.stderr as unknown as ProgressStream;
}

function isQuiet(): boolean {
    return process.env.OPENCODE_ANTHROPIC_QUIET_PROGRESS === "1" || process.env.CI === "true";
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m${seconds}s`;
}

function renderBar(fraction: number): string {
    const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
    return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

export interface StepReport {
    step: string;
    detail?: string;
}

export interface ProgressRenderer {
    startStep(step: string, detail?: string): void;
    updateStep(detail: string): void;
    setBytes(current: number, total?: number): void;
    finishStep(detail?: string): void;
    fail(message: string): void;
    done(message?: string): void;
}

interface RendererState {
    currentStep: string | null;
    currentDetail: string;
    stepStartMs: number;
    totalStartMs: number;
    bytesCurrent: number;
    bytesTotal: number | null;
    frameIndex: number;
    spinnerTimer: ReturnType<typeof setInterval> | null;
    lastLineLen: number;
}

function createTtyRenderer(): ProgressRenderer {
    const stream = getStream();
    const state: RendererState = {
        currentStep: null,
        currentDetail: "",
        stepStartMs: 0,
        totalStartMs: Date.now(),
        bytesCurrent: 0,
        bytesTotal: null,
        frameIndex: 0,
        spinnerTimer: null,
        lastLineLen: 0,
    };

    const clearLine = (): void => {
        if (state.lastLineLen === 0) return;
        stream.write(`\r${" ".repeat(state.lastLineLen)}\r`);
        state.lastLineLen = 0;
    };

    const render = (): void => {
        if (!state.currentStep) return;
        const frame = FRAMES[state.frameIndex % FRAMES.length];
        const elapsed = Date.now() - state.stepStartMs;
        let line = `${frame} ${state.currentStep}`;

        if (state.bytesTotal != null && state.bytesTotal > 0) {
            const fraction = Math.max(0, Math.min(1, state.bytesCurrent / state.bytesTotal));
            const percent = Math.round(fraction * 100);
            line += ` ${renderBar(fraction)} ${percent}% (${formatBytes(state.bytesCurrent)}/${formatBytes(state.bytesTotal)})`;
        } else if (state.bytesCurrent > 0) {
            line += ` ${formatBytes(state.bytesCurrent)}`;
        } else if (state.currentDetail) {
            line += ` ${state.currentDetail}`;
        }

        line += ` [${formatDuration(elapsed)}]`;

        const columns = stream.columns ?? 120;
        if (line.length > columns - 1) {
            line = `${line.slice(0, columns - 2)}…`;
        }

        clearLine();
        stream.write(line);
        state.lastLineLen = line.length;
        state.frameIndex += 1;
    };

    const stopSpinner = (): void => {
        if (state.spinnerTimer) {
            clearInterval(state.spinnerTimer);
            state.spinnerTimer = null;
        }
    };

    const startSpinner = (): void => {
        stopSpinner();
        state.spinnerTimer = setInterval(render, 80);
        state.spinnerTimer.unref?.();
    };

    return {
        startStep(step, detail) {
            clearLine();
            stopSpinner();
            state.currentStep = step;
            state.currentDetail = detail ?? "";
            state.stepStartMs = Date.now();
            state.bytesCurrent = 0;
            state.bytesTotal = null;
            render();
            startSpinner();
        },
        updateStep(detail) {
            state.currentDetail = detail;
            render();
        },
        setBytes(current, total) {
            state.bytesCurrent = current;
            if (typeof total === "number") state.bytesTotal = total;
        },
        finishStep(detail) {
            if (!state.currentStep) return;
            stopSpinner();
            const elapsed = Date.now() - state.stepStartMs;
            clearLine();
            const suffix = detail ? ` ${detail}` : "";
            stream.write(`✓ ${state.currentStep}${suffix} [${formatDuration(elapsed)}]\n`);
            state.currentStep = null;
            state.currentDetail = "";
            state.bytesCurrent = 0;
            state.bytesTotal = null;
        },
        fail(message) {
            stopSpinner();
            clearLine();
            stream.write(`✗ ${state.currentStep ?? "error"}: ${message}\n`);
            state.currentStep = null;
        },
        done(message) {
            stopSpinner();
            clearLine();
            const totalElapsed = Date.now() - state.totalStartMs;
            if (message) {
                stream.write(`${message} [${formatDuration(totalElapsed)}]\n`);
            }
        },
    };
}

function createPlainRenderer(): ProgressRenderer {
    const stream = getStream();
    const totalStartMs = Date.now();
    let currentStep: string | null = null;
    let stepStartMs = 0;

    return {
        startStep(step, detail) {
            currentStep = step;
            stepStartMs = Date.now();
            stream.write(`→ ${step}${detail ? ` (${detail})` : ""}\n`);
        },
        updateStep(_detail) {
            // No-op in plain mode — each update would add a line of noise.
        },
        setBytes(_current, _total) {
            // No-op in plain mode for the same reason.
        },
        finishStep(detail) {
            if (!currentStep) return;
            const elapsed = Date.now() - stepStartMs;
            stream.write(`  done${detail ? ` ${detail}` : ""} [${formatDuration(elapsed)}]\n`);
            currentStep = null;
        },
        fail(message) {
            stream.write(`  FAILED: ${message}\n`);
            currentStep = null;
        },
        done(message) {
            if (message) {
                const totalElapsed = Date.now() - totalStartMs;
                stream.write(`${message} [${formatDuration(totalElapsed)}]\n`);
            }
        },
    };
}

function createNoopRenderer(): ProgressRenderer {
    return {
        startStep() {},
        updateStep() {},
        setBytes() {},
        finishStep() {},
        fail() {},
        done() {},
    };
}

export function createProgress(): ProgressRenderer {
    if (isQuiet()) return createNoopRenderer();
    const stream = getStream();
    if (stream.isTTY) return createTtyRenderer();
    return createPlainRenderer();
}
