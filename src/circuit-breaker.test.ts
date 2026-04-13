import { describe, expect, it, vi } from "vitest";
import { createCircuitBreaker, CircuitState } from "./circuit-breaker.js";

// ---------------------------------------------------------------------------
// Circuit Breaker - Core State Tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker - State Management", () => {
    it("starts in CLOSED state and allows requests", () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });

        expect(breaker.getState()).toBe(CircuitState.CLOSED);
        expect(breaker.canExecute()).toBe(true);
    });

    it("transitions to OPEN after N consecutive failures", () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });

        breaker.recordFailure();
        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.CLOSED);

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);
        expect(breaker.canExecute()).toBe(false);
    });

    it("resets failure count on success", () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });

        breaker.recordFailure();
        breaker.recordFailure();
        breaker.recordSuccess();

        expect(breaker.getState()).toBe(CircuitState.CLOSED);
        expect(breaker.getFailureCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Circuit Breaker - Open State Behavior
// ---------------------------------------------------------------------------

describe("CircuitBreaker - Open State", () => {
    it("fails fast without calling upstream when OPEN", () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 1,
            resetTimeoutMs: 5000,
        });

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        const upstreamCall = vi.fn();
        const result = breaker.execute(upstreamCall);

        expect(upstreamCall).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.error).toBe("Circuit breaker is OPEN");
    });

    it("tracks open state duration", () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 1,
            resetTimeoutMs: 5000,
        });

        const openTime = Date.now();
        breaker.recordFailure();

        expect(breaker.getState()).toBe(CircuitState.OPEN);
        expect(breaker.getOpenedAt()).toBeGreaterThanOrEqual(openTime);
    });
});

// ---------------------------------------------------------------------------
// Circuit Breaker - Half-Open State
// ---------------------------------------------------------------------------

describe("CircuitBreaker - Half-Open State", () => {
    it("transitions to HALF_OPEN after timeout expires", async () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 1,
            resetTimeoutMs: 100,
        });

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
        expect(breaker.canExecute()).toBe(true);
    });

    it("closes breaker on success in HALF_OPEN state", () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 1,
            resetTimeoutMs: 0,
        });

        breaker.recordFailure();
        breaker.transitionToHalfOpen();
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

        breaker.recordSuccess();
        expect(breaker.getState()).toBe(CircuitState.CLOSED);
        expect(breaker.getFailureCount()).toBe(0);
    });

    it("reopens breaker on failure in HALF_OPEN state", () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 3,
            resetTimeoutMs: 0,
        });

        breaker.recordFailure();
        breaker.recordFailure();
        breaker.transitionToHalfOpen();
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
});

// ---------------------------------------------------------------------------
// Circuit Breaker - Per-Client Isolation
// ---------------------------------------------------------------------------

describe("CircuitBreaker - Per-Client Isolation", () => {
    it("client A failures do not affect client B breaker", () => {
        const clientABreaker = createCircuitBreaker({
            clientId: "client-a",
            failureThreshold: 3,
        });
        const clientBBreaker = createCircuitBreaker({
            clientId: "client-b",
            failureThreshold: 3,
        });

        // Client A fails 3 times
        clientABreaker.recordFailure();
        clientABreaker.recordFailure();
        clientABreaker.recordFailure();

        // Client A should be OPEN
        expect(clientABreaker.getState()).toBe(CircuitState.OPEN);
        expect(clientABreaker.canExecute()).toBe(false);

        // Client B should still be CLOSED
        expect(clientBBreaker.getState()).toBe(CircuitState.CLOSED);
        expect(clientBBreaker.canExecute()).toBe(true);
    });

    it("each client has independent failure count", () => {
        const clientABreaker = createCircuitBreaker({
            clientId: "client-a",
            failureThreshold: 3,
        });
        const clientBBreaker = createCircuitBreaker({
            clientId: "client-b",
            failureThreshold: 3,
        });

        clientABreaker.recordFailure();
        clientABreaker.recordFailure();

        expect(clientABreaker.getFailureCount()).toBe(2);
        expect(clientBBreaker.getFailureCount()).toBe(0);
    });

    it("shared registry returns same breaker for same clientId", () => {
        const breaker1 = createCircuitBreaker({
            clientId: "shared-client",
            failureThreshold: 3,
        });
        const breaker2 = createCircuitBreaker({
            clientId: "shared-client",
            failureThreshold: 3,
        });

        breaker1.recordFailure();
        breaker1.recordFailure();

        // Both references should see the same failure count
        expect(breaker2.getFailureCount()).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Circuit Breaker - Configuration
// ---------------------------------------------------------------------------

describe("CircuitBreaker - Configuration", () => {
    it("uses default values when options not provided", () => {
        const breaker = createCircuitBreaker({});

        expect(breaker.getConfig().failureThreshold).toBe(5);
        expect(breaker.getConfig().resetTimeoutMs).toBe(30000);
    });

    it("respects custom failure threshold", () => {
        const breaker = createCircuitBreaker({ failureThreshold: 10 });

        for (let i = 0; i < 9; i++) {
            breaker.recordFailure();
        }
        expect(breaker.getState()).toBe(CircuitState.CLOSED);

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it("respects custom reset timeout", async () => {
        const breaker = createCircuitBreaker({
            failureThreshold: 1,
            resetTimeoutMs: 50,
        });

        breaker.recordFailure();
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });
});

// ---------------------------------------------------------------------------
// Circuit Breaker - Execute Wrapper
// ---------------------------------------------------------------------------

describe("CircuitBreaker - Execute Wrapper", () => {
    it("executes upstream function when CLOSED", async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });
        const upstreamFn = vi.fn().mockResolvedValue("success");

        const result = await breaker.execute(upstreamFn);

        expect(upstreamFn).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        expect(result.data).toBe("success");
    });

    it("records success when upstream succeeds", async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });
        const upstreamFn = vi.fn().mockResolvedValue("data");

        await breaker.execute(upstreamFn);

        expect(breaker.getFailureCount()).toBe(0);
        expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("records failure when upstream throws", async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });
        const upstreamFn = vi.fn().mockRejectedValue(new Error("upstream error"));

        await breaker.execute(upstreamFn);

        expect(breaker.getFailureCount()).toBe(1);
    });

    it("returns error result when upstream throws", async () => {
        const breaker = createCircuitBreaker({ failureThreshold: 3 });
        const error = new Error("upstream error");
        const upstreamFn = vi.fn().mockRejectedValue(error);

        const result = await breaker.execute(upstreamFn);

        expect(result.success).toBe(false);
        expect(result.error).toBe("upstream error");
    });
});
