export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export const BreakerState = CircuitState;

export interface CircuitBreakerOptions {
  clientId?: string;
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export interface CircuitBreakerConfig {
  clientId?: string;
  failureThreshold: number;
  resetTimeoutMs: number;
}

export interface CircuitBreakerSuccess<T> {
  success: true;
  data: T;
}

export interface CircuitBreakerFailure {
  success: false;
  error: string;
}

export type CircuitBreakerResult<T> = CircuitBreakerSuccess<T> | CircuitBreakerFailure;

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

const pendingClientBreakers = new Map<string, CircuitBreaker>();

function normalizeConfig(options: CircuitBreakerOptions = {}): CircuitBreakerConfig {
  return {
    clientId: options.clientId,
    failureThreshold: Math.max(1, Math.trunc(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD)),
    resetTimeoutMs: Math.max(0, Math.trunc(options.resetTimeoutMs ?? DEFAULT_RESET_TIMEOUT_MS)),
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error) {
    return error;
  }

  return "Unknown error";
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value;
}

function releasePendingClientBreaker(clientId: string, breaker: CircuitBreaker): void {
  queueMicrotask(() => {
    if (pendingClientBreakers.get(clientId) === breaker) {
      pendingClientBreakers.delete(clientId);
    }
  });
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;

  private state = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CircuitBreakerOptions = {}) {
    this.config = normalizeConfig(options);
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  getOpenedAt(): number | null {
    return this.openedAt;
  }

  getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  canExecute(): boolean {
    return this.state !== CircuitState.OPEN;
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionToClosed();
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.transitionToOpen();
      return;
    }

    if (this.state === CircuitState.OPEN) {
      return;
    }

    this.failureCount += 1;

    if (this.failureCount >= this.config.failureThreshold) {
      this.transitionToOpen();
    }
  }

  transitionToHalfOpen(): void {
    this.clearResetTimer();
    this.state = CircuitState.HALF_OPEN;
    this.openedAt = null;
    this.failureCount = 0;
  }

  execute<T>(
    operation: () => T | Promise<T>,
  ): CircuitBreakerResult<Awaited<T>> | Promise<CircuitBreakerResult<Awaited<T>>> {
    if (!this.canExecute()) {
      return {
        success: false,
        error: "Circuit breaker is OPEN",
      };
    }

    try {
      const result = operation();

      if (isPromiseLike(result)) {
        return result
          .then((data) => {
            this.recordSuccess();
            return {
              success: true,
              data: data as Awaited<T>,
            } satisfies CircuitBreakerSuccess<Awaited<T>>;
          })
          .catch((error: unknown) => {
            this.recordFailure();
            return {
              success: false,
              error: getErrorMessage(error),
            } satisfies CircuitBreakerFailure;
          });
      }

      this.recordSuccess();
      return {
        success: true,
        data: result as Awaited<T>,
      };
    } catch (error) {
      this.recordFailure();
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  dispose(): void {
    this.clearResetTimer();
  }

  private transitionToClosed(): void {
    this.clearResetTimer();
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.openedAt = null;
  }

  private transitionToOpen(): void {
    this.clearResetTimer();
    this.state = CircuitState.OPEN;
    this.openedAt = Date.now();
    this.scheduleHalfOpenTransition();
  }

  private scheduleHalfOpenTransition(): void {
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      if (this.state === CircuitState.OPEN) {
        this.transitionToHalfOpen();
      }
    }, this.config.resetTimeoutMs);

    this.resetTimer.unref?.();
  }

  private clearResetTimer(): void {
    if (!this.resetTimer) {
      return;
    }

    clearTimeout(this.resetTimer);
    this.resetTimer = null;
  }
}

export function createCircuitBreaker(options: CircuitBreakerOptions = {}): CircuitBreaker {
  if (!options.clientId) {
    return new CircuitBreaker(options);
  }

  const existingBreaker = pendingClientBreakers.get(options.clientId);
  if (existingBreaker) {
    return existingBreaker;
  }

  const breaker = new CircuitBreaker(options);
  pendingClientBreakers.set(options.clientId, breaker);
  releasePendingClientBreaker(options.clientId, breaker);
  return breaker;
}
