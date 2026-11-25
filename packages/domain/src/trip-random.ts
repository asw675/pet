const UINT32_MAX = 0xffff_ffff;

/** Versioned, deterministic gameplay PRNG. Not suitable for security purposes. */
export function nextRandomUint32(state: number): number {
  if (!Number.isInteger(state) || state <= 0 || state > UINT32_MAX) {
    throw new RangeError('Random state must be a non-zero uint32');
  }

  let value = state;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}

/** Each call consumes one draw and uses modulo mapping. */
export function drawRandomInt(state: number, maxExclusive: number): {
  readonly state: number;
  readonly value: number;
} {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_MAX + 1) {
    throw new RangeError('Random bound must be an integer in [1, 2^32]');
  }
  const next = nextRandomUint32(state);
  return { state: next, value: next % maxExclusive };
}
