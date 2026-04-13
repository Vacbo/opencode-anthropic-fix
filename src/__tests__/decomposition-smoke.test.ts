/**
 * Decomposition smoke tests (Tasks 6-7 from quality-refactor plan)
 *
 * Verifies that extracted refresh-helpers and plugin-helpers modules
 * export their factory functions and produce the expected API surface.
 */

import { describe, it, expect, vi } from "vitest";

import { DEFAULT_CONFIG } from "../config.js";
import { createRefreshHelpers } from "../refresh-helpers.js";
import { createPluginHelpers } from "../plugin-helpers.js";

describe("refresh-helpers module", () => {
    it("exports createRefreshHelpers as a function", () => {
        expect(typeof createRefreshHelpers).toBe("function");
    });

    it("factory returns an object when called with valid deps", () => {
        const stubClient = {
            tui: { showToast: vi.fn() },
            command: { prompt: vi.fn() },
            session: { prompt: vi.fn() },
        };
        const helpers = createRefreshHelpers({
            client: stubClient as any,
            config: { ...DEFAULT_CONFIG } as any,
            getAccountManager: () => null,
            debugLog: vi.fn(),
        });

        expect(helpers).toBeDefined();
        expect(typeof helpers).toBe("object");
        expect(helpers).not.toBeNull();
    });

    it("factory reads idle_refresh config fields at construction", () => {
        const config = {
            ...DEFAULT_CONFIG,
            idle_refresh: { enabled: false, window_minutes: 10, min_interval_minutes: 5 },
        };
        expect(() =>
            createRefreshHelpers({
                client: {} as any,
                config: config as any,
                getAccountManager: () => null,
                debugLog: vi.fn(),
            }),
        ).not.toThrow();
    });
});

describe("plugin-helpers module", () => {
    it("exports createPluginHelpers as a function", () => {
        expect(typeof createPluginHelpers).toBe("function");
    });

    it("factory returns an object when called with valid deps", () => {
        const stubClient = {
            tui: { showToast: vi.fn() },
            command: { prompt: vi.fn() },
            session: { prompt: vi.fn() },
        };
        const helpers = createPluginHelpers({
            client: stubClient as any,
            config: { ...DEFAULT_CONFIG } as any,
            debugLog: vi.fn(),
            getAccountManager: () => null,
            setAccountManager: vi.fn(),
        });

        expect(helpers).toBeDefined();
        expect(typeof helpers).toBe("object");
        expect(helpers).not.toBeNull();
    });

    it("factory accepts quiet toast config without throwing", () => {
        const config = {
            ...DEFAULT_CONFIG,
            toasts: { quiet: true, debounce_seconds: 60 },
        };
        expect(() =>
            createPluginHelpers({
                client: {} as any,
                config: config as any,
                debugLog: vi.fn(),
                getAccountManager: () => null,
                setAccountManager: vi.fn(),
            }),
        ).not.toThrow();
    });
});
