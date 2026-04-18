import { describe, expect, it } from "vitest";

import {
    partitionModels,
    shouldSkipModel,
    updateCacheAfterRun,
    type FailedModelsCache,
    type ModelResult,
    type SkippedModel,
} from "../../../scripts/smoke/test-models.ts";

const now = "2026-04-17T20:00:00.000Z";

describe("shouldSkipModel", () => {
    it("returns false when the model is not in the cache", () => {
        expect(shouldSkipModel("claude-haiku-4-5-20251001", {}, false)).toBe(false);
    });

    it("returns true when the model has never passed", () => {
        const cache: FailedModelsCache = {
            "claude-opus-4-7": {
                lastTested: now,
                lastPassedAt: null,
                error: "no quota",
                consecutiveFailures: 3,
            },
        };
        expect(shouldSkipModel("claude-opus-4-7", cache, false)).toBe(true);
    });

    it("returns false when the model passed before (failure is transient)", () => {
        const cache: FailedModelsCache = {
            "claude-sonnet-4-6": {
                lastTested: now,
                lastPassedAt: "2026-04-16T20:00:00.000Z",
                error: "timeout",
                consecutiveFailures: 1,
            },
        };
        expect(shouldSkipModel("claude-sonnet-4-6", cache, false)).toBe(false);
    });

    it("returns false when forceAll is true regardless of cache state", () => {
        const cache: FailedModelsCache = {
            "claude-opus-4-7": {
                lastTested: now,
                lastPassedAt: null,
                error: "no quota",
                consecutiveFailures: 5,
            },
        };
        expect(shouldSkipModel("claude-opus-4-7", cache, true)).toBe(false);
    });
});

describe("partitionModels", () => {
    it("routes fresh models to toTest", () => {
        const result = partitionModels(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"], {}, false);
        expect(result.toTest).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]);
        expect(result.skipped).toEqual([]);
    });

    it("moves never-passed models to skipped with reason and error", () => {
        const cache: FailedModelsCache = {
            "claude-opus-4-7": {
                lastTested: now,
                lastPassedAt: null,
                error: "no quota",
                consecutiveFailures: 2,
            },
        };
        const result = partitionModels(["claude-haiku-4-5-20251001", "claude-opus-4-7"], cache, false);
        expect(result.toTest).toEqual(["claude-haiku-4-5-20251001"]);
        expect(result.skipped).toEqual([
            {
                model: "claude-opus-4-7",
                reason: "Previously unsupported (never passed)",
                lastTested: now,
                lastError: "no quota",
            },
        ]);
    });

    it("ignores the cache entirely when forceAll is true", () => {
        const cache: FailedModelsCache = {
            "claude-opus-4-7": {
                lastTested: now,
                lastPassedAt: null,
                error: "no quota",
                consecutiveFailures: 2,
            },
        };
        const result = partitionModels(["claude-opus-4-7"], cache, true);
        expect(result.toTest).toEqual(["claude-opus-4-7"]);
        expect(result.skipped).toEqual([]);
    });
});

describe("updateCacheAfterRun", () => {
    it("returns empty cache when every model passes", () => {
        const results: ModelResult[] = [
            { model: "claude-haiku-4-5-20251001", status: "pass", timeMs: 500, error: null },
            { model: "claude-sonnet-4-6", status: "pass", timeMs: 900, error: null },
        ];
        expect(updateCacheAfterRun(results, [], {}, now)).toEqual({});
    });

    it("adds failed entries with fresh timestamps and preserves prior lastPassedAt", () => {
        const previousCache: FailedModelsCache = {
            "claude-sonnet-4-6": {
                lastTested: "2026-04-10T00:00:00.000Z",
                lastPassedAt: "2026-04-09T00:00:00.000Z",
                error: "old error",
                consecutiveFailures: 1,
            },
        };
        const results: ModelResult[] = [
            { model: "claude-sonnet-4-6", status: "fail", timeMs: 1200, error: "upstream timeout" },
        ];
        const updated = updateCacheAfterRun(results, [], previousCache, now);
        expect(updated).toEqual({
            "claude-sonnet-4-6": {
                lastTested: now,
                lastPassedAt: "2026-04-09T00:00:00.000Z",
                error: "upstream timeout",
                consecutiveFailures: 2,
            },
        });
    });

    it("carries forward skipped models unchanged", () => {
        const previousCache: FailedModelsCache = {
            "claude-opus-4-7": {
                lastTested: "2026-04-10T00:00:00.000Z",
                lastPassedAt: null,
                error: "quota",
                consecutiveFailures: 4,
            },
        };
        const skipped: SkippedModel[] = [
            {
                model: "claude-opus-4-7",
                reason: "Previously unsupported (never passed)",
                lastTested: "2026-04-10T00:00:00.000Z",
                lastError: "quota",
            },
        ];
        const updated = updateCacheAfterRun([], skipped, previousCache, now);
        expect(updated).toEqual(previousCache);
    });

    it("removes a model from the cache when it newly passes (regression heals)", () => {
        const previousCache: FailedModelsCache = {
            "claude-haiku-4-5-20251001": {
                lastTested: "2026-04-10T00:00:00.000Z",
                lastPassedAt: "2026-04-09T00:00:00.000Z",
                error: "transient",
                consecutiveFailures: 1,
            },
        };
        const results: ModelResult[] = [
            { model: "claude-haiku-4-5-20251001", status: "pass", timeMs: 400, error: null },
        ];
        expect(updateCacheAfterRun(results, [], previousCache, now)).toEqual({});
    });
});
