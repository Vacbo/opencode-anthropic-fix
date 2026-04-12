export const EXPECTED_CCH_PLACEHOLDER = "00000";
export const EXPECTED_CCH_SALT = "59cf53e54c78";
export const EXPECTED_CCH_SEED = 0x6e52_736a_c806_831en;

export const EXPECTED_XXHASH64_PRIMES = [
  0x9e37_79b1_85eb_ca87n,
  0xc2b2_ae3d_27d4_eb4fn,
  0x1656_67b1_9e37_79f9n,
  0x85eb_ca77_c2b2_ae63n,
  0x27d4_eb2f_1656_67c5n,
] as const;

export type DriftSeverity = "critical" | "warning";

export interface DriftFinding {
  name: string;
  severity: DriftSeverity;
  expected: string;
  actual: string;
  count: number;
}

export interface DriftScanReport {
  target: string;
  mode: "standalone" | "bundle";
  findings: DriftFinding[];
  checked: {
    placeholder: number;
    salt: number;
    seed: number;
    primes: number[];
  };
  passed: boolean;
}

function encodeAscii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function bigintToLittleEndianBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = value;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export function findAllOccurrences(haystack: Uint8Array, needle: Uint8Array): number[] {
  if (needle.length === 0 || haystack.length < needle.length) {
    return [];
  }

  const matches: number[] = [];
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    matches.push(start);
  }
  return matches;
}

function addFinding(
  findings: DriftFinding[],
  count: number,
  name: string,
  severity: DriftSeverity,
  expected: string,
  actual: string,
): void {
  if (count > 0) {
    return;
  }
  findings.push({ name, severity, expected, actual, count });
}

export function scanCchConstants(bytes: Uint8Array, target: string, mode: "standalone" | "bundle"): DriftScanReport {
  const placeholderMatches = findAllOccurrences(bytes, encodeAscii(`cch=${EXPECTED_CCH_PLACEHOLDER}`));
  const saltMatches = findAllOccurrences(bytes, encodeAscii(EXPECTED_CCH_SALT));
  const seedMatches = findAllOccurrences(bytes, bigintToLittleEndianBytes(EXPECTED_CCH_SEED));
  const primeMatches = EXPECTED_XXHASH64_PRIMES.map(
    (prime) => findAllOccurrences(bytes, bigintToLittleEndianBytes(prime)).length,
  );

  const findings: DriftFinding[] = [];
  addFinding(
    findings,
    placeholderMatches.length,
    "cch placeholder",
    "critical",
    `cch=${EXPECTED_CCH_PLACEHOLDER}`,
    "not found",
  );
  addFinding(findings, saltMatches.length, "cc_version salt", "critical", EXPECTED_CCH_SALT, "not found");

  if (mode === "standalone") {
    addFinding(
      findings,
      seedMatches.length,
      "native cch seed",
      "critical",
      `0x${EXPECTED_CCH_SEED.toString(16)}`,
      "not found",
    );
    for (const [index, count] of primeMatches.entries()) {
      addFinding(
        findings,
        count,
        `xxHash64 prime ${index + 1}`,
        "warning",
        `0x${EXPECTED_XXHASH64_PRIMES[index].toString(16)}`,
        "not found",
      );
    }
  }

  return {
    target,
    mode,
    findings,
    checked: {
      placeholder: placeholderMatches.length,
      salt: saltMatches.length,
      seed: seedMatches.length,
      primes: primeMatches,
    },
    passed: findings.length === 0,
  };
}
