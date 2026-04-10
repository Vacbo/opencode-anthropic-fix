/**
 * Controllable promises for concurrency tests.
 *
 * Provides utilities for creating deferred promises that can be resolved/rejected
 * externally, and a FIFO queue for managing multiple deferred promises.
 *
 * @example
 * ```ts
 * const deferred = createDeferred<string>();
 * setTimeout(() => deferred.resolve('done'), 100);
 * const result = await deferred.promise; // 'done'
 * ```
 */

export interface Deferred<T> {
  /** The promise that will resolve/reject when called */
  promise: Promise<T>;
  /** Resolve the promise with a value */
  resolve: (value: T | PromiseLike<T>) => void;
  /** Reject the promise with a reason */
  reject: (reason?: unknown) => void;
  /** Whether the promise has settled (resolved or rejected) */
  settled: boolean;
}

/**
 * Creates a deferred promise with external resolve/reject controls.
 *
 * Similar to Promise.withResolvers() but with additional settled tracking.
 *
 * @returns Deferred object with promise, resolve, reject, and settled state
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (!settled) {
        settled = true;
        res(value);
      }
    };
    reject = (reason) => {
      if (!settled) {
        settled = true;
        rej(reason);
      }
    };
  });

  return {
    promise,
    resolve: resolve!,
    reject: reject!,
    get settled() {
      return settled;
    },
  };
}

export interface DeferredQueue<T> {
  /** Add a new deferred to the queue */
  enqueue: () => Deferred<T>;
  /** Resolve the next deferred in FIFO order */
  resolveNext: (value: T | PromiseLike<T>) => boolean;
  /** Reject the next deferred in FIFO order */
  rejectNext: (reason?: unknown) => boolean;
  /** Number of pending deferreds in the queue */
  pending: number;
}

/**
 * Creates a FIFO queue of deferred promises.
 *
 * Useful for testing ordered async operations like request queues,
 * sequential processing, or race conditions.
 *
 * @returns Queue with enqueue, resolveNext, rejectNext, and pending count
 */
export function createDeferredQueue<T>(): DeferredQueue<T> {
  const queue: Deferred<T>[] = [];

  return {
    enqueue: () => {
      const deferred = createDeferred<T>();
      queue.push(deferred);
      return deferred;
    },
    resolveNext: (value) => {
      const next = queue.shift();
      if (next) {
        next.resolve(value);
        return true;
      }
      return false;
    },
    rejectNext: (reason) => {
      const next = queue.shift();
      if (next) {
        next.reject(reason);
        return true;
      }
      return false;
    },
    get pending() {
      return queue.length;
    },
  };
}

/**
 * Waits for one microtask tick.
 *
 * Useful for allowing pending promises to settle before assertions.
 *
 * @returns Promise that resolves after one microtask
 */
export function nextTick(): Promise<void> {
  return Promise.resolve();
}
