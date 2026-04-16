import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "../../src/config.js";

describe("DEFAULT_CONFIG shape parity", () => {
    it("includes every nested section used by command and harness test doubles", () => {
        expect(DEFAULT_CONFIG).toMatchObject({
            account_selection_strategy: "sticky",
            signature_profile: expect.any(String),
            failure_ttl_seconds: 3600,
            debug: false,
            signature_emulation: {
                enabled: true,
                fetch_claude_code_version_on_startup: true,
                prompt_compaction: "minimal",
                sanitize_system_prompt: false,
            },
            override_model_limits: {
                enabled: true,
                context: 1_000_000,
                output: 0,
            },
            custom_betas: [],
            health_score: {
                initial: 70,
                success_reward: 1,
                rate_limit_penalty: -10,
                failure_penalty: -20,
                recovery_rate_per_hour: 2,
                min_usable: 50,
                max_score: 100,
            },
            token_bucket: {
                max_tokens: 50,
                regeneration_rate_per_minute: 6,
                initial_tokens: 50,
            },
            toasts: {
                quiet: false,
                debounce_seconds: 30,
            },
            headers: {},
            idle_refresh: {
                enabled: true,
                window_minutes: 60,
                min_interval_minutes: 30,
            },
            cc_credential_reuse: {
                enabled: true,
                auto_detect: true,
                prefer_over_oauth: true,
            },
        });
    });

    it("supports nested spread cloning without sharing mutable sub-objects", () => {
        const clone = {
            ...DEFAULT_CONFIG,
            signature_emulation: { ...DEFAULT_CONFIG.signature_emulation },
            override_model_limits: { ...DEFAULT_CONFIG.override_model_limits },
            custom_betas: [...DEFAULT_CONFIG.custom_betas],
            health_score: { ...DEFAULT_CONFIG.health_score },
            token_bucket: { ...DEFAULT_CONFIG.token_bucket },
            toasts: { ...DEFAULT_CONFIG.toasts },
            headers: { ...DEFAULT_CONFIG.headers },
            idle_refresh: { ...DEFAULT_CONFIG.idle_refresh },
            cc_credential_reuse: { ...DEFAULT_CONFIG.cc_credential_reuse },
        };

        expect(clone).toEqual(DEFAULT_CONFIG);
        expect(clone).not.toBe(DEFAULT_CONFIG);
        expect(clone.signature_emulation).not.toBe(DEFAULT_CONFIG.signature_emulation);
        expect(clone.override_model_limits).not.toBe(DEFAULT_CONFIG.override_model_limits);
        expect(clone.health_score).not.toBe(DEFAULT_CONFIG.health_score);
        expect(clone.token_bucket).not.toBe(DEFAULT_CONFIG.token_bucket);
        expect(clone.toasts).not.toBe(DEFAULT_CONFIG.toasts);
        expect(clone.headers).not.toBe(DEFAULT_CONFIG.headers);
        expect(clone.idle_refresh).not.toBe(DEFAULT_CONFIG.idle_refresh);
        expect(clone.cc_credential_reuse).not.toBe(DEFAULT_CONFIG.cc_credential_reuse);
        expect(clone.custom_betas).not.toBe(DEFAULT_CONFIG.custom_betas);
    });
});
