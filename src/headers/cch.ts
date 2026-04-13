const MASK64 = 0xffff_ffff_ffff_ffffn;
const CCH_MASK = 0x0f_ffffn;
const PRIME1 = 0x9e37_79b1_85eb_ca87n;
const PRIME2 = 0xc2b2_ae3d_27d4_eb4fn;
const PRIME3 = 0x1656_67b1_9e37_79f9n;
const PRIME4 = 0x85eb_ca77_c2b2_ae63n;
const PRIME5 = 0x27d4_eb2f_1656_67c5n;
const CCH_FIELD_PREFIX = "cch=";

export const CCH_PLACEHOLDER = "00000";
export const CCH_SEED = 0x6e52_736a_c806_831en;

const encoder = new TextEncoder();

function toUint64(value: bigint): bigint {
    return value & MASK64;
}

function rotateLeft64(value: bigint, bits: number): bigint {
    const shift = BigInt(bits);
    return toUint64((value << shift) | (value >> (64n - shift)));
}

function readUint32LE(view: DataView, offset: number): bigint {
    return BigInt(view.getUint32(offset, true));
}

function readUint64LE(view: DataView, offset: number): bigint {
    return view.getBigUint64(offset, true);
}

function round64(acc: bigint, input: bigint): bigint {
    const mixed = toUint64(acc + toUint64(input * PRIME2));
    return toUint64(rotateLeft64(mixed, 31) * PRIME1);
}

function mergeRound64(acc: bigint, value: bigint): bigint {
    const mixed = acc ^ round64(0n, value);
    return toUint64(toUint64(mixed) * PRIME1 + PRIME4);
}

function avalanche64(hash: bigint): bigint {
    let mixed = hash ^ (hash >> 33n);
    mixed = toUint64(mixed * PRIME2);
    mixed ^= mixed >> 29n;
    mixed = toUint64(mixed * PRIME3);
    mixed ^= mixed >> 32n;
    return toUint64(mixed);
}

export function xxHash64(input: Uint8Array, seed: bigint = CCH_SEED): bigint {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const length = input.byteLength;
    let offset = 0;
    let hash: bigint;

    if (length >= 32) {
        let v1 = toUint64(seed + PRIME1 + PRIME2);
        let v2 = toUint64(seed + PRIME2);
        let v3 = toUint64(seed);
        let v4 = toUint64(seed - PRIME1);

        while (offset <= length - 32) {
            v1 = round64(v1, readUint64LE(view, offset));
            v2 = round64(v2, readUint64LE(view, offset + 8));
            v3 = round64(v3, readUint64LE(view, offset + 16));
            v4 = round64(v4, readUint64LE(view, offset + 24));
            offset += 32;
        }

        hash = toUint64(rotateLeft64(v1, 1) + rotateLeft64(v2, 7) + rotateLeft64(v3, 12) + rotateLeft64(v4, 18));
        hash = mergeRound64(hash, v1);
        hash = mergeRound64(hash, v2);
        hash = mergeRound64(hash, v3);
        hash = mergeRound64(hash, v4);
    } else {
        hash = toUint64(seed + PRIME5);
    }

    hash = toUint64(hash + BigInt(length));

    while (offset <= length - 8) {
        const lane = round64(0n, readUint64LE(view, offset));
        hash ^= lane;
        hash = toUint64(rotateLeft64(hash, 27) * PRIME1 + PRIME4);
        offset += 8;
    }

    if (offset <= length - 4) {
        hash ^= toUint64(readUint32LE(view, offset) * PRIME1);
        hash = toUint64(rotateLeft64(hash, 23) * PRIME2 + PRIME3);
        offset += 4;
    }

    while (offset < length) {
        hash ^= toUint64(BigInt(view.getUint8(offset)) * PRIME5);
        hash = toUint64(rotateLeft64(hash, 11) * PRIME1);
        offset += 1;
    }

    return avalanche64(hash);
}

export function computeNativeStyleCch(serializedBody: string): string {
    const hash = xxHash64(encoder.encode(serializedBody), CCH_SEED);
    return (hash & CCH_MASK).toString(16).padStart(5, "0");
}

export function replaceNativeStyleCch(serializedBody: string): string {
    const sentinel = `${CCH_FIELD_PREFIX}${CCH_PLACEHOLDER}`;
    const fieldIndex = serializedBody.indexOf(sentinel);
    if (fieldIndex === -1) {
        return serializedBody;
    }

    const valueStart = fieldIndex + CCH_FIELD_PREFIX.length;
    const valueEnd = valueStart + CCH_PLACEHOLDER.length;
    const cch = computeNativeStyleCch(serializedBody);
    return `${serializedBody.slice(0, valueStart)}${cch}${serializedBody.slice(valueEnd)}`;
}
