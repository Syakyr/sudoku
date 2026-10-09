/**
 * Deterministic pseudo-random numbers.
 *
 * Every generated puzzle must be reproducible from its seed on any device and any
 * browser, so nothing in the generation path may touch Math.random(), Date.now()
 * or anything else environment-dependent. All arithmetic here is 32-bit integer
 * arithmetic, which is exact in JS and therefore portable.
 */

/** xmur3 string hash -> 32-bit seed generator. */
export function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * sfc32 ("small fast counter" 32-bit) seeded from a string.
 * Long period (~2^128), good statistical quality, cheap.
 * Returns a function producing floats in [0, 1).
 */
export function createRng(seedString) {
  const h = hashSeed(String(seedString));
  let a = h();
  let b = h();
  let c = h();
  let d = h();
  for (let i = 0; i < 12; i++) next(); // discard initial output

  function next() {
    const t = (a + ((b ^ (c >>> 9)) | 0)) | 0;
    a = (b ^ (b << 3)) | 0;
    b = (c + ((c << 21) | (c >>> 11))) | 0;
    c = (c << 5) | (c >>> 27);
    const r = (d + 0x9e3779b9) | 0;
    d = r;
    return ((t + r) >>> 0) / 4294967296;
  }

  const rng = {
    /** float in [0,1) */
    float: next,
    /** integer in [0, n) */
    int(n) {
      return Math.floor(next() * n);
    },
    /** Fisher-Yates shuffle, in place, deterministic */
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
      return arr;
    },
    /** pick one element */
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    /** true with probability p */
    chance(p) {
      return next() < p;
    },
    /** next 32-bit integer, for deriving sub-seeds */
    uint32() {
      return Math.floor(next() * 4294967296) >>> 0;
    }
  };
  return rng;
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford-ish: no I,L,O,U

/** 32 bits -> 7 readable chars. */
export function encodeSeed(uint32) {
  let n = uint32 >>> 0;
  let s = '';
  for (let i = 0; i < 7; i++) {
    s = ALPHABET[n % 32] + s;
    n = Math.floor(n / 32);
  }
  return s;
}

/** 7 readable chars -> 32 bits. Throws on invalid characters. */
export function decodeSeed(str) {
  const clean = String(str).trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (clean.length !== 7) {
    throw new Error(`seed must be 7 characters, got "${str}"`);
  }
  let n = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid seed character "${ch}"`);
    n = n * 32 + v;
  }
  return n >>> 0;
}

/** A fresh, human-shareable seed derived from a caller-supplied entropy source. */
export function randomSeedString(entropy) {
  const e = entropy === undefined ? `${Date.now()}` : String(entropy);
  return encodeSeed(hashSeed(e)());
}
