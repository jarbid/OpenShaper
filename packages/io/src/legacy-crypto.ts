/**
 * Self-contained, dependency-free crypto for decrypting legacy encrypted
 * BoardCAD `.brd` files.
 *
 * Encrypted `.brd` files use Java's `PBEWithMD5AndDES` (PKCS#5 v1.5 PBES1):
 *   - Key derivation: PBKDF1 with MD5 (T1 = MD5(password ‖ salt); Ti = MD5(Ti-1)).
 *     The 16-byte derived block splits into an 8-byte DES key + 8-byte IV.
 *   - Cipher: single DES in CBC mode with PKCS#5 padding.
 *
 * The exact parameters (password, salt, iteration count, 12-byte header skip)
 * are taken verbatim from the legacy reader
 *   ../boardcad-le/src/board/readers/BrdReader.java  (lines 39–113)
 *
 * Why hand-rolled? DES is absent from the browser WebCrypto API and is disabled
 * by default in modern OpenSSL 3 / Node, so neither `node:crypto` nor
 * `crypto.subtle` can perform this decryption. This module is pure TypeScript
 * (Uint8Array only) so it runs identically in the browser and in Node tests,
 * keeping `@openshaper/io` dependency-free.
 *
 * Scope: decryption only (the app never writes encrypted files).
 */

// ===========================================================================
// MD5  (RFC 1321)
// ===========================================================================

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const rotl32 = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

/** Compute the MD5 digest (16 bytes) of `input`. */
export const md5 = (input: Uint8Array): Uint8Array => {
  const len = input.length;
  // Padded length: message + 0x80 + zeros to 56 mod 64 + 8-byte length.
  const paddedLen = ((len + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(input);
  buf[len] = 0x80;
  // Append original length in BITS, little-endian (only the low 32 bits matter
  // for the message sizes we handle).
  const bitLenLo = (len << 3) >>> 0;
  const bitLenHi = Math.floor(len / 0x20000000) & 0xffffffff;
  buf[paddedLen - 8] = bitLenLo & 0xff;
  buf[paddedLen - 7] = (bitLenLo >>> 8) & 0xff;
  buf[paddedLen - 6] = (bitLenLo >>> 16) & 0xff;
  buf[paddedLen - 5] = (bitLenLo >>> 24) & 0xff;
  buf[paddedLen - 4] = bitLenHi & 0xff;
  buf[paddedLen - 3] = (bitLenHi >>> 8) & 0xff;
  buf[paddedLen - 2] = (bitLenHi >>> 16) & 0xff;
  buf[paddedLen - 1] = (bitLenHi >>> 24) & 0xff;

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Int32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      m[i] = buf[j]! | (buf[j + 1]! << 8) | (buf[j + 2]! << 16) | (buf[j + 3]! << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      f = (f + a + MD5_K[i]! + m[g]!) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(f, MD5_S[i]!)) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i]! & 0xff;
    out[i * 4 + 1] = (words[i]! >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i]! >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i]! >>> 24) & 0xff;
  }
  return out;
};

// ===========================================================================
// DES  (FIPS 46-3) — decryption of a single 64-bit block, plus CBC wrapper.
//
// Implemented over 64-element bit arrays (MSB-first) for clarity and to match
// the published permutation tables directly.
// ===========================================================================

// prettier-ignore
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];

// prettier-ignore
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];

// prettier-ignore
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];

// prettier-ignore
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];

// prettier-ignore
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
  16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];

// prettier-ignore
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];

// prettier-ignore
const S_BOXES = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

/** Expand 8 bytes (MSB-first) into a 64-element bit array. */
const bytesToBits = (bytes: Uint8Array): number[] => {
  const bits: number[] = new Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    for (let b = 0; b < 8; b++) {
      bits[i * 8 + b] = (byte >>> (7 - b)) & 1;
    }
  }
  return bits;
};

/** Pack a bit array (MSB-first) back into bytes. */
const bitsToBytes = (bits: number[]): Uint8Array => {
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) {
      byte = (byte << 1) | bits[i * 8 + b]!;
    }
    out[i] = byte;
  }
  return out;
};

const permute = (bits: number[], table: number[]): number[] => table.map((pos) => bits[pos - 1]!);

/** Derive the 16 DES round subkeys (each 48 bits) from an 8-byte key. */
const desKeySchedule = (key: Uint8Array): number[][] => {
  const keyBits = bytesToBits(key);
  const permuted = permute(keyBits, PC1); // 56 bits
  let c = permuted.slice(0, 28);
  let d = permuted.slice(28, 56);

  const subkeys: number[][] = [];
  for (let round = 0; round < 16; round++) {
    const s = SHIFTS[round]!;
    c = c.slice(s).concat(c.slice(0, s));
    d = d.slice(s).concat(d.slice(0, s));
    subkeys.push(permute(c.concat(d), PC2));
  }
  return subkeys;
};

/** The DES Feistel f-function: 32-bit half + 48-bit subkey → 32-bit output. */
const feistel = (right: number[], subkey: number[]): number[] => {
  const expanded = permute(right, E); // 48 bits
  const xored = expanded.map((bit, i) => bit ^ subkey[i]!);

  // 8 S-boxes, each consuming 6 bits → 4 bits.
  const sboxOut: number[] = new Array(32);
  for (let i = 0; i < 8; i++) {
    const off = i * 6;
    const b0 = xored[off]!;
    const b5 = xored[off + 5]!;
    const row = (b0 << 1) | b5;
    const col =
      (xored[off + 1]! << 3) | (xored[off + 2]! << 2) | (xored[off + 3]! << 1) | xored[off + 4]!;
    const val = S_BOXES[i]![row * 16 + col]!;
    sboxOut[i * 4] = (val >>> 3) & 1;
    sboxOut[i * 4 + 1] = (val >>> 2) & 1;
    sboxOut[i * 4 + 2] = (val >>> 1) & 1;
    sboxOut[i * 4 + 3] = val & 1;
  }
  return permute(sboxOut, P);
};

/** Decrypt one 8-byte block given the precomputed (encryption-order) subkeys. */
const desDecryptBlock = (block: Uint8Array, subkeys: number[][]): Uint8Array => {
  const bits = permute(bytesToBits(block), IP);
  let left = bits.slice(0, 32);
  let right = bits.slice(32, 64);

  // Decryption applies subkeys in reverse order.
  for (let round = 15; round >= 0; round--) {
    const f = feistel(right, subkeys[round]!);
    const newRight = left.map((bit, i) => bit ^ f[i]!);
    left = right;
    right = newRight;
  }

  // Note the pre-output swap: combine as (right ‖ left).
  return bitsToBytes(permute(right.concat(left), FP));
};

/**
 * DES-CBC decrypt with PKCS#5 padding removal.
 * @throws if ciphertext length is not a positive multiple of 8 or padding is invalid.
 */
export const desCbcDecrypt = (cipher: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array => {
  if (cipher.length === 0 || cipher.length % 8 !== 0) {
    throw new Error(
      `DES-CBC ciphertext length must be a positive multiple of 8 (got ${cipher.length})`,
    );
  }
  const subkeys = desKeySchedule(key);
  const out = new Uint8Array(cipher.length);
  let prev = iv;
  for (let off = 0; off < cipher.length; off += 8) {
    const block = cipher.subarray(off, off + 8);
    const decrypted = desDecryptBlock(block, subkeys);
    for (let i = 0; i < 8; i++) out[off + i] = decrypted[i]! ^ prev[i]!;
    prev = block;
  }

  // Strip PKCS#5 padding.
  const pad = out[out.length - 1]!;
  if (pad < 1 || pad > 8) {
    throw new Error(`Invalid PKCS#5 padding byte: ${pad}`);
  }
  return out.subarray(0, out.length - pad);
};

// ===========================================================================
// PBKDF1 (MD5) — Java PBEWithMD5AndDES key/iv derivation
// ===========================================================================

/**
 * PBKDF1 with MD5: returns the first `dkLen` bytes of the iterated digest.
 * For PBEWithMD5AndDES, dkLen=16 → key = result[0..8), iv = result[8..16).
 */
export const pbkdf1Md5 = (
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen = 16,
): Uint8Array => {
  let t = md5(concat(password, salt));
  for (let i = 1; i < iterations; i++) {
    t = md5(t);
  }
  return t.subarray(0, dkLen);
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

// ===========================================================================
// BoardCAD encrypted .brd orchestration
// (../boardcad-le/src/board/readers/BrdReader.java lines 39–113)
// ===========================================================================

/** Fixed PBE salt used by BoardCAD (BrdReader.java line 90). */
const BRD_SALT = new Uint8Array([-57, 115, 33, -116, 126, -56, -18, -103].map((b) => b & 0xff));
/** Fixed iteration count (BrdReader.java line 91). */
const BRD_ITERATIONS = 20;
/** Number of leading bytes skipped before the ciphertext (BrdReader.java lines 97–98). */
const BRD_HEADER_SKIP = 12;

const MAGIC_102 = '%BRD-1.02';
const MAGIC_101 = '%BRD-1.01';

const PASSWORD_102 = 'deltaXTaildeltaXMiddle';
const PASSWORD_101 = 'deltaXTail';

/** Encode an ASCII/latin1 string to bytes (PBES1 passwords are 8-bit). */
const latin1ToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const latin1Decode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

/**
 * True if `bytes` begins with an encrypted-`.brd` magic header (`%BRD-1.01`/`1.02`).
 */
export const isEncryptedBrd = (bytes: Uint8Array): boolean => {
  const head = latin1Decode(bytes.subarray(0, 9));
  return head === MAGIC_101 || head === MAGIC_102;
};

/**
 * Decrypt an encrypted BoardCAD `.brd` byte buffer to its plain-text `.brd`
 * content. The caller should first confirm `isEncryptedBrd(bytes)`.
 *
 * @throws if the magic header is unrecognised or decryption fails.
 */
export const decryptBrd = (bytes: Uint8Array): string => {
  const head = latin1Decode(bytes.subarray(0, 9));
  let password: string;
  if (head === MAGIC_102) password = PASSWORD_102;
  else if (head === MAGIC_101) password = PASSWORD_101;
  else throw new Error(`Not an encrypted .brd file (header: ${JSON.stringify(head)})`);

  const dk = pbkdf1Md5(latin1ToBytes(password), BRD_SALT, BRD_ITERATIONS, 16);
  const key = dk.subarray(0, 8);
  const iv = dk.subarray(8, 16);
  const cipher = bytes.subarray(BRD_HEADER_SKIP);
  const plain = desCbcDecrypt(cipher, key, iv);
  return latin1Decode(plain);
};
