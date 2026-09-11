// RANDOMNESS, FROM THE PLATFORM'S CSPRNG.
//
// `Math.random()` is a fast PRNG with no security claim: V8 seeds it per context
// and its output is predictable from enough samples. Most uses in this console do
// not care — a demo animation, a playback jitter — but two of them mint
// IDENTIFIERS, and an identifier somebody can guess is a weak one the moment it is
// used to look anything up.
//
// Rather than split the codebase into "the random that matters" and "the random
// that does not" — a distinction the next reader has to re-derive at every call
// site, and get right — everything goes through `crypto.getRandomValues`. It is
// available in every browser and in Node, the cost at these call sites is
// unmeasurable, and it leaves one rule instead of a judgement.
//
// NO MODULO BIAS. `value % n` is only uniform when n divides the generator's range,
// and 256 % 10 is not 0 — so a naive byte-mod-10 draws 0–5 more often than 6–9.
// `randomInt` rejects the tail instead, which is the standard fix and the reason
// this is a shared function rather than an inline expression.

function bytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** A uniform integer in [0, max). */
export function randomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  if (max === 1) return 0;
  // The largest multiple of `max` that fits in a byte; anything at or above it is
  // redrawn, so every value below `max` is equally likely.
  const limit = Math.floor(256 / max) * max;
  for (;;) {
    const b = bytes(1)[0];
    if (b < limit) return b % max;
  }
}

/** A float in [0, 1), the shape `Math.random()` returns. */
export function randomFraction(): number {
  // 32 bits is more than enough for a jitter or a delay, and divides exactly.
  const [a, b, c, d] = bytes(4);
  // 2 ** 32 rather than a hex literal: this is "the number of values 32 bits can
  // hold", and that is what the expression should say.
  return ((a << 24) | (b << 16) | (c << 8) | d) / 2 ** 32 + 0.5;
}

/** A short opaque id — for a draft row or an editor block that needs to be told
 *  apart from its siblings before anything is saved. */
export function randomId(length = 10): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(bytes(length), (b) => alphabet[b % alphabet.length]).join("");
}

/** One character of a caller's alphabet, unbiased. */
export function randomFrom<T>(items: readonly T[]): T {
  return items[randomInt(items.length)];
}
