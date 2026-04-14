import { describe, expect, it } from "vitest";

import {
    EXPECTED_CCH_PLACEHOLDER,
    EXPECTED_CCH_SALT,
    EXPECTED_CCH_SEED,
    EXPECTED_XXHASH64_PRIMES,
    bigintToLittleEndianBytes,
    findAllOccurrences,
    scanCchConstants,
} from "../../../src/drift/cch-constants.js";

describe("cch drift checker helpers", () => {
    it("encodes bigint constants as little-endian bytes", () => {
        expect(Array.from(bigintToLittleEndianBytes(EXPECTED_CCH_SEED))).toEqual([
            0x1e, 0x83, 0x06, 0xc8, 0x6a, 0x73, 0x52, 0x6e,
        ]);
    });

    it("finds all occurrences of a byte pattern", () => {
        const haystack = new Uint8Array([1, 2, 3, 1, 2, 3, 4]);
        const needle = new Uint8Array([1, 2, 3]);
        expect(findAllOccurrences(haystack, needle)).toEqual([0, 3]);
    });
});

describe("scanCchConstants", () => {
    it("passes when all standalone constants are present", () => {
        const bytes = new Uint8Array([
            ...new TextEncoder().encode(`xx cch=${EXPECTED_CCH_PLACEHOLDER} yy ${EXPECTED_CCH_SALT} zz`),
            ...bigintToLittleEndianBytes(EXPECTED_CCH_SEED),
            ...EXPECTED_XXHASH64_PRIMES.flatMap((prime) => Array.from(bigintToLittleEndianBytes(prime))),
        ]);

        const report = scanCchConstants(bytes, "synthetic-standalone", "standalone");
        expect(report.passed).toBe(true);
        expect(report.findings).toEqual([]);
        expect(report.checked.placeholder).toBeGreaterThan(0);
        expect(report.checked.salt).toBeGreaterThan(0);
        expect(report.checked.seed).toBeGreaterThan(0);
        expect(report.checked.primes.every((count) => count > 0)).toBe(true);
    });

    it("fails critically when placeholder and seed are missing", () => {
        const bytes = new TextEncoder().encode(`missing ${EXPECTED_CCH_SALT}`);
        const report = scanCchConstants(bytes, "broken-standalone", "standalone");

        expect(report.passed).toBe(false);
        expect(report.findings.map((finding) => finding.name)).toContain("cch placeholder");
        expect(report.findings.map((finding) => finding.name)).toContain("native cch seed");
    });

    it("only requires placeholder and salt for npm cli bundles", () => {
        const bytes = new TextEncoder().encode(`prefix cch=${EXPECTED_CCH_PLACEHOLDER}; ${EXPECTED_CCH_SALT} suffix`);
        const report = scanCchConstants(bytes, "synthetic-bundle", "bundle");

        expect(report.passed).toBe(true);
        expect(report.checked.seed).toBe(0);
        expect(report.findings).toEqual([]);
    });
});
