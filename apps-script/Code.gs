/**
 * Taiwanese Mandarin Voice Tutor — Google Sheets + Apps Script Backend (Code.gs)
 *
 * Features:
 * 1. Auto-initializes 3 tabs (`Vocab`, `ReviewLog`, `Settings`) with clean formatting.
 * 2. Authenticates requests from the GitHub Pages PWA using a personal `BACKEND_SECRET`
 *    stored in Script Properties (or the `Settings` sheet).
 * 3. Parses & deduplicates Hanping Chinese Dictionary CSV/TSV exports (and Anki TSV exports).
 * 4. Fetches & caches the official Taiwan NAER / TOCFL dataset from `PSeitz/tocfl`
 *    (`https://raw.githubusercontent.com/PSeitz/tocfl/master/tocfl_words.json`),
 *    selecting new words by target TOCFL level sorted by `spoken_per_million` descending.
 * 5. Builds deterministic 20-word practice batches (default 90% due FSRS reviews + 10% new words,
 *    automatically back-filling with new words when fewer reviews are due).
 * 6. Calls `gemini-3.8-flash` (with automatic fallback to `gemini-3.5-flash-lite` / `gemini-2.5-flash`)
 *    in a single structured-JSON batch request to generate natural English translation prompts
 *    and back-fill missing English glosses for TOCFL words.
 * 7. Implements the FSRS v5 spaced repetition algorithm and Hybrid 1-4 deterministic rubric.
 * 8. Mints short-lived Gemini Live API ephemeral tokens (`v1alpha/authTokens`) or returns the
 *    configured Live credentials to the authenticated client.
 */

const TAB_VOCAB = 'Vocab';
const TAB_LOG = 'ReviewLog';
const TAB_SETTINGS = 'Settings';

const TOCFL_JSONL_URL = 'https://raw.githubusercontent.com/PSeitz/tocfl/master/tocfl_words.json';

const VOCAB_HEADERS = [
  'id',
  'traditional',
  'simplified',
  'pinyin',
  'zhuyin',
  'english_gloss',
  'source',
  'tocfl_level',
  'spoken_freq',
  'written_freq',
  'status',
  'stability',
  'difficulty',
  'due_date',
  'last_review',
  'reps',
  'lapses',
  'last_score',
  'english_prompt',
  'last_notes',
  'mandarin_sentence',
  'common_synonyms'
];

const LOG_HEADERS = [
  'timestamp',
  'word_id',
  'traditional',
  'pinyin',
  'score',
  'target_word_recalled',
  'needed_hint',
  'pronunciation_attempts',
  'grammar_errors',
  'conversation_fluency',
  'stability_before',
  'stability_after',
  'difficulty_after',
  'interval_days',
  'english_prompt',
  'notes',
  'mandarin_sentence'
];

const DEFAULT_SETTINGS = {
  BATCH_SIZE: '20',
  NEW_WORD_RATIO: '0.10',
  TOCFL_LEVEL: '2',
  LIVE_MODEL: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
  LIVE_FALLBACK_MODEL: 'models/gemini-3.8-live',
  BATCH_GEN_MODEL: 'gemini-3.5-flash-lite',
  VOICE_NAME: 'Aoede',
  DESIRED_RETENTION: '0.90'
};

/**
 * Adds a custom menu in the Google Sheet for one-click setup, TOCFL syncing, and Mandarin -> English sentence pre-generation.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Mandarin Tutor')
    .addItem('Initialize / Verify Sheet Tabs', 'setupSheet')
    .addItem('Generate Missing Mandarin -> English Sentences (Fast / Resume)', 'menuPregenerateMissingPrompts')
    .addItem('Regenerate All Mandarin -> English Sentences (Refresh All)', 'menuPregeneratePrompts')
    .addItem('Pull 50 Words from PSeitz/tocfl (Target Level)', 'menuPullTocflWords')
    .addToUi();
}

/**
 * Initializes the 3 tabs (`Vocab`, `ReviewLog`, `Settings`) if they don't exist,
 * upgrades `Vocab` headers in-place (`english_prompt`, `mandarin_sentence`),
 * and migrates retired Gemini 2.5 batch model IDs to `gemini-3.5-flash-lite`.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let vocabSheet = ss.getSheetByName(TAB_VOCAB);
  if (!vocabSheet) {
    vocabSheet = ss.insertSheet(TAB_VOCAB);
    vocabSheet.appendRow(VOCAB_HEADERS);
    vocabSheet.getRange(1, 1, 1, VOCAB_HEADERS.length).setFontWeight('bold').setBackground('#f3f4f6');
    vocabSheet.setFrozenRows(1);
  } else {
    const existingCols = Math.max(vocabSheet.getLastColumn(), VOCAB_HEADERS.length);
    const currentHeaders = vocabSheet.getRange(1, 1, 1, existingCols).getValues()[0];
    if (
      vocabSheet.getLastColumn() < VOCAB_HEADERS.length ||
      String(currentHeaders[18] || '').trim() !== 'english_prompt' ||
      String(currentHeaders[20] || '').trim() !== 'mandarin_sentence'
    ) {
      vocabSheet.getRange(1, 1, 1, VOCAB_HEADERS.length).setValues([VOCAB_HEADERS]).setFontWeight('bold').setBackground('#f3f4f6');
    }
  }

  let logSheet = ss.getSheetByName(TAB_LOG);
  if (!logSheet) {
    logSheet = ss.insertSheet(TAB_LOG);
    logSheet.appendRow(LOG_HEADERS);
    logSheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold').setBackground('#f3f4f6');
    logSheet.setFrozenRows(1);
  } else if (logSheet.getLastColumn() < LOG_HEADERS.length) {
    logSheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold').setBackground('#f3f4f6');
  }

  let settingsSheet = ss.getSheetByName(TAB_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(TAB_SETTINGS);
    settingsSheet.appendRow(['key', 'value', 'description']);
    settingsSheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#f3f4f6');
    const descriptions = {
      BATCH_SIZE: 'Number of words per practice session batch (default: 20)',
      NEW_WORD_RATIO: 'Target fraction of new words per batch (0.10 = 10%, fills up with new words if fewer reviews are due)',
      TOCFL_LEVEL: 'TOCFL level (1 to 7) to pull supplemental words from PSeitz/tocfl',
      LIVE_MODEL: 'Primary Gemini Live native audio WebSocket model ID',
      LIVE_FALLBACK_MODEL: 'Fallback Gemini Live model ID (e.g. models/gemini-3.8-live)',
      BATCH_GEN_MODEL: 'Fast Gemini text model for Mandarin -> English sentences (auto-discovers gemini-3.5-flash-lite / gemini-3.8-flash)',
      VOICE_NAME: 'Gemini Live voice (Aoede, Kore, Puck, Charon, Fenrir)',
      DESIRED_RETENTION: 'Target FSRS memory retention probability (default 0.90)'
    };
    Object.keys(DEFAULT_SETTINGS).forEach(function(k) {
      settingsSheet.appendRow([k, DEFAULT_SETTINGS[k], descriptions[k] || '']);
    });
    settingsSheet.setFrozenRows(1);
  } else {
    // Auto-migrate retired Gemini 2.0 / 2.5 batch models (which return HTTP 404 since Oct 2026) to gemini-3.5-flash-lite
    const sRows = settingsSheet.getDataRange().getValues();
    for (let i = 1; i < sRows.length; i++) {
      const k = String(sRows[i][0] || '').trim();
      const v = String(sRows[i][1] || '').replace(/^models\//, '').trim();
      if (k === 'BATCH_GEN_MODEL' && (!v || v.indexOf('gemini-2.') === 0 || v.indexOf('gemini-1.') === 0)) {
        settingsSheet.getRange(i + 1, 2).setValue('gemini-3.5-flash-lite');
      }
      if (k === 'LIVE_FALLBACK_MODEL' && v.indexOf('gemini-2.5-flash-native-audio-latest') === 0) {
        settingsSheet.getRange(i + 1, 2).setValue('models/gemini-3.8-live');
      }
    }
  }

  return { ok: true, message: 'Sheets initialized.' };
}

/**
 * Simple health check / status endpoint for GET requests.
 */
function doGet(e) {
  return jsonResponse({
    ok: true,
    service: 'Taiwanese Mandarin Voice Tutor API',
    timestamp: new Date().toISOString()
  });
}

/**
 * Main POST RPC handler.
 * Expects `Content-Type: text/plain;charset=utf-8` containing a JSON payload so browsers
 * do not trigger a CORS OPTIONS preflight that Apps Script doesn't answer.
 */
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const body = JSON.parse(raw);

    verifySecret_(body.secret);
    setupSheet();

    const action = body.action || '';
    switch (action) {
      case 'ping':
        return jsonResponse(handlePing_());

      case 'get_batch':
        return jsonResponse(handleGetBatch_(body));

      case 'record_review':
        return jsonResponse(handleRecordReview_(body));

      case 'word_action':
        return jsonResponse(handleWordAction_(body));

      case 'import_hanping':
        return jsonResponse(handleImportHanping_(body));

      case 'supplement_tocfl':
        return jsonResponse(handleSupplementTocfl_(body));

      case 'pregenerate_prompts':
        return jsonResponse(handlePregeneratePrompts_(body));

      case 'update_settings':
        return jsonResponse(handleUpdateSettings_(body));

      default:
        return jsonResponse({ ok: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Verifies the personal secret token against Script Properties (`BACKEND_SECRET`).
 */
function verifySecret_(clientSecret) {
  const props = PropertiesService.getScriptProperties();
  const expected = props.getProperty('BACKEND_SECRET');
  if (!expected) {
    throw new Error('BACKEND_SECRET is not set in Apps Script Project Settings -> Script Properties.');
  }
  if (!clientSecret || String(clientSecret).trim() !== String(expected).trim()) {
    throw new Error('Unauthorized: invalid backend secret.');
  }
}

function getGeminiApiKey_() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set in Apps Script Project Settings -> Script Properties.');
  }
  return key.trim();
}

/**
 * Reads settings from the `Settings` sheet, merging with DEFAULT_SETTINGS.
 */
function getSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_SETTINGS);
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (!sheet) return out;

  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const k = String(rows[i][0] || '').trim();
    const v = String(rows[i][1] !== undefined ? rows[i][1] : '').trim();
    if (k) out[k] = v;
  }
  return out;
}

function handleUpdateSettings_(body) {
  const updates = body.settings || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_SETTINGS);
  const rows = sheet.getDataRange().getValues();
  const keyRowMap = {};
  for (let i = 1; i < rows.length; i++) {
    keyRowMap[String(rows[i][0]).trim()] = i + 1;
  }
  Object.keys(updates).forEach(function(k) {
    if (keyRowMap[k]) {
      sheet.getRange(keyRowMap[k], 2).setValue(String(updates[k]));
    } else {
      sheet.appendRow([k, String(updates[k]), '']);
    }
  });
  return { ok: true, settings: getSettings_() };
}

/**
 * Reads all rows from `Vocab` sheet as structured objects with their 1-based sheet row index,
 * normalizing `english_prompt` (or legacy `last_prompt`) and `mandarin_sentence` (or legacy `sample_mandarin`).
 */
function readAllVocab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_VOCAB);
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = data[0].map(function(h) { return String(h).trim(); });
  const list = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[1]) continue; // skip blank traditional
    const obj = { _rowIndex: i + 1 };
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = row[c];
    }
    // Normalize both new and legacy header names seamlessly
    const enPrompt = String(obj.english_prompt || obj.last_prompt || row[18] || '').trim();
    const zhSent = String(obj.mandarin_sentence || obj.sample_mandarin || row[20] || '').trim();
    obj.english_prompt = enPrompt;
    obj.last_prompt = enPrompt;
    obj.mandarin_sentence = zhSent;
    obj.sample_mandarin = zhSent;
    list.push(obj);
  }
  return list;
}

/**
 * Returns deck statistics and current settings.
 */
function handlePing_() {
  const vocab = readAllVocab_();
  const now = new Date();
  let dueCount = 0;
  let newCount = 0;
  let learnedCount = 0;
  let hanpingCount = 0;
  let tocflCount = 0;

  vocab.forEach(function(w) {
    const status = String(w.status || 'new').toLowerCase();
    if (status === 'flagged') return;
    const src = String(w.source).toLowerCase();
    if (src === 'hanping' || src === 'ankidroid') hanpingCount++;
    if (src === 'tocfl') tocflCount++;

    if (status === 'new' || !w.reps || Number(w.reps) === 0) {
      newCount++;
    } else {
      learnedCount++;
      const due = w.due_date ? new Date(w.due_date) : new Date(0);
      if (due <= now) dueCount++;
    }
  });

  return {
    ok: true,
    stats: {
      total: vocab.length,
      dueCount: dueCount,
      newCount: newCount,
      learnedCount: learnedCount,
      hanpingCount: hanpingCount,
      tocflCount: tocflCount
    },
    settings: getSettings_()
  };
}

/**
 * Builds the 20-word batch:
 * - Target 10% new words (e.g., 2 new words, 18 due reviews for a batch of 20).
 * - If fewer than 18 reviews are due, fills the remaining slots with new words!
 * - If the sheet doesn't have enough `new` words to fill those new-word slots,
 *   automatically pulls supplemental words from `PSeitz/tocfl` at `settings.TOCFL_LEVEL`
 *   sorted by `spoken_per_million` descending!
 * - Reads pre-generated `mandarin_sentence` + `english_prompt` directly from the Sheet
 *   (and back-fills on the fly only if any row is missing either sentence).
 */
function handleGetBatch_(body) {
  const settings = getSettings_();
  const batchSize = Number(body.batchSize || settings.BATCH_SIZE || 20);
  const newRatio = Number(body.newWordRatio !== undefined ? body.newWordRatio : (settings.NEW_WORD_RATIO || 0.10));
  const tocflLevel = Number(body.tocflLevel || settings.TOCFL_LEVEL || 2);

  let vocab = readAllVocab_();
  const now = new Date();

  const duePool = [];
  const newHanpingPool = [];
  const newTocflPool = [];

  vocab.forEach(function(w) {
    const status = String(w.status || 'new').toLowerCase();
    if (status === 'flagged') return;

    const isNew = (status === 'new' || !w.reps || Number(w.reps) === 0);
    if (isNew) {
      const src = String(w.source).toLowerCase();
      if (src === 'hanping' || src === 'ankidroid') {
        newHanpingPool.push(w);
      } else {
        newTocflPool.push(w);
      }
    } else {
      const due = w.due_date ? new Date(w.due_date) : new Date(0);
      if (due <= now) {
        duePool.push(w);
      }
    }
  });

  // Sort due reviews by most overdue first
  duePool.sort(function(a, b) {
    const da = a.due_date ? new Date(a.due_date).getTime() : 0;
    const db = b.due_date ? new Date(b.due_date).getTime() : 0;
    return da - db;
  });

  // Sort new TOCFL words by spoken frequency descending
  newTocflPool.sort(function(a, b) {
    return (Number(b.spoken_freq) || 0) - (Number(a.spoken_freq) || 0);
  });

  const targetNewMin = Math.max(1, Math.round(batchSize * newRatio));
  const maxDueSlots = Math.max(0, batchSize - targetNewMin);

  const selectedDue = duePool.slice(0, maxDueSlots);
  const neededNewCount = batchSize - selectedDue.length;

  let combinedNewPool = newHanpingPool.concat(newTocflPool);
  let autoSupplemented = 0;

  // If we need more new words than currently in the Sheet, auto-supplement from PSeitz/tocfl!
  if (combinedNewPool.length < neededNewCount) {
    const deficit = neededNewCount - combinedNewPool.length;
    const pullRes = supplementFromTocflInternal_(tocflLevel, Math.max(deficit, 25));
    autoSupplemented = pullRes.addedCount;
    vocab = readAllVocab_();
    combinedNewPool = [];
    vocab.forEach(function(w) {
      const status = String(w.status || 'new').toLowerCase();
      if (status === 'new' || !w.reps || Number(w.reps) === 0) {
        combinedNewPool.push(w);
      }
    });
    combinedNewPool.sort(function(a, b) {
      const srcA = String(a.source).toLowerCase();
      const srcB = String(b.source).toLowerCase();
      const sa = (srcA === 'hanping' || srcA === 'ankidroid') ? 1 : 0;
      const sb = (srcB === 'hanping' || srcB === 'ankidroid') ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (Number(b.spoken_freq) || 0) - (Number(a.spoken_freq) || 0);
    });
  }

  const selectedNew = combinedNewPool.slice(0, neededNewCount);

  // Interleave due and new words smoothly so new words are spread across the drive
  const batchWords = interleaveDueAndNew_(selectedDue, selectedNew);

  // Back-fill on the fly if any word in this 20-word batch is missing EITHER `english_prompt` OR `mandarin_sentence`
  const missingPromptWords = batchWords.filter(function(w) {
    return !String(w.english_prompt || '').trim() || !String(w.mandarin_sentence || '').trim();
  });
  let fallbackGeneratedMap = {};
  if (missingPromptWords.length > 0) {
    fallbackGeneratedMap = populateSheetPromptsForWords_(missingPromptWords, settings, {
      maxExecutionMs: 35000
    }).generatedMap;
  }

  const enrichedBatch = batchWords.map(function(w) {
    const gen = fallbackGeneratedMap[w.traditional] || {};
    const englishPrompt = String(gen.english_sentence || w.english_prompt || ('Please make a sentence using ' + w.traditional + '.')).trim();
    const mandarinSentence = String(gen.mandarin_sentence || w.mandarin_sentence || '').trim();
    const englishGloss = String(w.english_gloss || gen.english_gloss || '').trim();
    const synonymsNote = String(gen.common_synonyms || w.common_synonyms || '').trim();

    return {
      id: w.id,
      rowIndex: w._rowIndex,
      traditional: w.traditional,
      simplified: w.simplified || '',
      pinyin: w.pinyin || '',
      zhuyin: w.zhuyin || '',
      english_gloss: englishGloss,
      source: w.source || 'ankidroid',
      tocfl_level: w.tocfl_level || '',
      spoken_freq: Number(w.spoken_freq || 0),
      status: w.status || 'new',
      stability: Number(w.stability || 0),
      difficulty: Number(w.difficulty || 0),
      reps: Number(w.reps || 0),
      lapses: Number(w.lapses || 0),
      english_prompt: englishPrompt,
      mandarin_sentence: mandarinSentence,
      sample_mandarin: mandarinSentence,
      common_synonyms: synonymsNote
    };
  });

  const liveAuth = getLiveSessionAuth_(settings);

  return {
    ok: true,
    batch: enrichedBatch,
    batchSummary: {
      total: enrichedBatch.length,
      dueReviews: selectedDue.length,
      newWords: selectedNew.length,
      autoSupplementedTocfl: autoSupplemented
    },
    liveAuth: liveAuth,
    settings: settings
  };
}

/**
 * Spreads new words evenly among due review words.
 */
function interleaveDueAndNew_(dueList, newList) {
  if (dueList.length === 0) return newList.slice();
  if (newList.length === 0) return dueList.slice();

  const result = [];
  const total = dueList.length + newList.length;
  const stride = Math.max(1, Math.floor(total / newList.length));
  let dIdx = 0;
  let nIdx = 0;

  for (let i = 0; i < total; i++) {
    if ((i + 1) % stride === 0 && nIdx < newList.length) {
      result.push(newList[nIdx++]);
    } else if (dIdx < dueList.length) {
      result.push(dueList[dIdx++]);
    } else if (nIdx < newList.length) {
      result.push(newList[nIdx++]);
    }
  }
  return result;
}

/**
 * Preferred fast text-generation Gemini models (ordered fastest/lowest-latency first).
 * Note: `gemini-2.5-flash` and `gemini-2.5-flash-lite` were retired in Oct 2026 (HTTP 404).
 */
const PREFERRED_FAST_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite'
];

/**
 * Dynamically discovers active text-generation Gemini models available on this API key via
 * `GET /v1beta/models` (cached for 6 hours in `CacheService`), so model retirements never cause 404s.
 */
function discoverFastGeminiModels_(apiKey, settings) {
  const configured = String((settings && settings.BATCH_GEN_MODEL) || '')
    .replace(/^models\//, '')
    .trim();
  const configuredValid = configured &&
    configured.indexOf('gemini-2.') !== 0 &&
    configured.indexOf('gemini-1.') !== 0;

  let availableSet = null;
  let discoveredFlashList = [];

  try {
    const cache = (typeof CacheService !== 'undefined' && CacheService.getScriptCache)
      ? CacheService.getScriptCache()
      : null;
    let rawJson = cache ? cache.get('GEMINI_FAST_MODELS_V3') : null;

    if (!rawJson) {
      const listUrl = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=' +
        encodeURIComponent(apiKey);
      const resp = UrlFetchApp.fetch(listUrl, { method: 'get', muteHttpExceptions: true });
      if (resp && resp.getResponseCode() === 200) {
        rawJson = resp.getContentText();
        if (cache && rawJson && rawJson.length < 95000) {
          cache.put('GEMINI_FAST_MODELS_V3', rawJson, 21600); // cache for 6 hours
        }
      }
    }

    if (rawJson) {
      const parsed = JSON.parse(rawJson);
      const models = (parsed && parsed.models) || [];
      availableSet = {};
      models.forEach(function(m) {
        if (!m || !m.name) return;
        const id = String(m.name).replace(/^models\//, '');
        const methods = m.supportedGenerationMethods || [];
        if (methods.indexOf('generateContent') === -1) return;

        // Exclude non-text / specialized endpoints and retired 1.x / 2.x models
        if (/(-tts|-image|-live|-audio|embedding|aqa|imagen|veo|robotics|learnlm|gemma|computer-use)/i.test(id)) {
          return;
        }
        if (/^gemini-[12]\./i.test(id)) {
          return;
        }
        availableSet[id] = true;
        if (/^gemini-.*flash/i.test(id)) {
          discoveredFlashList.push(id);
        }
      });
    }
  } catch (e) {
    // Non-fatal: fall through to PREFERRED_FAST_MODELS
  }

  const ordered = [];
  function addCandidate(id) {
    if (!id || ordered.indexOf(id) !== -1) return;
    if (availableSet && Object.keys(availableSet).length > 0 && !availableSet[id]) return;
    ordered.push(id);
  }

  if (configuredValid) {
    addCandidate(configured);
  }
  PREFERRED_FAST_MODELS.forEach(addCandidate);

  // Also include any newer `gemini-*-flash-lite` then `gemini-*-flash` models discovered from `/v1beta/models`
  discoveredFlashList
    .slice()
    .sort(function(a, b) {
      const aLite = a.indexOf('lite') !== -1 ? 1 : 0;
      const bLite = b.indexOf('lite') !== -1 ? 1 : 0;
      if (aLite !== bLite) return bLite - aLite;
      return b.localeCompare(a);
    })
    .forEach(addCandidate);

  if (ordered.length === 0) {
    if (configuredValid) ordered.push(configured);
    PREFERRED_FAST_MODELS.forEach(function(m) {
      if (ordered.indexOf(m) === -1) ordered.push(m);
    });
  }

  return ordered;
}

/**
 * Builds a compact Tab-Separated (TSV) Mandarin-first -> English prompt.
 *
 * Why TSV instead of JSON + `responseSchema`:
 * - Cuts output token volume by ~3x and eliminates JSON-schema FSM compilation overhead on the server.
 * - Putting `mandarin_sentence` in Column 2 and `english_sentence` in Column 3 forces strict left-to-right
 *   causal generation: Gemini writes the idiomatic Taiwanese Mandarin sentence FIRST, then translates it
 *   into simple English SECOND.
 * - Allows 115+ words per request so a 332-word deck finishes in ONE parallel `UrlFetchApp.fetchAll` wave (~5-8s)!
 */
function buildMandarinFirstPromptText_(wordsChunk) {
  const inputLines = wordsChunk.map(function(w) {
    const trad = String(w.traditional || '').replace(/[\t\r\n]/g, ' ').trim();
    const pinyin = String(w.pinyin || '').replace(/[\t\r\n]/g, ' ').trim();
    const lvl = String(w.tocfl_level || 2).trim();
    const gloss = String(w.english_gloss || '').replace(/[\t\r\n]/g, ' ').trim();
    const prevZh = String(w.previous_mandarin || w.mandarin_sentence || '').replace(/[\t\r\n]/g, ' ').trim();
    return [trad, pinyin, 'L' + lvl, gloss, prevZh].join('\t');
  });

  return [
    'Generate Taiwanese Mandarin speaking practice pairs for ALL ' + wordsChunk.length + ' target words below.',
    'Output ONLY plain Tab-Separated Values (TSV), exactly ONE line per input word, with NO header row and NO markdown code fences.',
    '',
    'Exact 5 columns per line (separated by a single TAB character `\\t` — generate left-to-right in this exact order):',
    'Col 1: traditional — Exact Traditional Chinese headword from input.',
    'Col 2: mandarin_sentence — Write this FIRST: a short, natural everyday Taiwanese Mandarin sentence in Traditional Chinese (6 to 14 characters) using the exact Col 1 word. Use Taiwan usage (e.g. 餐廳, 計程車, 公車, 捷運, 早上, 平常, 順便). Every OTHER word in the sentence must be simple beginner/elementary everyday vocabulary (TOCFL 1-2). If input Col 5 has a previous sentence, write a DIFFERENT sentence.',
    'Col 3: english_sentence — Translate Col 2 SECOND into a simple, natural everyday English sentence (5 to 11 words) with the exact meaning of Col 2. Never put Chinese characters or Pinyin in Col 3.',
    'Col 4: english_gloss — Concise English meaning of the word (keep input Col 4 if already clear).',
    'Col 5: common_synonyms — Comma-separated close Taiwanese Mandarin synonyms (or leave empty after tab if none).',
    '',
    'Example output line:',
    '順便\t你可以順便幫我買一杯咖啡嗎？\tCan you buy me a coffee while you are at it?\twhile you are at it\t順道',
    '',
    'Input words (traditional \\t pinyin \\t level \\t gloss \\t previous_mandarin_to_avoid):',
    inputLines.join('\n')
  ].join('\n');
}

/**
 * Builds the `generateContent` JSON request body using clean Gemini 3.x config:
 * - Never sends deprecated `temperature` or Gemini-2.5-only `thinkingBudget` (which fail validation on newer models).
 * - Flash-Lite models (`gemini-3.5-flash-lite`, `gemini-flash-lite-latest`) already default to `minimal` thinking,
 *   so an empty/minimal config avoids any parameter rejection.
 * - Standard Flash models (`gemini-3.8-flash`, `gemini-3.6-flash`, etc.) use `thinkingConfig: { thinkingLevel: 'LOW' }`
 *   so they don't spend extra seconds on default `MEDIUM` reasoning.
 */
function buildSentenceRequestPayload_(wordsChunk, modelId, bareConfig) {
  const payloadObj = {
    contents: [{ parts: [{ text: buildMandarinFirstPromptText_(wordsChunk) }] }]
  };
  if (!bareConfig) {
    const m = String(modelId || '').toLowerCase();
    if (m.indexOf('lite') === -1) {
      payloadObj.generationConfig = {
        thinkingConfig: { thinkingLevel: 'LOW' }
      };
    }
  }
  return JSON.stringify(payloadObj);
}

/**
 * Parses TSV (or pipe-separated / JSON fallback) output from Gemini into a lookup map keyed by `traditional`.
 */
function parseSentenceBatchResponseText_(rawText) {
  if (!rawText) return null;
  let cleaned = String(rawText).trim();
  if (cleaned.indexOf('```') !== -1) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\s*/i, '').replace(/\s*```$/, '').trim();
  }
  if (!cleaned) return null;

  const map = {};

  // Fallback support if a model ever returns a JSON array
  if (cleaned.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        parsed.forEach(function(item) {
          if (!item || !item.traditional) return;
          const trad = String(item.traditional).trim();
          const zh = String(item.mandarin_sentence || item.sample_mandarin || '').trim();
          const en = String(item.english_sentence || item.english_prompt || '').trim();
          if (trad && zh && en) {
            map[trad] = {
              traditional: trad,
              mandarin_sentence: zh,
              sample_mandarin: zh,
              english_sentence: en,
              english_gloss: String(item.english_gloss || '').trim(),
              common_synonyms: String(item.common_synonyms || '').trim()
            };
          }
        });
        return map;
      }
    } catch (e) {}
  }

  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let parts = line.indexOf('\t') !== -1 ? line.split('\t') : null;
    if (!parts && line.indexOf('|') !== -1) {
      parts = line.split('|');
    }
    if (!parts || parts.length < 3) continue;

    const trad = String(parts[0] || '')
      .replace(/^\d+[\.\)\s]+/, '')
      .replace(/^[-*•]\s*/, '')
      .trim();
    const zh = String(parts[1] || '').trim();
    const en = String(parts[2] || '').replace(/^["']|["']$/g, '').trim();
    const gloss = String(parts[3] || '').trim();
    const syns = String(parts[4] || '').trim();

    // Skip accidental header lines
    if (!trad || trad.toLowerCase() === 'traditional' || trad.toLowerCase() === 'col 1') continue;
    // Validate that `zh` has CJK characters and `en` has Latin letters
    if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(zh) || !/[a-zA-Z]/.test(en)) continue;

    map[trad] = {
      traditional: trad,
      mandarin_sentence: zh,
      sample_mandarin: zh,
      english_sentence: en,
      english_gloss: gloss,
      common_synonyms: syns
    };
  }

  return map;
}

function extractGeminiResponseText_(respText) {
  const data = JSON.parse(respText);
  const parts = data &&
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  const chunks = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && !parts[i].thought && parts[i].text) {
      chunks.push(parts[i].text);
    }
  }
  return chunks.join('\n');
}

function extractApiErrorDetail_(resp, modelId) {
  if (!resp) return 'No response from ' + modelId;
  const code = resp.getResponseCode();
  let msg = '';
  try {
    const errObj = JSON.parse(resp.getContentText());
    if (errObj && errObj.error && errObj.error.message) {
      msg = ' — ' + String(errObj.error.message).slice(0, 140);
    }
  } catch (e) {}
  return 'HTTP ' + code + ' on ' + modelId + msg;
}

/**
 * Fallback across candidate live models (and bare zero-config payload if any parameter is rejected).
 */
function generateSingleChunkWithFallback_(wordsChunk, apiKey, candidateModels, failedPrimaryModel) {
  const attempts = [];
  // First retry the primary model with bare `{}` config in case `thinkingConfig` caused HTTP 400
  if (failedPrimaryModel) {
    attempts.push({ model: failedPrimaryModel, bareConfig: true });
  }
  for (let i = 0; i < candidateModels.length && attempts.length < 5; i++) {
    const m = candidateModels[i];
    if (m === failedPrimaryModel) continue;
    attempts.push({ model: m, bareConfig: false });
  }
  if (candidateModels.length > 1) {
    attempts.push({ model: candidateModels[1], bareConfig: true });
  }

  let lastErr = '';
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(att.model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    try {
      const resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: buildSentenceRequestPayload_(wordsChunk, att.model, att.bareConfig),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        const text = extractGeminiResponseText_(resp.getContentText());
        const map = parseSentenceBatchResponseText_(text);
        if (map && Object.keys(map).length > 0) {
          return { map: map, workingModel: att.model, error: '' };
        }
        lastErr = 'Empty/unparseable output from ' + att.model;
      } else {
        lastErr = extractApiErrorDetail_(resp, att.model);
      }
    } catch (e) {
      lastErr = (e && e.message ? e.message : String(e)) + ' (' + att.model + ')';
    }
  }

  return { map: {}, workingModel: '', error: lastErr || 'All candidate Gemini models failed' };
}

/**
 * Orders words so blank rows (`!mandarin_sentence || !english_prompt`) and due/active words are generated FIRST.
 */
function sortWordsForPromptGeneration_(words) {
  const nowMs = new Date().getTime();
  return words.slice().sort(function(a, b) {
    const aMissing = (!String(a.english_prompt || '').trim() || !String(a.mandarin_sentence || '').trim()) ? 1 : 0;
    const bMissing = (!String(b.english_prompt || '').trim() || !String(b.mandarin_sentence || '').trim()) ? 1 : 0;
    if (aMissing !== bMissing) return bMissing - aMissing;

    const aDue = (a.reps && Number(a.reps) > 0 && a.due_date && new Date(a.due_date).getTime() <= nowMs) ? 1 : 0;
    const bDue = (b.reps && Number(b.reps) > 0 && b.due_date && new Date(b.due_date).getTime() <= nowMs) ? 1 : 0;
    if (aDue !== bDue) return bDue - aDue;

    return (a._rowIndex || 0) - (b._rowIndex || 0);
  });
}

/**
 * High-speed bulk Mandarin -> English sentence generator:
 * - Dynamically discovers active Flash-Lite / Flash models on `/v1beta/models` (e.g. `gemini-3.5-flash-lite`, `gemini-3.8-flash`).
 * - Sends up to `3 x 115 = 345` words per parallel `UrlFetchApp.fetchAll` wave using compact TSV lines,
 *   completing a 332-word deck in ~5-10 seconds in a SINGLE parallel round-trip!
 * - Writes and flushes to the Sheet immediately after each wave.
 */
function populateSheetPromptsForWords_(wordsToUpdate, settings, options) {
  if (!wordsToUpdate || wordsToUpdate.length === 0) {
    return { updatedCount: 0, totalRequested: 0, remainingCount: 0, generatedMap: {}, modelUsed: '', lastError: '' };
  }

  const opts = options || {};
  const maxExecutionMs = Number(opts.maxExecutionMs || 240000);
  const showSheetToast = Boolean(opts.showSheetToast);
  const skipSort = Boolean(opts.skipSort);
  const startMs = new Date().getTime();

  const effectiveSettings = settings || getSettings_();
  const apiKey = getGeminiApiKey_();
  const candidateModels = discoverFastGeminiModels_(apiKey, effectiveSettings);
  let activePrimaryModel = candidateModels[0];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vocabSheet = ss.getSheetByName(TAB_VOCAB);
  const lastRow = vocabSheet.getLastRow();
  if (lastRow <= 1) {
    return { updatedCount: 0, totalRequested: wordsToUpdate.length, remainingCount: 0, generatedMap: {}, modelUsed: activePrimaryModel, lastError: '' };
  }

  const orderedWords = skipSort ? wordsToUpdate.slice() : sortWordsForPromptGeneration_(wordsToUpdate);
  const numDataRows = lastRow - 1;
  const glossValues = vocabSheet.getRange(2, 6, numDataRows, 1).getValues();
  const promptValues = vocabSheet.getRange(2, 19, numDataRows, 1).getValues();
  const extraValues = vocabSheet.getRange(2, 21, numDataRows, 2).getValues();

  // 115 words/chunk x 3 concurrent requests = 345 words in a single ~5-8s parallel wave!
  const CHUNK_SIZE = 115;
  const WAVE_CONCURRENCY = 3;
  const chunks = [];
  for (let i = 0; i < orderedWords.length; i += CHUNK_SIZE) {
    chunks.push(orderedWords.slice(i, i + CHUNK_SIZE));
  }

  const generatedMap = {};
  let totalUpdated = 0;
  let lastError = '';

  if (showSheetToast) {
    ss.toast(
      'Generating Mandarin -> English pairs for ' + orderedWords.length + ' words in parallel (' + activePrimaryModel + ')...',
      'Mandarin Tutor',
      8
    );
  }

  for (let w = 0; w < chunks.length; w += WAVE_CONCURRENCY) {
    if (w > 0 && (new Date().getTime() - startMs) >= maxExecutionMs) {
      break;
    }

    const waveChunks = chunks.slice(w, w + WAVE_CONCURRENCY);
    const primaryUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(activePrimaryModel) + ':generateContent?key=' + encodeURIComponent(apiKey);

    const requests = waveChunks.map(function(chunk) {
      return {
        url: primaryUrl,
        method: 'post',
        contentType: 'application/json',
        payload: buildSentenceRequestPayload_(chunk, activePrimaryModel, false),
        muteHttpExceptions: true
      };
    });

    let responses = [];
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      responses = [];
      lastError = e && e.message ? e.message : String(e);
    }

    const waveMap = {};
    const missedInWave = [];

    for (let r = 0; r < waveChunks.length; r++) {
      let chunkMap = null;
      const resp = responses[r];
      if (resp && resp.getResponseCode() === 200) {
        try {
          const text = extractGeminiResponseText_(resp.getContentText());
          chunkMap = parseSentenceBatchResponseText_(text);
        } catch (parseErr) {
          lastError = parseErr && parseErr.message ? parseErr.message : String(parseErr);
        }
      } else if (resp) {
        lastError = extractApiErrorDetail_(resp, activePrimaryModel);
      }

      if (!chunkMap || Object.keys(chunkMap).length === 0) {
        const fb = generateSingleChunkWithFallback_(
          waveChunks[r],
          apiKey,
          candidateModels,
          resp && resp.getResponseCode() === 400 ? activePrimaryModel : ''
        );
        chunkMap = fb.map;
        if (fb.workingModel) {
          activePrimaryModel = fb.workingModel;
        }
        if (fb.error && Object.keys(chunkMap).length === 0) {
          lastError = fb.error;
        }
      }

      Object.keys(chunkMap || {}).forEach(function(tradKey) {
        waveMap[tradKey] = chunkMap[tradKey];
        generatedMap[tradKey] = chunkMap[tradKey];
      });

      // Track any occasional straggler rows if a large chunk skipped 1-2 lines
      if (chunkMap && Object.keys(chunkMap).length > 0) {
        waveChunks[r].forEach(function(wordObj) {
          if (!waveMap[wordObj.traditional]) {
            missedInWave.push(wordObj);
          }
        });
      }
    }

    // Quick straggler pass if 1-5 words in a 332-word wave were skipped
    if (missedInWave.length > 0 && missedInWave.length <= 40 && (new Date().getTime() - startMs + 5000) < maxExecutionMs) {
      const stragglerUrl = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(activePrimaryModel) + ':generateContent?key=' + encodeURIComponent(apiKey);
      try {
        const sResp = UrlFetchApp.fetch(stragglerUrl, {
          method: 'post',
          contentType: 'application/json',
          payload: buildSentenceRequestPayload_(missedInWave, activePrimaryModel, false),
          muteHttpExceptions: true
        });
        if (sResp.getResponseCode() === 200) {
          const sMap = parseSentenceBatchResponseText_(extractGeminiResponseText_(sResp.getContentText())) || {};
          Object.keys(sMap).forEach(function(k) {
            waveMap[k] = sMap[k];
            generatedMap[k] = sMap[k];
          });
        }
      } catch (e) {}
    }

    // Apply this wave's generated sentences and FLUSH IMMEDIATELY to the Google Sheet!
    let waveUpdated = 0;
    let waveGlossModified = false;
    waveChunks.forEach(function(chunk) {
      chunk.forEach(function(wordObj) {
        const gen = waveMap[wordObj.traditional];
        if (!gen || !gen.english_sentence || !gen.mandarin_sentence) return;
        const rIdx = (wordObj._rowIndex || 0) - 2;
        if (rIdx < 0 || rIdx >= numDataRows) return;

        if (!String(glossValues[rIdx][0] || '').trim() && gen.english_gloss) {
          glossValues[rIdx][0] = String(gen.english_gloss).trim();
          waveGlossModified = true;
        }
        promptValues[rIdx][0] = String(gen.english_sentence).trim();
        extraValues[rIdx][0] = String(gen.mandarin_sentence).trim();
        extraValues[rIdx][1] = String(gen.common_synonyms || '').trim();
        waveUpdated++;
      });
    });

    if (waveUpdated > 0) {
      totalUpdated += waveUpdated;
      if (waveGlossModified) {
        vocabSheet.getRange(2, 6, numDataRows, 1).setValues(glossValues);
      }
      vocabSheet.getRange(2, 19, numDataRows, 1).setValues(promptValues);
      vocabSheet.getRange(2, 21, numDataRows, 2).setValues(extraValues);
      SpreadsheetApp.flush();

      if (showSheetToast) {
        ss.toast(
          'Saved ' + totalUpdated + ' / ' + orderedWords.length + ' Mandarin -> English sentence pairs (' + activePrimaryModel + ')...',
          'Mandarin Tutor',
          5
        );
      }
    }
  }

  const remainingCount = Math.max(0, orderedWords.length - totalUpdated);
  return {
    updatedCount: totalUpdated,
    totalRequested: orderedWords.length,
    remainingCount: remainingCount,
    generatedMap: generatedMap,
    modelUsed: activePrimaryModel,
    lastError: lastError
  };
}

/**
 * RPC & Menu handler to pre-generate or refresh Mandarin -> English sentence pairs across active words in `Vocab`.
 */
function handlePregeneratePrompts_(body) {
  const opts = body || {};
  const forceRefreshAll = opts.forceRefreshAll !== undefined ? Boolean(opts.forceRefreshAll) : false;
  const maxExecutionMs = Number(opts.maxExecutionMs || 45000);
  const showSheetToast = Boolean(opts.showSheetToast);
  const settings = getSettings_();
  const vocab = readAllVocab_();

  const allEligible = vocab.filter(function(w) {
    const status = String(w.status || 'new').toLowerCase();
    if (status === 'flagged') return false;
    if (forceRefreshAll) return true;
    return !String(w.english_prompt || '').trim() || !String(w.mandarin_sentence || '').trim();
  });

  const offset = Math.max(0, Number(opts.offset || 0));
  const limit = opts.limit ? Math.max(1, Number(opts.limit)) : allEligible.length;
  const sliceToProcess = allEligible.slice(offset, offset + limit);

  const res = populateSheetPromptsForWords_(sliceToProcess, settings, {
    maxExecutionMs: maxExecutionMs,
    showSheetToast: showSheetToast,
    skipSort: Boolean(opts.limit)
  });

  const remainingAfterSlice = forceRefreshAll
    ? Math.max(0, allEligible.length - (offset + res.updatedCount))
    : Math.max(0, allEligible.length - res.updatedCount);

  if (res.updatedCount === 0 && sliceToProcess.length > 0 && res.lastError && !opts.allowZeroUpdate) {
    throw new Error('Sentence generation failed (' + res.lastError + ').');
  }

  return {
    ok: true,
    totalEligible: allEligible.length,
    processedInCall: res.updatedCount,
    updatedCount: res.updatedCount,
    nextOffset: offset + sliceToProcess.length,
    remainingCount: remainingAfterSlice,
    modelUsed: res.modelUsed || '',
    lastError: res.lastError || ''
  };
}

/**
 * Menu Item 1: Fast / Resume mode — generates Mandarin -> English pairs only for rows missing either sentence.
 */
function menuPregenerateMissingPrompts() {
  setupSheet();
  const startedAt = new Date().getTime();
  const res = handlePregeneratePrompts_({
    forceRefreshAll: false,
    maxExecutionMs: 245000,
    showSheetToast: true,
    allowZeroUpdate: true
  });
  if (res.totalEligible === 0) {
    SpreadsheetApp.getUi().alert('All active vocabulary words already have both Mandarin and English sentences!');
    return;
  }
  const elapsedSec = ((new Date().getTime() - startedAt) / 1000).toFixed(1);
  if (res.updatedCount === 0) {
    SpreadsheetApp.getUi().alert(
      'Failed to generate sentences (0 of ' + res.totalEligible + ' saved).\n\n' +
      'Error detail: ' + (res.lastError || 'Unknown API error')
    );
    return;
  }
  const statusLine = res.remainingCount > 0
    ? '\n\n' + res.remainingCount + ' words still need sentences — run "Generate Missing Mandarin -> English Sentences" once more to finish them.'
    : '\n\nAll active words in your Sheet now have natural Mandarin + English sentences!';
  SpreadsheetApp.getUi().alert(
    'Saved natural Mandarin -> English sentence pairs for ' + res.updatedCount +
    ' of ' + res.totalEligible + ' words in ' + elapsedSec + 's (model: ' + res.modelUsed + ').' + statusLine
  );
}

/**
 * Menu Item 2: Refresh All mode — regenerates natural Mandarin -> English pairs across all active words.
 */
function menuPregeneratePrompts() {
  setupSheet();
  const startedAt = new Date().getTime();
  const res = handlePregeneratePrompts_({
    forceRefreshAll: true,
    maxExecutionMs: 245000,
    showSheetToast: true,
    allowZeroUpdate: true
  });
  const elapsedSec = ((new Date().getTime() - startedAt) / 1000).toFixed(1);
  if (res.updatedCount === 0 && res.totalEligible > 0) {
    SpreadsheetApp.getUi().alert(
      'Failed to generate sentences (0 of ' + res.totalEligible + ' active words saved).\n\n' +
      'Error detail: ' + (res.lastError || 'Unknown API error')
    );
    return;
  }
  const statusLine = res.updatedCount < res.totalEligible
    ? '\n\n(' + (res.totalEligible - res.updatedCount) + ' words were not updated — run "Generate Missing Mandarin -> English Sentences" to fill them.)' +
      (res.lastError ? '\nLast API note: ' + res.lastError : '')
    : '\n\n100% of your active vocabulary words now have natural Mandarin + English sentences saved in the Sheet!';
  SpreadsheetApp.getUi().alert(
    'Saved natural Mandarin -> English sentence pairs for ' + res.updatedCount +
    ' of ' + res.totalEligible + ' active vocabulary words in ' + elapsedSec + 's (model: ' + res.modelUsed + ').' + statusLine
  );
}

/**
 * Supplies Live model credentials to the authenticated personal client.
 */
function getLiveSessionAuth_(settings) {
  const apiKey = getGeminiApiKey_();
  return {
    apiKey: apiKey,
    liveModel: settings.LIVE_MODEL || 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    fallbackLiveModel: settings.LIVE_FALLBACK_MODEL || 'models/gemini-3.8-live',
    voiceName: settings.VOICE_NAME || 'Aoede'
  };
}

/**
 * Computes the deterministic 1-4 score from the structured telemetry reported by the Live tool call,
 * applies the FSRS v5 algorithm, updates the `Vocab` sheet row, appends a row to `ReviewLog`,
 * AND immediately pre-generates a fresh Mandarin -> English sentence pair for the word's next SRS review!
 */
function handleRecordReview_(body) {
  const wordId = body.word_id;
  const traditional = body.traditional;
  const telemetry = body.telemetry || {};

  const vocab = readAllVocab_();
  let targetRow = null;
  for (let i = 0; i < vocab.length; i++) {
    if ((wordId && String(vocab[i].id) === String(wordId)) ||
        (traditional && String(vocab[i].traditional) === String(traditional))) {
      targetRow = vocab[i];
      break;
    }
  }
  if (!targetRow) {
    throw new Error('Vocab word not found in sheet: ' + (traditional || wordId));
  }

  const practicedPrompt = String(body.english_prompt || targetRow.english_prompt || '').trim();
  const practicedMandarin = String(body.mandarin_sentence || targetRow.mandarin_sentence || '').trim();
  const score = computeDeterministicScore_(telemetry);
  const settings = getSettings_();
  const desiredRetention = Number(settings.DESIRED_RETENTION || 0.90);

  const fsrsNext = computeFsrsV5_(targetRow, score, desiredRetention);

  // Pre-generate a brand-new Mandarin sentence -> English translation right now so the NEXT review starts instantly!
  let nextPrompt = practicedPrompt;
  let nextMandarin = practicedMandarin;
  let nextSynonyms = String(targetRow.common_synonyms || '').trim();
  let generatedGloss = '';
  try {
    const apiKey = getGeminiApiKey_();
    const primaryModel = resolveFastBatchModel_(settings);
    const singleWord = [{
      traditional: targetRow.traditional,
      pinyin: targetRow.pinyin || '',
      tocfl_level: targetRow.tocfl_level || 2,
      english_gloss: targetRow.english_gloss || '',
      previous_mandarin: practicedMandarin
    }];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(primaryModel) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: buildSentenceRequestPayload_(singleWord, true),
      muteHttpExceptions: true
    });
    let genMap = null;
    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      const text = data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts &&
        data.candidates[0].content.parts[0] &&
        data.candidates[0].content.parts[0].text;
      genMap = parseSentenceBatchResponseText_(text);
    } else {
      genMap = generateSingleChunkWithFallback_(singleWord, apiKey, primaryModel, false).map;
    }
    const gen = genMap && genMap[targetRow.traditional];
    if (gen && gen.english_sentence && gen.mandarin_sentence) {
      nextPrompt = String(gen.english_sentence).trim();
      nextMandarin = String(gen.mandarin_sentence).trim();
      nextSynonyms = String(gen.common_synonyms || nextSynonyms).trim();
      generatedGloss = String(gen.english_gloss || '').trim();
    }
  } catch (e) {
    // Non-fatal: keep previous sentence pair if background generation fails
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vocabSheet = ss.getSheetByName(TAB_VOCAB);
  const rowIdx = targetRow._rowIndex;

  if (!String(targetRow.english_gloss || '').trim() && generatedGloss) {
    vocabSheet.getRange(rowIdx, 6).setValue(generatedGloss);
  }

  // Columns:
  // 11: status, 12: stability, 13: difficulty, 14: due_date, 15: last_review,
  // 16: reps, 17: lapses, 18: last_score, 19: english_prompt (NEXT pre-generated English!),
  // 20: last_notes, 21: mandarin_sentence (NEXT pre-generated Mandarin!), 22: common_synonyms
  vocabSheet.getRange(rowIdx, 11, 1, 12).setValues([[
    fsrsNext.status,
    fsrsNext.stability,
    fsrsNext.difficulty,
    fsrsNext.dueDateIso,
    fsrsNext.nowIso,
    fsrsNext.reps,
    fsrsNext.lapses,
    score,
    nextPrompt,
    telemetry.notes || '',
    nextMandarin,
    nextSynonyms
  ]]);

  const logSheet = ss.getSheetByName(TAB_LOG);
  logSheet.appendRow([
    fsrsNext.nowIso,
    targetRow.id,
    targetRow.traditional,
    targetRow.pinyin,
    score,
    Boolean(telemetry.target_word_recalled),
    Boolean(telemetry.needed_hint),
    Number(telemetry.pronunciation_attempts || 1),
    Number(telemetry.grammar_errors || 0),
    String(telemetry.conversation_fluency || 'good'),
    Number(targetRow.stability || 0),
    fsrsNext.stability,
    fsrsNext.difficulty,
    fsrsNext.intervalDays,
    practicedPrompt,
    telemetry.notes || '',
    practicedMandarin
  ]);

  return {
    ok: true,
    traditional: targetRow.traditional,
    score: score,
    nextPrompt: nextPrompt,
    nextMandarin: nextMandarin,
    fsrs: fsrsNext
  };
}

/**
 * Deterministic 1-4 rubric from LLM structured facts.
 */
function computeDeterministicScore_(t) {
  if (t.override_score && [1, 2, 3, 4].indexOf(Number(t.override_score)) !== -1) {
    return Number(t.override_score);
  }
  const recalled = t.target_word_recalled !== false;
  const neededHint = Boolean(t.needed_hint);
  const attempts = Number(t.pronunciation_attempts || 1);
  const grammarErrors = Number(t.grammar_errors || 0);
  const fluency = String(t.conversation_fluency || 'good').toLowerCase();

  if (!recalled || neededHint) {
    return 1; // Again
  }
  if (attempts > 2 || grammarErrors >= 2 || fluency === 'struggled') {
    return 2; // Hard
  }
  if (attempts <= 1 && grammarErrors === 0 && (fluency === 'natural' || fluency === 'excellent')) {
    return 4; // Easy
  }
  return 3; // Good
}

/**
 * FSRS v5 Spaced Repetition scheduling model.
 * Standard FSRS v5 default weights (w0..w18).
 */
function computeFsrsV5_(card, rating, requestRetention) {
  const w = [
    0.40255, 1.18385, 3.173, 15.69105,
    7.1949, 0.5345, 1.4604, 0.0046,
    1.54575, 0.1192, 1.01925, 1.9395,
    0.11, 0.29605, 2.2698, 0.2315,
    2.9898, 0.51655, 0.6621
  ];
  const DECAY = -0.5;
  const FACTOR = 19 / 81; // 0.9^(-1/DECAY) - 1

  const now = new Date();
  const reps = Number(card.reps || 0);
  let lapses = Number(card.lapses || 0);
  let S = Number(card.stability || 0);
  let D = Number(card.difficulty || 0);

  let elapsedDays = 0;
  if (card.last_review) {
    const lastDate = new Date(card.last_review);
    if (!isNaN(lastDate.getTime())) {
      elapsedDays = Math.max(0, (now.getTime() - lastDate.getTime()) / (1000 * 3600 * 24));
    }
  }

  if (reps === 0 || S <= 0 || D <= 0) {
    // First review initialization (FSRS v5)
    S = w[rating - 1];
    D = w[4] - Math.exp(w[5] * (rating - 1)) + 1;
    D = clamp_(D, 1, 10);
  } else {
    // Retrievability R(t, S)
    const R = Math.pow(1 + FACTOR * (elapsedDays / S), DECAY);

    // Update Difficulty D'
    const deltaD = -w[6] * (rating - 3);
    const dPrime = D + deltaD * ((10 - D) / 9);
    const d0Easy = w[4] - Math.exp(w[5] * 3) + 1;
    D = clamp_(w[7] * d0Easy + (1 - w[7]) * dPrime, 1, 10);

    if (rating === 1) {
      // Lapse / Forget stability S'_f
      lapses += 1;
      const sForgot = w[11] *
        Math.pow(D, -w[12]) *
        (Math.pow(S + 1, w[13]) - 1) *
        Math.exp(w[14] * (1 - R));
      S = Math.max(0.2, Math.min(S, sForgot));
    } else {
      // Recall stability S'_r
      const hardPenalty = (rating === 2) ? w[15] : 1;
      const easyBonus = (rating === 4) ? w[16] : 1;
      const inc = Math.exp(w[8]) *
        (11 - D) *
        Math.pow(S, -w[9]) *
        (Math.exp(w[10] * (1 - R)) - 1) *
        hardPenalty *
        easyBonus;
      S = S * (1 + inc);
    }
  }

  S = Math.round(S * 1000) / 1000;
  D = Math.round(D * 1000) / 1000;

  // Next interval from target retention
  const retention = clamp_(requestRetention || 0.90, 0.75, 0.97);
  let intervalDays = (S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  if (rating === 1) {
    intervalDays = Math.min(1, Math.max(0.04, intervalDays)); // review again within ~1 hr to 1 day
  } else {
    intervalDays = Math.max(1, Math.round(intervalDays * 10) / 10);
  }

  const dueDate = new Date(now.getTime() + intervalDays * 24 * 3600 * 1000);
  const status = (rating === 1)
    ? (reps === 0 ? 'learning' : 'relearning')
    : 'review';

  return {
    status: status,
    stability: S,
    difficulty: D,
    intervalDays: Math.round(intervalDays * 10) / 10,
    reps: reps + 1,
    lapses: lapses,
    nowIso: now.toISOString(),
    dueDateIso: dueDate.toISOString()
  };
}

function clamp_(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Handles flagging a bad card or skipping.
 */
function handleWordAction_(body) {
  const actionType = body.subAction || 'skip';
  if (actionType === 'flag_bad_card') {
    const vocab = readAllVocab_();
    for (let i = 0; i < vocab.length; i++) {
      if (String(vocab[i].traditional) === String(body.traditional) ||
          (body.word_id && String(vocab[i].id) === String(body.word_id))) {
        const ss = SpreadsheetApp.getActiveSpreadsheet();
        const sheet = ss.getSheetByName(TAB_VOCAB);
        sheet.getRange(vocab[i]._rowIndex, 11).setValue('flagged');
        sheet.getRange(vocab[i]._rowIndex, 20).setValue('Flagged by voice: ' + (body.reason || ''));
        return { ok: true, flagged: vocab[i].traditional };
      }
    }
  }
  return { ok: true, skipped: body.traditional || '' };
}

/**
 * Parses a Hanping Chinese Dictionary CSV/TSV/TXT export (or Anki plain-text export)
 * and merges new words into the `Vocab` sheet without overwriting existing FSRS progress.
 *
 * Supported Hanping export formats:
 * - Standard Hanping Word List export (CSV/TSV with columns like Hanzi/Traditional, Simplified, Pinyin, Definition/English)
 * - Bracket format: `傳統[传统] chuán tǒng /tradition/traditional/`
 * - Tab-separated AnkiDroid export: `餐館\t餐馆\tcānguǎn\trestaurant`
 */
function handleImportHanping_(body) {
  const csvText = String(body.csvText || '').trim();
  const tagFilter = String(body.tagFilter || '').trim();
  const pruneNonMatching = body.pruneNonMatching !== undefined ? Boolean(body.pruneNonMatching) : Boolean(tagFilter);
  if (!csvText) {
    throw new Error('Empty AnkiDroid export text.');
  }

  // Also cross-reference PSeitz/tocfl if cached so AnkiDroid words get Zhuyin, TOCFL level & spoken frequency!
  let tocflMap = {};
  try {
    tocflMap = fetchTocflLookupMap_();
  } catch (e) {
    // Non-fatal if GitHub fetch fails during import
  }

  const parsedEntries = parseHanpingText_(csvText, tocflMap, tagFilter);
  if (parsedEntries.length === 0) {
    if (tagFilter) {
      throw new Error('No Chinese vocabulary notes found matching tag "' + tagFilter + '". Make sure "Include tags" was checked when exporting from AnkiDroid.');
    }
    throw new Error('No Chinese vocabulary notes found in the file. (If you exported an empty Filtered Deck, export your main parent deck or "All decks" as "Notes in Plain Text (.txt)" with "Include tags" checked instead.)');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_VOCAB);

  // Build set of Traditional headwords in this filtered import
  const importedTradSet = {};
  parsedEntries.forEach(function(entry) {
    const trad = String(entry.traditional || '').trim();
    if (trad) importedTradSet[trad] = true;
  });

  // Optionally prune unstudied AnkiDroid/Hanping rows in the Sheet that do NOT match the filtered import
  // (e.g., cleaning up non-"everyday" tags from an earlier unfiltered import)
  let prunedCount = 0;
  if (pruneNonMatching) {
    const existingForPrune = readAllVocab_();
    // Delete from bottom row to top row so row indices don't shift
    for (let i = existingForPrune.length - 1; i >= 0; i--) {
      const w = existingForPrune[i];
      const trad = String(w.traditional || '').trim();
      const src = String(w.source || '').toLowerCase();
      const isAnkiSource = (src === 'ankidroid' || src === 'hanping');
      const isUnstudied = (!w.reps || Number(w.reps) === 0);
      if (isAnkiSource && isUnstudied && !importedTradSet[trad]) {
        sheet.deleteRow(w._rowIndex);
        prunedCount++;
      }
    }
  }

  const existing = readAllVocab_();
  const existingMap = {};
  existing.forEach(function(w) {
    existingMap[String(w.traditional).trim()] = w;
  });

  const newRows = [];
  let skippedDuplicate = 0;

  parsedEntries.forEach(function(entry, idx) {
    const trad = String(entry.traditional || '').trim();
    if (!trad) return;
    if (existingMap[trad]) {
      skippedDuplicate++;
      return;
    }

    const tocflHit = tocflMap[trad] || {};
    const rowId = 'anki_' + new Date().getTime() + '_' + idx;
    const row = [
      rowId,
      trad,
      entry.simplified || '',
      entry.pinyin || tocflHit.pinyin || '',
      entry.zhuyin || tocflHit.zhuyin || '',
      entry.english_gloss || '',
      'ankidroid',
      tocflHit.tocfl_level || '',
      tocflHit.spoken_per_million || 0,
      tocflHit.written_per_million || 0,
      'new',
      0,
      0,
      '',
      '',
      0,
      0,
      '',
      '',
      entry.notes || '',
      '',
      ''
    ];
    newRows.push(row);
    existingMap[trad] = true;
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, VOCAB_HEADERS.length).setValues(newRows);
    SpreadsheetApp.flush();
  }

  // Pre-generate natural Mandarin -> English sentence pairs during import (with safe 40s HTTP budget
  // so large imports never time out; any remaining rows are immediately filled by the PWA's follow-up waves)
  const settings = getSettings_();
  const updatedVocab = readAllVocab_();
  const wordsNeedingPrompts = updatedVocab.filter(function(w) {
    const status = String(w.status || 'new').toLowerCase();
    if (status === 'flagged') return false;
    return !String(w.english_prompt || '').trim() || !String(w.mandarin_sentence || '').trim();
  });
  const promptRes = populateSheetPromptsForWords_(wordsNeedingPrompts, settings, {
    maxExecutionMs: 40000
  });

  return {
    ok: true,
    addedCount: newRows.length,
    skippedDuplicate: skippedDuplicate,
    prunedCount: prunedCount,
    promptsGenerated: promptRes.updatedCount,
    remainingPrompts: promptRes.remainingCount,
    totalParsed: parsedEntries.length,
    tagFilter: tagFilter
  };
}

/**
 * Parser for AnkiDroid "Notes in Plain Text (.txt)" / "Cards in Plain Text (.txt)" exports
 * (including `Hanping Chinese Type` notes, `#separator:tab`, `#tags column:N` headers,
 * optional tag filtering, HTML spans, and `[sound:...]` tags).
 */
function parseHanpingText_(rawText, tocflMap, tagFilter) {
  const rawStr = String(rawText || '');
  if (!rawStr.trim()) return [];
  const lookup = tocflMap || {};
  const targetTagLower = String(tagFilter || '').trim().toLowerCase();

  const lines = rawStr.split(/\r?\n/);
  const results = [];
  let tagsColIndex = -1;
  let separator = '\t';

  for (let i = 0; i < lines.length; i++) {
    // IMPORTANT: Do NOT call .trim() before splitting by tab, or empty trailing tab columns will be stripped!
    const rawLine = lines[i].replace(/\r$/, '');
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.startsWith('//')) continue;

    // Parse Anki 2.1.54+ / AnkiDroid plain-text export header directives
    if (trimmedLine.startsWith('#')) {
      const sepMatch = trimmedLine.match(/^#separator\s*:\s*(.+)$/i);
      if (sepMatch) {
        const sepVal = sepMatch[1].trim().toLowerCase();
        if (sepVal === 'tab' || sepVal === '\\t') separator = '\t';
        else if (sepVal === 'comma') separator = ',';
        else if (sepVal === 'semicolon') separator = ';';
      }
      const tagColMatch = trimmedLine.match(/^#tags\s+column\s*:\s*(\d+)/i);
      if (tagColMatch) {
        tagsColIndex = Number(tagColMatch[1]) - 1;
      }
      continue;
    }

    // 1. Check CEDICT / bracket format: `餐館[餐馆] cān guǎn /restaurant/`
    const cedictMatch = trimmedLine.match(/^([^\s\[\],;]+)(?:\[([^\]]+)\])?\s+([a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s:·]+?)\s+\/(.+)\/$/);
    if (cedictMatch && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(cedictMatch[1]) && !targetTagLower) {
      results.push({
        traditional: cedictMatch[1].trim(),
        simplified: (cedictMatch[2] || '').trim(),
        pinyin: cedictMatch[3].trim(),
        english_gloss: cleanAnkiHtml_(cedictMatch[4].replace(/\//g, '; '))
      });
      continue;
    }

    // 2. Parse delimiter (Tab for AnkiDroid .txt / TSV, or Comma for CSV)
    const rawFields = (separator === '\t' || rawLine.indexOf('\t') !== -1)
      ? rawLine.split('\t')
      : parseCsvLine_(trimmedLine);
    if (rawFields.length === 0) continue;

    // Skip obvious header row
    const firstLower = cleanAnkiHtml_(rawFields[0]).toLowerCase();
    if (firstLower === 'traditional' || firstLower === 'hanzi' || firstLower === 'word' || firstLower === 'headword') {
      continue;
    }

    // Extract tags from the designated `#tags column:N` (or the last column if `#tags column` wasn't specified)
    const effectiveTagCol = (tagsColIndex >= 0 && tagsColIndex < rawFields.length)
      ? tagsColIndex
      : (rawFields.length >= 4 ? rawFields.length - 1 : -1);
    const rawTagsStr = effectiveTagCol >= 0 ? cleanAnkiHtml_(rawFields[effectiveTagCol]) : '';
    const rowTags = rawTagsStr ? rawTagsStr.split(/\s+/).filter(Boolean) : [];

    // If the user specified a tagFilter (e.g. a Hanping tag), check if this note carries that tag
    if (targetTagLower) {
      const hasMatchingTag = rowTags.some(function(t) {
        const tl = t.toLowerCase();
        return tl === targetTagLower || tl.endsWith('::' + targetTagLower);
      });
      if (!hasMatchingTag) continue;
    }

    // Clean HTML & [sound:...] from all fields
    const fields = rawFields.map(function(f, idx) {
      if (tagsColIndex !== -1 && idx === tagsColIndex) return '';
      return cleanAnkiHtml_(f);
    });

    // Scan fields to find Chinese headword column(s), Pinyin column, and English definition column.
    // This automatically skips AnkiDroid leading metadata columns like GUID (`k8J9a!2x`),
    // Note Type (`Hanping Chinese Type`), or Deck Name (`Everyday` / `Chinese::Hanping`).
    const cjkCols = [];
    let pinyin = '';
    const glossParts = [];

    for (let c = 0; c < fields.length; c++) {
      const val = fields[c];
      if (!val) continue;

      // Skip Anki metadata columns
      if (/^hanping\s+chinese/i.test(val) || /^chinese::/i.test(val) || /^everyday/i.test(val) || /^default$/i.test(val)) {
        continue;
      }
      // Skip Anki GUID in col 0..1 (8-12 ASCII chars with no spaces and no CJK, when there are 4+ columns)
      if (c <= 1 && fields.length >= 4 && !/[\u4e00-\u9fff\u3400-\u4dbf\s]/.test(val) && /^[!-~]{6,14}$/.test(val)) {
        continue;
      }

      // Check if this field is a pure CJK headword (or `餐館[餐馆]` / `餐館 (餐馆)`)
      const bracketMatch = val.match(/^([\u4e00-\u9fff\u3400-\u4dbf\uff0c\u3001]+)[\[\(\uff08]([\u4e00-\u9fff\u3400-\u4dbf\uff0c\u3001]+)[\]\)\uff09]$/);
      if (bracketMatch) {
        cjkCols.push(bracketMatch[1].trim());
        cjkCols.push(bracketMatch[2].trim());
        continue;
      }

      if (/^[\u4e00-\u9fff\u3400-\u4dbf\uff0c\u3001\u2026\u00b7\u30fb]{1,15}$/.test(val) && /[\u4e00-\u9fff\u3400-\u4dbf]/.test(val)) {
        cjkCols.push(val);
        continue;
      }

      // If we haven't found any CJK headword yet, skip leading metadata
      if (cjkCols.length === 0) continue;

      // Detect Pinyin column (tone marks or tone numbers, short length)
      if (!pinyin && val.length <= 60 && isLikelyPinyin_(val)) {
        pinyin = val;
        continue;
      }

      // Skip the fallback last column if it matches the tag filter
      if (c === fields.length - 1 && tagsColIndex === -1 && targetTagLower && val.toLowerCase().indexOf(targetTagLower) !== -1) {
        continue;
      }

      // Detect English definition column (contains Latin letters, not just a single tag token)
      if (/[a-zA-Z]{2,}/.test(val) && !/^(hanping|starred|tocfl|anki)/i.test(val)) {
        glossParts.push(val);
      }
    }

    if (cjkCols.length === 0) continue;

    // Determine which CJK column is Traditional vs Simplified:
    // In AnkiDroid's `Hanping Chinese Type`, both Simplified and Traditional fields are often present.
    // If one of them is in `PSeitz/tocfl` (which is 100% Traditional), prefer that as Traditional!
    let trad = cjkCols[0];
    let simp = cjkCols.length > 1 ? cjkCols[1] : '';
    if (cjkCols.length >= 2) {
      if (!lookup[cjkCols[0]] && lookup[cjkCols[1]]) {
        trad = cjkCols[1];
        simp = cjkCols[0];
      }
    }

    results.push({
      traditional: trad,
      simplified: simp === trad ? '' : simp,
      pinyin: pinyin,
      english_gloss: glossParts.join('; ').trim(),
      notes: rowTags.length > 0 ? ('Tags: ' + rowTags.join(' ')) : ''
    });
  }

  return results;
}

/**
 * Strips Anki `[sound:...]` tags, HTML tags (`<span class="tone1">`, `<br>`, `<div>`),
 * and decodes common HTML entities.
 */
function cleanAnkiHtml_(str) {
  return String(str || '')
    .replace(/\[sound:[^\]]+\]/gi, ' ')
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/<\/div\s*>/gi, '; ')
    .replace(/<[^>]+>/g, '')
    .replace(/%27/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[;\s]+|[;\s]+$/g, '')
    .trim();
}

/**
 * Returns true if a string looks like Mandarin Pinyin (with tone marks or tone numbers 1-5).
 */
function isLikelyPinyin_(str) {
  const s = String(str || '').trim();
  if (!s) return false;
  // Contains Pinyin tone diacritics
  if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(s)) return true;
  // Or syllable + tone number pattern like `can1 guan3` or `shun4 bian4`
  if (/^[a-zA-ZüÜvV]{1,6}[1-5](\s+[a-zA-ZüÜvV]{1,6}[1-5])*$/.test(s)) return true;
  return false;
}

function parseCsvLine_(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Menu helper to pull 50 words from PSeitz/tocfl into the Vocab sheet.
 */
function menuPullTocflWords() {
  setupSheet();
  const settings = getSettings_();
  const level = Number(settings.TOCFL_LEVEL || 2);
  const res = supplementFromTocflInternal_(level, 50, { maxExecutionMs: 220000, showSheetToast: true });
  SpreadsheetApp.getUi().alert(
    'Added ' + res.addedCount + ' new TOCFL Level ' + level +
    ' words from PSeitz/tocfl (sorted by highest spoken frequency) and generated ' +
    (res.promptsGenerated || 0) + ' Mandarin -> English sentence pairs.'
  );
}

function handleSupplementTocfl_(body) {
  const settings = getSettings_();
  const level = Number(body.tocflLevel || settings.TOCFL_LEVEL || 2);
  const count = Number(body.count || 30);
  return supplementFromTocflInternal_(level, count, { maxExecutionMs: 42000, showSheetToast: false });
}

/**
 * Fetches `tocfl_words.json` (JSON Lines) from `https://github.com/PSeitz/tocfl`,
 * filters to `tocfl_level === level`, sorts by `spoken_per_million` descending,
 * and adds up to `limit` unseen words into the `Vocab` sheet.
 */
function supplementFromTocflInternal_(level, limit, options) {
  const opts = options || {};
  const existing = readAllVocab_();
  const seen = {};
  existing.forEach(function(w) {
    seen[String(w.traditional).trim()] = true;
  });

  const resp = UrlFetchApp.fetch(TOCFL_JSONL_URL, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Failed to fetch PSeitz/tocfl dataset: HTTP ' + resp.getResponseCode());
  }

  const lines = resp.getContentText().split(/\r?\n/);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (Number(entry.tocfl_level) === Number(level)) {
        const trad = String(entry.text || '').trim();
        if (trad && !seen[trad]) {
          candidates.push(entry);
          seen[trad] = true;
        }
      }
    } catch (e) {
      // skip malformed line
    }
  }

  // Sort by spoken_per_million descending (then written_per_million descending)
  candidates.sort(function(a, b) {
    const sDiff = (Number(b.spoken_per_million) || 0) - (Number(a.spoken_per_million) || 0);
    if (sDiff !== 0) return sDiff;
    return (Number(b.written_per_million) || 0) - (Number(a.written_per_million) || 0);
  });

  const selected = candidates.slice(0, limit);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_VOCAB);

  const newRows = selected.map(function(entry) {
    return [
      'tocfl_' + entry.id,
      entry.text,
      '',
      entry.pinyin || '',
      entry.zhuyin || '',
      '', // English gloss is auto-populated below alongside the pre-generated sentence
      'tocfl',
      entry.tocfl_level,
      entry.spoken_per_million || 0,
      entry.written_per_million || 0,
      'new',
      0,
      0,
      '',
      '',
      0,
      0,
      '',
      '',
      (entry.category || '') + (entry.situation ? ' / ' + entry.situation : ''),
      '',
      ''
    ];
  });

  let promptsGenerated = 0;
  let remainingPrompts = 0;
  if (newRows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, newRows.length, VOCAB_HEADERS.length).setValues(newRows);
    SpreadsheetApp.flush();

    const addedWordsForPrompts = selected.map(function(entry, idx) {
      return {
        _rowIndex: startRow + idx,
        traditional: entry.text,
        pinyin: entry.pinyin || '',
        zhuyin: entry.zhuyin || '',
        tocfl_level: entry.tocfl_level || level,
        english_gloss: '',
        english_prompt: '',
        mandarin_sentence: ''
      };
    });
    const pRes = populateSheetPromptsForWords_(addedWordsForPrompts, getSettings_(), {
      maxExecutionMs: Number(opts.maxExecutionMs || 42000),
      showSheetToast: Boolean(opts.showSheetToast)
    });
    promptsGenerated = pRes.updatedCount;
    remainingPrompts = pRes.remainingCount;
  }

  return {
    ok: true,
    tocflLevel: level,
    addedCount: newRows.length,
    promptsGenerated: promptsGenerated,
    remainingPrompts: remainingPrompts,
    remainingInLevel: Math.max(0, candidates.length - selected.length)
  };
}

/**
 * Builds a lookup map by Traditional Hanzi from `PSeitz/tocfl` to enrich Hanping imports
 * with Zhuyin, TOCFL level, and spoken/written frequency.
 */
function fetchTocflLookupMap_() {
  const resp = UrlFetchApp.fetch(TOCFL_JSONL_URL, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return {};
  const lines = resp.getContentText().split(/\r?\n/);
  const map = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && entry.text && !map[entry.text]) {
        map[entry.text] = entry;
      }
    } catch (e) {}
  }
  return map;
}
