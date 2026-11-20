/**
 * Taiwanese Mandarin Voice Tutor — Main Application Controller (app.js)
 *
 * Coordinates:
 * - Google Apps Script (`doPost`) client using `Content-Type: text/plain;charset=utf-8`
 *   to avoid CORS OPTIONS preflight issues while keeping backend data strictly gated
 *   by the personal `BACKEND_SECRET`.
 * - Deterministic 20-word batch loop (default 10% new words, filling with new words
 *   when fewer reviews are due).
 * - Fresh Gemini Live WebSocket connection per word (zero context degradation).
 * - Screen Wake Lock (`navigator.wakeLock.request('screen')`) + MediaSession API
 *   so car steering-wheel Next / Play / Pause buttons control the tutor hands-free.
 * - Hanping CSV file importer & `PSeitz/tocfl` supplemental word puller.
 */

import { computeDeterministicScore, computeFsrsV5, scoreLabel } from './fsrs.js';
import { APP_VERSION, debugLogger } from './debug-logger.js?v=24';
import {
  ENABLE_USER_ASK_BACK_FLOW,
  GeminiLiveVoicePipeline
} from './live-audio.js?v=24';
import { numberedPinyinToToneMarks } from './pinyin-utils.js?v=24';
import { SAMPLE_TAIWAN_BATCH } from './sample-vocab.js';

function escapeRegExp(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compactRubricSummary(t = {}) {
  if (!t || typeof t !== 'object') return {};
  return {
    recalled: Boolean(t.recalled_target_without_hint),
    ...(t.used_synonym_first ? { synonymFirst: true } : {}),
    ...(t.needed_hint ? { hint: true } : {}),
    ...(t.minor_grammar_or_tone_fix ? { minorFix: true } : {}),
    ...(t.major_mistake ? { majorMistake: true } : {}),
    ...(t.notes ? { notes: String(t.notes).slice(0, 90) } : {})
  };
}

function hasMorphologicalRootOfTarget(userTxt = '', target = '') {
  const u = String(userTxt || '');
  const t = String(target || '').trim();
  if (!u || t.length < 3 || u.includes(t)) return false;
  const prefix = t.slice(0, t.length - 1);
  const suffix = t.slice(1);
  return (prefix.length >= 2 && u.includes(prefix)) || (suffix.length >= 2 && u.includes(suffix));
}

/**
 * Inspects completed dialogue turns across BOTH Phase 1 (translation) and Phase 3
 * (follow-up question reply) to separate:
 * - Benign synonym redirects (student used a valid synonym or morphological variant like `這樣` for `這樣子`
 *   while target word was hidden, then used target word cleanly — even if the tutor gave a disambiguating clue
 *   or named `targetTraditional` while redirecting from that praised synonym) -> MUST score 4 (`Easy`)!
 * - Corrections on NON-target words or general Phase 3 sentence structure (tone/pronunciation fixes,
 *   measure-word/grammar tweaks, full-sentence grammar remodels, or English-to-Mandarin word translations
 *   where `targetTraditional` itself was not the error) -> MUST NOT penalize the FSRS score for the target word!
 * - Real spoiler hints / surrenders or real pronunciation/tone/grammar corrections on `targetTraditional` itself.
 */
export function analyzeTurnCorrections(wordTurns = [], targetTraditional = '') {
  const turns = (Array.isArray(wordTurns) ? wordTurns : []).filter(
    (item) => item && String(item.text || '').trim()
  );
  const target = String(targetTraditional || '').trim();
  const targetChars = target ? Array.from(new Set([...target])) : [];
  const escapedCharClass = targetChars.map((ch) => escapeRegExp(ch)).join('');

  const surrenderRe =
    /給我提示|\bhint\b|給我答案|直接告訴我|我不知道|不知道怎麼翻|整句怎麼說|想不起來|忘了怎麼說/i;
  const repeatRequestRe =
    /^(再說一次|再講一次|再唸一次|請再說一次|請再講一次|請重複一次|重複一次|可以再說一次嗎|沒聽清楚|聽不清楚|再聽一次|再說一次英文|repeat|say that again|repeat that|can you repeat that)[。！？!?\s]*$/i;

  let synonymRedirects = 0;
  let nonTargetCorrections = 0;
  let pronunciationCorrections = 0;
  let grammarCorrections = 0;
  let tutorRevealedTargetWord = false;
  let tutorGaveSpoilerHint = false;
  let userAskedForTargetHint = false;
  let seenTutorTurns = 0;
  let studentProducedTargetSoFar = false;
  let inFollowUpPhase = false;
  let phase1CompletedWithoutSpoiler = false;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t || !t.text) continue;

    if (t.role === 'user') {
      if (!inFollowUpPhase && !studentProducedTargetSoFar && surrenderRe.test(t.text)) {
        if (!(target && t.text.includes(target))) {
          userAskedForTargetHint = true;
        }
      }
      if (
        target &&
        t.text.includes(target) &&
        !tutorRevealedTargetWord &&
        !tutorGaveSpoilerHint &&
        !userAskedForTargetHint
      ) {
        studentProducedTargetSoFar = true;
      }
      continue;
    }

    if (t.role !== 'tutor') continue;
    seenTutorTurns += 1;
    if (seenTutorTurns === 1) continue; // Skip initial Phase 1 English prompt turn

    // If the user pressed the Repeat button (two consecutive tutor turns with no user turn in between),
    // never double-count the repeated prompt as an extra error!
    const immediatePrevTurn = i > 0 ? turns[i - 1] : null;
    if (immediatePrevTurn && immediatePrevTurn.role === 'tutor') {
      continue;
    }

    const txt = t.text;
    const isRetryTurn =
      /把這句話翻成中文|翻成中文|再說一次|再完整說一次|重新說一次|再唸一次|整句話|整句說|整句回答|把你的回答|完整的句子|試著用|試著換|換成(我們)?今天|換成另|給你一點提示|提示你一下/.test(
        txt
      );

    const hasQuestionSignal =
      /[？?]|什麼|甚麼|哪裡|哪兒|哪個|哪一種|哪邊|怎麼|怎樣|為什麼|還是|有沒有|嗎|呢|多久|幾點|幾次|幾個|多少|誰|([一-龥])不\1|([一-龥])沒\2|喜不喜歡|可不可以|會不會|能不能|常不常|是不是|對不對|好不好/.test(
        txt
      );

    // Detect transition into Phase 2 follow-up question (first non-retry tutor turn asking a question)
    if (!inFollowUpPhase && !isRetryTurn && hasQuestionSignal) {
      inFollowUpPhase = true;
      if (!tutorRevealedTargetWord && !tutorGaveSpoilerHint && !userAskedForTargetHint) {
        phase1CompletedWithoutSpoiler = true;
      }
      continue;
    }

    let prevUserTxt = '';
    for (let j = i - 1; j >= 0; j--) {
      if (turns[j] && turns[j].role === 'user' && turns[j].text) {
        prevUserTxt = turns[j].text;
        break;
      }
    }

    // If the student merely asked the tutor to repeat its last prompt due to road noise (`再說一次` / `Repeat`),
    // the tutor's repeated prompt is NOT a new mistake or spoiler!
    if (repeatRequestRe.test(prevUserTxt.trim())) {
      continue;
    }

    const prevUserHadTarget = target ? prevUserTxt.includes(target) : false;
    const prevUserSurrendered = surrenderRe.test(prevUserTxt);
    const prevUserHasMandarin = /[\u4e00-\u9fff]{2,}/.test(prevUserTxt);
    const prevUserHasEnglish = /[A-Za-z]{2,}/.test(prevUserTxt);
    const prevUserHasRootVariant = hasMorphologicalRootOfTarget(prevUserTxt, target);
    const tutorUtteredTarget = Boolean(target && txt.includes(target));
    const isMeaningNegated =
      /意思不太對|意思不對|不太一樣|意思不同|不是這個意思|語法錯了|結構錯了/.test(txt);
    const hasOmissionCue = /漏了|少了|沒說到|沒有說出|忘了說/.test(txt);

    const hasEquivalencePraise =
      !isMeaningNegated &&
      /也可以|意思差不多|意思很接近|意思相近|意思一樣|意思完全對|意思對|完全沒問題|沒問題|很自然|很道地|很棒|很好|不錯|對了|近義詞|同義詞/.test(
        txt
      );
    const hasTargetSwapCue =
      /換成|換一個|換用|另一個|另外一個|今天(要|想)練|要練習的|這張卡片|目標詞|我們今天/.test(txt);
    const isDirectTargetSwapPrompt =
      !isMeaningNegated &&
      /換成(我們)?今天|換成另(外)?一個.*詞|試著(用|換|換成)(我們)?(今天|另)|要練習的(目標|另一個|那)?詞|今天(要|想)練(習)?的.*詞/.test(
        txt
      );
    const hasRootVariantSwapCue =
      prevUserHasRootVariant &&
      !hasOmissionCue &&
      /加一個|多加|多一個|三個字|四個字|口語裡|換成|今天(要|想)練|要練習/.test(txt);

    // If the tutor explicitly praises the student for having JUST spoken `target` (even if speech-to-text ASR
    // homophoned or dropped a character in `prevUserTxt`!), that proves the student recalled `target`!
    const tutorPraisedStudentTarget = Boolean(
      target &&
        !isMeaningNegated &&
        !hasOmissionCue &&
        !prevUserSurrendered &&
        !hasTargetSwapCue &&
        (new RegExp(
          `「?${escapeRegExp(target)}」?[^。！？!?，,；;]{0,8}(?:用得|說得|唸得|發音)?(?:很好|很棒|很自然|很標準|對了|沒問題|正確|非常標準)`
        ).test(txt) ||
          new RegExp(`(?:對|沒錯|很好)[，,！!\\s]*(?:就是)?「${escapeRegExp(target)}」`).test(txt))
    );
    if (
      tutorPraisedStudentTarget &&
      !tutorRevealedTargetWord &&
      !tutorGaveSpoilerHint &&
      !userAskedForTargetHint
    ) {
      studentProducedTargetSoFar = true;
    }

    const isSynonymRedirect =
      !inFollowUpPhase &&
      !prevUserHadTarget &&
      !prevUserSurrendered &&
      !prevUserHasEnglish &&
      !isMeaningNegated &&
      !hasOmissionCue &&
      ((prevUserHasMandarin && hasEquivalencePraise && hasTargetSwapCue) ||
        (!tutorUtteredTarget && isDirectTargetSwapPrompt) ||
        hasRootVariantSwapCue) &&
      /再說一次|再完整說一次|重新說一次|試著|換成|換一個|加一個|多加|整句|怎麼說|說說看/.test(txt);

    // A synonym redirect occurs when the student already produced a valid Mandarin synonym/variant on Attempt 1,
    // so it NEVER counts as a target-word spoiler, pronunciation error, or grammar error!
    if (isSynonymRedirect) {
      synonymRedirects += 1;
      continue;
    }

    // Did the tutor have to utter/reveal the target word itself in a Phase 1 retry before the student recalled it?
    if (
      target &&
      !inFollowUpPhase &&
      !studentProducedTargetSoFar &&
      !prevUserHadTarget &&
      tutorUtteredTarget &&
      (isRetryTurn || prevUserSurrendered || !prevUserTxt)
    ) {
      tutorRevealedTargetWord = true;
    }

    // Did the tutor give an explicit spoiler hint on a NON-synonym turn before the student recalled the target word?
    if (
      !inFollowUpPhase &&
      !studentProducedTargetSoFar &&
      !prevUserHadTarget &&
      /給你一點提示|提示你一下/.test(txt)
    ) {
      tutorGaveSpoilerHint = true;
    }

    const strippedPraise = txt.replace(/發音很(標準|好|清楚|自然|正確)|發音沒問題/g, '');

    // Strip clauses that explicitly praise the target word (e.g. `「經常」用得很好，不過...`)
    const strippedTargetPraise = target
      ? strippedPraise.replace(
          new RegExp(
            `「?${escapeRegExp(target)}」?[^。！？!?，,；;]{0,10}(很好|很自然|很標準|對了|沒問題|正確)`,
            'g'
          ),
          ''
        )
      : strippedPraise;

    // Strip full-sentence model quotes (`「...」` longer than target + 2 chars) so quoting a full corrected
    // sentence that merely includes `target` in context doesn't falsely blame `target` itself
    const strippedLongSentenceQuotes = target
      ? strippedTargetPraise.replace(/「([^」]+)」/g, (m, inner) =>
          inner.trim().length > target.length + 2 ? '' : m
        )
      : strippedTargetPraise;

    const isEnglishWordLookup =
      /[A-Za-z]{2,}/.test(prevUserTxt) ||
      /中文(我們)?(可以)?(說|叫|是)|在台灣我們(常)?說/.test(txt);

    const hasToneOrPronFix =
      /聲調|幾聲|一聲|二聲|三聲|四聲|輕聲|唸成|唸錯|讀音|發音不|發音有誤|發音要|注意.*發音/.test(
        strippedPraise
      );

    const hasRealGrammarFix =
      /語法|語序|量詞|不通順|漏了|少了|句子可以改成|不能這樣用|完整的一句話|完整的句子/.test(txt) ||
      (!hasToneOrPronFix &&
        /比較自然|再完整說一次|重新說一次|整句話再說一次|整句回答|把整句/.test(txt));

    if (hasToneOrPronFix) {
      if (target) {
        const quotedTargetCharRe = escapedCharClass
          ? new RegExp(`「[${escapedCharClass}]+」`)
          : null;
        const standaloneTargetCharToneRe = escapedCharClass
          ? new RegExp(
              `(?<![\\u4e00-\\u9fff])[${escapedCharClass}](?:這個字|的聲調|的發音|要唸|是[一二三四輕]聲|唸[一二三四輕]聲)`
            )
          : null;
        const mentionsTargetCharInError =
          (target.length >= 2 && strippedLongSentenceQuotes.includes(target)) ||
          Boolean(quotedTargetCharRe && quotedTargetCharRe.test(strippedLongSentenceQuotes)) ||
          Boolean(
            standaloneTargetCharToneRe && standaloneTargetCharToneRe.test(strippedLongSentenceQuotes)
          );
        if (
          !mentionsTargetCharInError &&
          (inFollowUpPhase || prevUserHadTarget || studentProducedTargetSoFar)
        ) {
          nonTargetCorrections += 1;
          continue;
        }
      }
      pronunciationCorrections += 1;
      continue;
    }

    if (hasRealGrammarFix || (isEnglishWordLookup && /再說一次|整句/.test(txt))) {
      if (target) {
        const mentionsTargetInGrammarError =
          target.length >= 2
            ? strippedLongSentenceQuotes.includes(target)
            : new RegExp(
                `「${escapeRegExp(target)}」|(?<![\\u4e00-\\u9fff])${escapeRegExp(target)}(?:這個字|的位置|要放在|後面|前面|不能)`
              ).test(strippedLongSentenceQuotes);
        if (
          !mentionsTargetInGrammarError &&
          (inFollowUpPhase || prevUserHadTarget || studentProducedTargetSoFar)
        ) {
          nonTargetCorrections += 1;
          continue;
        }
      }
      grammarCorrections += 1;
    }
  }

  const studentRecalledWithoutSpoiler = Boolean(
    (studentProducedTargetSoFar || phase1CompletedWithoutSpoiler) &&
      !tutorRevealedTargetWord &&
      !tutorGaveSpoilerHint &&
      !userAskedForTargetHint
  );

  return {
    synonymRedirects,
    nonTargetCorrections,
    tutorRevealedTargetWord,
    tutorGaveSpoilerHint,
    userAskedForTargetHint,
    studentRecalledWithoutSpoiler,
    pronunciationCorrections,
    grammarCorrections,
    totalFixes: pronunciationCorrections + grammarCorrections
  };
}

/**
 * Instant, deterministic 0ms FSRS rubric derivation from the completed spoken word dialogue.
 * Used immediately when the tutor speaks `「好，我們看下一題！」` so the next word starts right away,
 * and serves as the fallback if background REST JSON grading is offline or times out.
 */
export function deriveHeuristicTelemetryFromTurns(
  word = {},
  wordTurns = [],
  usedHintButton = false,
  peeked = false
) {
  const turns = Array.isArray(wordTurns) ? wordTurns : [];
  const target = String(word.traditional || '').trim();

  const {
    synonymRedirects,
    nonTargetCorrections,
    tutorRevealedTargetWord,
    tutorGaveSpoilerHint,
    userAskedForTargetHint,
    pronunciationCorrections,
    grammarCorrections,
    totalFixes
  } = analyzeTurnCorrections(turns, target);

  const neededHint = Boolean(
    usedHintButton ||
      peeked ||
      userAskedForTargetHint ||
      tutorGaveSpoilerHint ||
      tutorRevealedTargetWord
  );

  const pronunciationAttempts = 1 + pronunciationCorrections;
  const fluency =
    totalFixes >= 3 || (neededHint && totalFixes >= 2)
      ? 'struggled'
      : totalFixes >= 1
      ? 'good'
      : 'natural';

  let notes = 'Clean recall & natural conversation';
  if (neededHint) {
    notes = usedHintButton
      ? 'Used Hint button'
      : peeked
      ? 'Peeked target word'
      : tutorRevealedTargetWord
      ? 'Needed Mandarin for target word'
      : 'Requested hint';
  } else if (pronunciationCorrections > 0 && grammarCorrections > 0) {
    notes = 'Practiced target tones & usage';
  } else if (pronunciationCorrections > 0) {
    notes = 'Practiced target word tones';
  } else if (grammarCorrections > 0) {
    notes = 'Refined target word usage';
  } else if (synonymRedirects > 0) {
    notes = 'Used synonym first, then target word cleanly';
  } else if (nonTargetCorrections > 0) {
    notes = 'Target word clean (polished other words)';
  }

  return {
    target_word_recalled: !neededHint,
    needed_hint: neededHint,
    pronunciation_attempts: pronunciationAttempts,
    grammar_errors: grammarCorrections,
    conversation_fluency: fluency,
    notes
  };
}

/**
 * Deterministic post-normalization of the AI JSON grader output:
 * Ensures that:
 * 1. Benign synonym redirects on Attempt 1 (even with disambiguating clues from the tutor) -> Score 4 (`Easy`).
 * 2. Pronunciation, grammar, or English-word corrections strictly on OTHER words besides `targetTraditional`
 *    NEVER penalize the target word's FSRS score -> Score 4 (`Easy`).
 * 3. Ground-truth unassisted recall (student spoke `targetTraditional` without Hint/Peek, without surrendering,
 *    and without the tutor uttering `targetTraditional`) can NEVER be downgraded to Score 1 (`Again`) by LLM hallucination!
 */
export function normalizeAiGradingTelemetry(
  parsed = {},
  wordTurns = [],
  fallbackTelemetry = {},
  forceNeededHint = false,
  targetTraditional = ''
) {
  const turnAnalysis = analyzeTurnCorrections(wordTurns, targetTraditional);
  const hardSpoilerOccurred = Boolean(
    forceNeededHint ||
      turnAnalysis.userAskedForTargetHint ||
      turnAnalysis.tutorGaveSpoilerHint ||
      turnAnalysis.tutorRevealedTargetWord
  );

  const verifiedUnassistedRecall =
    !hardSpoilerOccurred &&
    (turnAnalysis.studentRecalledWithoutSpoiler ||
      turnAnalysis.synonymRedirects > 0 ||
      parsed.synonym_redirect_only === true ||
      parsed.non_target_corrections_only === true);

  const neededHint = hardSpoilerOccurred
    ? true
    : verifiedUnassistedRecall
    ? false
    : Boolean(parsed.needed_hint);

  const isCleanSynonymRedirectOnly =
    !neededHint &&
    (parsed.synonym_redirect_only === true ||
      (turnAnalysis.synonymRedirects > 0 && turnAnalysis.totalFixes === 0));

  const isNonTargetCorrectionsOnly =
    !neededHint &&
    (parsed.non_target_corrections_only === true ||
      (Boolean(targetTraditional) &&
        turnAnalysis.nonTargetCorrections > 0 &&
        turnAnalysis.totalFixes === 0));

  if (isCleanSynonymRedirectOnly || isNonTargetCorrectionsOnly) {
    const defaultNote = isCleanSynonymRedirectOnly
      ? 'Used synonym first, then target word cleanly'
      : 'Target word clean (polished other words)';
    return {
      target_word_recalled: true,
      needed_hint: false,
      pronunciation_attempts: 1,
      grammar_errors: 0,
      conversation_fluency: 'natural',
      notes: String(parsed.notes || fallbackTelemetry.notes || defaultNote).slice(0, 60)
    };
  }

  return {
    target_word_recalled: neededHint
      ? false
      : verifiedUnassistedRecall
      ? true
      : parsed.target_word_recalled !== false,
    needed_hint: neededHint,
    pronunciation_attempts: Math.max(1, Number(parsed.pronunciation_attempts) || 1),
    grammar_errors: Math.max(0, Number(parsed.grammar_errors) || 0),
    conversation_fluency: ['natural', 'good', 'struggled'].includes(parsed.conversation_fluency)
      ? parsed.conversation_fluency
      : fallbackTelemetry.conversation_fluency || 'natural',
    notes: String(parsed.notes || fallbackTelemetry.notes || '').slice(0, 60)
  };
}

const STORAGE_KEYS = {
  GAS_URL: 'tw_tutor_gas_url',
  SECRET: 'tw_tutor_backend_secret',
  DIRECT_API_KEY: 'tw_tutor_direct_gemini_key',
  REVEAL_TARGET: 'tw_tutor_reveal_target',
  TOCFL_LEVEL: 'tw_tutor_tocfl_level',
  BATCH_SIZE: 'tw_tutor_batch_size',
  NEW_RATIO: 'tw_tutor_new_ratio',
  VOICE_NAME: 'tw_tutor_voice_name',
  PREFERRED_LIVE_MODEL: 'tw_tutor_preferred_live_model',
  AUDIO_ROUTING_MODE: 'tw_tutor_audio_routing_mode',
  MIC_DEVICE_ID: 'tw_tutor_mic_device_id'
};

export class MandarinTutorApp {
  constructor() {
    this.batch = [];
    this.currentIndex = 0;
    this.sessionActive = false;
    this.sessionPaused = false;
    // Always start each word masked (`Peek Target Word` is strictly per-word so peeking once never forces Score 1 on later words)
    this.revealTarget = false;
    this.peekedInCurrentWord = false;
    localStorage.removeItem(STORAGE_KEYS.REVEAL_TARGET);
    this.isPageUnloading = false;
    this.cachedGradingCandidates = null;
    this.lastScoredWordId = null;
    this.lastMediaKeyPerfMs = -1000;
    this.mediaKeydownBound = false;

    window.addEventListener('beforeunload', () => {
      this.isPageUnloading = true;
    });
    window.addEventListener('pagehide', () => {
      this.isPageUnloading = true;
    });

    this.liveAuth = {
      apiKey: localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '',
      liveModel: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      fallbackLiveModel: 'models/gemini-3.1-flash-live-preview',
      preferredLiveModel: localStorage.getItem(STORAGE_KEYS.PREFERRED_LIVE_MODEL) || 'auto',
      voiceName: localStorage.getItem(STORAGE_KEYS.VOICE_NAME) || 'Aoede'
    };

    this.wakeLockSentinel = null;
    this.transcriptHistory = [];
    this.sessionScores = [];

    this.pipeline = new GeminiLiveVoicePipeline({
      onStateChange: (state, statusText) => this.handlePipelineState(state, statusText),
      onTranscript: (role, text) => this.handleTranscript(role, text),
      onPhaseHint: (phase) => this.setPhaseIndicator(phase),
      onCompleteWord: (completionPayload) => this.handleWordCompleted(completionPayload),
      onSessionControl: (cmd) => this.handleVoiceControlCommand(cmd),
      onAudioLevel: (lvl) => this.updateAudioMeter(lvl),
      onAudioHardwareUpdate: (micInfo, inputs) => this.handleAudioHardwareUpdate(micInfo, inputs),
      onError: (err) => {
        debugLogger.log('error', 'pipeline_error', err.message || String(err));
        this.showToast(err.message || String(err), 'error');
      }
    });

    const rawRouting = localStorage.getItem(STORAGE_KEYS.AUDIO_ROUTING_MODE);
    const savedRouting = rawRouting === 'voice_comm' ? 'voice_comm' : 'bluetooth_hfp';
    if (rawRouting !== savedRouting) {
      localStorage.setItem(STORAGE_KEYS.AUDIO_ROUTING_MODE, savedRouting);
    }
    const savedMicId = localStorage.getItem(STORAGE_KEYS.MIC_DEVICE_ID) || 'auto';
    this.pipeline.setAudioConfig({
      routingMode: savedRouting,
      preferredDeviceId: savedMicId
    });

    this.bindDom();
    this.loadSavedConfigIntoInputs();
    this.handleAudioHardwareUpdate(this.pipeline.activeMicInfo, this.pipeline.enumeratedAudioInputs);
    this.setupDebugLogsSubscription();
    this.setupMediaSessionControls();
    this.setupWakeLockLifecycle();
    debugLogger.log('info', 'app_boot', `Mandarin Driving Tutor ${APP_VERSION} booted`, {
      preferredLiveModel: this.liveAuth.preferredLiveModel,
      voiceName: this.liveAuth.voiceName,
      audioRoutingMode: savedRouting
    });
    this.refreshBackendStatus();
  }

  bindDom() {
    this.els = {
      connectionBadge: document.getElementById('connection-badge'),
      statDue: document.getElementById('stat-due'),
      statNew: document.getElementById('stat-new'),
      statLearned: document.getElementById('stat-learned'),
      statSourceMix: document.getElementById('stat-source-mix'),

      drivingStage: document.getElementById('driving-stage'),
      stageStatusPill: document.getElementById('stage-status-pill'),
      stageProgressText: document.getElementById('stage-progress-text'),
      stageProgressBar: document.getElementById('stage-progress-fill'),
      activeAudioPill: document.getElementById('active-audio-pill'),
      englishPromptText: document.getElementById('english-prompt-text'),
      targetWordBox: document.getElementById('target-word-box'),
      targetHanzi: document.getElementById('target-hanzi'),
      targetPhonetics: document.getElementById('target-phonetics'),
      targetGloss: document.getElementById('target-gloss'),
      targetMetaBadge: document.getElementById('target-meta-badge'),

      phaseSteps: [
        document.getElementById('phase-step-1'),
        document.getElementById('phase-step-2'),
        document.getElementById('phase-step-3'),
        document.getElementById('phase-step-4')
      ],

      voiceOrb: document.getElementById('voice-orb'),
      voiceOrbLabel: document.getElementById('voice-orb-label'),
      liveTranscriptFeed: document.getElementById('live-transcript-feed'),
      lastScoreBanner: document.getElementById('last-score-banner'),

      btnStartDriving: document.getElementById('btn-start-driving'),
      btnDoneSpeaking: document.getElementById('btn-done-speaking'),
      btnPauseResume: document.getElementById('btn-pause-resume'),
      btnRepeatPrompt: document.getElementById('btn-repeat-prompt'),
      btnHint: document.getElementById('btn-ask-hint'),
      btnSkipWord: document.getElementById('btn-skip-word'),
      btnEndSession: document.getElementById('btn-end-session'),
      btnToggleReveal: document.getElementById('btn-toggle-reveal'),

      btnOpenLogs: document.getElementById('btn-open-logs'),
      logsAlertDot: document.getElementById('logs-alert-dot'),
      drawerLogs: document.getElementById('drawer-logs'),
      btnCloseLogs: document.getElementById('btn-close-logs'),
      logsSummaryBox: document.getElementById('logs-summary-box'),
      btnCopyLogsGemini: document.getElementById('btn-copy-logs-gemini'),
      btnShareLogs: document.getElementById('btn-share-logs'),
      btnClearLogs: document.getElementById('btn-clear-logs'),
      selectLogFilter: document.getElementById('select-log-filter'),
      logsViewer: document.getElementById('logs-viewer'),

      btnOpenSettings: document.getElementById('btn-open-settings'),
      btnOpenImport: document.getElementById('btn-open-import'),
      drawerSettings: document.getElementById('drawer-settings'),
      drawerImport: document.getElementById('drawer-import'),
      btnCloseSettings: document.getElementById('btn-close-settings'),
      btnCloseImport: document.getElementById('btn-close-import'),

      inputGasUrl: document.getElementById('input-gas-url'),
      inputSecret: document.getElementById('input-backend-secret'),
      inputDirectKey: document.getElementById('input-direct-gemini-key'),
      inputBatchSize: document.getElementById('input-batch-size'),
      inputNewRatio: document.getElementById('input-new-ratio'),
      inputTocflLevel: document.getElementById('input-tocfl-level'),
      inputVoiceName: document.getElementById('input-voice-name'),
      inputLiveModel: document.getElementById('input-live-model'),
      inputAudioRouting: document.getElementById('input-audio-routing'),
      inputMicDevice: document.getElementById('input-mic-device'),
      btnRefreshMics: document.getElementById('btn-refresh-mics'),
      activeMicStatusHint: document.getElementById('active-mic-status-hint'),
      btnSaveSettings: document.getElementById('input-save-settings') || document.getElementById('btn-save-settings'),
      btnTestConnection: document.getElementById('btn-test-connection'),

      fileHanpingCsv: document.getElementById('file-hanping-csv'),
      selectAnkiTag: document.getElementById('select-anki-tag'),
      inputAnkiTag: document.getElementById('input-anki-tag'),
      ankiTagSummary: document.getElementById('anki-tag-summary'),
      labelPreviewCount: document.getElementById('label-preview-count'),
      chkPruneNonmatching: document.getElementById('chk-prune-nonmatching'),
      textareaHanpingCsv: document.getElementById('textarea-hanping-csv'),
      btnUploadHanping: document.getElementById('btn-upload-hanping'),
      selectSupplementLevel: document.getElementById('select-supplement-level'),
      inputSupplementCount: document.getElementById('input-supplement-count'),
      btnPullTocfl: document.getElementById('btn-pull-tocfl'),
      btnPregeneratePrompts: document.getElementById('btn-pregenerate-prompts'),
      btnNormalizePinyin: document.getElementById('btn-normalize-pinyin'),
      importResultBox: document.getElementById('import-result-box'),

      toastContainer: document.getElementById('toast-container')
    };

    this.rawAnkiFileText = '';

    this.els.btnStartDriving.addEventListener('click', () => this.startDrivingSession());
    if (this.els.btnDoneSpeaking) {
      this.els.btnDoneSpeaking.addEventListener('click', () => {
        this.pipeline.finishUserTurnNow('btn');
      });
    }
    this.els.btnPauseResume.addEventListener('click', () => this.togglePauseSession());
    this.els.btnRepeatPrompt.addEventListener('click', () => {
      this.pipeline.repeatLastTutorPrompt('button');
    });
    this.els.btnHint.addEventListener('click', () => {
      this.pipeline.sendTextCommand(
        '請用簡單、自然慢速的台灣中文給我一點提示，但先不要直接講出整句答案。',
        { isHint: true, tag: 'ask_hint', statusText: 'Asking tutor for a hint...' }
      );
    });
    this.els.btnSkipWord.addEventListener('click', () => this.skipCurrentWord('manual_skip'));
    this.els.btnEndSession.addEventListener('click', () => this.stopDrivingSession());

    this.els.btnToggleReveal.addEventListener('click', () => {
      this.revealTarget = !this.revealTarget;
      if (this.revealTarget && this.sessionActive) {
        const curWord = this.batch[this.currentIndex];
        const target = curWord ? String(curWord.traditional || '').trim() : '';
        const alreadyRecalledInPhase1 =
          (debugLogger.context.phase || 1) >= 2 ||
          (target &&
            Array.isArray(this.pipeline.wordTurns) &&
            this.pipeline.wordTurns.some((t) => t && t.role === 'user' && String(t.text || '').includes(target)));
        if (!alreadyRecalledInPhase1) {
          this.peekedInCurrentWord = true;
        }
      }
      this.renderCurrentWordCard();
    });

    // Giant eyes-free tap zone on the main orb:
    // - If disconnected after retries, tapping reconnects the current word in place
    // - If waiting for user speech OR waiting on a stalled turn commit, tapping advances immediately ("Done Speaking")
    // - Otherwise starts or pauses/resumes the session
    this.els.voiceOrb.addEventListener('click', () => {
      if (!this.sessionActive) {
        this.startDrivingSession();
      } else if (!this.sessionPaused && this.pipeline.isDisconnected()) {
        this.pipeline.reconnectCurrentWord().catch((err) => {
          this.showToast(err.message || 'Reconnect failed — tap again when online.', 'error');
        });
      } else if (!this.sessionPaused && this.pipeline.canForceFinishUserTurn()) {
        this.pipeline.finishUserTurnNow('orb');
      } else {
        this.togglePauseSession();
      }
    });

    if (this.els.btnOpenLogs) {
      this.els.btnOpenLogs.addEventListener('click', () => this.openLogsDrawer());
    }
    if (this.els.btnCloseLogs) {
      this.els.btnCloseLogs.addEventListener('click', () => this.els.drawerLogs.classList.add('hidden'));
    }
    if (this.els.btnCopyLogsGemini) {
      this.els.btnCopyLogsGemini.addEventListener('click', () => this.copyLogsForGemini());
    }
    if (this.els.btnShareLogs) {
      this.els.btnShareLogs.addEventListener('click', () => this.shareOrDownloadLogs());
    }
    if (this.els.btnClearLogs) {
      this.els.btnClearLogs.addEventListener('click', () => {
        debugLogger.clear();
        this.renderLogsDrawer();
        this.showToast('Cleared debug logs.', 'info');
      });
    }
    if (this.els.selectLogFilter) {
      this.els.selectLogFilter.addEventListener('change', () => this.renderLogsDrawer());
    }

    const openSettingsAndEnumerate = () => {
      this.els.drawerSettings.classList.remove('hidden');
      this.pipeline.enumerateAudioDevices('settings_open').catch(() => {});
    };

    this.els.btnOpenSettings.addEventListener('click', openSettingsAndEnumerate);
    if (this.els.activeAudioPill) {
      this.els.activeAudioPill.addEventListener('click', openSettingsAndEnumerate);
    }
    this.els.btnCloseSettings.addEventListener('click', () => this.els.drawerSettings.classList.add('hidden'));
    this.els.btnOpenImport.addEventListener('click', () => this.els.drawerImport.classList.remove('hidden'));
    this.els.btnCloseImport.addEventListener('click', () => this.els.drawerImport.classList.add('hidden'));

    if (this.els.btnRefreshMics) {
      this.els.btnRefreshMics.addEventListener('click', async () => {
        try {
          if (!this.pipeline.micStream && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
            temp.getTracks().forEach((t) => t.stop());
          }
          const { inputs } = await this.pipeline.enumerateAudioDevices('manual_scan_btn');
          this.showToast(`Found ${inputs.length} microphone input(s).`, 'info');
        } catch (err) {
          this.showToast(err.message || 'Microphone scan blocked.', 'error');
        }
      });
    }

    this.els.btnSaveSettings.addEventListener('click', () => this.saveSettings());
    this.els.btnTestConnection.addEventListener('click', () => this.refreshBackendStatus(true));

    this.els.fileHanpingCsv.addEventListener('change', (e) => this.handleFilePicked(e));
    if (this.els.selectAnkiTag) {
      this.els.selectAnkiTag.addEventListener('change', () => {
        if (this.els.inputAnkiTag) {
          this.els.inputAnkiTag.value = this.els.selectAnkiTag.value;
        }
        this.applyAnkiTagFilterPreview();
      });
    }
    if (this.els.inputAnkiTag) {
      this.els.inputAnkiTag.addEventListener('input', () => {
        const typed = this.els.inputAnkiTag.value.trim().toLowerCase();
        if (this.els.selectAnkiTag) {
          let matchedOpt = false;
          for (const opt of this.els.selectAnkiTag.options) {
            if (opt.value.toLowerCase() === typed) {
              opt.selected = true;
              matchedOpt = true;
              break;
            }
          }
          if (!matchedOpt && !typed) {
            this.els.selectAnkiTag.value = '';
          }
        }
        this.applyAnkiTagFilterPreview();
      });
    }
    this.els.textareaHanpingCsv.addEventListener('input', () => {
      // If the user pastes a raw AnkiDroid file with #tags column into the textarea, capture it
      const val = this.els.textareaHanpingCsv.value;
      if (val.includes('#tags column:') || !this.rawAnkiFileText) {
        this.rawAnkiFileText = val;
        this.populateAnkiTagOptions(this.rawAnkiFileText, false);
      }
    });
    this.els.btnUploadHanping.addEventListener('click', () => this.uploadHanpingCsv());
    this.els.btnPullTocfl.addEventListener('click', () => this.pullTocflSupplemental());
    if (this.els.btnPregeneratePrompts) {
      this.els.btnPregeneratePrompts.addEventListener('click', () => this.pregenerateSheetPrompts());
    }
    if (this.els.btnNormalizePinyin) {
      this.els.btnNormalizePinyin.addEventListener('click', () => this.normalizeSheetPinyin());
    }
  }

  handleAudioHardwareUpdate(micInfo = {}, inputs = []) {
    const modeLabel =
      micInfo.routingMode === 'voice_comm'
        ? 'Phone Speaker'
        : micInfo.isBluetooth
        ? 'Bluetooth Call'
        : 'Bluetooth / Auto';
    const micLabel = micInfo.label || 'Not initialized';

    if (this.els && this.els.activeAudioPill) {
      if (micLabel === 'Not initialized') {
        this.els.activeAudioPill.textContent =
          micInfo.routingMode === 'voice_comm'
            ? 'Audio: Phone Speakerphone Only'
            : 'Audio: Bluetooth Call / Earbuds (Auto)';
      } else {
        const shortMic =
          micLabel.length > 24 ? `${micLabel.slice(0, 23)}…` : micLabel;
        this.els.activeAudioPill.textContent = `Audio: ${modeLabel} · ${shortMic}`;
      }
    }

    if (this.els && this.els.activeMicStatusHint) {
      this.els.activeMicStatusHint.textContent =
        micLabel === 'Not initialized'
          ? `Mode: ${modeLabel} · Auto-connects Bluetooth when session starts`
          : `Active mic: "${micLabel}" (AEC=${Boolean(micInfo.echoCancellation)}, NS=${Boolean(micInfo.noiseSuppression)})`;
    }

    if (this.els && this.els.inputMicDevice && Array.isArray(inputs)) {
      const savedPref =
        localStorage.getItem(STORAGE_KEYS.MIC_DEVICE_ID) ||
        this.pipeline.preferredMicDeviceId ||
        'auto';
      const currentOptions = [{ value: 'auto', text: 'Auto (Bluetooth First, Speaker Fallback)' }];
      for (const inp of inputs) {
        if (inp.deviceId) {
          currentOptions.push({
            value: inp.deviceId,
            text: inp.label || `Mic (${inp.shortId})`
          });
        }
      }
      this.els.inputMicDevice.innerHTML = '';
      for (const o of currentOptions) {
        const optEl = document.createElement('option');
        optEl.value = o.value;
        optEl.textContent = o.text;
        if (o.value === savedPref) {
          optEl.selected = true;
        }
        this.els.inputMicDevice.appendChild(optEl);
      }
    }
  }

  loadSavedConfigIntoInputs() {
    this.els.inputGasUrl.value = localStorage.getItem(STORAGE_KEYS.GAS_URL) || '';
    this.els.inputSecret.value = localStorage.getItem(STORAGE_KEYS.SECRET) || '';
    this.els.inputDirectKey.value = localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '';
    this.els.inputBatchSize.value = localStorage.getItem(STORAGE_KEYS.BATCH_SIZE) || '20';
    this.els.inputNewRatio.value = localStorage.getItem(STORAGE_KEYS.NEW_RATIO) || '10';
    this.els.inputTocflLevel.value = localStorage.getItem(STORAGE_KEYS.TOCFL_LEVEL) || '2';
    this.els.inputVoiceName.value = localStorage.getItem(STORAGE_KEYS.VOICE_NAME) || 'Aoede';
    if (this.els.inputLiveModel) {
      this.els.inputLiveModel.value = localStorage.getItem(STORAGE_KEYS.PREFERRED_LIVE_MODEL) || 'auto';
    }
    if (this.els.inputAudioRouting) {
      const savedMode = localStorage.getItem(STORAGE_KEYS.AUDIO_ROUTING_MODE);
      this.els.inputAudioRouting.value = savedMode === 'voice_comm' ? 'voice_comm' : 'bluetooth_hfp';
    }
    if (this.els.inputMicDevice) {
      this.els.inputMicDevice.value = localStorage.getItem(STORAGE_KEYS.MIC_DEVICE_ID) || 'auto';
    }
    this.els.selectSupplementLevel.value = localStorage.getItem(STORAGE_KEYS.TOCFL_LEVEL) || '2';
  }

  async saveSettings() {
    const gasUrl = this.els.inputGasUrl.value.trim();
    const secret = this.els.inputSecret.value.trim();
    const directKey = this.els.inputDirectKey.value.trim();
    const batchSize = this.els.inputBatchSize.value.trim() || '20';
    const newRatioPct = this.els.inputNewRatio.value.trim() || '10';
    const tocflLevel = this.els.inputTocflLevel.value.trim() || '2';
    const voiceName = this.els.inputVoiceName.value.trim() || 'Aoede';
    const preferredLiveModel = this.els.inputLiveModel ? this.els.inputLiveModel.value : 'auto';
    const audioRoutingMode =
      this.els.inputAudioRouting && this.els.inputAudioRouting.value === 'voice_comm'
        ? 'voice_comm'
        : 'bluetooth_hfp';
    const micDeviceId = this.els.inputMicDevice ? this.els.inputMicDevice.value : 'auto';

    const routingOrMicChanged =
      audioRoutingMode !== this.pipeline.audioRoutingMode ||
      micDeviceId !== this.pipeline.preferredMicDeviceId;

    localStorage.setItem(STORAGE_KEYS.GAS_URL, gasUrl);
    localStorage.setItem(STORAGE_KEYS.SECRET, secret);
    localStorage.setItem(STORAGE_KEYS.DIRECT_API_KEY, directKey);
    localStorage.setItem(STORAGE_KEYS.BATCH_SIZE, batchSize);
    localStorage.setItem(STORAGE_KEYS.NEW_RATIO, newRatioPct);
    localStorage.setItem(STORAGE_KEYS.TOCFL_LEVEL, tocflLevel);
    localStorage.setItem(STORAGE_KEYS.VOICE_NAME, voiceName);
    localStorage.setItem(STORAGE_KEYS.PREFERRED_LIVE_MODEL, preferredLiveModel);
    localStorage.setItem(STORAGE_KEYS.AUDIO_ROUTING_MODE, audioRoutingMode);
    localStorage.setItem(STORAGE_KEYS.MIC_DEVICE_ID, micDeviceId);

    this.pipeline.setAudioConfig({
      routingMode: audioRoutingMode,
      preferredDeviceId: micDeviceId
    });

    if (routingOrMicChanged && this.pipeline.micStream) {
      try {
        await this.pipeline.initAudioHardware(true);
      } catch (errMic) {
        debugLogger.log('error', 'mic_hotswap_error', errMic.message || String(errMic));
      }
    }

    this.liveAuth.voiceName = voiceName;
    this.liveAuth.preferredLiveModel = preferredLiveModel;
    if (directKey) {
      this.liveAuth.apiKey = directKey;
    }

    debugLogger.log('info', 'settings_saved', 'Updated tutor settings', {
      batchSize,
      newRatioPct,
      tocflLevel,
      voiceName,
      preferredLiveModel,
      audioRoutingMode,
      micDeviceId: micDeviceId === 'auto' ? 'auto' : micDeviceId.slice(0, 10)
    });

    if (gasUrl && secret) {
      try {
        await this.callBackend('update_settings', {
          settings: {
            BATCH_SIZE: batchSize,
            NEW_WORD_RATIO: String(Number(newRatioPct) / 100),
            TOCFL_LEVEL: tocflLevel,
            VOICE_NAME: voiceName
          }
        });
      } catch (_) {}
    }

    this.els.drawerSettings.classList.add('hidden');
    this.showToast('Configuration saved on your Pixel 9.', 'success');
    await this.refreshBackendStatus(true);
  }

  /**
   * Calls the bound Google Apps Script Web App (`doPost`) using `text/plain;charset=utf-8`
   * so Chrome never triggers an unanswerable CORS OPTIONS preflight.
   */
  async callBackend(action, payload = {}, options = {}) {
    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    if (!gasUrl || !secret) {
      throw new Error('Google Sheet Web App URL or Secret is not configured yet.');
    }

    const startMs = performance.now();
    const body = Object.assign({}, payload, { action, secret });
    try {
      const response = await fetch(gasUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(body),
        redirect: 'follow'
      });

      const durationMs = Math.round(performance.now() - startMs);
      if (!response.ok) {
        debugLogger.log('error', 'backend_rpc_http_error', `RPC ${action} HTTP ${response.status}`, {
          action,
          status: response.status,
          durationMs
        });
        throw new Error(`Apps Script HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!data.ok) {
        debugLogger.log('error', 'backend_rpc_error', `RPC ${action} failed: ${data.error || 'unknown'}`, {
          action,
          durationMs
        });
        throw new Error(data.error || 'Apps Script backend error.');
      }
      if (!options.silentOkLog) {
        debugLogger.log('info', 'backend_rpc_ok', `RPC ${action} succeeded in ${durationMs}ms`, {
          action,
          durationMs
        });
      }
      return data;
    } catch (err) {
      if (!String(err.message || '').startsWith('Apps Script')) {
        const unloading = Boolean(
          this.isPageUnloading || (typeof window !== 'undefined' && window.__swReloading)
        );
        debugLogger.log(
          unloading ? 'info' : 'error',
          unloading ? 'backend_rpc_aborted_reload' : 'backend_rpc_network_error',
          unloading
            ? `RPC ${action} aborted due to page reload`
            : `RPC ${action} error: ${err.message || err}`,
          {
            action,
            durationMs: Math.round(performance.now() - startMs)
          }
        );
      }
      throw err;
    }
  }

  async refreshBackendStatus(notify = false) {
    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    const directKey = (localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '').trim();

    if (!gasUrl || !secret) {
      if (directKey) {
        this.els.connectionBadge.textContent = 'Direct Key Mode (Sample Deck)';
        this.els.connectionBadge.className = 'badge badge-ready';
      } else {
        this.els.connectionBadge.textContent = 'Setup Required — Tap Settings';
        this.els.connectionBadge.className = 'badge badge-warn';
      }
      this.els.statDue.textContent = '3';
      this.els.statNew.textContent = '2';
      this.els.statLearned.textContent = '3';
      this.els.statSourceMix.textContent = '5 sample words';
      return;
    }

    try {
      this.els.connectionBadge.textContent = 'Syncing Sheet...';
      const res = await this.callBackend('ping', {}, { silentOkLog: !notify });
      const s = res.stats || {};
      this.els.statDue.textContent = String(s.dueCount ?? 0);
      this.els.statNew.textContent = String(s.newCount ?? 0);
      this.els.statLearned.textContent = String(s.learnedCount ?? 0);
      this.els.statSourceMix.textContent = `${s.hanpingCount ?? 0} Hanping · ${s.tocflCount ?? 0} TOCFL`;
      this.els.connectionBadge.textContent = 'Google Sheet Connected';
      this.els.connectionBadge.className = 'badge badge-ok';
      if (notify) {
        this.showToast(`Connected! ${s.total || 0} words in Sheet (${s.dueCount || 0} due).`, 'success');
      }
    } catch (err) {
      this.els.connectionBadge.textContent = 'Sheet Auth / URL Error';
      this.els.connectionBadge.className = 'badge badge-error';
      if (notify) {
        this.showToast(err.message, 'error');
      }
    }
  }

  /**
   * Starts the hands-free, eyes-free driving loop:
   * 1. Acquires Screen Wake Lock + WebAudio microphone pipeline.
   * 2. Fetches a 20-word batch from Google Sheets (with simple everyday English sentences),
   *    or loads the built-in Taiwanese Mandarin sample batch if testing in Direct API Key mode.
   * 3. Starts Word #1 in a clean Gemini Live WebSocket.
   */
  async startDrivingSession() {
    try {
      this.els.btnStartDriving.disabled = true;
      this.handlePipelineState('connecting', 'Initializing microphone & wake lock...');

      await this.requestWakeLock();
      await this.pipeline.initAudioHardware();
      await this.pipeline.startMediaSessionAnchor();

      await this.loadNextBatch();

      if (!this.batch || this.batch.length === 0) {
        throw new Error('No vocabulary words available in batch.');
      }

      this.sessionActive = true;
      this.sessionPaused = false;
      this.currentIndex = 0;

      this.els.btnStartDriving.classList.add('hidden');
      if (this.els.btnDoneSpeaking) {
        this.els.btnDoneSpeaking.classList.remove('hidden');
      }
      this.els.btnPauseResume.classList.remove('hidden');
      this.els.btnRepeatPrompt.disabled = false;
      this.els.btnHint.disabled = false;
      this.els.btnSkipWord.disabled = false;
      this.els.btnEndSession.disabled = false;

      await this.launchCurrentWord();
    } catch (err) {
      this.pipeline.stopMediaSessionAnchor();
      this.els.btnStartDriving.disabled = false;
      this.handlePipelineState('idle', 'Tap Start to begin');
      this.showToast(err.message || String(err), 'error');
    }
  }

  async loadNextBatch() {
    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    const directKey = (localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '').trim();

    if (gasUrl && secret) {
      const batchSize = Number(localStorage.getItem(STORAGE_KEYS.BATCH_SIZE) || 20);
      const newRatio = Number(localStorage.getItem(STORAGE_KEYS.NEW_RATIO) || 10) / 100;
      const tocflLevel = Number(localStorage.getItem(STORAGE_KEYS.TOCFL_LEVEL) || 2);

      this.handlePipelineState('connecting', `Loading ${batchSize} pre-generated words from Sheet...`);
      const res = await this.callBackend('get_batch', {
        batchSize,
        newWordRatio: newRatio,
        tocflLevel
      });

      this.batch = (res.batch || []).map((w) =>
        Object.assign({}, w, { pinyin: numberedPinyinToToneMarks(w.pinyin || '') })
      );
      if (res.liveAuth && res.liveAuth.apiKey) {
        this.liveAuth = Object.assign({}, this.liveAuth, res.liveAuth, {
          preferredLiveModel:
            localStorage.getItem(STORAGE_KEYS.PREFERRED_LIVE_MODEL) ||
            this.liveAuth.preferredLiveModel ||
            'auto'
        });
      }
      if (directKey) {
        this.liveAuth.apiKey = directKey;
      }

      const sum = res.batchSummary || {};
      debugLogger.log('info', 'batch_loaded', `Loaded ${this.batch.length} words from Sheet`, sum);
      this.showToast(
        `Loaded ${sum.total || this.batch.length} words (${sum.dueReviews || 0} due, ${sum.newWords || 0} new)`,
        'success'
      );
    } else if (directKey) {
      this.liveAuth.apiKey = directKey;
      this.batch = SAMPLE_TAIWAN_BATCH.map((w) =>
        Object.assign({}, w, { pinyin: numberedPinyinToToneMarks(w.pinyin || '') })
      );
      debugLogger.log('info', 'batch_loaded_sample', 'Loaded 5 sample words (Direct Key Mode)');
      this.showToast('Loaded 5 sample Taiwanese Mandarin words (Direct Key Mode).', 'info');
    } else {
      this.els.drawerSettings.classList.remove('hidden');
      throw new Error('Please configure your Google Apps Script URL + Secret (or a Gemini API Key) in Settings first.');
    }
  }

  async launchCurrentWord() {
    if (!this.sessionActive || this.sessionPaused) return;

    if (this.currentIndex >= this.batch.length) {
      // Automatically fetch the next 20-word batch so long drives continue seamlessly!
      this.showToast('Batch of 20 complete! Fetching next batch...', 'success');
      await this.loadNextBatch();
      this.currentIndex = 0;
      if (this.batch.length === 0) {
        this.stopDrivingSession();
        return;
      }
    }

    const word = this.batch[this.currentIndex];
    this.revealTarget = false;
    this.peekedInCurrentWord = false;
    this.transcriptHistory = [];
    this.renderTranscriptFeed();
    this.setPhaseIndicator(1);
    this.renderCurrentWordCard();
    this.updateMediaSessionMetadata(word);

    const posLabel = `#${this.currentIndex + 1}/${this.batch.length}`;
    await this.pipeline.startWordSession(word, this.liveAuth, posLabel);
  }

  renderCurrentWordCard() {
    const word = this.batch[this.currentIndex];
    if (!word) {
      this.els.englishPromptText.textContent = 'Ready for hands-free Taiwanese Mandarin practice.';
      this.els.targetHanzi.textContent = 'Ready';
      this.els.targetPhonetics.textContent = 'Target word hidden until revealed';
      this.els.targetGloss.textContent = 'Tap Start Driving Session below';
      this.els.stageProgressText.textContent = 'Batch: 20 words (90% Due / 10% New)';
      this.els.stageProgressBar.style.width = '0%';
      return;
    }

    const total = this.batch.length;
    const pos = this.currentIndex + 1;
    this.els.stageProgressText.textContent = `Word ${pos} of ${total} · ${word.status === 'new' ? 'NEW' : 'REVIEW'}`;
    this.els.stageProgressBar.style.width = `${Math.round((pos / total) * 100)}%`;

    this.els.englishPromptText.textContent = `"${word.english_prompt}"`;

    const levelTag = word.tocfl_level ? `TOCFL L${word.tocfl_level}` : '';
    const freqTag = word.spoken_freq ? `Spoken ${word.spoken_freq}/M` : '';
    this.els.targetMetaBadge.textContent = [word.source?.toUpperCase(), levelTag, freqTag]
      .filter(Boolean)
      .join(' · ');

    if (this.revealTarget) {
      const displayPinyin = numberedPinyinToToneMarks(word.pinyin || '');
      this.els.targetWordBox.classList.remove('spoiler-masked');
      this.els.targetHanzi.textContent = word.traditional;
      this.els.targetPhonetics.textContent = [displayPinyin, word.zhuyin].filter(Boolean).join(' · ');
      const refMandarin = (word.mandarin_sentence || word.sample_mandarin || '').trim();
      this.els.targetGloss.textContent = [word.english_gloss, refMandarin ? `Ref: ${refMandarin}` : '']
        .filter(Boolean)
        .join(' · ');
      this.els.btnToggleReveal.textContent = 'Hide Target Word';
    } else {
      this.els.targetWordBox.classList.add('spoiler-masked');
      this.els.targetHanzi.textContent = '•••';
      this.els.targetPhonetics.textContent = 'Hidden while translating (tap to peek)';
      this.els.targetGloss.textContent = word.english_gloss ? `Hint: ${word.english_gloss}` : '';
      this.els.btnToggleReveal.textContent = 'Peek Target Word';
    }
  }

  _renderScoreBanner(word, score, intervalDays, notes = '') {
    if (!this.els.lastScoreBanner) return;
    this.els.lastScoreBanner.classList.remove('hidden');
    const cleanNotes = notes ? ` · ${this.escapeHtml(notes)}` : '';
    const displayPinyin = numberedPinyinToToneMarks(word.pinyin || '');
    this.els.lastScoreBanner.innerHTML = `
      <strong>${this.escapeHtml(word.traditional)} (${this.escapeHtml(displayPinyin)})</strong> →
      <span class="score-pill score-${score}">${scoreLabel(score)}</span>
      <span class="next-due-note">Next review in ${intervalDays}d${cleanNotes}</span>
    `;
  }

  async _discoverFastGradingCandidates(apiKey) {
    if (Array.isArray(this.cachedGradingCandidates) && this.cachedGradingCandidates.length > 0) {
      return this.cachedGradingCandidates;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3500);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        { signal: ctrl.signal }
      );
      if (!resp.ok) throw new Error(`models.list HTTP ${resp.status}`);
      const json = await resp.json();
      const models = (json.models || []).filter(
        (m) =>
          m &&
          m.name &&
          Array.isArray(m.supportedGenerationMethods) &&
          m.supportedGenerationMethods.includes('generateContent') &&
          !/tts|image|imagen|veo|live|native-audio|embedding|aqa|robotics|computer-use/i.test(
            m.name
          )
      );
      const names = models.map((m) => m.name);
      const ordered = [];
      const preferredMatchers = [
        /gemini-2\.5-flash$/i,
        /flash-lite/i,
        /gemini-2\.5-flash/i,
        /gemini-3(\.\d+)?-flash(-preview)?$/i,
        /flash/i
      ];
      for (const rx of preferredMatchers) {
        for (const n of names) {
          if (rx.test(n) && !ordered.includes(n)) {
            ordered.push(n);
          }
        }
      }
      for (const n of names) {
        if (!ordered.includes(n)) ordered.push(n);
      }
      if (ordered.length > 0) {
        this.cachedGradingCandidates = ordered.slice(0, 4);
        return this.cachedGradingCandidates;
      }
    } catch (_) {
      // Fall back to standard Flash model IDs if models.list fails
    } finally {
      clearTimeout(timer);
    }
    return ['models/gemini-2.5-flash', 'models/gemini-3.1-flash-lite-preview', 'models/gemini-3-flash-preview'];
  }

  async _requestGradingJsonFromModel(modelName, apiKey, gradingPrompt, signal) {
    const generationConfig = {
      temperature: 0.1,
      responseMimeType: 'application/json'
    };
    if (modelName.includes('2.5')) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: gradingPrompt }] }],
          generationConfig
        }),
        signal
      }
    );

    if (!resp.ok) {
      const err = new Error(`Grading HTTP ${resp.status} on ${modelName}`);
      err.httpStatus = resp.status;
      throw err;
    }

    const data = await resp.json();
    const rawJson = (
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || ''
    )
      .replace(/^```json\s*/i, '')
      .replace(/```$/i, '')
      .trim();

    return JSON.parse(rawJson);
  }

  async gradeWordTranscriptWithFlash(word, wordTurns, fallbackTelemetry, forceNeededHint = false) {
    const apiKey = (this.liveAuth && this.liveAuth.apiKey ? this.liveAuth.apiKey : '').trim();
    if (!apiKey || !Array.isArray(wordTurns) || wordTurns.length === 0) {
      return fallbackTelemetry;
    }

    const startMs = performance.now();
    const candidates = (await this._discoverFastGradingCandidates(apiKey)).slice();

    try {
      const dialogueText = wordTurns
        .filter((t) => t && String(t.text || '').trim())
        .map((t) => `${t.role === 'tutor' ? '老師' : '學生'}：${t.text}`)
        .join('\n');

      const gradingPrompt = `Evaluate this completed Taiwanese Mandarin voice tutor dialogue for spaced-repetition (FSRS v5) scoring OF THE TARGET WORD ONLY and return ONLY a JSON object with these exact keys:
{
  "target_word_recalled": boolean,
  "needed_hint": boolean,
  "pronunciation_attempts": integer (>=1),
  "grammar_errors": integer (>=0),
  "conversation_fluency": "natural" | "good" | "struggled",
  "synonym_redirect_only": boolean,
  "non_target_corrections_only": boolean,
  "notes": "short English note <= 8 words"
}

Grading rules:
- Target word: "${word.traditional}" (${word.pinyin || ''}, meaning "${word.english_gloss || ''}")
- English prompt: "${word.english_prompt || ''}"
- Reference Mandarin: "${word.mandarin_sentence || word.sample_mandarin || ''}"
- IMPORTANT: The student ("學生") lines come from speech-to-text ASR, which may contain minor homophones or segmentation quirks (e.g. 餐館/餐廳, 設一個/是個, or dropping a trailing neutral-tone suffix). Always trust the tutor's ("老師") spoken reaction! If the tutor immediately praised the student ("說得很好！", etc.) without correcting the target word, set target_word_recalled=true, pronunciation_attempts=1, grammar_errors=0, conversation_fluency="natural".
- TARGET-WORD-ONLY SCORING RULE (CRITICAL — MUST STILL SCORE 4 / PERFECT):
  Both the initial translation AND the follow-up question reply include strict native-speaker coaching loops where the tutor corrects ANY non-native phrasing, tone, measure word, or English word anywhere in the student's sentences until the student repeats a clean complete sentence.
  Grammar corrections, pronunciation/tone corrections, measure-word fixes, sentence-structure coaching, or English-to-Mandarin word translations on OTHER words besides "${word.traditional}" (in EITHER the translation OR the follow-up reply) MUST NOT impact the score for "${word.traditional}"!
  * If the student recalled "${word.traditional}" on their own in the translation (or after a valid synonym redirect), pronounced "${word.traditional}" with accurate tones, and used "${word.traditional}" grammatically, THEN EVEN IF the tutor corrected tones, pronunciation, phrasing, or translated an English word on OTHER words across one or more retries in the translation or follow-up reply, you MUST set:
    target_word_recalled=true, needed_hint=false, pronunciation_attempts=1, grammar_errors=0, conversation_fluency="natural", non_target_corrections_only=true!
- SYNONYM & MORPHOLOGICAL VARIANT RULE (CRITICAL — MUST STILL SCORE 4 / PERFECT, NEVER needed_hint=true!):
  Because the target word is masked ("•••") on screen while the student hears the English sentence, the student may naturally use a valid Mandarin synonym or root-sharing variant on their first try (e.g. saying "這樣" when the hidden target is "這樣子", "幸好"/"好險" for "還好", or "平常"/"常常" for "經常").
  To steer the student to today's specific card, the tutor may give a clue (word length, adding "子", saying "提示你一下") or even name "${word.traditional}" while praising their valid synonym ("「這樣」也很自然，不過我們今天要練..."). Because the student ALREADY knew a valid Mandarin translation without surrendering or using English, when they then produce "${word.traditional}" cleanly without target-word tone/grammar errors, you MUST set:
  target_word_recalled=true, needed_hint=false, pronunciation_attempts=1, grammar_errors=0, conversation_fluency="natural", synonym_redirect_only=true!
- Only set pronunciation_attempts > 1 if the tutor explicitly corrected wrong tones or mispronunciation ON THE TARGET WORD "${word.traditional}" ITSELF AFTER the student attempted "${word.traditional}".
- Only set grammar_errors > 0 if the student misused or misplaced THE TARGET WORD "${word.traditional}" ITSELF (or failed to include it in the Phase 1 translation without a valid synonym). Note: the student is NOT required to repeat "${word.traditional}" in their Phase 3 follow-up reply.
- Set needed_hint=true ONLY if the student genuinely did NOT know Mandarin for "${word.traditional}" in Phase 1 (e.g. explicitly asked for a hint / surrendered, used an English word FOR "${word.traditional}" itself, or omitted "${word.traditional}" without any valid synonym and needed the tutor to supply it).

Dialogue:
${dialogueText}`;

      let parsed = null;
      let usedModel = candidates[0];
      let lastErr = null;

      for (let i = 0; i < Math.min(3, candidates.length); i++) {
        usedModel = candidates[i];
        const modelCtrl = new AbortController();
        let timedOut = false;
        const modelTimer = setTimeout(() => {
          timedOut = true;
          modelCtrl.abort(new Error(`grading_timeout_6s (${usedModel})`));
        }, 6000);
        try {
          parsed = await this._requestGradingJsonFromModel(
            usedModel,
            apiKey,
            gradingPrompt,
            modelCtrl.signal
          );
          lastErr = null;
          break;
        } catch (errTry) {
          lastErr = errTry;
          if (
            (errTry.httpStatus === 404 || timedOut) &&
            Array.isArray(this.cachedGradingCandidates) &&
            this.cachedGradingCandidates.length > 1
          ) {
            this.cachedGradingCandidates = this.cachedGradingCandidates.filter(
              (m) => m !== usedModel
            );
          }
          // Only stop trying fallback models if the API key itself is unauthorized (401 / 403)
          if (errTry.httpStatus === 401 || errTry.httpStatus === 403) {
            break;
          }
        } finally {
          clearTimeout(modelTimer);
        }
      }

      if (!parsed) {
        throw lastErr || new Error('All grading models failed');
      }

      const normalized = normalizeAiGradingTelemetry(
        parsed,
        wordTurns,
        fallbackTelemetry,
        forceNeededHint,
        word.traditional
      );
      const aiScore = computeDeterministicScore(normalized);
      const rawScore = computeDeterministicScore(parsed);

      debugLogger.log(
        'info',
        'word_graded_ai',
        `Graded ${word.traditional} -> Score ${aiScore} (${scoreLabel(aiScore)}) via ${usedModel.replace(/^models\//, '')} in ${Math.round(performance.now() - startMs)}ms`,
        {
          finalScore: aiScore,
          ...(rawScore !== aiScore ? { rawAiScore: rawScore, rawAiParsed: parsed } : {}),
          rubric: compactRubricSummary(normalized)
        }
      );
      return normalized;
    } catch (err) {
      debugLogger.log(
        'warn',
        'word_graded_heuristic_fallback',
        `Using local heuristic rubric for ${word.traditional} (${err.message || err})`
      );
      return fallbackTelemetry;
    }
  }

  async persistAndGradeWordReview(word, wordTurns, heuristicTelemetry, forceNeededHint) {
    const finalTelemetry = await this.gradeWordTranscriptWithFlash(
      word,
      wordTurns,
      heuristicTelemetry,
      forceNeededHint
    );
    const finalScore = computeDeterministicScore(finalTelemetry);
    const finalFsrs = computeFsrsV5(word, finalScore, 0.90);

    if (this.lastScoredWordId === word.id) {
      this._renderScoreBanner(word, finalScore, finalFsrs.intervalDays, finalTelemetry.notes);
    }

    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    if (gasUrl && secret) {
      this.callBackend(
        'record_review',
        {
          word_id: word.id,
          traditional: word.traditional,
          english_prompt: word.english_prompt,
          mandarin_sentence: word.mandarin_sentence || word.sample_mandarin || '',
          telemetry: finalTelemetry
        },
        { silentOkLog: true }
      )
        .then(() => this.refreshBackendStatus(false))
        .catch((err) => console.warn('Failed to persist review to Sheet:', err));
    }
  }

  /**
   * Called deterministically when the tutor speaks `「好，我們看下一題！」` at the end of Phase 3/4.
   * 1. Computes an instant 0ms score preview and advances immediately to the next word's clean WebSocket!
   * 2. Runs background REST JSON transcript grading + Google Sheet FSRS v5 persistence without blocking audio!
   */
  async handleWordCompleted(completionPayload = {}) {
    const word = this.batch[this.currentIndex];
    if (!word) return;

    this.pipeline.closeCurrentWordSocket();
    this.setPhaseIndicator(4);

    const hasTurnsPayload = Array.isArray(completionPayload.wordTurns);
    const wordTurns = hasTurnsPayload ? completionPayload.wordTurns : [];
    const usedHintButton = Boolean(completionPayload.usedHintButton);
    const peeked = Boolean(this.peekedInCurrentWord);
    const forceNeededHint = Boolean(usedHintButton || peeked);

    const initialTelemetry = hasTurnsPayload
      ? deriveHeuristicTelemetryFromTurns(word, wordTurns, usedHintButton, peeked)
      : completionPayload;

    const score = computeDeterministicScore(initialTelemetry);
    const fsrsPreview = computeFsrsV5(word, score, 0.90);
    this.lastScoredWordId = word.id;

    debugLogger.log(
      'info',
      'word_completed',
      `Completed ${word.traditional} -> Instant Score ${score} (${scoreLabel(score)}, +${fsrsPreview.intervalDays}d)`,
      {
        score,
        intervalDays: fsrsPreview.intervalDays,
        turnsCount: wordTurns.length,
        rubric: compactRubricSummary(initialTelemetry),
        turns: wordTurns.map(
          (t) => `${t.role === 'tutor' ? 'T' : 'U'}:${String(t.text || '').slice(0, 64)}`
        )
      }
    );

    this._renderScoreBanner(word, score, fsrsPreview.intervalDays, initialTelemetry.notes);

    // Non-blocking background AI transcript grading + Sheet persistence
    this.persistAndGradeWordReview(word, wordTurns, initialTelemetry, forceNeededHint).catch(
      (err) => console.warn('Background grading error:', err)
    );

    this.currentIndex += 1;
    setTimeout(() => {
      if (this.sessionActive && !this.sessionPaused) {
        this.launchCurrentWord();
      }
    }, 320);
  }

  /**
   * Handles hands-free voice escape hatches (`skip`, `flag_bad_card`, `pause`, `end_session`).
   */
  async handleVoiceControlCommand(cmd = {}) {
    const action = cmd.action || 'skip';
    const word = this.batch[this.currentIndex];

    if (action === 'pause') {
      this.togglePauseSession(true);
      return;
    }
    if (action === 'end_session') {
      this.stopDrivingSession();
      return;
    }
    if (action === 'flag_bad_card' && word) {
      this.showToast(`Flagged ${word.traditional} in Google Sheet.`, 'info');
      this.callBackend('word_action', {
        subAction: 'flag_bad_card',
        word_id: word.id,
        traditional: word.traditional,
        reason: cmd.reason || 'Voice flagged'
      }).catch(() => {});
    }

    await this.skipCurrentWord(action);
  }

  /**
   * Restarts the entire practice flow for the CURRENT word from the very beginning (Phase 1 English prompt),
   * triggered by the car steering-wheel / Bluetooth earbud `Previous` (`previoustrack` / `seekbackward`) button.
   */
  async restartCurrentWord(reason = 'steering_wheel_prev') {
    if (!this.sessionActive || !Array.isArray(this.batch) || !this.batch[this.currentIndex]) {
      return;
    }
    const word = this.batch[this.currentIndex];
    if (this.sessionPaused) {
      this.sessionPaused = false;
      if (this.els && this.els.btnPauseResume) {
        this.els.btnPauseResume.textContent = 'Pause';
      }
      this.pipeline.startMediaSessionAnchor().catch(() => {});
    }

    this.pipeline.closeCurrentWordSocket();
    this.pipeline.playChime('start');

    debugLogger.log(
      'info',
      'word_restarted',
      `Restarted ${word.traditional} from Phase 1 (${reason})`,
      {
        wordIndex: this.currentIndex + 1,
        traditional: word.traditional,
        reason
      }
    );
    // Keep toast spoiler-free while translating eyes-free
    this.showToast(`Restarting Word #${this.currentIndex + 1} from beginning`, 'info');
    await this.launchCurrentWord();
  }

  async skipCurrentWord(reason = 'skip') {
    if (this.sessionActive && this.sessionPaused) {
      this.sessionPaused = false;
      if (this.els && this.els.btnPauseResume) {
        this.els.btnPauseResume.textContent = 'Pause';
      }
      this.pipeline.startMediaSessionAnchor().catch(() => {});
    }

    this.pipeline.closeCurrentWordSocket();
    this.pipeline.playChime('skip');

    const word = this.batch[this.currentIndex];
    if (word) {
      debugLogger.log('info', 'word_skipped', `Skipped ${word.traditional} (${reason})`, {
        wordIndex: this.currentIndex + 1,
        reason
      });
      this.showToast(`Skipped ${word.traditional}`, 'info');
    }
    this.currentIndex += 1;
    if (this.sessionActive && !this.sessionPaused) {
      await this.launchCurrentWord();
    }
  }

  togglePauseSession(forcePause = null) {
    if (!this.sessionActive) return;
    this.sessionPaused = forcePause !== null ? forcePause : !this.sessionPaused;

    if (this.sessionPaused) {
      this.pipeline.closeCurrentWordSocket();
      this.pipeline.pauseMediaSessionAnchor();
      this._setMediaSessionPlaybackState('paused');
      this.els.btnPauseResume.textContent = 'Resume Driving';
      this.handlePipelineState('paused', 'Paused — Tap Orb or Steering Play to Resume');
    } else {
      this.els.btnPauseResume.textContent = 'Pause';
      this.pipeline.startMediaSessionAnchor().catch(() => {});
      this._setMediaSessionPlaybackState('playing');
      this.launchCurrentWord();
    }
  }

  stopDrivingSession() {
    this.sessionActive = false;
    this.sessionPaused = false;
    this.pipeline.closeCurrentWordSocket();
    this.pipeline.stopMediaSessionAnchor();
    this._setMediaSessionPlaybackState('none');
    this.releaseWakeLock();

    this.els.btnStartDriving.disabled = false;
    this.els.btnStartDriving.classList.remove('hidden');
    if (this.els.btnDoneSpeaking) {
      this.els.btnDoneSpeaking.classList.add('hidden');
    }
    this.els.btnPauseResume.classList.add('hidden');
    this.els.btnRepeatPrompt.disabled = true;
    this.els.btnHint.disabled = true;
    this.els.btnSkipWord.disabled = true;
    this.els.btnEndSession.disabled = true;

    this.handlePipelineState('idle', 'Session Ended — Tap Start when ready');
  }

  handlePipelineState(state, statusText) {
    this.els.stageStatusPill.textContent = statusText;
    this.els.stageStatusPill.dataset.state = state;
    this.els.voiceOrb.dataset.state = state;
    this.els.voiceOrbLabel.textContent = statusText;
  }

  handleTranscript(role, text) {
    if (role === 'discard_last_tutor') {
      const lastIdx = this.transcriptHistory.length - 1;
      if (lastIdx >= 0 && this.transcriptHistory[lastIdx].role === 'tutor') {
        this.transcriptHistory.pop();
        this.renderTranscriptFeed();
      }
      return;
    }

    if (role === 'discard_last_user') {
      const lastIdx = this.transcriptHistory.length - 1;
      if (lastIdx >= 0 && this.transcriptHistory[lastIdx].role === 'user' && !this.transcriptHistory[lastIdx].finalized) {
        this.transcriptHistory.pop();
        this.renderTranscriptFeed();
      }
      return;
    }

    if (role === 'turn_end') {
      const last = this.transcriptHistory[this.transcriptHistory.length - 1];
      if (last) last.finalized = true;
      return;
    }

    if (role === 'late_user_append') {
      if (!text) return;
      for (let i = this.transcriptHistory.length - 1; i >= 0; i--) {
        if (this.transcriptHistory[i].role === 'user') {
          this.transcriptHistory[i].text += text;
          this.renderTranscriptFeed();
          return;
        }
      }
      if (!text.trim()) return;
      const lastIdx = this.transcriptHistory.length - 1;
      if (lastIdx >= 0 && this.transcriptHistory[lastIdx].role === 'tutor') {
        this.transcriptHistory.splice(lastIdx, 0, { role: 'user', text, finalized: true });
      } else {
        this.transcriptHistory.push({ role: 'user', text, finalized: true });
      }
      if (this.transcriptHistory.length > 6) {
        this.transcriptHistory.shift();
      }
      this.renderTranscriptFeed();
      return;
    }

    // Strictly show only actual speech (`user` inputTranscription and `tutor` outputTranscription),
    // never internal model thoughts.
    if (role !== 'user' && role !== 'tutor') return;
    if (!text) return;

    const last = this.transcriptHistory[this.transcriptHistory.length - 1];
    if (last && last.role === role && !last.finalized) {
      last.text += text;
    } else {
      if (!text.trim()) return;
      this.transcriptHistory.push({ role, text, finalized: false });
      if (this.transcriptHistory.length > 6) {
        this.transcriptHistory.shift();
      }
    }

    const latest = this.transcriptHistory[this.transcriptHistory.length - 1];
    if (role === 'tutor' && latest) {
      const isRetryPrompt =
        /再說一次|再完整說一次|重新說一次|再唸一次|整句話|整句說|整句回答|把你的回答|完整的句子|翻成中文/.test(
          latest.text
        );
      if (
        !isRetryPrompt &&
        (debugLogger.context.phase || 1) < 2 &&
        (latest.text.includes('？') || latest.text.includes('?'))
      ) {
        this.setPhaseIndicator(2);
      }
      if (ENABLE_USER_ASK_BACK_FLOW && /換你問我|問我一個問題/.test(latest.text)) {
        this.setPhaseIndicator(3);
      }
    } else if (role === 'user' && latest && debugLogger.context.phase === 2) {
      if (!ENABLE_USER_ASK_BACK_FLOW || /[？?嗎呢什麼誰哪怎麼幾]/.test(latest.text)) {
        this.setPhaseIndicator(3);
      }
    }

    this.renderTranscriptFeed();
  }

  renderTranscriptFeed() {
    const visible = this.transcriptHistory.filter((item) => item.text && item.text.trim());
    if (visible.length === 0) {
      this.els.liveTranscriptFeed.innerHTML =
        '<p class="transcript-placeholder">Hands-free voice transcript will appear here...</p>';
      return;
    }
    this.els.liveTranscriptFeed.innerHTML = visible
      .map((item) => {
        const tag = item.role === 'user' ? 'You' : 'Tutor';
        const cls = item.role === 'user' ? 'turn-user' : 'turn-tutor';
        const display = item.text.replace(/\s+/g, ' ').trim();
        return `<div class="transcript-turn ${cls}"><span class="turn-tag">${tag}</span><span class="turn-text">${this.escapeHtml(display)}</span></div>`;
      })
      .join('');
    this.els.liveTranscriptFeed.scrollTop = this.els.liveTranscriptFeed.scrollHeight;
  }

  setPhaseIndicator(stepNum) {
    debugLogger.setContext({ phase: stepNum });
    this.els.phaseSteps.forEach((el, idx) => {
      if (!el) return;
      const n = idx + 1;
      el.classList.toggle('active', n === stepNum);
      el.classList.toggle('done', n < stepNum);
    });
  }

  updateAudioMeter(level) {
    const scale = 1 + Math.min(0.28, level * 0.35);
    this.els.voiceOrb.style.setProperty('--mic-scale', scale.toFixed(3));
  }

  /**
   * Screen Wake Lock API so the Pixel 9 never locks or kills the WebSocket while on a car mount.
   */
  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLockSentinel = await navigator.wakeLock.request('screen');
      } catch (_) {}
    }
  }

  async releaseWakeLock() {
    if (this.wakeLockSentinel) {
      try {
        await this.wakeLockSentinel.release();
      } catch (_) {}
      this.wakeLockSentinel = null;
    }
  }

  setupWakeLockLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.sessionActive && !this.sessionPaused) {
        this.requestWakeLock();
        if (this.pipeline.audioCtx && this.pipeline.audioCtx.state === 'suspended') {
          this.pipeline.audioCtx.resume().catch(() => {});
        }
        this.pipeline.startMediaSessionAnchor().catch(() => {});
        if (this.pipeline.isDisconnected()) {
          this.pipeline.reconnectCurrentWord().catch(() => {});
        }
      }
    });

    window.addEventListener('online', () => {
      if (this.sessionActive && !this.sessionPaused && this.pipeline.isDisconnected()) {
        this.pipeline.reconnectCurrentWord().catch(() => {});
      }
    });
  }

  _setMediaSessionPlaybackState(state = 'none') {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = state;
      if (state === 'playing' && typeof navigator.mediaSession.setPositionState === 'function') {
        navigator.mediaSession.setPositionState({
          duration: 12,
          playbackRate: 1,
          position: 0
        });
      }
    } catch (_) {}
  }

  _handleHardwareMediaAction(actionName, source = 'mediaSession') {
    if (!this.sessionActive) return;

    const isTrackSeek =
      actionName === 'previoustrack' ||
      actionName === 'seekbackward' ||
      actionName === 'nexttrack' ||
      actionName === 'seekforward';

    if (isTrackSeek) {
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      if (now - (this.lastMediaKeyPerfMs || -1000) < 350) {
        return;
      }
      this.lastMediaKeyPerfMs = now;
    }

    debugLogger.log(
      'tool',
      'steering_media_button',
      `Hardware media control: ${actionName} (${source})`,
      {
        action: actionName,
        source,
        wordIndex: this.currentIndex + 1,
        paused: Boolean(this.sessionPaused)
      }
    );

    if (actionName === 'previoustrack' || actionName === 'seekbackward') {
      this.restartCurrentWord(`steering_${actionName}`);
      return;
    }
    if (actionName === 'nexttrack' || actionName === 'seekforward') {
      this.skipCurrentWord(`steering_${actionName}`);
      return;
    }
    if (actionName === 'play') {
      if (this.sessionPaused) this.togglePauseSession(false);
      return;
    }
    if (actionName === 'pause') {
      if (!this.sessionPaused) this.togglePauseSession(true);
      return;
    }
    if (actionName === 'toggle_play_pause') {
      this.togglePauseSession();
      return;
    }
    if (actionName === 'stop') {
      this.stopDrivingSession();
    }
  }

  /**
   * MediaSession API + Hardware Media Key (`keydown`) listeners so car steering-wheel and
   * Bluetooth earbud Previous / Next / Play / Pause buttons control the tutor hands-free:
   * - Previous (`previoustrack`, `seekbackward`, `MediaTrackPrevious`) -> Restart current word from Phase 1
   * - Next (`nexttrack`, `seekforward`, `MediaTrackNext`) -> Skip to next word
   */
  setupMediaSessionControls() {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      const actions = [
        'play',
        'pause',
        'stop',
        'previoustrack',
        'nexttrack',
        'seekbackward',
        'seekforward'
      ];
      for (const action of actions) {
        try {
          navigator.mediaSession.setActionHandler(action, () => {
            this._handleHardwareMediaAction(action, 'mediaSession');
          });
        } catch (_) {}
      }
    }

    if (typeof window !== 'undefined' && !this.mediaKeydownBound) {
      this.mediaKeydownBound = true;
      window.addEventListener('keydown', (e) => {
        if (!this.sessionActive || !e) return;
        const tag = e.target && e.target.tagName ? String(e.target.tagName).toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (e.key === 'MediaTrackPrevious' || e.key === 'MediaRewind') {
          e.preventDefault();
          this._handleHardwareMediaAction('previoustrack', `keydown:${e.key}`);
        } else if (e.key === 'MediaTrackNext' || e.key === 'MediaFastForward') {
          e.preventDefault();
          this._handleHardwareMediaAction('nexttrack', `keydown:${e.key}`);
        } else if (e.key === 'MediaPlayPause') {
          e.preventDefault();
          this._handleHardwareMediaAction('toggle_play_pause', `keydown:${e.key}`);
        }
      });
    }
  }

  updateMediaSessionMetadata(word) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !word) return;
    try {
      if (typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: word.english_prompt,
          artist: 'Mandarin Driving Tutor',
          album: `Word ${this.currentIndex + 1} of ${this.batch.length}`,
          artwork: [{ src: './icons/icon.svg', sizes: '512x512', type: 'image/svg+xml' }]
        });
      }
    } catch (_) {}
    this._setMediaSessionPlaybackState(this.sessionPaused ? 'paused' : 'playing');
  }

  /**
   * File picker for AnkiDroid Plain Text (.txt) exports.
   * Detects empty Filtered Deck exports, parses `#separator:tab` and `#tags column:12`,
   * auto-discovers all Anki tags in the file, and updates the live filtered preview.
   */
  async handleFilePicked(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      this.rawAnkiFileText = text;
      const dataLines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));

      if (dataLines.length === 0) {
        this.els.textareaHanpingCsv.value = text;
        this.els.importResultBox.classList.remove('hidden');
        this.els.importResultBox.textContent =
          `Note: "${file.name}" contains 0 notes (only Anki header lines). This happens when exporting an empty Filtered Deck in AnkiDroid. Instead, export your main parent deck (e.g. "Everyday" or "All decks") as "Notes in Plain Text (.txt)" with "Include tags" checked, then choose your tag in the filter above!`;
        this.showToast(`"${file.name}" has 0 notes (empty Filtered Deck). Export your main deck instead!`, 'error');
        this.populateAnkiTagOptions('', true);
        return;
      }

      const tagCount = this.populateAnkiTagOptions(text, true);
      this.els.importResultBox.classList.add('hidden');
      this.showToast(
        `Loaded ${file.name}: ${dataLines.length} total notes (${tagCount} tags detected).`,
        'info'
      );
    } catch (err) {
      this.showToast(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /**
   * Parses AnkiDroid `#separator:...` and `#tags column:N` metadata headers (e.g. `#tags column:12`)
   * without stripping leading/trailing tabs from data lines.
   */
  parseAnkiMetadataAndRows(rawText) {
    const lines = String(rawText || '').split(/\r?\n/);
    let separator = '\t';
    let tagsCol1Based = -1;
    const headerLines = [];
    const rows = [];

    for (const rawLine of lines) {
      const cleanLine = rawLine.replace(/\r$/, '');
      if (!cleanLine.trim()) continue;

      if (cleanLine.trim().startsWith('#')) {
        const directive = cleanLine.trim();
        headerLines.push(directive);
        const sepMatch = directive.match(/^#separator\s*:\s*(.+)$/i);
        if (sepMatch) {
          const val = sepMatch[1].trim().toLowerCase();
          if (val === 'tab' || val === '\\t') separator = '\t';
          else if (val === 'comma' || val === ',') separator = ',';
          else if (val === 'semicolon' || val === ';') separator = ';';
        }
        const tagColMatch = directive.match(/^#tags\s+column\s*:\s*(\d+)/i);
        if (tagColMatch) {
          tagsCol1Based = Number(tagColMatch[1]);
        }
        continue;
      }

      if (!/[\u4e00-\u9fff\u3400-\u4dbf]/.test(cleanLine)) continue;
      // Split by separator WITHOUT calling .trim() first so leading/trailing empty tab columns are preserved!
      const cols = cleanLine.split(separator);
      if (cols.length < 2) continue;

      const tagsColIndex = tagsCol1Based >= 1 ? tagsCol1Based - 1 : cols.length - 1;
      const rawTagsCell = (tagsColIndex >= 0 && tagsColIndex < cols.length ? cols[tagsColIndex] : '').trim();
      const tags = rawTagsCell && !/[\u4e00-\u9fff]/.test(rawTagsCell)
        ? rawTagsCell.split(/\s+/).filter(Boolean)
        : [];

      rows.push({
        rawLine: cleanLine,
        cols,
        tags,
        tagsColIndex
      });
    }

    return {
      separator,
      tagsCol1Based,
      headerLines,
      rows
    };
  }

  /**
   * Scans an AnkiDroid "Notes in Plain Text (.txt)" file for `#tags column:N` (e.g. column 12)
   * and populates `#select-anki-tag`, auto-selecting `"everyday"` if present when a new file is picked.
   */
  populateAnkiTagOptions(rawText, autoSelectEveryday = false) {
    const selectEl = this.els.selectAnkiTag || document.getElementById('select-anki-tag');
    const inputEl = this.els.inputAnkiTag || document.getElementById('input-anki-tag');
    if (!selectEl) return 0;

    const parsed = this.parseAnkiMetadataAndRows(rawText);
    const tagCounts = new Map();

    for (const row of parsed.rows) {
      for (const tok of row.tags) {
        if (parsed.tagsCol1Based === -1 && row.tags.length > 4) continue;
        tagCounts.set(tok, (tagCounts.get(tok) || 0) + 1);
      }
    }

    const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
    let currentVal = (inputEl ? inputEl.value : '').trim();

    // If a file was just loaded and no tag filter was manually typed yet, auto-select "everyday" if present!
    if (autoSelectEveryday && !currentVal) {
      const hasEveryday = sortedTags.find(([t]) => t.toLowerCase() === 'everyday');
      if (hasEveryday) {
        currentVal = hasEveryday[0];
        if (inputEl) inputEl.value = currentVal;
      }
    }

    selectEl.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = `All Notes in File (${parsed.rows.length} notes)`;
    selectEl.appendChild(allOpt);

    for (const [tag, count] of sortedTags) {
      const opt = document.createElement('option');
      opt.value = tag;
      opt.textContent = `${tag} (${count} notes)`;
      if (currentVal && tag.toLowerCase() === currentVal.toLowerCase()) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    }

    this.applyAnkiTagFilterPreview();
    return sortedTags.length;
  }

  /**
   * Filters `this.rawAnkiFileText` in real time whenever the selected/typed tag changes,
   * updates `#textarea-hanping-csv` so the user can verify the exact filtered lines,
   * and updates `#anki-tag-summary` with the detected metadata and match count.
   */
  applyAnkiTagFilterPreview() {
    const sourceText = this.rawAnkiFileText || (this.els.textareaHanpingCsv ? this.els.textareaHanpingCsv.value : '');
    if (!sourceText) return;

    const selectEl = this.els.selectAnkiTag || document.getElementById('select-anki-tag');
    const inputEl = this.els.inputAnkiTag || document.getElementById('input-anki-tag');
    const summaryEl = this.els.ankiTagSummary || document.getElementById('anki-tag-summary');
    const labelEl = this.els.labelPreviewCount || document.getElementById('label-preview-count');

    const activeTag = ((inputEl && inputEl.value) || (selectEl && selectEl.value) || '').trim();
    const targetLower = activeTag.toLowerCase();

    const parsed = this.parseAnkiMetadataAndRows(sourceText);
    const tagCounts = new Map();
    for (const row of parsed.rows) {
      for (const tok of row.tags) {
        tagCounts.set(tok, (tagCounts.get(tok) || 0) + 1);
      }
    }

    const matchedRows = targetLower
      ? parsed.rows.filter((r) =>
          r.tags.some((t) => {
            const tl = t.toLowerCase();
            return tl === targetLower || tl.endsWith('::' + targetLower);
          })
        )
      : parsed.rows;

    if (this.els.textareaHanpingCsv) {
      const outLines = [...parsed.headerLines, ...matchedRows.map((r) => r.rawLine)];
      this.els.textareaHanpingCsv.value = outLines.join('\n');
    }

    if (labelEl) {
      labelEl.textContent = activeTag
        ? `Filtered Preview (${matchedRows.length} of ${parsed.rows.length} notes matching tag "${activeTag}")`
        : `Filtered Preview (All ${parsed.rows.length} notes)`;
    }

    if (summaryEl) {
      if (parsed.rows.length === 0) {
        summaryEl.classList.add('hidden');
      } else {
        const tagListStr = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `${t} (${c})`)
          .join(', ');
        const colInfo = parsed.tagsCol1Based > 0 ? `column ${parsed.tagsCol1Based}` : 'last column';
        const filterInfo = activeTag
          ? `Filtering by tag "${activeTag}": ${matchedRows.length} of ${parsed.rows.length} notes matched.`
          : `Showing all ${parsed.rows.length} notes (select or type a tag above to filter).`;
        summaryEl.textContent = `Detected #separator:tab, tags in ${colInfo} · Tags in file: ${tagListStr || 'none'} · ${filterInfo}`;
        summaryEl.classList.remove('hidden');
      }
    }
  }

  /**
   * Normalizes filtered AnkiDroid rows into clean 5-column TSV (`Traditional\tSimplified\tPinyin\tGloss\tTags`)
   * so that any version of the Apps Script backend imports ONLY the filtered notes with clean fields.
   */
  buildCleanFilteredTsv(sourceText, tagFilter) {
    const parsed = this.parseAnkiMetadataAndRows(sourceText);
    const targetLower = String(tagFilter || '').trim().toLowerCase();

    const matchedRows = targetLower
      ? parsed.rows.filter((r) =>
          r.tags.some((t) => {
            const tl = t.toLowerCase();
            return tl === targetLower || tl.endsWith('::' + targetLower);
          })
        )
      : parsed.rows;

    if (matchedRows.length === 0) return { csvText: '', matchedCount: 0, totalCount: parsed.rows.length };

    const cleanLines = ['#separator:tab', '#html:false', '#tags column:5'];
    for (const row of matchedRows) {
      const cols = row.cols;
      // For standard 12-col Hanping->AnkiDroid export: col 0 = Trad, col 1 = Simp, col 2 = Pinyin, col 4 = Gloss
      if (cols.length >= 5 && /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test((cols[0] || '').trim())) {
        const trad = (cols[0] || '').trim();
        const simp = /^[\u4e00-\u9fff\u3400-\u4dbf]+$/.test((cols[1] || '').trim()) ? (cols[1] || '').trim() : '';
        const pinyin = numberedPinyinToToneMarks((cols[2] || '').trim());
        const gloss = ((cols[4] || cols[3] || '').replace(/%27/gi, "'")).trim();
        const tagsStr = row.tags.join(' ');
        cleanLines.push([trad, simp, pinyin, gloss, tagsStr].join('\t'));
      } else {
        const convertedCols = cols.map((c, idx) =>
          idx >= 1 && idx <= 2 && !/[\u4e00-\u9fff]/.test(c) ? numberedPinyinToToneMarks(c) : c
        );
        cleanLines.push(convertedCols.join(parsed.separator));
      }
    }

    return {
      csvText: cleanLines.join('\n'),
      matchedCount: matchedRows.length,
      totalCount: parsed.rows.length
    };
  }

  async uploadHanpingCsv() {
    const sourceText = (this.rawAnkiFileText || (this.els.textareaHanpingCsv ? this.els.textareaHanpingCsv.value : '')).trim();
    const inputEl = this.els.inputAnkiTag || document.getElementById('input-anki-tag');
    const selectEl = this.els.selectAnkiTag || document.getElementById('select-anki-tag');
    const pruneEl = this.els.chkPruneNonmatching || document.getElementById('chk-prune-nonmatching');

    const tagFilter = ((inputEl && inputEl.value) || (selectEl && selectEl.value) || '').trim();
    const pruneNonMatching = pruneEl ? Boolean(pruneEl.checked) : true;

    if (!sourceText) {
      this.showToast('Please select an AnkiDroid .txt export file or paste rows first.', 'error');
      return;
    }
    const dataLines = sourceText.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (dataLines.length === 0) {
      this.showToast(
        'This file has 0 notes (only # header lines from an empty Filtered Deck). Export your main parent deck with "Include tags" checked instead.',
        'error'
      );
      return;
    }

    const { csvText, matchedCount, totalCount } = this.buildCleanFilteredTsv(sourceText, tagFilter);
    if (!csvText || matchedCount === 0) {
      this.showToast(`No notes found with tag "${tagFilter}" out of ${totalCount} notes.`, 'error');
      return;
    }

    try {
      this.els.btnUploadHanping.disabled = true;
      this.els.btnUploadHanping.textContent = `Importing ${matchedCount} Notes & Generating Mandarin -> English...`;
      const res = await this.callBackend('import_hanping', {
        csvText,
        tagFilter,
        pruneNonMatching
      });

      let totalPromptsGenerated = Number(res.promptsGenerated || 0);
      let remaining = Number(res.remainingPrompts || 0);
      let guard = 0;
      while (remaining > 0 && guard < 20) {
        guard++;
        this.els.btnUploadHanping.textContent =
          `Saved ${totalPromptsGenerated} Mandarin -> English pairs (${remaining} left)...`;
        const waveRes = await this.callBackend('pregenerate_prompts', {
          forceRefreshAll: false,
          limit: 345
        });
        const newlyUpdated = Number(waveRes.updatedCount || 0);
        totalPromptsGenerated += newlyUpdated;
        remaining = Number(waveRes.remainingCount || 0);
        if (newlyUpdated === 0) break;
      }

      this.els.importResultBox.classList.remove('hidden');
      const tagSummary = tagFilter ? ` with tag "${tagFilter}"` : '';
      const prunedSummary = res.prunedCount ? `, removed ${res.prunedCount} non-matching unstudied words` : '';
      const promptSummary = totalPromptsGenerated ? `, pre-generated ${totalPromptsGenerated} Mandarin -> English sentence pairs` : '';
      this.els.importResultBox.textContent =
        `Matched ${matchedCount} notes${tagSummary} (out of ${totalCount} in file): ${res.addedCount} newly added to Sheet, ${res.skippedDuplicate} already in Sheet${prunedSummary}${promptSummary}.`;
      this.showToast(
        `Synced ${matchedCount} notes${tagSummary} (${res.addedCount} new${promptSummary})!`,
        'success'
      );
      await this.refreshBackendStatus(false);
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnUploadHanping.disabled = false;
      this.els.btnUploadHanping.textContent = 'Import Filtered Notes & Pre-Generate Sentences';
    }
  }

  async pullTocflSupplemental() {
    const tocflLevel = Number(this.els.selectSupplementLevel.value || 2);
    const count = Number(this.els.inputSupplementCount.value || 30);
    try {
      this.els.btnPullTocfl.disabled = true;
      this.els.btnPullTocfl.textContent = `Pulling Level ${tocflLevel} & Generating Mandarin -> English...`;
      const res = await this.callBackend('supplement_tocfl', { tocflLevel, count });
      this.els.importResultBox.classList.remove('hidden');
      const promptInfo = res.promptsGenerated ? ` and pre-generated ${res.promptsGenerated} Mandarin -> English pairs` : '';
      this.els.importResultBox.textContent =
        `Added ${res.addedCount} highest-spoken-frequency TOCFL Level ${res.tocflLevel} words from PSeitz/tocfl${promptInfo} (${res.remainingInLevel} remaining in level).`;
      this.showToast(`Added ${res.addedCount} TOCFL L${tocflLevel} words!`, 'success');
      await this.refreshBackendStatus(false);
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnPullTocfl.disabled = false;
      this.els.btnPullTocfl.textContent = 'Supplement from PSeitz/tocfl';
    }
  }

  async pregenerateSheetPrompts() {
    if (!this.els.btnPregeneratePrompts) return;
    try {
      this.els.btnPregeneratePrompts.disabled = true;
      let offset = 0;
      const limit = 345;
      let totalUpdated = 0;
      let totalEligible = 0;
      let guard = 0;

      while (guard < 30) {
        guard++;
        this.els.btnPregeneratePrompts.textContent = totalEligible > 0
          ? `Saved ${totalUpdated} / ${totalEligible} Mandarin -> English pairs...`
          : 'Generating Mandarin -> English Sentences in Parallel...';

        const res = await this.callBackend('pregenerate_prompts', {
          forceRefreshAll: true,
          offset,
          limit
        });

        totalEligible = Number(res.totalEligible || 0);
        totalUpdated += Number(res.updatedCount || 0);

        if (res.nextOffset === undefined) {
          break;
        }
        offset = Number(res.nextOffset);
        if (offset >= totalEligible || Number(res.processedInCall || 0) === 0) {
          break;
        }
      }

      this.els.importResultBox.classList.remove('hidden');
      this.els.importResultBox.textContent =
        `Pre-generated ${totalUpdated} natural Taiwanese Mandarin -> English sentence pairs across ${totalEligible} words in your Sheet! Sessions will now start immediately.`;
      this.showToast(`Saved ${totalUpdated} Mandarin -> English sentence pairs in Sheet!`, 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnPregeneratePrompts.disabled = false;
      this.els.btnPregeneratePrompts.textContent = 'Generate / Refresh Mandarin → English Sentences';
    }
  }

  async normalizeSheetPinyin() {
    if (!this.els.btnNormalizePinyin) return;
    try {
      this.els.btnNormalizePinyin.disabled = true;
      this.els.btnNormalizePinyin.textContent = 'Converting Sheet Pinyin to Tone Marks...';
      const res = await this.callBackend('normalize_pinyin');
      const vocabUpdated = Number(res.vocabUpdated || 0);
      const reviewLogUpdated = Number(res.reviewLogUpdated || 0);
      const totalVocab = Number(res.totalVocab || 0);

      this.els.importResultBox.classList.remove('hidden');
      if (vocabUpdated > 0 || reviewLogUpdated > 0) {
        this.els.importResultBox.textContent =
          `Converted ${vocabUpdated} Vocab rows (out of ${totalVocab}) and ${reviewLogUpdated} ReviewLog rows in your Google Sheet to standard tone-mark Pinyin (ā á ǎ à)!`;
        this.showToast(`Converted ${vocabUpdated} words in Sheet to tone-mark Pinyin!`, 'success');
      } else {
        this.els.importResultBox.textContent =
          `All ${totalVocab} words in your Google Sheet already use standard tone-mark Pinyin (ā á ǎ à).`;
        this.showToast('All Sheet Pinyin is already using tone marks!', 'info');
      }
    } catch (err) {
      const msg = String(err.message || err);
      if (/Unknown action:\s*normalize_pinyin/i.test(msg)) {
        this.els.importResultBox.classList.remove('hidden');
        this.els.importResultBox.textContent =
          'Your Google Sheet Web App is running an older Code.gs deployment. Paste the updated apps-script/Code.gs into Extensions → Apps Script → Deploy → Manage deployments → Edit → New version (or run Mandarin Tutor → Convert All Pinyin to Tone Marks in your Sheet) to rewrite all Sheet rows in-place!';
        this.showToast('Update Code.gs in Apps Script to rewrite Sheet cells (app already shows tone marks!).', 'info');
      } else {
        this.showToast(msg, 'error');
      }
    } finally {
      this.els.btnNormalizePinyin.disabled = false;
      this.els.btnNormalizePinyin.textContent = 'Convert Sheet Pinyin to Tone Marks (ā á ǎ à)';
    }
  }

  /**
   * Persistent Debug Logs Drawer & 1-Tap Gemini Diagnostic Export
   */
  setupDebugLogsSubscription() {
    const syncAlertState = () => {
      const hasAlert = debugLogger.hasUnreadIssue;
      if (this.els.logsAlertDot) {
        this.els.logsAlertDot.classList.toggle('hidden', !hasAlert);
      }
      if (this.els.btnOpenLogs) {
        this.els.btnOpenLogs.classList.toggle('has-alert', hasAlert);
      }
      if (this.els.drawerLogs && !this.els.drawerLogs.classList.contains('hidden')) {
        this.renderLogsDrawer();
      }
    };
    syncAlertState();
    debugLogger.subscribe(() => syncAlertState());
  }

  openLogsDrawer() {
    if (!this.els.drawerLogs) return;
    debugLogger.markIssuesRead();
    this.els.drawerLogs.classList.remove('hidden');
    if (this.els.logsAlertDot) this.els.logsAlertDot.classList.add('hidden');
    if (this.els.btnOpenLogs) this.els.btnOpenLogs.classList.remove('has-alert');
    this.renderLogsDrawer();
  }

  renderLogsDrawer() {
    if (!this.els.logsViewer || !this.els.logsSummaryBox) return;

    const stats = debugLogger.getSummaryStats();
    let closeNote = '0';
    if (stats.lastUnexpectedClose) {
      const d = stats.lastUnexpectedClose.data || {};
      closeNote = `${stats.unexpectedCloseCount} (last code=${d.code ?? '?'}${d.reason ? `, "${this.escapeHtml(d.reason)}"` : ''})`;
    }

    const audioSummary = debugLogger.context?.audioSummary || 'Not initialized yet';
    this.els.logsSummaryBox.innerHTML =
      `<strong>App ${this.escapeHtml(stats.version)}</strong> · Model: <code>${this.escapeHtml(stats.activeModel)}</code> · Events: <strong>${stats.totalEntries}</strong><br />` +
      `Audio: <code>${this.escapeHtml(audioSummary)}</code><br />` +
      `Network: <code>${this.escapeHtml(stats.networkSummary)}</code><br />` +
      `Health: Words: <strong>${stats.wordCompletedCount}</strong> · Auto-Replays: <strong>${stats.utteranceReplayCount}</strong> · Wedged-ASR: <strong>${stats.wedgedAsrCount}</strong> · WS-Closes: <strong>${closeNote}</strong><br />` +
      `<span style="font-size:0.76rem; color:var(--text-muted);">Tap <strong>Copy Logs for Gemini</strong> below and paste directly into Gemini chat to debug any voice, cellular, car audio, or WebSocket issue.</span>`;

    const filter = this.els.selectLogFilter ? this.els.selectLogFilter.value : 'all';
    const entries = debugLogger.getEntries(filter);
    if (entries.length === 0) {
      this.els.logsViewer.textContent =
        filter === 'highlights'
          ? 'No scores, network changes, audio alerts, or errors recorded yet.'
          : 'No events logged yet.';
      return;
    }

    const htmlRows = entries.slice(-250).map((e) => {
      const lineText = debugLogger._formatSingleEntryLine(e);
      const cls = `log-row log-level-${e.level || 'info'}`;
      return `<div class="${cls}">${this.escapeHtml(lineText)}</div>`;
    });

    this.els.logsViewer.innerHTML = htmlRows.join('');
    this.els.logsViewer.scrollTop = this.els.logsViewer.scrollHeight;
  }

  async copyLogsForGemini() {
    const markdownReport = debugLogger.formatForGemini(130, 17800);
    let copied = false;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(markdownReport);
        copied = true;
      } catch (_) {}
    }

    if (!copied) {
      try {
        const tempArea = document.createElement('textarea');
        tempArea.value = markdownReport;
        tempArea.style.position = 'fixed';
        tempArea.style.opacity = '0';
        document.body.appendChild(tempArea);
        tempArea.focus();
        tempArea.select();
        copied = document.execCommand('copy');
        tempArea.remove();
      } catch (_) {}
    }

    if (copied) {
      this.showToast('Copied diagnostic log! Paste directly into Gemini chat.', 'success');
    } else {
      this.showToast('Clipboard blocked — tap Share / Save .txt instead.', 'error');
    }
  }

  async shareOrDownloadLogs() {
    const markdownReport = debugLogger.formatForGemini(300, 120000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `mandarin-tutor-logs-${stamp}.txt`;

    // On Android Pixel 9 Chrome, native Web Share opens the Android share sheet (Gemini, Keep, Drive, Gmail, etc.)
    if (navigator.share) {
      try {
        const file = new File([markdownReport], filename, { type: 'text/plain' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            title: 'Mandarin Tutor Diagnostic Log',
            text: 'Diagnostic log bundle for Gemini debugging',
            files: [file]
          });
          return;
        }
        await navigator.share({
          title: 'Mandarin Tutor Diagnostic Log',
          text: markdownReport
        });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    // Fallback: direct .txt download
    const blob = new Blob([markdownReport], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.showToast(`Downloaded ${filename}`, 'success');
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    this.els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    window.tutorApp = new MandarinTutorApp();
  });
}

