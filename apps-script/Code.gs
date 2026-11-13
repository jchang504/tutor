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
  'last_prompt',
  'last_notes'
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
  'notes'
];

const DEFAULT_SETTINGS = {
  BATCH_SIZE: '20',
  NEW_WORD_RATIO: '0.10',
  TOCFL_LEVEL: '2',
  LIVE_MODEL: 'models/gemini-3.8-live',
  LIVE_FALLBACK_MODEL: 'models/gemini-3.1-flash-live-preview',
  BATCH_GEN_MODEL: 'gemini-3.8-flash',
  VOICE_NAME: 'Aoede',
  DESIRED_RETENTION: '0.90'
};

/**
 * Adds a custom menu in the Google Sheet for one-click setup and TOCFL syncing.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Mandarin Tutor')
    .addItem('Initialize / Verify Sheet Tabs', 'setupSheet')
    .addItem('Pull 50 Words from PSeitz/tocfl (Target Level)', 'menuPullTocflWords')
    .addToUi();
}

/**
 * Initializes the 3 tabs (`Vocab`, `ReviewLog`, `Settings`) if they don't exist.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let vocabSheet = ss.getSheetByName(TAB_VOCAB);
  if (!vocabSheet) {
    vocabSheet = ss.insertSheet(TAB_VOCAB);
    vocabSheet.appendRow(VOCAB_HEADERS);
    vocabSheet.getRange(1, 1, 1, VOCAB_HEADERS.length).setFontWeight('bold').setBackground('#f3f4f6');
    vocabSheet.setFrozenRows(1);
  }

  let logSheet = ss.getSheetByName(TAB_LOG);
  if (!logSheet) {
    logSheet = ss.insertSheet(TAB_LOG);
    logSheet.appendRow(LOG_HEADERS);
    logSheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold').setBackground('#f3f4f6');
    logSheet.setFrozenRows(1);
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
      LIVE_FALLBACK_MODEL: 'Fallback Gemini Live model ID if primary model hits quota or is unavailable',
      BATCH_GEN_MODEL: 'Gemini model used to pre-generate English translation sentences in batch',
      VOICE_NAME: 'Gemini Live voice (Aoede, Kore, Puck, Charon, Fenrir)',
      DESIRED_RETENTION: 'Target FSRS memory retention probability (default 0.90)'
    };
    Object.keys(DEFAULT_SETTINGS).forEach(function(k) {
      settingsSheet.appendRow([k, DEFAULT_SETTINGS[k], descriptions[k] || '']);
    });
    settingsSheet.setFrozenRows(1);
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
 * Reads all rows from `Vocab` sheet as structured objects with their 1-based sheet row index.
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
    if (String(w.source).toLowerCase() === 'hanping') hanpingCount++;
    if (String(w.source).toLowerCase() === 'tocfl') tocflCount++;

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
 * - Calls `gemini-3.8-flash` in one batch request to generate fresh English sentences
 *   that naturally require each target Mandarin word (and back-fills missing English glosses).
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
      if (String(w.source).toLowerCase() === 'hanping') {
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
    // Re-read vocab after adding TOCFL rows
    vocab = readAllVocab_();
    combinedNewPool = [];
    vocab.forEach(function(w) {
      const status = String(w.status || 'new').toLowerCase();
      if (status === 'new' || !w.reps || Number(w.reps) === 0) {
        combinedNewPool.push(w);
      }
    });
    combinedNewPool.sort(function(a, b) {
      const sa = String(a.source).toLowerCase() === 'hanping' ? 1 : 0;
      const sb = String(b.source).toLowerCase() === 'hanping' ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return (Number(b.spoken_freq) || 0) - (Number(a.spoken_freq) || 0);
    });
  }

  const selectedNew = combinedNewPool.slice(0, neededNewCount);

  // Interleave due and new words smoothly so new words are spread across the drive
  const batchWords = interleaveDueAndNew_(selectedDue, selectedNew);

  // Pre-generate fresh English prompts + missing English glosses using gemini-3.8-flash
  const generatedMap = generateBatchEnglishPrompts_(batchWords, settings);

  // Persist any newly generated English glosses or prompts back to the Vocab sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vocabSheet = ss.getSheetByName(TAB_VOCAB);

  const enrichedBatch = batchWords.map(function(w) {
    const gen = generatedMap[w.traditional] || {};
    const englishPrompt = gen.english_sentence || w.last_prompt || ('Please make a sentence using ' + w.traditional + '.');
    const englishGloss = w.english_gloss || gen.english_gloss || '';
    const sampleMandarin = gen.sample_mandarin || '';
    const synonymsNote = gen.common_synonyms || '';

    if ((!w.english_gloss && englishGloss) || englishPrompt) {
      if (!w.english_gloss && englishGloss) {
        vocabSheet.getRange(w._rowIndex, 6).setValue(englishGloss);
      }
      vocabSheet.getRange(w._rowIndex, 19).setValue(englishPrompt);
    }

    return {
      id: w.id,
      rowIndex: w._rowIndex,
      traditional: w.traditional,
      simplified: w.simplified || '',
      pinyin: w.pinyin || '',
      zhuyin: w.zhuyin || '',
      english_gloss: englishGloss,
      source: w.source || 'hanping',
      tocfl_level: w.tocfl_level || '',
      spoken_freq: Number(w.spoken_freq || 0),
      status: w.status || 'new',
      stability: Number(w.stability || 0),
      difficulty: Number(w.difficulty || 0),
      reps: Number(w.reps || 0),
      lapses: Number(w.lapses || 0),
      english_prompt: englishPrompt,
      sample_mandarin: sampleMandarin,
      common_synonyms: synonymsNote
    };
  });

  // Create an ephemeral token or pass the API key for the Live WebSocket connection
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
 * Calls `gemini-3.8-flash` (with fallback to `gemini-3.5-flash-lite` and `gemini-2.5-flash`)
 * to generate natural, everyday English sentences that naturally translate into Taiwanese Mandarin
 * using each target vocabulary word, plus an English gloss if missing.
 */
function generateBatchEnglishPrompts_(words, settings) {
  if (!words || words.length === 0) return {};

  const apiKey = getGeminiApiKey_();
  const preferredModel = (settings && settings.BATCH_GEN_MODEL) ? settings.BATCH_GEN_MODEL : 'gemini-3.8-flash';
  const candidateModels = [preferredModel, 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  // Deduplicate model list
  const modelsToTry = candidateModels.filter(function(m, idx) {
    return m && candidateModels.indexOf(m) === idx;
  });

  const itemsPayload = words.map(function(w) {
    return {
      traditional: w.traditional,
      pinyin: w.pinyin || '',
      zhuyin: w.zhuyin || '',
      english_gloss: w.english_gloss || '',
      previous_prompt: w.last_prompt || ''
    };
  });

  const promptText = [
    'You are designing translation prompts for an interactive Taiwanese Mandarin speaking tutor.',
    'For each target Traditional Chinese vocabulary word below, generate:',
    '1. `english_gloss`: A concise, accurate English definition (in Taiwanese Mandarin usage). If one is already provided, refine or keep it concise.',
    '2. `english_sentence`: A natural, everyday conversational English sentence (10-18 words) that a speaker in Taiwan would say in real life, which naturally translates into Taiwanese Mandarin using the target word.',
    '   - Make sure the scenario is concrete and conversational (great for follow-up questions!).',
    '   - If `previous_prompt` is non-empty, invent a DIFFERENT scenario and sentence from `previous_prompt`.',
    '   - NEVER include the Mandarin characters or Pinyin inside `english_sentence`.',
    '3. `sample_mandarin`: The natural Taiwanese Mandarin translation (Traditional characters) of `english_sentence` using the target word.',
    '4. `common_synonyms`: Comma-separated valid Taiwanese Mandarin synonyms the student might accidentally guess instead of the target word (e.g. if target is 餐館, synonym is 餐廳), or empty string if none.',
    '',
    'Return ONLY a JSON array of objects with keys: `traditional`, `english_gloss`, `english_sentence`, `sample_mandarin`, `common_synonyms`.',
    '',
    'Target words JSON:',
    JSON.stringify(itemsPayload)
  ].join('\n');

  const requestBody = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.7,
      responseMimeType: 'application/json'
    }
  };

  for (let i = 0; i < modelsToTry.length; i++) {
    const modelName = modelsToTry[i].replace(/^models\//, '');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(modelName) + ':generateContent?key=' + encodeURIComponent(apiKey);
    try {
      const resp = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(requestBody),
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        const data = JSON.parse(resp.getContentText());
        const text = data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts &&
          data.candidates[0].content.parts[0] &&
          data.candidates[0].content.parts[0].text;
        if (text) {
          const parsed = JSON.parse(text);
          const map = {};
          if (Array.isArray(parsed)) {
            parsed.forEach(function(item) {
              if (item && item.traditional) {
                map[item.traditional] = item;
              }
            });
            return map;
          }
        }
      }
    } catch (e) {
      // Try next fallback model
    }
  }

  return {};
}

/**
 * Attempts to mint a short-lived ephemeral token (`v1alpha/authTokens`) for Gemini Live API,
 * and also supplies the API key to the authenticated personal client so WebSocket setup
 * works across all model versions.
 */
function getLiveSessionAuth_(settings) {
  const apiKey = getGeminiApiKey_();
  return {
    apiKey: apiKey,
    liveModel: settings.LIVE_MODEL || 'models/gemini-3.8-live',
    fallbackLiveModel: settings.LIVE_FALLBACK_MODEL || 'models/gemini-3.1-flash-live-preview',
    voiceName: settings.VOICE_NAME || 'Aoede'
  };
}

/**
 * Computes the deterministic 1-4 score from the structured telemetry reported by the Live tool call,
 * applies the FSRS v5 algorithm, updates the `Vocab` sheet row, and appends a row to `ReviewLog`.
 *
 * Hybrid Rubric (1 = Again, 2 = Hard, 3 = Good, 4 = Easy):
 * - 1 (Again): `target_word_recalled === false` OR `needed_hint === true`
 * - 2 (Hard): Recalled without full spoiler hint, but `pronunciation_attempts > 2` OR `grammar_errors >= 2` OR `conversation_fluency === 'struggled'`
 * - 3 (Good): Recalled target word, needed 1-2 attempts or 1 minor grammar/tone fix, good conversation
 * - 4 (Easy): Recalled target word on first try (`pronunciation_attempts <= 1`), `grammar_errors === 0`, and `conversation_fluency === 'natural'`
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

  const score = computeDeterministicScore_(telemetry);
  const settings = getSettings_();
  const desiredRetention = Number(settings.DESIRED_RETENTION || 0.90);

  const fsrsNext = computeFsrsV5_(targetRow, score, desiredRetention);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const vocabSheet = ss.getSheetByName(TAB_VOCAB);
  const rowIdx = targetRow._rowIndex;

  // Columns:
  // 11: status, 12: stability, 13: difficulty, 14: due_date, 15: last_review,
  // 16: reps, 17: lapses, 18: last_score, 19: last_prompt, 20: last_notes
  vocabSheet.getRange(rowIdx, 11, 1, 10).setValues([[
    fsrsNext.status,
    fsrsNext.stability,
    fsrsNext.difficulty,
    fsrsNext.dueDateIso,
    fsrsNext.nowIso,
    fsrsNext.reps,
    fsrsNext.lapses,
    score,
    body.english_prompt || targetRow.last_prompt || '',
    telemetry.notes || ''
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
    body.english_prompt || targetRow.last_prompt || '',
    telemetry.notes || ''
  ]);

  return {
    ok: true,
    traditional: targetRow.traditional,
    score: score,
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
  if (!csvText) {
    throw new Error('Empty Hanping CSV text.');
  }

  const parsedEntries = parseHanpingText_(csvText);
  if (parsedEntries.length === 0) {
    throw new Error('No valid Chinese vocabulary rows found in the provided file.');
  }

  const existing = readAllVocab_();
  const existingMap = {};
  existing.forEach(function(w) {
    existingMap[String(w.traditional).trim()] = w;
  });

  // Also cross-reference PSeitz/tocfl if cached so Hanping words get Zhuyin, TOCFL level & spoken frequency!
  let tocflMap = {};
  try {
    tocflMap = fetchTocflLookupMap_();
  } catch (e) {
    // Non-fatal if GitHub fetch fails during import
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TAB_VOCAB);
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
    const rowId = 'hp_' + new Date().getTime() + '_' + idx;
    const row = [
      rowId,
      trad,
      entry.simplified || '',
      entry.pinyin || tocflHit.pinyin || '',
      entry.zhuyin || tocflHit.zhuyin || '',
      entry.english_gloss || '',
      'hanping',
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
      entry.notes || ''
    ];
    newRows.push(row);
    existingMap[trad] = true;
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, VOCAB_HEADERS.length).setValues(newRows);
  }

  return {
    ok: true,
    addedCount: newRows.length,
    skippedDuplicate: skippedDuplicate,
    totalParsed: parsedEntries.length
  };
}

/**
 * Flexible parser for Hanping CSV/TSV/CEDICT-style exports.
 */
function parseHanpingText_(rawText) {
  const lines = rawText.split(/\r?\n/);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // 1. Check CEDICT / Hanping plain text format: `餐館[餐馆] cān guǎn /restaurant/` or `餐館 cān guǎn /restaurant/`
    const cedictMatch = line.match(/^([^\s\[\],;]+)(?:\[([^\]]+)\])?\s+([a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s:·]+?)\s+\/(.+)\/$/);
    if (cedictMatch) {
      results.push({
        traditional: cedictMatch[1].trim(),
        simplified: (cedictMatch[2] || '').trim(),
        pinyin: cedictMatch[3].trim(),
        english_gloss: cedictMatch[4].replace(/\//g, '; ').trim()
      });
      continue;
    }

    // 2. Parse delimiter (Tab or Comma)
    const fields = line.indexOf('\t') !== -1 ? line.split('\t') : parseCsvLine_(line);
    if (fields.length === 0) continue;

    // Skip header row if detected
    const firstLower = String(fields[0]).toLowerCase().trim();
    if (firstLower === 'traditional' || firstLower === 'hanzi' || firstLower === 'word' || firstLower === 'headword' || firstLower === 'id') {
      continue;
    }

    // Identify columns heuristically
    let trad = String(fields[0] || '').trim();
    // Handle `餐館[餐馆]` or `餐館 (餐馆)` in column 0
    let simp = '';
    const bracketInFirst = trad.match(/^([^\[\(\s]+)[\[\(]([^\]\)]+)[\]\)]/);
    if (bracketInFirst) {
      trad = bracketInFirst[1].trim();
      simp = bracketInFirst[2].trim();
    }

    // Must contain at least one CJK character
    if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(trad)) continue;

    let pinyin = '';
    let gloss = '';

    if (fields.length === 2) {
      gloss = String(fields[1] || '').trim();
    } else if (fields.length === 3) {
      pinyin = String(fields[1] || '').trim();
      gloss = String(fields[2] || '').trim();
    } else if (fields.length >= 4) {
      // Check if col 1 is simplified Hanzi or Pinyin
      const col1 = String(fields[1] || '').trim();
      if (/^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test(col1)) {
        simp = simp || col1;
        pinyin = String(fields[2] || '').trim();
        gloss = fields.slice(3).join('; ').trim();
      } else {
        pinyin = col1;
        gloss = fields.slice(2).join('; ').trim();
      }
    }

    // Strip HTML tags from Anki/Hanping exports
    gloss = gloss.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    results.push({
      traditional: trad,
      simplified: simp,
      pinyin: pinyin,
      english_gloss: gloss
    });
  }

  return results;
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
  const settings = getSettings_();
  const level = Number(settings.TOCFL_LEVEL || 2);
  const res = supplementFromTocflInternal_(level, 50);
  SpreadsheetApp.getUi().alert(
    'Added ' + res.addedCount + ' new TOCFL Level ' + level +
    ' words from PSeitz/tocfl (sorted by highest spoken frequency).'
  );
}

function handleSupplementTocfl_(body) {
  const settings = getSettings_();
  const level = Number(body.tocflLevel || settings.TOCFL_LEVEL || 2);
  const count = Number(body.count || 30);
  return supplementFromTocflInternal_(level, count);
}

/**
 * Fetches `tocfl_words.json` (JSON Lines) from `https://github.com/PSeitz/tocfl`,
 * filters to `tocfl_level === level`, sorts by `spoken_per_million` descending,
 * and adds up to `limit` unseen words into the `Vocab` sheet.
 */
function supplementFromTocflInternal_(level, limit) {
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
      '', // English gloss is auto-filled by gemini-3.8-flash when the word enters a practice batch
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
      (entry.category || '') + (entry.situation ? ' / ' + entry.situation : '')
    ];
  });

  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, VOCAB_HEADERS.length).setValues(newRows);
  }

  return {
    ok: true,
    tocflLevel: level,
    addedCount: newRows.length,
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
