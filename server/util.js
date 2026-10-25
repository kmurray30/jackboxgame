export function makeRng(seed) {
  // Mulberry32 — deterministic rng for tests. Returns a function in [0,1).
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function pick(arr, rng = Math.random) {
  return arr[Math.floor(rng() * arr.length)];
}

export function randomId(rng = Math.random, len = 16) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
}

// Remove control characters and zero-width junk, collapse whitespace, trim, cap length.
// Characters we strip from user text: C0/C1 controls, zero-width and bidi marks, line/paragraph separators, BOM.
const JUNK_RANGES = [
  [0x0000, 0x0008], [0x000b, 0x001f], [0x007f, 0x009f],
  [0x200b, 0x200f], [0x2028, 0x202f], [0x2060, 0x206f], [0xfeff, 0xfeff],
];
const JUNK_RE = new RegExp(
  "[" + JUNK_RANGES.map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]",
  "g",
);

// Remove control characters and zero-width junk, collapse whitespace, trim, cap length.
export function cleanText(input, maxLen) {
  if (typeof input !== "string") return "";
  let s = input.replace(JUNK_RE, "").replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = Array.from(s).slice(0, maxLen).join("").trim();
  return s;
}

export function cleanName(input) {
  return cleanText(input, 12);
}

export function normalizeForCompare(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Did the answer use the plant word? Case-insensitive, whole word, allows simple plurals.
export function usedPlantWord(text, word) {
  if (!text || !word) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}(s|es)?(?=$|[^\\p{L}\\p{N}])`, "iu");
  return re.test(text);
}

export function fillName(template, name) {
  return template.replaceAll("{name}", name);
}
