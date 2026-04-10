import { describe, it, expect } from "vitest";
import { createDeferred, createDeferredQueue, nextTick } from "./deferred";

describe("deferred helpers", () => {
  describe("createDeferred", () => {
    it("should resolve with expected value", async () => {
      const deferred = createDeferred<string>();

      deferred.resolve("expected-value");

      const result = await deferred.promise;
      expect(result).toBe("expected-value");
    });

    it("should reject with expected reason", async () => {
      const deferred = createDeferred<string>();
      const error = new Error("test-error");

      deferred.reject(error);

      await expect(deferred.promise).rejects.toBe(error);
    });

    it("should track settled state", async () => {
      const deferred = createDeferred<string>();

      expect(deferred.settled).toBe(false);

      deferred.resolve("done");

      expect(deferred.settled).toBe(true);
      await deferred.promise;
    });

    it("should ignore second resolve", async () => {
      const deferred = createDeferred<string>();

      deferred.resolve("first");
      deferred.resolve("second");

      const result = await deferred.promise;
      expect(result).toBe("first");
    });

    it("should ignore reject after resolve", async () => {
      const deferred = createDeferred<string>();

      deferred.resolve("value");
      deferred.reject(new Error("ignored"));

      const result = await deferred.promise;
      expect(result).toBe("value");
    });
  });

  describe("createDeferredQueue", () => {
    it("should resolve deferreds in FIFO order", async () => {
      const queue = createDeferredQueue<string>();

      const d1 = queue.enqueue();
      const d2 = queue.enqueue();
      const d3 = queue.enqueue();

      expect(queue.pending).toBe(3);

      queue.resolveNext("first");
      queue.resolveNext("second");
      queue.resolveNext("third");

      expect(queue.pending).toBe(0);

      const results = await Promise.all([d1.promise, d2.promise, d3.promise]);

      expect(results).toEqual(["first", "second", "third"]);
    });

    it("should reject deferreds in FIFO order", async () => {
      const queue = createDeferredQueue<string>();

      const d1 = queue.enqueue();
      const d2 = queue.enqueue();

      const error1 = new Error("error-1");
      const error2 = new Error("error-2");

      queue.rejectNext(error1);
      queue.rejectNext(error2);

      await expect(d1.promise).rejects.toBe(error1);
      await expect(d2.promise).rejects.toBe(error2);
    });

    it("should return false when resolving empty queue", () => {
      const queue = createDeferredQueue<string>();

      const result = queue.resolveNext("value");

      expect(result).toBe(false);
    });

    it("should return false when rejecting empty queue", () => {
      const queue = createDeferredQueue<string>();

      const result = queue.rejectNext(new Error("test"));

      expect(result).toBe(false);
    });

    it("should handle mixed resolve and reject", async () => {
      const queue = createDeferredQueue<string>();

      const d1 = queue.enqueue();
      const d2 = queue.enqueue();
      const d3 = queue.enqueue();

      queue.resolveNext("success");
      queue.rejectNext(new Error("failure"));
      queue.resolveNext("another-success");

      const r1 = await d1.promise;
      expect(r1).toBe("success");

      await expect(d2.promise).rejects.toThrow("failure");

      const r3 = await d3.promise;
      expect(r3).toBe("another-success");
    });
  });

  describe("nextTick", () => {
    it("should allow pending promises to settle", async () => {
      const deferred = createDeferred<string>();
      let resolved = false;

      deferred.promise.then(() => {
        resolved = true;
      });

      deferred.resolve("done");

      expect(resolved).toBe(false);

      await nextTick();

      expect(resolved).toBe(true);
    });

    it("should resolve after microtask queue", async () => {
      const order: string[] = [];

      Promise.resolve().then(() => order.push("promise-1"));
      Promise.resolve().then(() => order.push("promise-2"));

      await nextTick();

      order.push("after-nextTick");

      expect(order).toEqual(["promise-1", "promise-2", "after-nextTick"]);
    });
  });
});
