/* =============================================================================
   Minimal QR encoder — byte mode, error-correction level L, versions 1–13.

   Why this exists: the obvious way to draw an enrolment QR is to hand the
   otpauth:// URI to a public chart-image service. That URI *contains the TOTP
   shared secret*, so doing it that way emails a third party the one value that
   makes 2FA worth having. This keeps it on the device.

   Implements ISO/IEC 18004: bit stream → Reed–Solomon over GF(256) → block
   interleave → module placement → mask selection by penalty score.
   ========================================================================== */

/* Data capacity in bytes, ECC level L, byte mode. Index = version. */
const CAPACITY_L = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425];

/* [ecCodewordsPerBlock, blocksG1, dataPerBlockG1, blocksG2, dataPerBlockG2] */
const BLOCKS_L = [
  null,
  [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
  [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
  [30, 2, 116, 0, 0], [18, 2, 68, 2, 69], [20, 4, 81, 0, 0], [24, 2, 92, 2, 93],
  [26, 4, 107, 0, 0],
];

const ALIGN = [
  [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
  [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
];

/* 15-bit format strings for ECC L, one per mask. */
const FORMAT_L = [
  0b111011111000100, 0b111001011110011, 0b111110110101010, 0b111100010011101,
  0b110011000101111, 0b110001100011000, 0b110110001000001, 0b110100101110110,
];

/* 18-bit version strings, versions 7–13. */
const VERSION_BITS = {
  7:  0b000111110010010100, 8:  0b001000010110111100, 9:  0b001001101010011001,
  10: 0b001010010011010011, 11: 0b001011101111110110, 12: 0b001100011101100010,
  13: 0b001101100001000111,
};

/* --- GF(256), primitive polynomial 0x11D ---------------------------------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree) {
  let poly = [1];

  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);

    // Multiply by (x + α^i). Coefficients are in descending degree, so the
    // ×x term keeps its index and the ×α^i term moves one place right —
    // swapping these two silently produces a valid-looking but wrong
    // generator, and every ECC codeword with it.
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }

    poly = next;
  }

  return poly;
}

function ecCodewords(data, count) {
  const gen = generatorPoly(count);
  const remainder = new Array(count).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);

    for (let i = 0; i < count; i++) {
      remainder[i] ^= mul(gen[i + 1], factor);
    }
  }

  return remainder;
}

/* --- Encoding ------------------------------------------------------------- */
function toBytes(text) {
  return Array.from(new TextEncoder().encode(text));
}

function pickVersion(byteLength) {
  for (let v = 1; v < CAPACITY_L.length; v++) {
    if (byteLength <= CAPACITY_L[v]) return v;
  }

  throw new Error('Payload is too long for a version-13 QR code.');
}

function buildCodewords(bytes, version) {
  const [ecPerBlock, blocksG1, dataG1, blocksG2, dataG2] = BLOCKS_L[version];
  const totalData = blocksG1 * dataG1 + blocksG2 * dataG2;

  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                                   // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);         // character count
  bytes.forEach((byte) => push(byte, 8));

  // Terminator, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }

  // Alternating pad bytes, per the spec.
  const PAD = [0xec, 0x11];
  while (data.length < totalData) data.push(PAD[(data.length - bits.length / 8) % 2]);

  // Split into blocks, compute ECC per block.
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let i = 0; i < blocksG1 + blocksG2; i++) {
    const size = i < blocksG1 ? dataG1 : dataG2;
    const block = data.slice(offset, offset + size);

    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(ecCodewords(block, ecPerBlock));
  }

  // Interleave: column-major across blocks.
  const result = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));

  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }

  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }

  return result;
}

/* --- Matrix --------------------------------------------------------------- */
function buildMatrix(codewords, version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFn = (r, c, value) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = value;
    reserved[r][c] = true;
  };

  // Finder patterns + separators.
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setFn(row + r, col + c, inner);
      }
    }
  };

  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the finder corners.
  const centres = ALIGN[version];

  for (const r of centres) {
    for (const c of centres) {
      const nearFinder = (r <= 8 && c <= 8)
        || (r <= 8 && c >= size - 9)
        || (r >= size - 9 && c <= 8);

      if (nearFinder) continue;

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFn(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Dark module + reserved format areas.
  setFn(size - 8, 8, true);

  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) setFn(8, i, false);
    if (modules[i][8] === null) setFn(i, 8, false);
  }

  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) setFn(8, size - 1 - i, false);
    if (modules[size - 1 - i][8] === null) setFn(size - 1 - i, 8, false);
  }

  // Version information (versions 7 and up).
  if (version >= 7) {
    const bits = VERSION_BITS[version];

    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      setFn(Math.floor(i / 3), size - 11 + (i % 3), bit);
      setFn(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }

  // Data, snaking upward in two-column strips, skipping the timing column.
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit === 1;
  };

  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;                       // the vertical timing pattern

    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;

      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (reserved[row][cc]) continue;
        modules[row][cc] = nextBit();
      }
    }

    upward = !upward;
  }

  return { modules, reserved, size };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(base, maskIndex) {
  const { modules, reserved, size } = base;
  const mask = MASKS[maskIndex];

  const out = modules.map((row, r) => row.map((value, c) =>
    (reserved[r][c] ? value : value !== mask(r, c))));

  // Format information for this mask.
  const bits = FORMAT_L[maskIndex];

  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> (14 - i)) & 1) === 1;

    // Top-left copy.
    if (i < 6)       out[8][i] = bit;
    else if (i < 8)  out[8][i + 1] = bit;
    else if (i === 8) out[7][8] = bit;
    else             out[14 - i][8] = bit;

    // Duplicate copy along the other two finders. The split is 7/8, not 8/7:
    // (size-8, 8) is the dark module, so the vertical run is only 7 long.
    if (i < 7) out[size - 1 - i][8] = bit;
    else       out[8][size - 15 + i] = bit;
  }

  out[size - 8][8] = true;   // dark module survives masking

  return out;
}

/** ISO 18004 §8.8.2 penalty score — lower is better. */
function penalty(matrix) {
  const size = matrix.length;
  let score = 0;

  const runScore = (line) => {
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    if (run >= 5) score += run - 2;
  };

  for (let i = 0; i < size; i++) {
    runScore(matrix[i]);
    runScore(matrix.map((row) => row[i]));
  }

  // 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Finder-like 1:1:3:1:1 sequences.
  const PATTERN = [true, false, true, true, true, false, true];

  const hasPattern = (line, start) => {
    for (let i = 0; i < 7; i++) if (line[start + i] !== PATTERN[i]) return false;

    const before = line.slice(Math.max(0, start - 4), start);
    const after = line.slice(start + 7, start + 11);

    return (before.length === 4 && before.every((v) => !v))
      || (after.length === 4 && after.every((v) => !v));
  };

  for (let i = 0; i < size; i++) {
    const row = matrix[i];
    const col = matrix.map((r) => r[i]);

    for (let j = 0; j + 7 <= size; j++) {
      if (hasPattern(row, j)) score += 40;
      if (hasPattern(col, j)) score += 40;
    }
  }

  // Global light/dark balance.
  const dark = matrix.flat().filter(Boolean).length;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` and return the QR as a boolean matrix (true = dark module).
 */
export function encode(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const base = buildMatrix(codewords, version);

  let best = null;
  let bestScore = Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, mask);
    const score = penalty(candidate);

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

/**
 * Render `text` as an SVG string. Always drawn dark-on-white with a 4-module
 * quiet zone — scanners expect that contrast regardless of the page theme.
 */
export function toSvg(text, { size = 190, quiet = 4 } = {}) {
  const matrix = encode(text);
  const count = matrix.length + quiet * 2;
  const rects = [];

  // Merge horizontal runs into single rects — far fewer nodes than one per module.
  matrix.forEach((row, r) => {
    let start = null;

    row.forEach((dark, c) => {
      if (dark && start === null) start = c;
      if ((!dark || c === row.length - 1) && start !== null) {
        const end = dark ? c + 1 : c;
        rects.push(`<rect x="${start + quiet}" y="${r + quiet}" width="${end - start}" height="1"/>`);
        start = null;
      }
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count} ${count}"
     width="${size}" height="${size}" shape-rendering="crispEdges"
     role="img" aria-label="QR code for enrolling your authenticator app">
  <rect width="${count}" height="${count}" fill="#ffffff"/>
  <g fill="#000000">${rects.join('')}</g>
</svg>`;
}
