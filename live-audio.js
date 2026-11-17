/**
 * Gemini Live WebSocket + WebAudio PCM 16kHz/24kHz Streaming Engine (`live-audio.js`)
 *
 * Key architectural guarantees (v22):
 * 1. Fresh WebSocket connection per vocabulary word (zero multi-word context drift).
 * 2. ZERO `tools` / `functionDeclarations` on the Live Audio WebSocket:
 *    Uses deterministic spoken sign-off phrases (`「好，我們看下一題！」`, `「好，我們跳過這題！」`,
 *    etc.) detected from `outputAudioTranscription`, while FSRS v5 grading runs asynchronously
 *    over standard REST JSON in the background after the word ends!
 * 3. Model-aware cold-start `clientContent` (`turnComplete: true` on 2.5) + clean same-model
 *    continuation on stalled turns / manual "Done Speaking" + late-ASR preservation into `wordTurns`.
 * 4. Mid-sentence crash recovery: if a cellular drop or server `1011` interrupts the tutor
 *    BEFORE `turnComplete`, auto-reconnect rotates to the next healthy Live model immediately
 *    and prompts the tutor to finish its interrupted sentence instead of freezing in `listening`.
 * 5. Smart context- & sentence-completeness-aware endpointing (~850–1100ms on completed sentences,
 *    ~1950ms on incomplete mid-sentence pauses) + 400ms real mic tail + transient noise rejection.
 * 6. Clean Unboosted Bluetooth Call / Earbuds Default Audio (`bluetooth_hfp` default) + Persistent
 *    12s `<audio>` MediaSession Anchor so Android OS & Bluetooth AVRCP route steering-wheel / earbud
 *    Previous (restart word) & Next (skip word) buttons to `navigator.mediaSession`.
 */

import { debugLogger } from './debug-logger.js?v=22';
import { numberedPinyinToToneMarks } from './pinyin-utils.js?v=22';

const LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// 1600 samples @ 16kHz (3200 zero bytes) = exact 100ms frame of pure digital silence
const ZERO_PCM16_100MS_BASE64 = btoa('\0'.repeat(3200));

/**
 * Generates an in-memory 16-bit mono PCM WAV buffer (`durationSec >= 5` seconds for Chromium Android
 * `MediaContentType::Persistent`) with alternating ±1 LSB (`-90.3 dBFS`, completely inaudible to
 * human ears yet non-zero so Android/Chromium silence detectors keep `MediaSessionCompat` active
 * for car steering-wheel & Bluetooth AVRCP `previoustrack` / `nexttrack` buttons).
 */
export function buildSilentWavBytes(durationSec = 12, sampleRate = 8000) {
  const numSamples = Math.max(sampleRate * 6, Math.floor(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, (i & 1) === 0 ? 1 : -1, true);
  }
  return new Uint8Array(buffer);
}

/**
 * Feature flag for the Phase 3 "student asks tutor a follow-up question back" step.
 * Kept intact in code & prompts so it can be re-enabled anytime by flipping to `true`.
 */
export const ENABLE_USER_ASK_BACK_FLOW = false;

/**
 * Identifies genuine Bluetooth audio devices (car HFP hands-free, Pixel Buds, AirPods, etc.)
 * while explicitly excluding Pixel's built-in `"Headset earpiece"` / wired USB devices.
 */
export function isBluetoothAudioDeviceLabel(label = '') {
  const s = String(label || '').trim();
  if (!s) return false;
  if (/earpiece|wired|usb/i.test(s)) return false;
  return /bluetooth|\bbt\b|hands-free|earbud|buds|airpods|hfp|car|leaf|nissan|headset/i.test(s);
}

const WORKLET_CODE = `
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 2400 samples @ 24kHz = exact 100ms -> 1600 samples (3200 bytes) @ 16kHz PCM
    this.bufferSize = 2400;
    this.buffer = new Float32Array(this.bufferSize);
    this.idx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.idx++] = channel[i];
      if (this.idx >= this.bufferSize) {
        this.port.postMessage(this.buffer.slice(0));
        this.idx = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
`;

/**
 * Deterministic spoken sign-off phrase detector on `outputAudioTranscription`.
 * Eliminates fragile `BidiGenerateContent` tool calls completely!
 */
export function detectSpokenTerminalCue(spokenText = '') {
  const clean = String(spokenText || '').replace(/\s+/g, '');
  if (!clean) return null;

  if (/已標記問題卡片|標記問題卡片|標記這題|標記這張卡片/.test(clean)) {
    return { type: 'control', action: 'flag_bad_card' };
  }
  if (/我們跳過這題|跳過這題|跳過這一題|跳過這個單字/.test(clean)) {
    return { type: 'control', action: 'skip' };
  }
  if (/我們先暫停練習|先暫停練習|暫停練習/.test(clean)) {
    return { type: 'control', action: 'pause' };
  }
  if (/今天的練習結束|結束今天的練習|練習結束囉|結束練習囉/.test(clean)) {
    return { type: 'control', action: 'end_session' };
  }
  if (/我們看下一題|看下一題吧|看下一題囉|進入下一題|換下一題|來看下一題|進行下一題|下一個單字/.test(clean)) {
    return { type: 'complete_word' };
  }
  return null;
}

/**
 * Detects whether a Mandarin string contains an actual question (excluding declarative
 * negative phrases like `沒做什麼` / `不知道去哪裡` that are statements rather than questions).
 */
export function containsMandarinQuestion(text = '') {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/[？?]/.test(s)) return true;

  const strippedDeclaratives = s.replace(
    /沒(?:有)?(?:做|說|吃|買|去|看|發生|講|想)?(?:什麼|甚麼)|(?:不知道|不確定|忘了|忘記)(?:要|該|會|能|可以|怎麼|怎樣)?(?:去|到|做|買|吃|說|看|講|選|點)?(?:哪裡|哪兒|哪個|哪邊|哪家|什麼|甚麼|誰|怎麼|怎樣|為什麼|幾點|多少|多久)?/g,
    ''
  );

  return (
    /[嗎呢]\s*[。！？!?]*$/.test(strippedDeclaratives) ||
    /那你呢|你呢|對吧|是吧|好嗎|可以嗎|對嗎|行嗎/.test(strippedDeclaratives) ||
    /什麼|甚麼|誰|哪裡|哪兒|哪個|哪邊|哪家|哪一家|哪間|哪些|怎麼|怎樣|為什麼|幹嘛|幾點|幾個|幾次|幾天|幾年|幾歲|多少|多久|多遠|多常|還是|([一-龥])不\1|([一-龥])沒\2|喜不喜歡|可不可以|有沒有|正不正常|可不可能|經不經常/.test(
      strippedDeclaratives
    )
  );
}

/**
 * Determines what kind of user response the tutor's just-completed turn expects next:
 * - `'translate'`: Phase 1 sentence translation (or Phase 1 pronunciation/grammar/synonym/English-word retry)
 * - `'answer_followup'`: Tutor asked a Phase 2 follow-up question or is coaching a Phase 3 follow-up reply retry
 * - `'reply_and_ask_back'`: Preserved for `enableAskBack === true` (student answers AND asks a question back)
 * - `'ask_question_only'`: Preserved for `enableAskBack === true` (`"現在換你問我一個問題吧！"`)
 */
export function classifyNextUserTurnExpectation(
  tutorSpokenText = '',
  completedTutorTurnsCount = 1,
  { enableAskBack = ENABLE_USER_ASK_BACK_FLOW, previousExpectation = 'translate' } = {}
) {
  const txt = String(tutorSpokenText || '').trim();
  const prev = previousExpectation || 'translate';
  if (!txt || completedTutorTurnsCount <= 1) {
    return 'translate';
  }

  if (enableAskBack && /換你問我|問我一個問題|請你問我|問我問題|向我提問/.test(txt)) {
    if (/再說一次|再唸一次|重新說一次/.test(txt) && prev !== 'ask_question_only') {
      return 'reply_and_ask_back';
    }
    return 'ask_question_only';
  }

  // Explicit Phase 1 translation instruction (e.g. repeating English sentence on request)
  if (/把這句話翻成中文|翻成中文/.test(txt)) {
    return 'translate';
  }

  // Pronunciation / grammar / English-word / full-sentence retry prompt:
  // Stay in the current phase (`'translate'` during Phase 1; `'answer_followup'` / `'reply_and_ask_back'` / `'ask_question_only'` during Phase 3)
  if (
    /再說一次|再完整說一次|重新說一次|再唸一次|整句話|整句說|整句回答|把你的回答|完整的句子|試著用|換成我們今天|給你一點提示|提示你一下/.test(
      txt
    )
  ) {
    return prev;
  }

  if (containsMandarinQuestion(txt)) {
    if (prev === 'ask_question_only') {
      return 'ask_question_only';
    }
    return enableAskBack ? 'reply_and_ask_back' : 'answer_followup';
  }

  return prev;
}

/**
 * Reconstructs the current `turnExpectation` across all completed tutor turns in `wordTurns`
 * (including across mid-word WebSocket reconnects during Phase 1 or Phase 3 correction loops).
 */
export function deriveTurnExpectationFromHistory(
  wordTurns = [],
  { enableAskBack = ENABLE_USER_ASK_BACK_FLOW } = {}
) {
  let expectation = 'translate';
  let tutorCount = 0;
  for (const t of Array.isArray(wordTurns) ? wordTurns : []) {
    if (t && t.role === 'tutor' && t.text) {
      tutorCount += 1;
      expectation = classifyNextUserTurnExpectation(t.text, tutorCount, {
        enableAskBack,
        previousExpectation: expectation
      });
    }
  }
  return expectation;
}

/**
 * Checks during a `'reply_and_ask_back'` turn whether the student has ALREADY spoken
 * both their answer AND their follow-up question back to the tutor.
 * (Preserved for `ENABLE_USER_ASK_BACK_FLOW = true`.)
 */
export function hasCompletedReplyAndQuestionBack(transcript = '', speechSegmentsInTurn = 1) {
  const raw = String(transcript || '').trim();

  if (raw) {
    const clauses = raw
      .split(/[。！？!?，,；;\s]+/)
      .map((c) => c.trim())
      .filter(Boolean);

    if (clauses.length >= 2 && containsMandarinQuestion(clauses[clauses.length - 1])) {
      return true;
    }

    const hanziOnly = (raw.match(/[\u4e00-\u9fff]/g) || []).join('');
    if (hanziOnly.length >= 6) {
      const tailAfterShortAnswer = raw.slice(Math.min(raw.length, 3));
      if (
        /(?:那你|你|老師|您)/.test(tailAfterShortAnswer) &&
        containsMandarinQuestion(tailAfterShortAnswer)
      ) {
        return true;
      }
    }

    if (speechSegmentsInTurn >= 2 && containsMandarinQuestion(raw)) {
      return true;
    }
    return false;
  }

  // Pure acoustic fallback only if server ASR emitted zero text across 2 distinct speech segments
  return speechSegmentsInTurn >= 2;
}

/**
 * Intelligent context- and sentence-completeness-aware post-speech silence calculator:
 * - Responds snappily (~850–1100ms, matching consumer Gemini Live) when a sentence is complete.
 * - Holds longer (~1850–1950ms) when the user pauses mid-sentence (short fragment, filler, or dangling word).
 * - Preserves `'reply_and_ask_back'` (~2650ms) and `'ask_question_only'` branches when `ENABLE_USER_ASK_BACK_FLOW` is enabled.
 */
export function computeSmartSilenceThresholdMs({
  transcript = '',
  turnExpectation = 'translate',
  speechSegmentsInTurn = 1,
  voicedMs = 0,
  expectedMinHanzi = 0
} = {}) {
  const raw = String(transcript || '').trim();
  const hanziCount = (raw.match(/[\u4e00-\u9fff]/g) || []).length;

  // 1. Instant voice control commands
  if (
    raw &&
    /^(跳過|下一題|下一個|換下一題|暫停|先暫停|結束練習|停止練習|再說一次|再唸一次|再說一次英文|提示|給我提示|skip|next|pause|repeat|hint)[。！!？?\s]*$/i.test(
      raw
    )
  ) {
    return { thresholdMs: 850, reason: 'voice_command' };
  }

  const hasTerminalPunct = /[。！？!?]\s*$/.test(raw);
  const hasTrailingCommaOrFiller =
    /[，,、…—-]\s*$/.test(raw) || /(?:嗯|呃|那個|就是|然後)\s*[。，,、…]*$/.test(raw);
  const hasAlwaysDanglingWord =
    /(?:因為|所以|如果|要是|雖然|但是|可是|不過|而且|還是|或者|的時候|的話|我覺得|我想|我要|我打算|我準備|正在|試著|在|從|離|把|被|給|跟|對|比|往)\s*[。，,、…]*$/.test(
      raw
    );
  const hasUnpunctuatedAuxiliaryTail =
    !hasTerminalPunct && /(?:去|到|要|想|會|能|可以|應該|可能|喜歡|開始|繼續)\s*$/.test(raw);

  const isTrailingIncomplete =
    Boolean(raw) &&
    (hasTrailingCommaOrFiller || hasAlwaysDanglingWord || hasUnpunctuatedAuxiliaryTail);

  // 2. Preserved Phase 2 -> 3: Answer tutor's question AND ask a question back (`ENABLE_USER_ASK_BACK_FLOW = true`)
  if (turnExpectation === 'reply_and_ask_back') {
    if (
      !isTrailingIncomplete &&
      hasCompletedReplyAndQuestionBack(raw, speechSegmentsInTurn)
    ) {
      return { thresholdMs: 950, reason: 'reply_and_question_complete' };
    }
    return {
      thresholdMs: isTrailingIncomplete ? 2850 : 2650,
      reason: 'awaiting_followup_question'
    };
  }

  // 3. Preserved standalone question turn (`ENABLE_USER_ASK_BACK_FLOW = true`)
  if (turnExpectation === 'ask_question_only') {
    if (!isTrailingIncomplete && containsMandarinQuestion(raw) && hanziCount >= 3) {
      return { thresholdMs: 950, reason: 'question_complete' };
    }
    if (isTrailingIncomplete || (raw && !containsMandarinQuestion(raw))) {
      return { thresholdMs: 1850, reason: 'forming_question' };
    }
    return {
      thresholdMs: voicedMs >= 1300 ? 1500 : 1850,
      reason: 'question_acoustic'
    };
  }

  // 4. Phase 1 sentence translation & Phase 3 follow-up answer (`'translate'` | `'answer_followup'`)
  const effectiveExpectedMin = turnExpectation === 'answer_followup' ? 0 : expectedMinHanzi;
  const minCompleteHanzi =
    effectiveExpectedMin >= 5
      ? Math.max(4, Math.ceil(effectiveExpectedMin * 0.6))
      : turnExpectation === 'answer_followup'
      ? 3
      : 4;

  if (raw) {
    if (
      isTrailingIncomplete ||
      (effectiveExpectedMin >= 6 &&
        hanziCount > 0 &&
        hanziCount < Math.ceil(effectiveExpectedMin * 0.52))
    ) {
      return { thresholdMs: 1950, reason: 'incomplete_sentence_fragment' };
    }
    if (hasTerminalPunct && hanziCount >= minCompleteHanzi) {
      return { thresholdMs: 950, reason: 'sentence_complete_punctuated' };
    }
    if (hanziCount >= minCompleteHanzi && voicedMs >= 950) {
      return { thresholdMs: 1100, reason: 'sentence_complete_length' };
    }
    return { thresholdMs: 1500, reason: 'short_partial_transcript' };
  }

  // Acoustic fallback when interim/final transcript has not arrived yet (e.g. mobile cellular latency in car):
  if (voicedMs >= 1350) {
    return { thresholdMs: 1650, reason: 'acoustic_sentence_complete' };
  }
  return { thresholdMs: 1950, reason: 'acoustic_short_utterance' };
}

export function buildWordSystemInstruction(
  word,
  priorTurns = [],
  { enableAskBack = ENABLE_USER_ASK_BACK_FLOW } = {}
) {
  const referenceMandarin = (word.mandarin_sentence || word.sample_mandarin || '').trim();
  const synonymsLine = word.common_synonyms
    ? `常見近義詞（若學生先說了近義詞，請肯定句子自然並請他換成今天要練習的另一個近義詞，不要直接唸出目標詞讀音，也不要扣分）：${word.common_synonyms}`
    : '若學生使用了其他合法的近義詞，請先肯定句子自然，並請他「換成我們今天要練習的另一個近義詞」再把整句話說一次，不要直接唸出目標詞的發音，也不扣分。';

  let resumeSection = '';
  if (Array.isArray(priorTurns) && priorTurns.length > 0) {
    const formattedTurns = priorTurns
      .map((t) => `${t.role === 'tutor' ? '老師' : '學生'}：${t.text}`)
      .join('\n');
    const resumeEndHint = enableAskBack
      ? '若學生已回答或反問問題，請同樣嚴格檢查他的發音、聲調與語法：若有錯誤或夾雜英文請先糾正並請他重說整句；若整句已經完全自然正確且已完成問答，請簡短回答一句並說出固定結尾口令「好，我們看下一題！」。'
      : '若你已經問過延伸問題且學生剛才已回答，請同樣先嚴格檢查他剛才那句回答的發音、聲調與語法：若有錯誤、夾雜英文或只說了單詞片段，請先糾正並停下來等待他重說整句回答；只有當整句回答已經完全自然正確時，才簡短自然回應一句並說出固定結尾口令「好，我們看下一題！」。';
    resumeSection = `\n\n【本題目前已完成的對話紀錄（剛才網路短暫重連，請直接從最後一句自然接續，絕對不要重頭出題或重複已經說過的話！）】\n${formattedTurns}\n請根據上述對話進度直接接續目前的練習階段；${resumeEndHint}`;
  }

  // Preserved Phase 3 + Phase 4 block for `ENABLE_USER_ASK_BACK_FLOW = true`
  const askBackFlowPhases = `- **階段三（學生回答＋請學生反問老師，並嚴格把關發音聲調與語法直到整句完全正確）**：
  1. 學生會用中文回答你的問題，並且應該要順便反問你一個相關的問題。
  2. 請用與階段一完全相同的標準，非常仔細地檢查學生回答與提問的發音、聲調、用詞與語法（若夾雜英文單字請告訴他台灣華語怎麼說；局部錯誤請只糾正該詞或聲調而不要直接洩漏整句，整體語法錯誤則可示範完整自然句）。只要有任何錯誤，請務必請他把修正後的完整句子重說一次並停下來等待，反覆修正直到整句完全正確為止！
  3. **關鍵規則**：當回答句子完全正確後，如果學生還沒反問你問題，**請絕對不要再問他新的問題**！請先簡短回應他一句，然後明確請他問你一個問題（例如：「聽起來不錯！現在換你問我一個問題吧！」），並對他的提問同樣把關直到整句正確後再進入階段四。

- **階段四（老師簡短回答並說出固定換題口令）**：
  當學生親口完整說出正確自然的提問後，請用簡單、自然慢速的台灣華語**簡短回答他的問題（1 句短句即可）**，並在最後一字不差地說出固定換題口令：**「好，我們看下一題！」**。
  （注意：在階段一至階段三未全部完成且句子完全正確前，絕對不可以說出「我們看下一題」；一說出「好，我們看下一題！」系統就會自動計分並切換到下一個單字！）`;

  // Active default Phase 3 block (`ENABLE_USER_ASK_BACK_FLOW = false` — no ask-back question required)
  const answerOnlyFlowPhases = `- **階段三（學生回答延伸問題、嚴格把關母語者自然度與發音聲調、直到整句回答完全正確 → 老師簡短回應並說出固定換題口令）**：
  1. 學生會用中文回答你的延伸問題（**不需要**請學生反問你問題；回答內容只要自然合情理即可，不強制一定要包含目標詞，但必須是一句**語意完整的自然中文句子**）。
  2. **對學生的回答進行與階段一完全相同的嚴格母語者把關（Strict Native Speaker Check — 極重要）**：
     - **非常仔細地檢查發音、聲調與語法**：只要學生的回答有任何地方跟台灣母語者自然的說法不一樣——包含**任何一個字的聲調或發音不準、用詞不道地、量詞錯誤、語序不自然、漏字，或是只回答了單一詞語而非完整句子**——都請務必明確指出來糾正，不要放水帶過！
     - **學生夾雜英文單字時**：如果學生在回答裡用了任何英文單字（或問某個英文詞怎麼說），請清楚告訴他**那個詞在台灣華語怎麼說**，然後請他把**整句中文回答**重新完整說一次！
     - **局部錯誤請勿直接洩漏整句答案**：
       - 如果問題**只出在某一個詞、某個字的發音/聲調、或某個短語**（或是夾雜了一個英文詞），請**只針對那個特定的詞、聲調或短語給予糾正與示範**，**盡量不要直接幫他把整句回答唸出來**，讓學生自己組合並說出完整句子！
       - **只有當整句回答的整體語法結構或語序都錯了**（或只說了零碎單詞、或學生主動要求示範）時，才直接示範一句自然完整的中文回答並請他跟著說一次。
  3. **修正後務必停下來等待學生重說「完整的回答句子」（重複修正直到整句完全正確，才可換下一題！）**：
     - **關鍵鐵律**：只要你給了**任何發音/聲調糾正、語法/用詞修正、或英文詞翻譯**，請務必請學生**把修正後的「整句回答」重新完整說一次**，然後**立刻停下來等待學生開口**！**絕對不可以**在同一輪糾正裡直接結束並說出「好，我們看下一題！」！
     - 如果學生只單獨唸了那一個詞、沒有說完整句話，請肯定那個詞對了，並請他**把整句回答完整連起來說一次**。
     - 如果學生重說時還有其他發音、聲調或語法小錯誤，請**繼續針對錯誤糾正並請他重說整句回答**，反覆練習直到他親口完整說出一句自然、語法正確且發音標準的中文回答為止！
  4. **整句回答完全正確後，簡短回應並切換下一題**：
     - 當學生的回答一開始就完全自然正確，或者經過修正後終於親口完整說出正確自然的句子時，請用簡單、自然慢速的台灣華語**簡短自然回應他的回答（1 句短句即可）**，並在最後一字不差地說出固定換題口令：**「好，我們看下一題！」**。
     - （注意：在階段一「翻譯句子整句完全正確」與階段三「延伸問題的回答整句完全正確」都完成之前，絕對不可以提前說出「我們看下一題」；一說出「好，我們看下一題！」系統就會自動計分並切換到下一個單字！）`;

  return `你是一位專業、親切、有耐心且聽力極敏銳的台灣華語（Taiwanese Mandarin）口語家教。學生正在進行全免持（hands-free）口說練習。

【語速與難度原則（極重要）】
1. **中文請用對學習者說話的自然慢速**：當你說台灣華語（中文）時，請放慢語速，就像面對華語學習者說話一樣，發音清楚、語調自然流暢。請保持正常的句子連貫感，不要刻意一字一頓或在詞與詞之間做不自然的停頓。
2. **英文題目保持正常語速**：朗讀預先產生的「英文句子（Pre-Generated English Sentence）」時，請維持正常的自然英文語速。
3. **全程使用與目標詞同等級的簡單日常詞彙**：你對學生說的所有中文回饋與延伸問題，請使用簡單、日常的基礎生活詞彙（TOCFL 1～2 級初級詞彙），句子簡短自然（每次 1～2 句短句），避免艱深詞彙、成語或複雜長句。
4. 除了朗讀指定的英文題目（或指出學生剛才夾雜的某個英文單字中文怎麼說）之外，全程請使用自然的台灣華語（繁體中文、台灣日常用語，例如「聲調、一聲/二聲/三聲/四聲、餐廳、計程車、公車、早上/晚上」）與學生對話。

【本題預先產生的對照句子與目標詞彙（內部資訊，在學生成功說出前請勿直接洩漏讀音）】
- 目標詞（繁體）：${word.traditional}
- 拼音 / 注音：${numberedPinyinToToneMarks(word.pinyin || '')} ${word.zhuyin ? '(' + word.zhuyin + ')' : ''}
- 英文詞義：${word.english_gloss || ''}
- 預先產生的自然台灣華語原句（Pre-Generated Mandarin Reference）：「${referenceMandarin}」
- 由上述中文原句翻譯出的英文題目（Pre-Generated English Sentence）："${word.english_prompt}"
- ${synonymsLine}

【對話練習流程（請嚴格按順序執行）】
- **階段一（朗讀英文題目、嚴格把關母語者自然度與發音聲調、直到整句完全正確）**：
  1. 對話一開始，請直接用正常英文語速唸出預先產生的英文句子："${word.english_prompt}"，接著用對學習者說話的自然慢速台灣華語簡短說：「請試著把這句話翻成中文。」（千萬不要在開頭把目標詞「${word.traditional}」或中文原句唸出來！）
  2. **非常仔細地檢查學生的發音、聲調與語法（Strict Native Speaker Check — 極重要）**：
     - **允許真正的自然表達差異**：只要台灣母語者真的會這樣自然說話、準確表達英文原意、每個字的聲調發音正確、且正確使用了目標詞「${word.traditional}」，就算措辭與參考句「${referenceMandarin}」有些微差異，也請視為完全正確並進入階段二。
     - **嚴格把關不自然的說法與發音**：只要有任何地方跟台灣母語者自然的說法不一樣——包含**任何一個字的聲調或發音不準、用詞不道地、量詞錯誤、語序不自然、漏字、漏掉目標詞「${word.traditional}」**——都請務必明確指出來糾正，不要放水帶過！
     - **學生夾雜英文單字時**：如果學生在句子裡用了任何英文單字（或問某個英文詞怎麼說），請清楚告訴他**那個詞在台灣華語怎麼說**，然後請他把**整句中文句子**重新完整說一次！
     - **局部錯誤請勿直接洩漏整句答案（極重要）**：
       - 如果問題**只出在某一個詞、某個字的發音/聲調、或某個短語**（或是夾雜了一個英文詞），請**只針對那個特定的詞、聲調或短語給予糾正與示範**，**盡量不要直接把整句正確答案唸出來**，讓學生自己組合並說出完整句子！
       - **只有當整句話的整體語法結構或語序都錯了**（或學生主動要求直接給答案）時，才直接示範完整的自然句子「${referenceMandarin}」並請他跟著說一次。
     - **近義詞引導（嚴禁直接唸出目標詞「${word.traditional}」！）**：若學生用了合法近義詞或同根短詞（例如目標詞是「這樣子」而學生說「這樣」，或目標詞是「經常」而學生說「常常」），請先肯定句子自然，接著只用不劇透的方式引導（例如：「『這樣』也很自然！不過我們今天要練習口語裡三個字的說法，在後面多加一個字，試著把整句話再說一次喔！」或「『⋯⋯』意思完全對！不過我們今天要練習另一個近義詞，試著換成那個詞把整句話再說一次喔！」），**絕對不可以**直接把目標詞「${word.traditional}」完整唸出來！
  3. **修正後務必停下來等待學生重說「完整句子」（重複修正直到整句完全正確）**：
     - **關鍵鐵律**：只要你給了**任何糾正、英文詞翻譯、或近義詞提示**，請務必請學生**把修正後的「整句中文」重新完整說一次**，然後**立刻停下來等待學生開口**！**絕對不可以**在同一輪糾正裡直接問階段二的延伸問題！
     - 如果學生只單獨唸了那一個詞、沒有說完整句話，請肯定那個詞對了，並請他**把整句話完整連起來說一次**。
     - 如果學生重說時還有其他發音、聲調或語法小錯誤，請**繼續針對錯誤糾正並請他重說整句話**，反覆練習直到他親口完整說出自然、發音正確且包含「${word.traditional}」的整句話為止，才可進入階段二！

- **階段二（老師延伸提問——盡可能使用目標詞「${word.traditional}」，且嚴禁照抄原句改問句！）**：
  1. 當學生終於把整句話完全說對後，先簡短肯定他（例如：「說得很好，很自然！」），接著用**簡單、自然慢速的台灣華語**問他一個連結他自己日常生活、習慣、喜好或經驗的**延伸問題（follow-up question）**（1 句自然短句，約 8～18 個字，使用 TOCFL 1～2 級日常基礎詞彙）。
  2. **盡可能把目標詞「${word.traditional}」自然放進你的延伸問題裡（極重要）**：只要語意自然合理，你的延伸問題**請務必使用本題目標詞「${word.traditional}」**，讓學生在真實問答中再次聽見並運用這個詞！
  3. **絕對禁止「原句照抄改問句」（No Direct Restatement）**：
     - **千萬不要**只是把剛才翻譯的原句「${referenceMandarin}」（或學生剛說的那句話）把主詞換成「你」、或只在句尾加上「嗎？／對不對？／是不是？」就當作問題問回去！請換一個新的生活情境、時間點、個人習慣或偏好來提問（同時自然帶入「${word.traditional}」）。

${enableAskBack ? askBackFlowPhases : answerOnlyFlowPhases}

【免持語音控制固定口令（僅在學生主動要求時說出對應句子）】
- 學生說「跳過 / 下一題 / Skip / Next word」 -> 請直接說：**「好，我們跳過這題！」**
- 學生說「這題怪怪的 / 標記問題卡片 / Flag card」 -> 請直接說：**「好，已標記問題卡片，我們跳過這題！」**
- 學生說「再說一次英文 / Repeat the English sentence」 -> 重新清楚唸一次英文題目："${word.english_prompt}"
- 學生說「暫停 / Pause」 -> 請直接說：**「好，我們先暫停練習。」**
- 學生說「結束練習 / 停止 / End session」 -> 請直接說：**「好，今天的練習結束囉！」**${resumeSection}`;
}

export class GeminiLiveVoicePipeline {
  constructor(callbacks = {}) {
    this.onStateChange = callbacks.onStateChange || (() => {});
    this.onTranscript = callbacks.onTranscript || (() => {});
    this.onPhaseHint = callbacks.onPhaseHint || (() => {});
    this.onCompleteWord = callbacks.onCompleteWord || (() => {});
    this.onSessionControl = callbacks.onSessionControl || (() => {});
    this.onAudioLevel = callbacks.onAudioLevel || (() => {});
    this.onAudioHardwareUpdate = callbacks.onAudioHardwareUpdate || (() => {});
    this.onError = callbacks.onError || (() => {});

    this.audioCtx = null;
    this.micStream = null;
    this.micSourceNode = null;
    this.workletNode = null;
    this.workletLoaded = false;
    this.deviceChangeBound = false;
    this._micAcquirePromise = null;
    this.trackEndedRecoveryTimer = null;
    this.mediaAnchorAudio = null;
    this.mediaAnchorBlobUrl = null;

    // Default Audio Routing: Bluetooth Call / Earbuds (`bluetooth_hfp`) with automatic Speakerphone fallback
    this.audioRoutingMode = 'bluetooth_hfp'; // 'bluetooth_hfp' | 'voice_comm'
    this.preferredMicDeviceId = 'auto';
    this.enumeratedAudioInputs = [];
    this.activeMicInfo = {
      label: 'Not initialized',
      routingMode: 'bluetooth_hfp',
      echoCancellation: true,
      noiseSuppression: true
    };

    this.ws = null;
    this.activeModelId = null;
    this.isMuted = false;
    this.isActive = false;
    this.intentionalClose = false;
    this.wordTerminalActionLocked = false;
    this.usedHintInWord = false;

    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.pendingActionAfterPlayback = null;

    // Smart Context- & Sentence-Completeness-Aware Endpointing + Clean Zero-PCM Silence Gating
    this.silenceWaitMs = 1100;
    this.turnExpectation = 'translate';
    this.listeningForUser = false;
    this.tutorTurnActive = false;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.hasUnflushedAudio = false;
    this.consecutiveSpeechFrames = 0;
    this.resumeSpeechFrames = 0;
    this.speechSegmentsInTurn = 0;
    this.turnVoicedMs = 0;
    this.lastCommittedVoicedMs = 0;
    this.turnPeakSpeechRms = 0.04;
    this.silenceFramesSentInPause = 0;
    this.pausePreRollBuffer = [];
    this.lastVoiceActivityTime = 0;
    this.lastCountdownText = '';
    this.noiseFloor = 0.0035;
    this.turnFramesCount = 0;
    this.turnZeroFramesCount = 0;
    this.turnRawMaxRms = 0;
    this.turnRawSumRms = 0;
    this.currentTurnUserTranscript = '';
    this.currentTurnInterimUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.interruptedTutorPartialText = '';
    this.activeUserTurnIndex = -1;
    this.noReplyRecoveryTimer = null;
    this.reconnectTimer = null;
    this.postPlaybackCooldownUntil = 0;

    // Diagnostics, PCM audibility & silent-turn auto-recovery per turn
    this.turnCommitPerfMs = 0;
    this.sentAudioChunksInTurn = 0;
    this.turnAudioChunks = 0;
    this.turnAudioSec = 0;
    this.turnAudibleChunks = 0;
    this.turnAudibleSec = 0;
    this.hasSentRealtimeAudioOnSocket = false;
    this.isPhase1InitialTurn = false;
    this.silentTurnRetries = 0;
    this.lastTutorPromptRequestText = '';

    // Mid-word auto-reconnect state so transient network/1007/1011 drops self-heal seamlessly
    this.currentWord = null;
    this.lastLiveConfig = null;
    this.wordTurns = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.isReconnecting = false;
    this.connectionState = 'idle';
  }

  setAudioConfig({ routingMode, preferredDeviceId } = {}) {
    if (routingMode === 'voice_comm') {
      this.audioRoutingMode = 'voice_comm';
    } else if (routingMode) {
      // Auto-migrate deprecated `'media_auto'` (and default) to `'bluetooth_hfp'`
      this.audioRoutingMode = 'bluetooth_hfp';
    }
    if (typeof preferredDeviceId === 'string' && preferredDeviceId.trim()) {
      this.preferredMicDeviceId = preferredDeviceId.trim();
    }
    this.activeMicInfo.routingMode = this.audioRoutingMode;
    this._syncAudioSummaryContext();
  }

  _routingModeShortLabel(mode = this.audioRoutingMode) {
    if (mode === 'voice_comm') return 'Phone Speakerphone';
    return 'Bluetooth Call / Auto';
  }

  _syncAudioSummaryContext() {
    const modeLabel = this._routingModeShortLabel(this.audioRoutingMode);
    const micLabel = this.activeMicInfo?.label || 'Not initialized';
    const summary = `${modeLabel} | Mic: "${micLabel}" (AEC=${Boolean(
      this.activeMicInfo?.echoCancellation
    )}, NS=${Boolean(this.activeMicInfo?.noiseSuppression)})`;
    debugLogger.setContext({ audioSummary: summary });
  }

  async enumerateAudioDevices(reason = 'manual') {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.enumerateDevices !== 'function'
    ) {
      return { inputs: [], outputs: [] };
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all
        .filter((d) => d.kind === 'audioinput')
        .map((d, idx) => ({
          deviceId: d.deviceId || '',
          shortId: (d.deviceId || '').slice(0, 10),
          label: d.label || `Microphone ${idx + 1}`,
          groupId: (d.groupId || '').slice(0, 8)
        }));
      const outputs = all
        .filter((d) => d.kind === 'audiooutput')
        .map((d, idx) => ({
          deviceId: d.deviceId || '',
          shortId: (d.deviceId || '').slice(0, 10),
          label: d.label || `Speaker ${idx + 1}`
        }));

      this.enumeratedAudioInputs = inputs;
      const hasBluetoothInput = inputs.some((d) => isBluetoothAudioDeviceLabel(d.label));
      const hasSpeakerphoneInput = inputs.some((d) => /speakerphone/i.test(d.label));

      debugLogger.log('info', 'audio_devices_enumerated', `Enumerated ${inputs.length} mic(s) (${reason})`, {
        reason,
        hasBluetoothInput,
        hasSpeakerphoneInput,
        inputs: inputs.map((i) => ({ id: i.shortId, label: i.label })),
        outputs: outputs.map((o) => ({ id: o.shortId, label: o.label }))
      });

      this.onAudioHardwareUpdate(this.activeMicInfo, this.enumeratedAudioInputs);
      return { inputs, outputs };
    } catch (err) {
      debugLogger.log('warn', 'audio_enumerate_failed', err.message || String(err));
      return { inputs: [], outputs: [] };
    }
  }

  _pickAutoDeviceIdForMode(inputs = [], mode = this.audioRoutingMode) {
    if (!Array.isArray(inputs) || inputs.length === 0) return null;
    if (mode === 'bluetooth_hfp') {
      // Automatically prefer any connected Bluetooth device (car HFP or Bluetooth earbuds),
      // and fall back cleanly to Phone Speakerphone (avoiding "Headset earpiece") when offline/indoors!
      const bt = inputs.find((d) => isBluetoothAudioDeviceLabel(d.label));
      if (bt) return bt.deviceId;
      const spk = inputs.find((d) => /speakerphone/i.test(d.label));
      return spk ? spk.deviceId : null;
    }
    const spk = inputs.find((d) => /speakerphone/i.test(d.label));
    return spk ? spk.deviceId : null;
  }

  _buildAudioConstraints(targetDeviceId = null) {
    const devConstraint =
      targetDeviceId && targetDeviceId !== 'auto' ? { deviceId: { exact: targetDeviceId } } : {};

    return {
      ...devConstraint,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };
  }

  _emitState(state, statusText) {
    this.connectionState = state;
    debugLogger.setContext({ connectionState: state });
    this.onStateChange(state, statusText);
  }

  isDisconnected() {
    return this.connectionState === 'disconnected';
  }

  _getRemainingPlaybackSec() {
    if (!this.audioCtx) return 0;
    return Math.max(0, this.nextPlayTime - this.audioCtx.currentTime);
  }

  isTutorPlayingAudio() {
    if (!this.audioCtx) return false;
    return this.activeSources.size > 0 || this.audioCtx.currentTime < this.nextPlayTime - 0.02;
  }

  isWaitingForUser() {
    return (
      this.isActive &&
      this.listeningForUser &&
      !this.tutorTurnActive &&
      !this.wordTerminalActionLocked
    );
  }

  /**
   * True both while actively listening for user speech AND when auto-VAD already committed
   * (`listeningForUser === false`) while waiting on a sluggish/stalled server reply.
   * Ensures pressing "Done Speaking" or tapping the Orb ALWAYS advances the turn!
   */
  canForceFinishUserTurn() {
    return (
      this.isActive &&
      !this.wordTerminalActionLocked &&
      !this.pendingActionAfterPlayback &&
      !this.isReconnecting &&
      !this.isTutorPlayingAudio() &&
      (this.listeningForUser || !this.tutorTurnActive)
    );
  }

  _getCombinedLiveUserTranscript() {
    const fin = this.currentTurnUserTranscript.trim();
    const interim = this.currentTurnInterimUserTranscript.trim();
    if (fin && interim) return `${fin} ${interim}`;
    return fin || interim;
  }

  _getExpectedMinHanziForCurrentWord() {
    if (!this.currentWord) return 0;
    const ref = String(
      this.currentWord.mandarin_sentence || this.currentWord.sample_mandarin || ''
    );
    return (ref.match(/[\u4e00-\u9fff]/g) || []).length;
  }

  _getCurrentDynamicSilenceTarget() {
    return computeSmartSilenceThresholdMs({
      transcript: this._getCombinedLiveUserTranscript(),
      turnExpectation: this.turnExpectation,
      speechSegmentsInTurn: Math.max(1, this.speechSegmentsInTurn),
      voicedMs: this.turnVoicedMs,
      expectedMinHanzi: this._getExpectedMinHanziForCurrentWord()
    });
  }

  _buildTurnMicTelemetry() {
    const frames = this.turnFramesCount;
    const avgRms = frames > 0 ? this.turnRawSumRms / frames : 0;
    return {
      routingMode: this.audioRoutingMode,
      micLabel: this.activeMicInfo?.label || 'unknown',
      frames,
      zeroFrames: this.turnZeroFramesCount,
      rawMaxRms: Number(this.turnRawMaxRms.toFixed(4)),
      rawAvgRms: Number(avgRms.toFixed(4)),
      noiseFloor: Number(this.noiseFloor.toFixed(4))
    };
  }

  _getUserMediaWithTimeout(constraints, timeoutMs = 2800) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`getUserMedia timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      navigator.mediaDevices
        .getUserMedia(constraints)
        .then((stream) => {
          clearTimeout(timer);
          if (settled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          settled = true;
          resolve(stream);
        })
        .catch((err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    });
  }

  /**
   * Initializes (or hot-swaps) WebAudio and the microphone stream.
   */
  async initAudioHardware(forceReacquireMic = false) {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      try {
        this.audioCtx = new AudioContextClass({ sampleRate: 24000, latencyHint: 'interactive' });
      } catch (_) {
        this.audioCtx = new AudioContextClass({ sampleRate: 24000 });
      }
      debugLogger.log('info', 'audio_ctx_init', `Initialized WebAudio (${this.audioCtx.sampleRate}Hz)`, {
        sampleRate: this.audioCtx.sampleRate,
        baseLatency: this.audioCtx.baseLatency ?? null,
        routingMode: this.audioRoutingMode
      });
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    if (!this.workletLoaded) {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      this.workletLoaded = true;
    }

    if (!this.workletNode) {
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-recorder-processor');
      this.workletNode.port.onmessage = (event) => {
        if (!this.isActive || this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const float32Samples = event.data;
        const rawRms = this._computeRawRms(float32Samples);
        this._processMicFrameWithVad(float32Samples, rawRms);
      };

      const silentGain = this.audioCtx.createGain();
      silentGain.gain.value = 0;
      this.workletNode.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
    }

    const existingTracks = this.micStream ? this.micStream.getAudioTracks() : [];
    const micDead =
      existingTracks.length === 0 || existingTracks.every((t) => t.readyState === 'ended');

    if (!this.micStream || forceReacquireMic || micDead) {
      await this._acquireAndBindMicrophone(forceReacquireMic ? 'reconfigure' : 'session_init');
    }

    if (
      !this.deviceChangeBound &&
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.addEventListener === 'function'
    ) {
      this.deviceChangeBound = true;
      navigator.mediaDevices.addEventListener('devicechange', async () => {
        if (this.trackEndedRecoveryTimer) {
          clearTimeout(this.trackEndedRecoveryTimer);
          this.trackEndedRecoveryTimer = null;
        }
        const { inputs } = await this.enumerateAudioDevices('devicechange_hotplug');
        const activeTrack = this.micStream ? this.micStream.getAudioTracks()[0] : null;
        const trackEnded = !activeTrack || activeTrack.readyState === 'ended';
        const hasBtDeviceNow = inputs.some((d) => isBluetoothAudioDeviceLabel(d.label));
        const shouldSwitchToNewBt =
          this.audioRoutingMode === 'bluetooth_hfp' &&
          this.preferredMicDeviceId === 'auto' &&
          hasBtDeviceNow &&
          activeTrack &&
          !isBluetoothAudioDeviceLabel(activeTrack.label || '');

        debugLogger.log('info', 'audio_device_changed', 'Audio hardware topology changed (Bluetooth / Speaker)', {
          trackEnded,
          hasBtDeviceNow,
          shouldSwitchToNewBt,
          activeTrackLabel: activeTrack ? activeTrack.label : null,
          inputsCount: inputs.length
        });

        if (this.isActive && (trackEnded || shouldSwitchToNewBt)) {
          this._acquireAndBindMicrophone('hotplug_recovery').catch((err) => {
            debugLogger.log('error', 'mic_hotplug_recovery_failed', err.message || String(err));
          });
        }
      });
    }
  }

  async _acquireAndBindMicrophone(reason = 'init') {
    if (this._micAcquirePromise) {
      return this._micAcquirePromise;
    }
    this._micAcquirePromise = this._acquireAndBindMicrophoneImpl(reason).finally(() => {
      this._micAcquirePromise = null;
    });
    return this._micAcquirePromise;
  }

  async _acquireAndBindMicrophoneImpl(reason = 'init') {
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (_) {}
      this.micSourceNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }

    // Always re-enumerate fresh on hotplug/track-ended/reconfigure so we never try to open a just-disconnected Bluetooth SCO device!
    const forceFreshEnum =
      !this.enumeratedAudioInputs ||
      this.enumeratedAudioInputs.length === 0 ||
      reason !== 'session_init';
    const preInputs = forceFreshEnum
      ? (await this.enumerateAudioDevices(`${reason}_pre`)).inputs
      : this.enumeratedAudioInputs;

    const chosenDeviceId =
      this.preferredMicDeviceId !== 'auto'
        ? this.preferredMicDeviceId
        : this._pickAutoDeviceIdForMode(preInputs, this.audioRoutingMode);

    let stream = null;
    try {
      stream = chosenDeviceId
        ? await this._getUserMediaWithTimeout(
            { audio: this._buildAudioConstraints(chosenDeviceId) },
            2800
          )
        : await navigator.mediaDevices.getUserMedia({
            audio: this._buildAudioConstraints(null)
          });
    } catch (errSpecific) {
      debugLogger.log(
        'warn',
        'mic_constraints_fallback',
        `Specific mic constraints failed (${errSpecific.message || errSpecific}); falling back to default device`,
        { routingMode: this.audioRoutingMode, chosenDeviceId: (chosenDeviceId || '').slice(0, 10) }
      );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: this._buildAudioConstraints(null)
      });
    }

    // Re-enumerate once permission is granted so full device labels (`Bluetooth headset`, `Speakerphone`, etc.) appear!
    const postEnum = await this.enumerateAudioDevices(`${reason}_post`);
    if (this.preferredMicDeviceId === 'auto') {
      const currentLabel = stream.getAudioTracks()[0]?.label || '';
      const hasBt = postEnum.inputs.some((d) => isBluetoothAudioDeviceLabel(d.label));
      const desiredAutoId = this._pickAutoDeviceIdForMode(postEnum.inputs, this.audioRoutingMode);
      const alreadyMatched =
        this.audioRoutingMode === 'bluetooth_hfp' && hasBt
          ? isBluetoothAudioDeviceLabel(currentLabel)
          : /speakerphone/i.test(currentLabel);

      if (desiredAutoId && !alreadyMatched) {
        try {
          const upgradedStream = await this._getUserMediaWithTimeout(
            { audio: this._buildAudioConstraints(desiredAutoId) },
            2800
          );
          stream.getTracks().forEach((t) => t.stop());
          stream = upgradedStream;
        } catch (_) {}
      }
    }

    this.micStream = stream;
    const track = stream.getAudioTracks()[0];
    const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
    const trackLabel = track?.label || 'Default Microphone';

    this.activeMicInfo = {
      label: trackLabel,
      routingMode: this.audioRoutingMode,
      isBluetooth: isBluetoothAudioDeviceLabel(trackLabel),
      echoCancellation: settings.echoCancellation ?? true,
      noiseSuppression: settings.noiseSuppression ?? true,
      autoGainControl: settings.autoGainControl ?? true,
      sampleRate: settings.sampleRate || this.audioCtx?.sampleRate || 24000,
      muted: Boolean(track?.muted),
      readyState: track?.readyState || 'live'
    };

    if (track) {
      track.onmute = () => {
        debugLogger.log('warn', 'mic_track_event', `Mic track muted by OS (${trackLabel})`, {
          event: 'mute',
          label: trackLabel,
          routingMode: this.audioRoutingMode
        });
      };
      track.onunmute = () => {
        debugLogger.log('info', 'mic_track_event', `Mic track unmuted (${trackLabel})`, {
          event: 'unmute',
          label: trackLabel,
          routingMode: this.audioRoutingMode
        });
      };
      track.onended = () => {
        debugLogger.log('warn', 'mic_track_event', `Mic track ended (${trackLabel})`, {
          event: 'ended',
          label: trackLabel,
          routingMode: this.audioRoutingMode
        });
        if (this.isActive && !this.intentionalClose) {
          if (this.trackEndedRecoveryTimer) {
            clearTimeout(this.trackEndedRecoveryTimer);
          }
          // Wait 350ms so Android finishes detaching a powered-off Bluetooth HFP headset before re-enumerating!
          this.trackEndedRecoveryTimer = setTimeout(() => {
            this.trackEndedRecoveryTimer = null;
            if (this.isActive && !this.intentionalClose) {
              this._acquireAndBindMicrophone('track_ended_recovery').catch((err) => {
                debugLogger.log('error', 'mic_track_ended_recovery_failed', err.message || String(err));
              });
            }
          }, 350);
        }
      };
    }

    this.micSourceNode = this.audioCtx.createMediaStreamSource(this.micStream);
    this.micSourceNode.connect(this.workletNode);

    this._syncAudioSummaryContext();
    debugLogger.log(
      'info',
      'mic_acquired',
      `Microphone ready: "${trackLabel}" [${this._routingModeShortLabel()}]`,
      {
        reason,
        label: trackLabel,
        isBluetooth: Boolean(this.activeMicInfo.isBluetooth),
        routingMode: this.audioRoutingMode,
        preferredMicDeviceId:
          this.preferredMicDeviceId === 'auto'
            ? 'auto'
            : this.preferredMicDeviceId.slice(0, 10),
        muted: Boolean(track?.muted),
        readyState: track?.readyState || 'unknown',
        settings: {
          sampleRate: settings.sampleRate ?? null,
          channelCount: settings.channelCount ?? null,
          echoCancellation: settings.echoCancellation ?? null,
          noiseSuppression: settings.noiseSuppression ?? null,
          autoGainControl: settings.autoGainControl ?? null
        }
      }
    );

    this.onAudioHardwareUpdate(this.activeMicInfo, this.enumeratedAudioInputs);
  }

  _processMicFrameWithVad(float32Samples, rawRms) {
    const now = performance.now();

    if (
      this.wordTerminalActionLocked ||
      this.pendingActionAfterPlayback ||
      this.tutorTurnActive ||
      this.isTutorPlayingAudio() ||
      now < this.postPlaybackCooldownUntil ||
      !this.listeningForUser
    ) {
      return;
    }

    this.turnFramesCount += 1;
    if (rawRms < 0.00005) {
      this.turnZeroFramesCount += 1;
    }
    if (rawRms > this.turnRawMaxRms) {
      this.turnRawMaxRms = rawRms;
    }
    this.turnRawSumRms += rawRms;

    this.onAudioLevel(Math.min(1, rawRms * 5));

    const inputRate = this.audioCtx ? this.audioCtx.sampleRate : 24000;
    const pcm16Base64 = this._downsampleAndEncodePcm16(float32Samples, inputRate, 16000);

    // Calibrated for Bluetooth Call HFP & Phone Speakerphone hardware AGC:
    // Real speech arrives at ~0.12–0.37 RMS while minor car bumps/blinkers sit at ~0.012–0.026 RMS.
    // Floor of 0.020 (3 frames = 300ms, or 2 frames when >= 0.036) blocks road-noise false triggers!
    const speechStartThreshold = Math.max(0.020, Math.min(0.045, this.noiseFloor * 3.2));

    if (!this.userSpokeInTurn) {
      this._sendAudioChunk(pcm16Base64);

      if (rawRms >= speechStartThreshold) {
        this.consecutiveSpeechFrames += 1;
        const requiredFrames =
          rawRms >= Math.max(0.036, speechStartThreshold * 1.4) ? 2 : 3;
        if (this.consecutiveSpeechFrames >= requiredFrames) {
          this.userSpokeInTurn = true;
          this.speechSegmentsInTurn = 1;
          this.turnVoicedMs = requiredFrames * 100;
          this.turnPeakSpeechRms = Math.max(0.03, Math.min(0.4, rawRms));
          this.silenceFramesSentInPause = 0;
          this.resumeSpeechFrames = 0;
          this.pausePreRollBuffer = [];
          this.lastVoiceActivityTime = now;
          this.lastCountdownText = '';
          debugLogger.log('info', 'user_speech_start', 'User started speaking Mandarin', {
            rawRms: Number(rawRms.toFixed(4)),
            noiseFloor: Number(this.noiseFloor.toFixed(4)),
            threshold: Number(speechStartThreshold.toFixed(4)),
            turnExpectation: this.turnExpectation
          });
          this._emitState('listening', 'Hearing your Mandarin...');
        }
      } else {
        this.consecutiveSpeechFrames = 0;
        const updatedNoise =
          rawRms < this.noiseFloor
            ? 0.85 * this.noiseFloor + 0.15 * rawRms
            : 0.97 * this.noiseFloor + 0.03 * rawRms;
        this.noiseFloor = Math.max(0.0002, Math.min(0.025, updatedNoise));
      }
      return;
    }

    const speechContinueThreshold = Math.max(
      0.010,
      Math.min(0.038, Math.max(this.noiseFloor * 2.4, this.turnPeakSpeechRms * 0.14))
    );
    const silenceBeforeFrame = now - this.lastVoiceActivityTime;

    let isVoicedSpeech = false;
    if (silenceBeforeFrame <= 300) {
      isVoicedSpeech = rawRms >= speechContinueThreshold;
    } else if (rawRms >= Math.max(speechStartThreshold * 1.25, speechContinueThreshold * 1.45)) {
      isVoicedSpeech = true;
    } else if (rawRms >= speechContinueThreshold) {
      this.resumeSpeechFrames += 1;
      if (this.resumeSpeechFrames >= 2) {
        isVoicedSpeech = true;
      }
    } else {
      this.resumeSpeechFrames = 0;
    }

    if (isVoicedSpeech) {
      if (silenceBeforeFrame >= 450) {
        this.speechSegmentsInTurn += 1;
        for (const bufferedChunk of this.pausePreRollBuffer) {
          this._sendAudioChunk(bufferedChunk);
        }
      }
      this.pausePreRollBuffer = [];
      this.silenceFramesSentInPause = 0;
      this.resumeSpeechFrames = 0;
      this.lastVoiceActivityTime = now;
      this.turnVoicedMs += 100;
      this.turnPeakSpeechRms = Math.min(0.4, Math.max(this.turnPeakSpeechRms * 0.98, rawRms));
      this._sendAudioChunk(pcm16Base64);

      if (this.lastCountdownText !== '') {
        this.lastCountdownText = '';
        this._emitState('listening', 'Hearing your Mandarin...');
      }
      return;
    }

    const silenceElapsed = now - this.lastVoiceActivityTime;
    const { thresholdMs, reason } = this._getCurrentDynamicSilenceTarget();

    if (silenceElapsed >= thresholdMs) {
      // Transient road-bump / breath / click guard: if a brief <=550ms non-speech sound triggered speech_start
      // and produced zero interim/final ASR text across the full silence window, reset in 0ms without locking out the mic!
      if (
        !this._getCombinedLiveUserTranscript() &&
        this.turnVoicedMs <= 550 &&
        this.turnPeakSpeechRms < 0.095
      ) {
        debugLogger.log(
          'info',
          'transient_noise_ignored',
          'Ignored brief non-speech impulse without locking out microphone',
          {
            voicedMs: this.turnVoicedMs,
            peakRms: Number(this.turnPeakSpeechRms.toFixed(4)),
            noiseFloor: Number(this.noiseFloor.toFixed(4))
          }
        );
        this.userSpokeInTurn = false;
        this.consecutiveSpeechFrames = 0;
        this.resumeSpeechFrames = 0;
        this.speechSegmentsInTurn = 0;
        this.turnVoicedMs = 0;
        this.silenceFramesSentInPause = 0;
        this.pausePreRollBuffer = [];
        this.lastCountdownText = '';
        this._emitState('listening', this._defaultListeningLabel());
        return;
      }

      this.commitUserSpeechTurn(`smart_${reason}`, {
        thresholdMs,
        silenceElapsedMs: Math.round(silenceElapsed),
        completenessReason: reason
      });
      return;
    }

    // During a pause BEFORE thresholdMs is reached:
    // - Frames 1–4 (400ms): send real mic tail so soft trailing syllables / neutral-tone suffixes
    //   (like `子` in `這樣子`, `了`, `嗎`, `的`) are preserved 100% intact!
    // - Frames 5–11 (700ms): send clean digital-zero PCM so server ASR emits `inputTranscription` promptly
    //   while keeping the 100ms stream continuously clocked below server `silenceDurationMs` (1500ms)!
    // - Frames >= 12: hold silence locally (keeping a 300ms pre-roll ring buffer) during longer pauses.
    if (this.silenceFramesSentInPause < 4) {
      this._sendAudioChunk(pcm16Base64);
      this.silenceFramesSentInPause += 1;
    } else if (this.silenceFramesSentInPause < 11) {
      this._sendAudioChunk(ZERO_PCM16_100MS_BASE64);
      this.silenceFramesSentInPause += 1;
    } else {
      this.pausePreRollBuffer.push(pcm16Base64);
      if (this.pausePreRollBuffer.length > 3) {
        this.pausePreRollBuffer.shift();
      }
    }

    if (silenceElapsed >= 450) {
      const remainSec = Math.max(0.1, (thresholdMs - silenceElapsed) / 1000).toFixed(1);
      const statusMsg =
        reason === 'awaiting_followup_question'
          ? `Waiting ${remainSec}s for your question back (or tap Done)`
          : `Pause detected — sending in ${remainSec}s (or tap Done)`;
      if (statusMsg !== this.lastCountdownText) {
        this.lastCountdownText = statusMsg;
        this._emitState('listening', statusMsg);
      }
    }
  }

  _sendAudioChunk(pcm16Base64) {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.listeningForUser ||
      this.wordTerminalActionLocked
    ) {
      return;
    }
    this.hasUnflushedAudio = true;
    this.hasSentRealtimeAudioOnSocket = true;
    this.sentAudioChunksInTurn += 1;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            mimeType: 'audio/pcm;rate=16000',
            data: pcm16Base64
          }
        }
      })
    );
  }

  _flushAudioStreamEnd() {
    if (!this.hasUnflushedAudio || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.hasUnflushedAudio = false;
    try {
      this.ws.send(
        JSON.stringify({
          realtimeInput: {
            audioStreamEnd: true
          }
        })
      );
      debugLogger.log('ws', 'audio_stream_end_sent', 'Sent realtimeInput.audioStreamEnd');
    } catch (_) {}
  }

  commitUserSpeechTurn(reason = 'auto_silence', telemetryExtra = {}) {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.tutorTurnActive || this.wordTerminalActionLocked) return;

    const hadUserSpeech = this.userSpokeInTurn;
    if (reason === 'manual_done' && this.listeningForUser && this.pausePreRollBuffer.length > 0) {
      for (const bufferedChunk of this.pausePreRollBuffer) {
        this._sendAudioChunk(bufferedChunk);
      }
      this.pausePreRollBuffer = [];
    }

    // Pad at most 2 clean 100ms zero frames before `audioStreamEnd` (avoiding 12-packet 0ms bursts
    // that previously caused duplicate empty `turnComplete` frames on Gemini 2.5 Native Audio).
    if (this.listeningForUser && hadUserSpeech && this.silenceFramesSentInPause < 2) {
      const padCount = 2 - this.silenceFramesSentInPause;
      for (let i = 0; i < padCount; i++) {
        this._sendAudioChunk(ZERO_PCM16_100MS_BASE64);
      }
    }

    const chunksSent = this.sentAudioChunksInTurn;
    const liveTranscriptSnapshot = this._getCombinedLiveUserTranscript();
    const micStats = this._buildTurnMicTelemetry();

    this.lastCommittedVoicedMs = this.turnVoicedMs;
    this.lastCommittedMicStats = micStats;
    this._commitPendingUserTranscriptToTurns();

    this.isPhase1InitialTurn = false;
    this.silentTurnRetries = 0;
    this.listeningForUser = false;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.consecutiveSpeechFrames = 0;
    this.resumeSpeechFrames = 0;
    this.silenceFramesSentInPause = 0;
    this.pausePreRollBuffer = [];
    this.sentAudioChunksInTurn = 0;
    this.lastCountdownText = '';
    this.turnCommitPerfMs = performance.now();

    debugLogger.finalizeStreamingEntries('input_transcript');
    debugLogger.log('info', 'user_turn_committed', `Committed user turn (${reason})`, {
      reason,
      turnExpectation: this.turnExpectation,
      speechSegmentsInTurn: this.speechSegmentsInTurn,
      voicedMs: this.lastCommittedVoicedMs,
      ...telemetryExtra,
      audioChunksSent: chunksSent,
      transcriptSoFar: liveTranscriptSnapshot,
      micStats
    });

    this._emitState('connecting', 'Processing your Mandarin...');
    this._flushAudioStreamEnd();

    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
    }

    const recoveryWaitMs =
      reason === 'manual_done'
        ? 1400
        : hadUserSpeech || liveTranscriptSnapshot
        ? 2600
        : 1800;

    this.noReplyRecoveryTimer = setTimeout(() => {
      this.noReplyRecoveryTimer = null;
      if (!this.isActive) return;
      if (
        this.wordTerminalActionLocked ||
        this.pendingActionAfterPlayback ||
        this.tutorTurnActive ||
        this.serverAckedCurrentUserTurn ||
        this.isTutorPlayingAudio()
      ) {
        return;
      }
      this._recoverStalledTurnOnFreshSocket(
        reason === 'manual_done' ? 'manual_done_no_reply' : 'no_reply_auto_continue',
        micStats
      );
    }, recoveryWaitMs);
  }

  /**
   * Deterministic recovery when `audioStreamEnd` stalls on the server (or when the user taps
   * "Done Speaking" while waiting on a stalled turn):
   * - If the user's Mandarin speech WAS transcribed (`activeUserTurnIndex >= 0`), opens a fresh
   *   same-model (`rotationOffset = 0`) WebSocket with `this.wordTurns` seeded and triggers `Case 2`
   *   (`clientContent` with `turnComplete: true`), avoiding `realtimeInput.text` 0-audio `turnComplete` loops!
   * - If loud speech occurred with ZERO ASR text (wedged server audio recognizer), refreshes the
   *   WebSocket via `Case 3` (`reconnect_resume_listening`) so the very next utterance is heard cleanly!
   */
  _recoverStalledTurnOnFreshSocket(triggerReason = 'no_reply_auto_continue', micStats = null) {
    if (
      !this.isActive ||
      this.wordTerminalActionLocked ||
      this.pendingActionAfterPlayback ||
      this.isReconnecting
    ) {
      return false;
    }
    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
      this.noReplyRecoveryTimer = null;
    }

    this._commitPendingUserTranscriptToTurns();

    const stats = micStats || this.lastCommittedMicStats || this._buildTurnMicTelemetry();
    const committedTurn =
      this.activeUserTurnIndex >= 0 &&
      this.wordTurns[this.activeUserTurnIndex] &&
      this.wordTurns[this.activeUserTurnIndex].role === 'user'
        ? this.wordTurns[this.activeUserTurnIndex]
        : null;

    if (committedTurn && committedTurn.text.trim() && this.currentWord && this.lastLiveConfig) {
      debugLogger.log(
        'warn',
        'stalled_turn_socket_continue',
        `Advancing stalled user turn on clean same-model socket (${triggerReason})`,
        {
          triggerReason,
          userText: committedTurn.text,
          micStats: stats
        }
      );

      this.listeningForUser = false;
      this.tutorTurnActive = true;
      this.isReconnecting = true;
      this._closeRawSocketOnly();
      this._emitState('connecting', 'Tutor responding...');

      this._openSocketWithFallbacks(this.currentWord, this.lastLiveConfig, true, 0)
        .then(() => {
          this.isReconnecting = false;
        })
        .catch((err) => {
          this.isReconnecting = false;
          debugLogger.log('error', 'stalled_turn_continue_failed', err.message || String(err));
          this._attemptAutoReconnect(1006, triggerReason);
        });
      return true;
    }

    const hadAudibleSpeechAttempt =
      triggerReason === 'manual_done_force' ||
      triggerReason === 'manual_done_no_reply' ||
      Boolean(stats && stats.rawMaxRms >= 0.085 && this.lastCommittedVoicedMs >= 500);

    if (hadAudibleSpeechAttempt && this.currentWord && this.lastLiveConfig) {
      debugLogger.log(
        'warn',
        'wedged_asr_socket_refresh',
        `Loud speech produced 0 ASR text (${triggerReason}); refreshing clean audio socket`,
        {
          triggerReason,
          voicedMs: this.lastCommittedVoicedMs,
          micStats: stats
        }
      );
      this.playChime('relisten');
      this.isReconnecting = true;
      this._closeRawSocketOnly();
      this._emitState('connecting', 'Refreshing mic link...');

      this._openSocketWithFallbacks(
        this.currentWord,
        this.lastLiveConfig,
        this.wordTurns.length > 0,
        0
      )
        .then(() => {
          this.isReconnecting = false;
          if (this.listeningForUser) {
            this._emitState('listening', 'Ready — please say that again');
          }
        })
        .catch((err) => {
          this.isReconnecting = false;
          debugLogger.log('error', 'wedged_asr_refresh_failed', err.message || String(err));
          this._attemptAutoReconnect(1006, triggerReason);
        });
      return true;
    }

    debugLogger.log(
      'info',
      'no_reply_timer_fired',
      `No speech transcribed (${triggerReason}); resuming listening immediately`,
      { micStats: stats }
    );
    this._beginListeningTurn(null, true);
    return true;
  }

  finishUserTurnNow() {
    if (!this.isActive || this.wordTerminalActionLocked || this.pendingActionAfterPlayback) {
      return false;
    }
    if (this.listeningForUser && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.commitUserSpeechTurn('manual_done');
      return true;
    }
    if (!this.tutorTurnActive && !this.isTutorPlayingAudio() && !this.isReconnecting) {
      return this._recoverStalledTurnOnFreshSocket('manual_done_force');
    }
    return false;
  }

  playChime(type = 'next') {
    if (!this.audioCtx) return;
    try {
      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      if (type === 'start') {
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.11); // E5
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.29);
      } else if (type === 'complete') {
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880.0, now + 0.12); // A5
        gain.gain.setValueAtTime(0.14, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'relisten') {
        osc.frequency.setValueAtTime(392.0, now); // G4
        osc.frequency.setValueAtTime(493.88, now + 0.09); // B4
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.23);
      } else if (type === 'skip') {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(349.23, now + 0.1);
        gain.gain.setValueAtTime(0.10, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.26);
      }
    } catch (_) {}
  }

  /**
   * Opens a clean, dedicated Gemini Live WebSocket session scoped to a single vocabulary word.
   */
  async startWordSession(word, liveConfig = {}, wordNumberLabel = '') {
    this.closeCurrentWordSocket();
    this.pendingActionAfterPlayback = null;
    this.wordTerminalActionLocked = false;
    this.usedHintInWord = false;
    this.isActive = true;
    this.intentionalClose = false;
    this.currentWord = word;
    this.lastLiveConfig = Object.assign({}, liveConfig);
    this.wordTurns = [];
    this.turnExpectation = 'translate';
    this.currentTurnUserTranscript = '';
    this.currentTurnInterimUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.interruptedTutorPartialText = '';
    this.activeUserTurnIndex = -1;
    this.lastCommittedVoicedMs = 0;
    this.lastCommittedMicStats = null;
    this.serverAckedCurrentUserTurn = false;
    this.sentAudioChunksInTurn = 0;
    this.turnAudioChunks = 0;
    this.turnAudioSec = 0;
    this.turnAudibleChunks = 0;
    this.turnAudibleSec = 0;
    this.isPhase1InitialTurn = true;
    this.silentTurnRetries = 0;
    this.lastTutorPromptRequestText = '';
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    const label = wordNumberLabel
      ? `${wordNumberLabel} ${word.traditional}`
      : word.traditional;
    debugLogger.setContext({
      wordLabel: label,
      wordPrompt: word.english_prompt || '',
      phase: 1
    });
    debugLogger.log('info', 'word_session_start', `Starting word session: ${label}`, {
      id: word.id,
      traditional: word.traditional,
      english_prompt: word.english_prompt,
      mandarin_sentence: word.mandarin_sentence || word.sample_mandarin || ''
    });

    await this._openSocketWithFallbacks(word, this.lastLiveConfig, false, 0);
  }

  /**
   * Manually reconnects the active word session without losing conversation progress.
   */
  async reconnectCurrentWord() {
    if (!this.currentWord || !this.lastLiveConfig) return;
    this._capturePreDisconnectState();
    this._closeRawSocketOnly();
    this.isActive = true;
    this.intentionalClose = false;
    this.wordTerminalActionLocked = false;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    debugLogger.log('info', 'manual_reconnect', 'User triggered manual reconnect for current word', {
      wordTurnsCount: this.wordTurns.length,
      interruptedTutorPartialText: this.interruptedTutorPartialText
    });
    await this._openSocketWithFallbacks(this.currentWord, this.lastLiveConfig, true, 0);
  }

  _commitPendingUserTranscriptToTurns() {
    const pendingUser = this._getCombinedLiveUserTranscript();
    if (pendingUser) {
      if (
        this.activeUserTurnIndex >= 0 &&
        this.wordTurns[this.activeUserTurnIndex] &&
        this.wordTurns[this.activeUserTurnIndex].role === 'user'
      ) {
        this.wordTurns[this.activeUserTurnIndex].text += pendingUser;
      } else {
        this.wordTurns.push({ role: 'user', text: pendingUser });
        this.activeUserTurnIndex = this.wordTurns.length - 1;
      }
    }
    this.currentTurnUserTranscript = '';
    this.currentTurnInterimUserTranscript = '';
  }

  _appendLateUserTranscriptToTurns(text) {
    if (!text) return;
    if (
      this.activeUserTurnIndex >= 0 &&
      this.wordTurns[this.activeUserTurnIndex] &&
      this.wordTurns[this.activeUserTurnIndex].role === 'user'
    ) {
      this.wordTurns[this.activeUserTurnIndex].text += text;
      return;
    }
    const lastIdx = this.wordTurns.length - 1;
    if (lastIdx >= 0 && this.wordTurns[lastIdx].role === 'tutor' && !this.tutorTurnActive) {
      // Tutor turn already committed right before trailing user ASR arrived -> splice chronologically before tutor turn!
      this.wordTurns.splice(lastIdx, 0, { role: 'user', text });
      this.activeUserTurnIndex = lastIdx;
    } else {
      this.wordTurns.push({ role: 'user', text });
      this.activeUserTurnIndex = this.wordTurns.length - 1;
    }
  }

  _commitCompletedTutorTranscriptToTurns() {
    const completedTutor = this.currentTurnTutorTranscript.trim();
    if (completedTutor) {
      const last = this.wordTurns[this.wordTurns.length - 1];
      if (!last || last.role !== 'tutor' || last.text !== completedTutor) {
        this.wordTurns.push({ role: 'tutor', text: completedTutor });
      }
      this.currentTurnTutorTranscript = '';
    }
    this.interruptedTutorPartialText = '';
  }

  /**
   * Distinguishes between a COMPLETED tutor turn (`turnComplete` already arrived) vs. an
   * INTERRUPTED mid-sentence tutor turn (`tutorTurnActive === true` when the socket dropped!).
   * Never marks an interrupted tutor utterance as a finished turn, so reconnect immediately
   * finishes speaking instead of freezing in `listening`!
   */
  _capturePreDisconnectState() {
    this._commitPendingUserTranscriptToTurns();
    const partialTutor = this.currentTurnTutorTranscript.trim();
    if (partialTutor) {
      this.interruptedTutorPartialText = partialTutor;
      this.currentTurnTutorTranscript = '';
    }
  }

  async _attemptAutoReconnect(closeCode, closeReason = '') {
    if (
      !this.isActive ||
      this.intentionalClose ||
      this.wordTerminalActionLocked ||
      this.pendingActionAfterPlayback ||
      this.isReconnecting
    ) {
      return;
    }
    if (!this.currentWord || !this.lastLiveConfig) {
      this._emitState('disconnected', `Connection closed (${closeCode})`);
      return;
    }

    this._capturePreDisconnectState();

    // Check if the partial tutor utterance right before disconnect ALREADY contained the terminal sign-off!
    if (this.interruptedTutorPartialText) {
      const partialCue = detectSpokenTerminalCue(this.interruptedTutorPartialText);
      if (partialCue) {
        this.wordTurns.push({ role: 'tutor', text: this.interruptedTutorPartialText });
        this.interruptedTutorPartialText = '';
        this._executeTerminalCue(partialCue, 'partial_before_disconnect');
        return;
      }
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      debugLogger.log(
        'error',
        'auto_reconnect_exhausted',
        `Exhausted ${this.maxReconnectAttempts} auto-reconnect attempts (last code=${closeCode}, reason="${closeReason}")`
      );
      this._emitState('disconnected', `Connection lost (${closeCode}) — Tap Orb to retry`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    const delayMs = this.reconnectAttempts === 1 ? 450 : this.reconnectAttempts === 2 ? 1100 : 2000;

    // Immediately rotate to the next Live model candidate if a model crashed mid-word with 1007/1008/1011!
    const modelRotationOffset =
      closeCode === 1007 || closeCode === 1008 || closeCode === 1011
        ? this.reconnectAttempts
        : 0;

    debugLogger.log(
      'warn',
      'auto_reconnect_scheduled',
      `Scheduling reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delayMs}ms`,
      {
        closeCode,
        closeReason,
        modelRotationOffset,
        wordTurnsCount: this.wordTurns.length,
        interruptedTutorPartialText: this.interruptedTutorPartialText || null
      }
    );

    this._emitState(
      'connecting',
      `Reconnecting voice (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (
        !this.isActive ||
        this.intentionalClose ||
        this.wordTerminalActionLocked ||
        this.pendingActionAfterPlayback
      ) {
        this.isReconnecting = false;
        return;
      }
      try {
        await this._openSocketWithFallbacks(
          this.currentWord,
          this.lastLiveConfig,
          true,
          modelRotationOffset
        );
        this.isReconnecting = false;
      } catch (err) {
        this.isReconnecting = false;
        debugLogger.log('error', 'auto_reconnect_failed', err.message || String(err));
        this._attemptAutoReconnect(closeCode, closeReason);
      }
    }, delayMs);
  }

  async _openSocketWithFallbacks(word, liveConfig, isReconnect = false, rotationOffset = 0) {
    const apiKey = liveConfig.apiKey;
    if (!apiKey) {
      throw new Error('Missing Gemini API key.');
    }

    const preferred =
      liveConfig.preferredLiveModel && liveConfig.preferredLiveModel !== 'auto'
        ? liveConfig.preferredLiveModel
        : null;

    const rawCandidates = [
      preferred,
      'models/gemini-2.5-flash-native-audio-preview-12-2025',
      'models/gemini-3.1-flash-live-preview',
      'models/gemini-3.8-live',
      'models/gemini-2.5-flash-native-audio-latest',
      liveConfig.liveModel,
      liveConfig.fallbackLiveModel
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    const candidateModels =
      rotationOffset > 0 && rawCandidates.length > 1
        ? [
            ...rawCandidates.slice(rotationOffset % rawCandidates.length),
            ...rawCandidates.slice(0, rotationOffset % rawCandidates.length)
          ]
        : rawCandidates;

    const voiceName = liveConfig.voiceName || 'Aoede';

    let lastErr = null;
    for (let i = 0; i < candidateModels.length; i++) {
      const modelId = candidateModels[i].startsWith('models/')
        ? candidateModels[i]
        : `models/${candidateModels[i]}`;
      try {
        await this._connectSingleModelSocket(word, apiKey, modelId, voiceName, true, isReconnect);
        return;
      } catch (errExt) {
        lastErr = errExt;
        try {
          await this._connectSingleModelSocket(word, apiKey, modelId, voiceName, false, isReconnect);
          return;
        } catch (errMin) {
          lastErr = errMin;
          debugLogger.log(
            'warn',
            'model_setup_fallback',
            `Model ${modelId} failed setup; trying next candidate`,
            { error: errMin.message || String(errMin) }
          );
        }
      }
    }
    throw lastErr || new Error('Unable to establish Gemini Live WebSocket connection.');
  }

  /**
   * Model-aware text prompt sender:
   * - On Gemini 2.5 Native Audio BEFORE mic audio chunks have streamed on this socket, uses
   *   `clientContent` with `turnComplete: true` (giving 2.5 an explicit turn boundary under
   *   `TURN_INCLUDES_ONLY_ACTIVITY` and preventing cold-start 0-audio / cut-off turns).
   * - On Gemini 3.1 / 3.8 Live (or after realtimeInput audio has begun), uses `realtimeInput.text`.
   */
  _sendPromptTurn(ws, modelId, text, tag = 'prompt', extraLog = {}) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const targetModel = String(modelId || this.activeModelId || '');
    this.lastTutorPromptRequestText = text;
    const useClientContent = targetModel.includes('2.5') && !this.hasSentRealtimeAudioOnSocket;

    if (useClientContent) {
      debugLogger.log('ws', 'client_content_sent', `Sent clientContent (${tag})`, {
        tag,
        ...extraLog
      });
      ws.send(
        JSON.stringify({
          clientContent: {
            turns: [{ role: 'user', parts: [{ text }] }],
            turnComplete: true
          }
        })
      );
    } else {
      debugLogger.log('ws', 'realtime_text_sent', `Sent realtimeInput.text (${tag})`, {
        tag,
        ...extraLog
      });
      ws.send(
        JSON.stringify({
          realtimeInput: {
            text
          }
        })
      );
    }
  }

  _connectSingleModelSocket(word, apiKey, modelId, voiceName, useExtendedConfig = true, isReconnect = false) {
    return new Promise((resolve, reject) => {
      this._closeRawSocketOnly();
      let setupCompleted = false;
      const connectStartMs = performance.now();
      this.hasUnflushedAudio = false;
      this.hasSentRealtimeAudioOnSocket = false;
      this.turnAudioChunks = 0;
      this.turnAudioSec = 0;
      this.turnAudibleChunks = 0;
      this.turnAudibleSec = 0;

      const wsUrl = `${LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.activeModelId = modelId;
      debugLogger.setContext({ model: modelId.replace(/^models\//, '') });

      if (!isReconnect) {
        this._emitState('connecting', `Connecting (${modelId.replace('models/', '')})...`);
      }

      debugLogger.log('ws', 'ws_connecting', `Opening WebSocket for ${modelId}`, {
        modelId,
        voiceName,
        useExtendedConfig,
        isReconnect
      });

      const setupTimeout = setTimeout(() => {
        if (!setupCompleted) {
          debugLogger.log('warn', 'ws_setup_timeout', `Timeout waiting for setupComplete on ${modelId}`);
          try {
            ws.close();
          } catch (_) {}
          reject(new Error(`Timeout waiting for setupComplete on ${modelId}`));
        }
      }, 8500);

      ws.onopen = () => {
        const generationConfig = {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName
              }
            }
          }
        };

        if (useExtendedConfig && modelId.includes('2.5')) {
          generationConfig.thinkingConfig = {
            thinkingBudget: 0
          };
        }

        // Pure Speech-to-Speech setup: NO `tools` array!
        // Prevents 100% of Live API `1011 Internal error occurred` and `1007` tool-call crashes.
        const setupObj = {
          model: modelId,
          generationConfig,
          systemInstruction: {
            parts: [{ text: buildWordSystemInstruction(word, isReconnect ? this.wordTurns : []) }]
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        };

        if (useExtendedConfig) {
          setupObj.realtimeInputConfig = {
            automaticActivityDetection: {
              prefixPaddingMs: 300,
              silenceDurationMs: 1500
            }
          };
          setupObj.contextWindowCompression = {
            slidingWindow: {}
          };
        }

        debugLogger.log('ws', 'ws_setup_sent', 'Sent BidiGenerateContentSetup (pure audio, zero tools)', {
          model: modelId,
          voiceName,
          useExtendedConfig,
          thinkingBudget: generationConfig.thinkingConfig ? generationConfig.thinkingConfig.thinkingBudget : 'default',
          priorTurnsSeeded: isReconnect ? this.wordTurns.length : 0
        });

        ws.send(JSON.stringify({ setup: setupObj }));
      };

      ws.onmessage = async (event) => {
        try {
          let rawText = event.data;
          if (rawText instanceof Blob) {
            rawText = await rawText.text();
          }
          const msg = JSON.parse(rawText);

          if (msg.setupComplete !== undefined) {
            setupCompleted = true;
            clearTimeout(setupTimeout);
            const setupLatencyMs = Math.round(performance.now() - connectStartMs);
            debugLogger.log('ws', 'ws_setup_complete', `setupComplete received in ${setupLatencyMs}ms`, {
              setupLatencyMs,
              isReconnect
            });

            const lastTurn = this.wordTurns.length > 0 ? this.wordTurns[this.wordTurns.length - 1] : null;

            // Case 1: Reconnecting after the tutor crashed MID-SENTENCE before `turnComplete`!
            if (isReconnect && this.interruptedTutorPartialText) {
              const partial = this.interruptedTutorPartialText;
              this.interruptedTutorPartialText = '';
              this.isPhase1InitialTurn = false;
              this.tutorTurnActive = true;
              this.listeningForUser = false;
              this.turnCommitPerfMs = performance.now();
              this._emitState('speaking', 'Tutor finishing response...');
              const finishPrompt = `剛才語音連線在你講到「${partial}」時短暫重連。請不要重複前面講過的話，直接把最後一句簡短講完！（如果本題練習已經完成，請直接說出：「好，我們看下一題！」）`;
              this._sendPromptTurn(ws, modelId, finishPrompt, 'mid_sentence_recovery', {
                interruptedPartial: partial
              });
              resolve();
              return;
            }

            // Case 2: Reconnecting after the user spoke (tutor hadn't started speaking yet)
            if (isReconnect && lastTurn && lastTurn.role === 'user') {
              this.isPhase1InitialTurn = false;
              this.tutorTurnActive = true;
              this.listeningForUser = false;
              this.turnCommitPerfMs = performance.now();
              this._emitState('speaking', 'Tutor responding...');
              const resumePrompt = `剛才語音連線短暫重連。我最後說的是：「${lastTurn.text}」。請不要重新唸英文題目，直接根據系統提示中的對話紀錄接續回應我！`;
              this._sendPromptTurn(ws, modelId, resumePrompt, 'reconnect_continuation', {
                lastUserText: lastTurn.text
              });
              resolve();
              return;
            }

            // Case 3: Reconnecting after a COMPLETED tutor turn (user's turn to speak)
            if (isReconnect && lastTurn && lastTurn.role === 'tutor') {
              this.isPhase1InitialTurn = false;
              this.turnExpectation = deriveTurnExpectationFromHistory(this.wordTurns);
              debugLogger.log('info', 'reconnect_resume_listening', 'Tutor turn was already complete; resuming user listening', {
                turnExpectation: this.turnExpectation
              });
              this._beginListeningTurn();
              resolve();
              return;
            }

            // Case 4: Fresh word start (or Phase 1 retry reconnect) -> kick off Phase 1
            if (!isReconnect) {
              this.playChime('start');
            }
            this.isPhase1InitialTurn = true;
            this.tutorTurnActive = true;
            this.listeningForUser = false;
            this.turnCommitPerfMs = performance.now();
            this._emitState('speaking', 'Tutor reading English prompt...');

            const kickoffText = `請直接開口清楚說出下面這兩句話（第一句英文請用正常語速唸出來，第二句台灣華語請用對學習者說話的自然慢速唸出來，兩句都必須發出清楚完整的語音，絕對不要省略英文句子）：\n${word.english_prompt} 請試著把這句話翻成中文。`;
            this._sendPromptTurn(ws, modelId, kickoffText, 'phase1_kickoff');
            resolve();
            return;
          }

          this._handleServerMessage(msg);
        } catch (parseErr) {
          debugLogger.log('error', 'ws_frame_parse_error', parseErr.message || String(parseErr));
          console.error('Error parsing Live WebSocket frame:', parseErr);
        }
      };

      ws.onerror = () => {
        debugLogger.log('warn', 'ws_error_event', `WebSocket error event fired on ${modelId}`, {
          setupCompleted
        });
        if (!setupCompleted) {
          clearTimeout(setupTimeout);
          reject(new Error(`WebSocket error on ${modelId}`));
        }
      };

      ws.onclose = (ev) => {
        clearTimeout(setupTimeout);
        debugLogger.finalizeStreamingEntries();
        if (this.ws === ws) {
          this.ws = null;
        }

        const code = ev.code;
        const reason = ev.reason || '';
        const wasClean = Boolean(ev.wasClean);

        if (!setupCompleted) {
          debugLogger.log(
            'warn',
            'ws_close_during_setup',
            `WebSocket closed during setup (${code}: ${reason || 'setup rejected'}) on ${modelId}`,
            { code, reason, wasClean, modelId, useExtendedConfig }
          );
          reject(new Error(`WebSocket closed (${code}: ${reason || 'setup rejected'}) on ${modelId}`));
          return;
        }

        if (this.wordTerminalActionLocked || this.intentionalClose || !this.isActive) {
          debugLogger.log('ws', 'ws_close_clean', `WebSocket closed cleanly (${code})`, {
            code,
            reason,
            wasClean
          });
          return;
        }

        debugLogger.log(
          'error',
          'ws_close_unexpected',
          `Unexpected WebSocket close: code=${code}${reason ? `, reason="${reason}"` : ''}`,
          {
            code,
            reason,
            wasClean,
            modelId,
            tutorTurnActive: this.tutorTurnActive,
            listeningForUser: this.listeningForUser,
            turnAudioChunks: this.turnAudioChunks,
            partialTutorText: this.currentTurnTutorTranscript.trim() || null
          }
        );

        this._attemptAutoReconnect(code, reason);
      };
    });
  }

  _defaultListeningLabel() {
    if (this.turnExpectation === 'answer_followup') {
      return 'Your turn — answer in Mandarin';
    }
    if (this.turnExpectation === 'reply_and_ask_back') {
      return 'Your turn — answer & ask a question back';
    }
    if (this.turnExpectation === 'ask_question_only') {
      return 'Your turn — ask the tutor a question in Mandarin';
    }
    return 'Your turn — speak in Mandarin';
  }

  _beginListeningTurn(customLabel = null, skipCooldown = false) {
    if (!this.isActive || this.wordTerminalActionLocked) return;
    this.tutorTurnActive = false;
    this.listeningForUser = true;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.activeUserTurnIndex = -1;
    this.consecutiveSpeechFrames = 0;
    this.resumeSpeechFrames = 0;
    this.speechSegmentsInTurn = 0;
    this.turnVoicedMs = 0;
    this.turnPeakSpeechRms = 0.04;
    this.turnFramesCount = 0;
    this.turnZeroFramesCount = 0;
    this.turnRawMaxRms = 0;
    this.turnRawSumRms = 0;
    this.silenceFramesSentInPause = 0;
    this.pausePreRollBuffer = [];
    this.sentAudioChunksInTurn = 0;
    this.currentTurnUserTranscript = '';
    this.currentTurnInterimUserTranscript = '';
    this.lastCountdownText = '';
    this.postPlaybackCooldownUntil = skipCooldown ? 0 : performance.now() + 180;

    this._emitState('listening', customLabel || this._defaultListeningLabel());
  }

  _executeTerminalCue(cue, triggerSource = 'turn_complete') {
    if (this.wordTerminalActionLocked) return;
    this.wordTerminalActionLocked = true;
    this.intentionalClose = true;
    this.listeningForUser = false;
    this.tutorTurnActive = true;

    const remainSec = Number(this._getRemainingPlaybackSec().toFixed(2));
    debugLogger.log(
      'tool',
      'spoken_cue_detected',
      `Detected spoken sign-off cue (${cue.type}${cue.action ? ':' + cue.action : ''}) via ${triggerSource}; playing ${remainSec}s remaining audio`,
      { cue, remainingAudioSec: remainSec, turnsCount: this.wordTurns.length }
    );

    // Close WebSocket cleanly right away while WebAudio plays out the remaining farewell speech!
    this._closeRawSocketOnly();

    const turnsSnapshot = this.wordTurns.map((t) => ({ role: t.role, text: t.text }));
    const usedHint = this.usedHintInWord;

    this._schedulePostPlaybackCallback(() => {
      if (cue.type === 'complete_word') {
        this.playChime('complete');
        this.onCompleteWord({
          wordTurns: turnsSnapshot,
          usedHintButton: usedHint
        });
      } else {
        this.playChime('skip');
        this.onSessionControl({
          action: cue.action || 'skip',
          reason: 'Voice spoken command'
        });
      }
    });
  }

  _markTutorTurnStartedFromServer() {
    this.serverAckedCurrentUserTurn = true;
    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
      this.noReplyRecoveryTimer = null;
    }
    if (!this.tutorTurnActive) {
      if (this.listeningForUser) {
        // Server-side automatic VAD committed the user's turn
        this.isPhase1InitialTurn = false;
        this.silentTurnRetries = 0;
        debugLogger.finalizeStreamingEntries('input_transcript');
        this.turnCommitPerfMs = performance.now();
        debugLogger.log('info', 'server_vad_turn_committed', 'Server VAD detected end of user speech', {
          userTranscript: this._getCombinedLiveUserTranscript()
        });
      }
      this._commitPendingUserTranscriptToTurns();
      this.tutorTurnActive = true;
      this.listeningForUser = false;
      this.hasUnflushedAudio = false;
    }
  }

  _speakBrowserFallbackIfAvailable(text, onDone) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window && text) {
      try {
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = /[A-Za-z]{3,}/.test(text) ? 'en-US' : 'zh-TW';
        utter.rate = 0.92;
        utter.onend = () => onDone();
        utter.onerror = () => onDone();
        window.speechSynthesis.speak(utter);
        return;
      } catch (_) {}
    }
    onDone();
  }

  _handleServerMessage(msg) {
    if (
      msg.goAway &&
      this.isActive &&
      !this.wordTerminalActionLocked &&
      !this.pendingActionAfterPlayback &&
      !this.intentionalClose
    ) {
      debugLogger.log('warn', 'ws_goaway', 'Received server GoAway frame', msg.goAway);
      this._schedulePostPlaybackCallback(() => {
        if (
          this.isActive &&
          !this.wordTerminalActionLocked &&
          !this.pendingActionAfterPlayback &&
          !this.intentionalClose
        ) {
          this._attemptAutoReconnect('goAway', 'server_goaway');
        }
      });
    }

    if (msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.interrupted) {
        debugLogger.log('info', 'server_interrupted', 'Server reported interrupted flag', {
          userSpokeInTurn: this.userSpokeInTurn
        });
        if (this.userSpokeInTurn && !this.wordTerminalActionLocked) {
          this.stopPlaybackImmediately();
          this._beginListeningTurn();
        }
      }

      if (sc.interimInputTranscription && sc.interimInputTranscription.text) {
        this.currentTurnInterimUserTranscript = sc.interimInputTranscription.text;
      }

      if (sc.inputTranscription && sc.inputTranscription.text) {
        const text = sc.inputTranscription.text;
        this.currentTurnInterimUserTranscript = '';
        debugLogger.appendStream('info', 'input_transcript', text);

        if (this.listeningForUser) {
          this.currentTurnUserTranscript += text;
          this.onTranscript('user', text);
          // IMPORTANT: Do NOT reset `lastVoiceActivityTime` if `userSpokeInTurn` is already true!
          // `inputTranscription` chunks arrive 800-1800ms AFTER acoustic speech pauses, which previously
          // restarted the post-speech silence timer and added ~1.5-2.0s of extra lag on every turn.
          if (!this.userSpokeInTurn) {
            this.userSpokeInTurn = true;
            this.speechSegmentsInTurn = Math.max(1, this.speechSegmentsInTurn);
            this.lastVoiceActivityTime = performance.now();
          }
        } else {
          // Late `inputTranscription` arriving AFTER `commitUserSpeechTurn` / during tutor reply:
          // Append directly onto the active user turn in `this.wordTurns` so trailing characters
          // (e.g. `子` in `這樣子`) are never lost when `_beginListeningTurn()` resets the live buffer!
          this._appendLateUserTranscriptToTurns(text);
          this.onTranscript('late_user_append', text);
        }
      }

      if (sc.outputTranscription && sc.outputTranscription.text) {
        this._markTutorTurnStartedFromServer();
        const spokenText = sc.outputTranscription.text;
        this.currentTurnTutorTranscript += spokenText;
        debugLogger.appendStream('info', 'output_transcript', spokenText);
        this.onTranscript('tutor', spokenText);
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        this._markTutorTurnStartedFromServer();

        for (const part of sc.modelTurn.parts) {
          if (part.thought || (typeof part.text === 'string' && part.text.trim())) {
            debugLogger.appendStream(
              'thought',
              'model_thought',
              part.text || '[thought part]',
              { thoughtFlag: Boolean(part.thought) }
            );
          }

          if (part.inlineData && part.inlineData.data) {
            if (this.turnAudioChunks === 0) {
              const ttfaMs = this.turnCommitPerfMs
                ? Math.round(performance.now() - this.turnCommitPerfMs)
                : null;
              debugLogger.log('info', 'tutor_audio_start', 'First 24kHz audio chunk received', {
                ttfaMs
              });
            }
            this._emitState('speaking', 'Tutor speaking...');
            const chunkStats = this._enqueuePcm24kAudio(part.inlineData.data);
            this.turnAudioChunks += 1;
            this.turnAudioSec += chunkStats.duration;
            if (chunkStats.isAudible) {
              this.turnAudibleChunks += 1;
              this.turnAudibleSec += chunkStats.duration;
            }
          }
        }
      }

      if (sc.turnComplete) {
        debugLogger.finalizeStreamingEntries();
        const completedTutorText = this.currentTurnTutorTranscript.trim();
        const totalAudioChunks = this.turnAudioChunks;
        const totalAudioSec = Number(this.turnAudioSec.toFixed(2));
        const audibleChunks = this.turnAudibleChunks;
        const audibleSec = Number(this.turnAudibleSec.toFixed(2));

        debugLogger.log('info', 'tutor_turn_complete', 'Server signaled turnComplete', {
          audioChunks: totalAudioChunks,
          audioSec: totalAudioSec,
          audibleChunks,
          audibleSec,
          spokenChars: completedTutorText.length
        });

        this.turnAudioChunks = 0;
        this.turnAudioSec = 0;
        this.turnAudibleChunks = 0;
        this.turnAudibleSec = 0;

        const pendingCue = detectSpokenTerminalCue(completedTutorText);

        // Guard 1: Detect completely silent tutor turn (0 audio chunks or all-zero `AAA=` chunks)
        if (
          this.isActive &&
          !this.wordTerminalActionLocked &&
          audibleSec < 0.45 &&
          !(pendingCue && this.silentTurnRetries >= 1)
        ) {
          this.currentTurnTutorTranscript = '';
          this.onTranscript('discard_last_tutor', '');

          const canRetryOnSameSocket = !(
            String(this.activeModelId || '').includes('2.5') && this.hasSentRealtimeAudioOnSocket
          );

          if (
            this.silentTurnRetries === 0 &&
            canRetryOnSameSocket &&
            this.ws &&
            this.ws.readyState === WebSocket.OPEN
          ) {
            this.silentTurnRetries = 1;
            debugLogger.log(
              'warn',
              'silent_tutor_turn_retry',
              'Tutor turn had <0.45s audible speech; regenerating spoken audio immediately',
              {
                audioChunks: totalAudioChunks,
                audioSec: totalAudioSec,
                audibleSec,
                spokenChars: completedTutorText.length,
                retry: 1
              }
            );
            this.tutorTurnActive = true;
            this.listeningForUser = false;
            this.turnCommitPerfMs = performance.now();
            this._emitState('speaking', 'Tutor speaking...');

            const regenPrompt =
              this.isPhase1InitialTurn && this.currentWord
                ? `剛才沒有發出語音！請現在直接開口清楚唸出這句英文題目與中文提示（兩句都必須發出清楚聲音）：\n${this.currentWord.english_prompt} 請試著把這句話翻成中文。`
                : completedTutorText
                ? `剛才你的回覆沒有發出聲音，學生沒聽到！請現在直接開口把這句話清楚說出來：「${completedTutorText}」`
                : this.lastTutorPromptRequestText ||
                  '請用自然慢速的台灣華語簡短回應學生剛才說的話。';

            this._sendPromptTurn(this.ws, this.activeModelId, regenPrompt, 'silent_turn_retry_1');
            return;
          }

          if (this.silentTurnRetries <= 1 && this.currentWord && this.lastLiveConfig) {
            this.silentTurnRetries = 2;
            const hadRealtimeAudioOnThisSocket = this.hasSentRealtimeAudioOnSocket;
            const nextRotationOffset = hadRealtimeAudioOnThisSocket ? 0 : 1;
            debugLogger.log(
              'warn',
              'silent_tutor_turn_rotate_model',
              hadRealtimeAudioOnThisSocket
                ? 'Second silent turn after realtime audio; refreshing clean socket on primary Live model'
                : 'Second consecutive silent turn on cold socket; rotating to fallback Live model',
              { failedModel: this.activeModelId, rotationOffset: nextRotationOffset }
            );
            this._closeRawSocketOnly();
            this._openSocketWithFallbacks(
              this.currentWord,
              this.lastLiveConfig,
              this.wordTurns.length > 0,
              nextRotationOffset
            ).catch((err) => {
              debugLogger.log('error', 'silent_rotate_failed', err.message || String(err));
              this._beginListeningTurn();
            });
            return;
          }

          // Ultimate safety net if multiple sockets returned silent audio
          const fallbackLine =
            completedTutorText ||
            (this.currentWord ? `${this.currentWord.english_prompt}` : '');
          if (fallbackLine) {
            this.onTranscript('tutor', fallbackLine);
            this.onTranscript('turn_end', '');
          }
          this.isPhase1InitialTurn = false;
          this.silentTurnRetries = 0;
          this._speakBrowserFallbackIfAvailable(fallbackLine, () => {
            if (this.isActive && !this.wordTerminalActionLocked) {
              this._beginListeningTurn();
            }
          });
          return;
        }

        // Guard 2: Detect Phase 1 greeting where English sentence was skipped or Chinese instruction truncated
        if (
          this.isActive &&
          !this.wordTerminalActionLocked &&
          this.isPhase1InitialTurn &&
          this.silentTurnRetries === 0 &&
          this.currentWord &&
          !pendingCue
        ) {
          const engPrompt = String(this.currentWord.english_prompt || '').trim();
          const engWords = engPrompt.match(/[A-Za-z0-9']+/g) || [];
          const minBothSec = Math.min(3.65, Math.max(3.15, 2.35 + engWords.length * 0.19));
          const compactTutorText = completedTutorText.replace(/\s+/g, '');
          const hasChineseInstructionEnd = /中文|說說看|怎麼說|翻譯/.test(compactTutorText);
          const lowerTranscript = completedTutorText.toLowerCase();
          const matchedEngWords = engWords.filter((w) =>
            lowerTranscript.includes(w.toLowerCase())
          ).length;
          const hasEnglishInTranscript =
            engWords.length === 0 || matchedEngWords >= Math.ceil(engWords.length * 0.5);

          if (audibleSec < minBothSec || !hasChineseInstructionEnd || !hasEnglishInTranscript) {
            this.isPhase1InitialTurn = false;
            this.silentTurnRetries = 1;
            this._commitCompletedTutorTranscriptToTurns();
            this.onTranscript('turn_end', '');

            debugLogger.log(
              'warn',
              'partial_phase1_audio_autorepeat',
              'Phase 1 audio was partial or truncated; auto-speaking English prompt clearly',
              {
                audibleSec,
                minBothSec: Number(minBothSec.toFixed(2)),
                hasChineseInstructionEnd,
                hasEnglishInTranscript,
                spokenText: completedTutorText
              }
            );

            this._schedulePostPlaybackCallback(() => {
              if (
                !this.isActive ||
                this.wordTerminalActionLocked ||
                !this.ws ||
                this.ws.readyState !== WebSocket.OPEN
              ) {
                return;
              }
              this.tutorTurnActive = true;
              this.listeningForUser = false;
              this.turnCommitPerfMs = performance.now();
              this._emitState('speaking', 'Reading English sentence...');
              const repeatEngPrompt = `請立刻用正常語速清楚唸出這題的英文句子："${engPrompt}"，接著簡短說：「請翻成中文。」`;
              this._sendPromptTurn(
                this.ws,
                this.activeModelId,
                repeatEngPrompt,
                'phase1_missing_english_autofix'
              );
            });
            return;
          }
        }

        this.isPhase1InitialTurn = false;
        this.silentTurnRetries = 0;
        this._commitCompletedTutorTranscriptToTurns();
        this.reconnectAttempts = 0;
        this.onTranscript('turn_end', '');

        // Check if the tutor spoke a deterministic terminal sign-off phrase (`「好，我們看下一題！」`, etc.)
        if (pendingCue) {
          this._executeTerminalCue(pendingCue, 'turn_complete');
          return;
        }

        this.turnExpectation = deriveTurnExpectationFromHistory(this.wordTurns);
        if (
          this.turnExpectation === 'answer_followup' ||
          this.turnExpectation === 'reply_and_ask_back'
        ) {
          if ((debugLogger.context.phase || 1) < 2) {
            debugLogger.setContext({ phase: 2 });
            this.onPhaseHint(2);
          }
        } else if (this.turnExpectation === 'ask_question_only') {
          if ((debugLogger.context.phase || 1) < 3) {
            debugLogger.setContext({ phase: 3 });
            this.onPhaseHint(3);
          }
        }

        this._schedulePostPlaybackCallback(() => {
          if (this.isActive && !this.wordTerminalActionLocked) {
            this._beginListeningTurn();
          }
        });
      }
    }
  }

  /**
   * Sends a text command into the active Live session (e.g., if the user taps "Repeat" or "Hint")
   */
  sendTextCommand(text, options = {}) {
    if (this.wordTerminalActionLocked) return;
    if (options.isHint) {
      this.usedHintInWord = true;
    }
    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
      this.noReplyRecoveryTimer = null;
    }
    this._commitPendingUserTranscriptToTurns();
    this.isPhase1InitialTurn = false;
    this.silentTurnRetries = 0;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.isDisconnected() && this.currentWord) {
        this.reconnectCurrentWord().catch(() => {});
      }
      return;
    }
    this._flushAudioStreamEnd();
    this.listeningForUser = false;
    this.tutorTurnActive = true;
    this.turnCommitPerfMs = performance.now();
    this._emitState('connecting', 'Requesting from tutor...');
    this._sendPromptTurn(this.ws, this.activeModelId, text, 'user_button_command');
  }

  _enqueuePcm24kAudio(base64Data) {
    if (!base64Data) return { duration: 0, isAudible: false, rms: 0 };
    const binary = atob(base64Data);
    const byteLen = binary.length;
    const samples = byteLen >> 1;
    if (samples === 0) return { duration: 0, isAudible: false, rms: 0 };

    const float32 = new Float32Array(samples);
    let sumSq = 0;
    for (let i = 0; i < samples; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      let int16 = (hi << 8) | lo;
      if (int16 >= 0x8000) int16 -= 0x10000;
      const s = int16 / 32768.0;
      float32[i] = s;
      sumSq += s * s;
    }

    const rms = Math.sqrt(sumSq / samples);
    const duration = samples / 24000;
    const isAudible = rms >= 0.0015;

    if (!this.audioCtx) {
      return { duration, isAudible, rms };
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    // Skip scheduling leading pure-zero (`AAA=`) digital-silence chunks before real speech begins
    if (this.turnAudibleChunks === 0 && rms < 0.0004) {
      return { duration, isAudible: false, rms };
    }

    const audioBuffer = this.audioCtx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const src = this.audioCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.audioCtx.destination);

    const now = this.audioCtx.currentTime;
    if (this.nextPlayTime < now) {
      this.nextPlayTime = now + 0.02;
    }

    src.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
    this.activeSources.add(src);

    src.onended = () => {
      this.activeSources.delete(src);
    };

    return { duration: audioBuffer.duration, isAudible, rms };
  }

  _schedulePostPlaybackCallback(cb) {
    if (!this.audioCtx) {
      cb();
      return;
    }
    const remainingSec = Math.max(0, this.nextPlayTime - this.audioCtx.currentTime);
    setTimeout(cb, Math.ceil(remainingSec * 1000) + 80);
  }

  stopPlaybackImmediately() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch (_) {}
    }
    this.activeSources.clear();
    if (this.audioCtx) {
      this.nextPlayTime = this.audioCtx.currentTime;
    }
  }

  _closeRawSocketOnly() {
    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
      this.noReplyRecoveryTimer = null;
    }
    this.hasUnflushedAudio = false;
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }

  closeCurrentWordSocket() {
    this.intentionalClose = true;
    this.isActive = false;
    this.isReconnecting = false;
    this.listeningForUser = false;
    this.tutorTurnActive = false;
    this.userSpokeInTurn = false;
    this.pendingActionAfterPlayback = null;
    this.interruptedTutorPartialText = '';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._closeRawSocketOnly();
    this.stopPlaybackImmediately();
  }

  /**
   * Starts a persistent, inaudible (`-90.3 dBFS` ±1 LSB) 12-second looping `<audio>` element.
   * On Chrome for Android, `WebAudio` (`AudioContext`) alone NEVER registers an Android OS
   * `MediaSessionCompat` or Bluetooth AVRCP listener — Chromium requires an active `HTMLMediaElement`
   * of duration >= 5 seconds (`MediaContentType::Persistent`) to route car steering-wheel & earbud
   * `previoustrack` / `nexttrack` / `play` / `pause` buttons to `navigator.mediaSession`.
   */
  async startMediaSessionAnchor() {
    if (
      typeof document === 'undefined' ||
      typeof Blob === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return false;
    }
    try {
      if (!this.mediaAnchorBlobUrl) {
        const wavBytes = buildSilentWavBytes(12, 8000);
        const blob = new Blob([wavBytes], { type: 'audio/wav' });
        this.mediaAnchorBlobUrl = URL.createObjectURL(blob);
      }
      let created = false;
      if (!this.mediaAnchorAudio) {
        const el = document.createElement('audio');
        el.loop = true;
        el.preload = 'auto';
        el.volume = 1.0;
        el.muted = false;
        el.setAttribute('playsinline', '');
        el.setAttribute('aria-hidden', 'true');
        el.style.display = 'none';
        el.src = this.mediaAnchorBlobUrl;
        if (document.body) {
          document.body.appendChild(el);
        }
        this.mediaAnchorAudio = el;
        created = true;
      }
      if (this.mediaAnchorAudio.paused) {
        await this.mediaAnchorAudio.play();
      }
      if (created) {
        debugLogger.log(
          'info',
          'media_session_anchor_started',
          'Started 12s persistent MediaSession audio anchor for car/Bluetooth controls'
        );
      }
      return true;
    } catch (err) {
      debugLogger.log(
        'warn',
        'media_session_anchor_warn',
        `MediaSession anchor play deferred: ${err.message || err}`
      );
      return false;
    }
  }

  pauseMediaSessionAnchor() {
    if (this.mediaAnchorAudio && !this.mediaAnchorAudio.paused) {
      try {
        this.mediaAnchorAudio.pause();
      } catch (_) {}
    }
  }

  stopMediaSessionAnchor() {
    if (this.mediaAnchorAudio) {
      try {
        this.mediaAnchorAudio.pause();
        this.mediaAnchorAudio.removeAttribute('src');
        this.mediaAnchorAudio.load();
        if (this.mediaAnchorAudio.parentNode) {
          this.mediaAnchorAudio.parentNode.removeChild(this.mediaAnchorAudio);
        }
      } catch (_) {}
      this.mediaAnchorAudio = null;
    }
    if (this.mediaAnchorBlobUrl) {
      try {
        URL.revokeObjectURL(this.mediaAnchorBlobUrl);
      } catch (_) {}
      this.mediaAnchorBlobUrl = null;
    }
  }

  async destroyAll() {
    this.closeCurrentWordSocket();
    this.stopMediaSessionAnchor();
    if (this.trackEndedRecoveryTimer) {
      clearTimeout(this.trackEndedRecoveryTimer);
      this.trackEndedRecoveryTimer = null;
    }
    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (_) {}
      this.micSourceNode = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    this.workletNode = null;
    this.workletLoaded = false;
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch (_) {}
      this.audioCtx = null;
    }
  }

  _computeRawRms(float32Samples) {
    let sum = 0;
    const step = 2;
    let count = 0;
    for (let i = 0; i < float32Samples.length; i += step) {
      const s = float32Samples[i];
      sum += s * s;
      count += 1;
    }
    return count > 0 ? Math.sqrt(sum / count) : 0;
  }

  _computeMicLevel(float32Samples) {
    const rms = this._computeRawRms(float32Samples);
    this.onAudioLevel(Math.min(1, rms * 5));
    return rms;
  }

  _downsampleAndEncodePcm16(buffer, inputRate, outputRate) {
    let samples = buffer;
    if (inputRate !== outputRate) {
      const ratio = inputRate / outputRate;
      const newLength = Math.round(buffer.length / ratio);
      samples = new Float32Array(newLength);
      for (let i = 0; i < newLength; i++) {
        const start = i * ratio;
        const end = start + ratio;
        const iStart = Math.floor(start);
        const iEnd = Math.min(buffer.length - 1, Math.ceil(end) - 1);
        let acc = 0;
        let count = 0;
        for (let j = iStart; j <= iEnd; j++) {
          acc += buffer[j];
          count += 1;
        }
        samples[i] = count > 0 ? acc / count : buffer[Math.min(buffer.length - 1, iStart)];
      }
    }

    const bytes = new Uint8Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
      bytes[i * 2] = int16 & 0xff;
      bytes[i * 2 + 1] = (int16 >> 8) & 0xff;
    }

    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
}
