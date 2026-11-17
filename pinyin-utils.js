/**
 * Standard Hanyu Pinyin Tone-Mark Converter (`pinyin-utils.js`)
 *
 * Converts numbered Pinyin (`ping2 chang2`, `wei4 shen2 me5`, `kao3 lv4`, `lv3 xing2`, `yi1 dian3 r5`)
 * into standard tone-marked Hanyu Pinyin (`píng cháng`, `wèi shén me`, `kǎo lǜ`, `lǚ xíng`, `yī diǎn r`)
 * following official Mandarin vowel placement rules:
 *   1. `a` or `e` always takes the tone mark (`pai1` -> `pāi`, `mei2` -> `méi`, `lve4` -> `lüè`).
 *   2. In `ou`, `o` takes the tone mark (`kou3` -> `kǒu`, `dou4` -> `dòu`).
 *   3. Otherwise, the last vowel (`a, e, i, o, u, ü`) takes the tone mark (`liu2` -> `liú`, `shui4` -> `shuì`).
 *   4. `u:` and `v` normalize to `ü` (and after `j`, `q`, `x`, `y` normalize to `u` per standard orthography).
 *   5. Neutral tone `5` or `0` removes the digit cleanly with no diacritic (`de5` -> `de`).
 */

const TONE_VOWEL_MAP = {
  a: ['ā', 'á', 'ǎ', 'à'],
  A: ['Ā', 'Á', 'Ǎ', 'À'],
  e: ['ē', 'é', 'ě', 'è'],
  E: ['Ē', 'É', 'Ě', 'È'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  I: ['Ī', 'Í', 'Ǐ', 'Ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  O: ['Ō', 'Ó', 'Ǒ', 'Ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  U: ['Ū', 'Ú', 'Ǔ', 'Ù'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
  Ü: ['Ǖ', 'Ǘ', 'Ǚ', 'Ǜ']
};

const NASAL_TONE_MAP = {
  m: [null, 'ḿ', null, null],
  M: [null, 'Ḿ', null, null],
  n: ['n̄', 'ń', 'ň', 'ǹ'],
  N: ['N̄', 'Ń', 'Ň', 'Ǹ']
};

function applyToneToSyllable(rawLetters, toneNum) {
  let s = String(rawLetters || '')
    .replace(/u:/g, 'ü')
    .replace(/U:/g, 'Ü')
    .replace(/v/g, 'ü')
    .replace(/V/g, 'Ü');

  // In standard Hanyu Pinyin, ü after j, q, x, y is written without the umlaut (`ju`, `qu`, `xu`, `yu`)
  s = s.replace(/^([jqxy])ü/i, (_, init) => init + (s[1] === 'Ü' ? 'U' : 'u'));

  if (toneNum < 1 || toneNum > 4) {
    return s; // Neutral tone (0 or 5): strip number cleanly
  }

  const lower = s.toLowerCase();
  let targetIdx = -1;

  const aIdx = lower.indexOf('a');
  const eIdx = lower.indexOf('e');
  const ouIdx = lower.indexOf('ou');

  if (aIdx !== -1) {
    targetIdx = aIdx;
  } else if (eIdx !== -1) {
    targetIdx = eIdx;
  } else if (ouIdx !== -1) {
    targetIdx = ouIdx;
  } else {
    for (let i = s.length - 1; i >= 0; i--) {
      if ('aeiouüAEIOUÜ'.includes(s[i])) {
        targetIdx = i;
        break;
      }
    }
  }

  if (targetIdx !== -1) {
    const ch = s[targetIdx];
    const table = TONE_VOWEL_MAP[ch];
    if (table && table[toneNum - 1]) {
      return s.slice(0, targetIdx) + table[toneNum - 1] + s.slice(targetIdx + 1);
    }
  }

  // Fallback for rare syllabic nasals (`m2` -> `ḿ`, `n2`/`n3`/`n4`, `ng2`/`ng3`/`ng4`)
  for (let i = 0; i < s.length; i++) {
    const table = NASAL_TONE_MAP[s[i]];
    if (table && table[toneNum - 1]) {
      return s.slice(0, i) + table[toneNum - 1] + s.slice(i + 1);
    }
  }

  return s;
}

const PINYIN_SYLLABLE_WITH_TONE_RE =
  /((?:zh|ch|sh|[bpmfdtnlgkhjqxzcsryw])?(?:u:|[aeiouvü]){1,3}(?:ng|n)?r?|h?(?:ng|m|n)|r)([0-5])(?![0-9])/gi;

/**
 * Converts any numbered Pinyin syllables inside `input` to standard tone-marked Pinyin,
 * while preserving spacing, capitalization, punctuation, and already-marked Pinyin.
 */
export function numberedPinyinToToneMarks(input = '') {
  if (input === null || input === undefined) return '';
  const str = String(input);
  if (!str) return '';

  return str.replace(PINYIN_SYLLABLE_WITH_TONE_RE, (_, letters, digit) => {
    return applyToneToSyllable(letters, Number(digit));
  });
}

/**
 * Returns true if converting `input` changes any numbered Pinyin into tone marks.
 */
export function hasNumberedPinyin(input = '') {
  const raw = String(input || '');
  if (!/[0-5]/.test(raw)) return false;
  return numberedPinyinToToneMarks(raw) !== raw;
}
