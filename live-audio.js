/**
 * Gemini Live WebSocket + WebAudio PCM 16kHz/24kHz Streaming Engine (`live-audio.js`)
 *
 * Key architectural guarantees (v14):
 * 1. Fresh WebSocket connection per vocabulary word (zero multi-word context drift).
 * 2. ZERO `tools` / `functionDeclarations` on the Live Audio WebSocket:
 *    Uses deterministic spoken sign-off phrases (`「好，我們看下一題！」`, `「好，我們跳過這題！」`,
 *    etc.) detected from `outputAudioTranscription`, while FSRS v5 grading runs asynchronously
 *    over standard REST JSON in the background after the word ends!
 * 3. Model-aware cold-start `clientContent` (`turnComplete: true` on 2.5) + real-time 24kHz PCM
 *    audibility RMS verification (`turnAudibleSec`) that automatically detects and regenerates
 *    silent (`0` audio / `AAA=` zeros) or missing-English Phase 1 prompts without user intervention.
 * 4. Mid-sentence crash recovery: if a cellular drop or server `1011` interrupts the tutor
 *    BEFORE `turnComplete`, auto-reconnect rotates to the next healthy Live model immediately
 *    and prompts the tutor to finish its interrupted sentence instead of freezing in `listening`.
 */

import { debugLogger } from './debug-logger.js?v=14';

const LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

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

export function buildWordSystemInstruction(word, priorTurns = []) {
  const referenceMandarin = (word.mandarin_sentence || word.sample_mandarin || '').trim();
  const synonymsLine = word.common_synonyms
    ? `常見近義詞（若學生誤用請溫柔引導換成目標詞，不要扣分）：${word.common_synonyms}`
    : '若學生使用了其他合法的近義詞，請肯定他的句子，並提示他換成我們今天要練習的目標詞，不要直接唸出目標詞的發音，也不扣分。';

  let resumeSection = '';
  if (Array.isArray(priorTurns) && priorTurns.length > 0) {
    const formattedTurns = priorTurns
      .map((t) => `${t.role === 'tutor' ? '老師' : '學生'}：${t.text}`)
      .join('\n');
    resumeSection = `\n\n【本題目前已完成的對話紀錄（剛才網路短暫重連，請直接從最後一句自然接續，絕對不要重頭出題或重複已經說過的話！）】\n${formattedTurns}\n請根據上述對話進度直接接續目前的練習階段；若學生已反問問題（或已完成三輪問答），請簡短回答一句並說出固定結尾口令「好，我們看下一題！」。`;
  }

  return `你是一位專業、親切、有耐心的台灣華語（Taiwanese Mandarin）口語家教。學生正在進行全免持（hands-free）口說練習。

【語速與難度原則（極重要）】
1. **中文請用對學習者說話的自然慢速**：當你說台灣華語（中文）時，請放慢語速，就像面對華語學習者說話一樣，發音清楚、語調自然流暢。請保持正常的句子連貫感，不要刻意一字一頓或在詞與詞之間做不自然的停頓。
2. **英文題目保持正常語速**：朗讀預先產生的「英文句子（Pre-Generated English Sentence）」時，請維持正常的自然英文語速。
3. **全程使用與目標詞同等級的簡單日常詞彙**：你對學生說的所有中文回饋與延伸問題，請使用簡單、日常的基礎生活詞彙（TOCFL 1～2 級初級詞彙），句子簡短自然（每次 1～2 句短句），避免艱深詞彙、成語或複雜長句。
4. 除了朗讀指定的英文題目之外，全程請 100% 使用自然的台灣華語（繁體中文、台灣日常用語，例如「聲調、四聲、三聲、餐廳、計程車、公車、早上/晚上」）與學生對話，不要用英文解釋。

【本題預先產生的對照句子與目標詞彙（內部資訊，在學生成功說出前請勿直接洩漏讀音）】
- 目標詞（繁體）：${word.traditional}
- 拼音 / 注音：${word.pinyin || ''} ${word.zhuyin ? '(' + word.zhuyin + ')' : ''}
- 英文詞義：${word.english_gloss || ''}
- 預先產生的自然台灣華語原句（Pre-Generated Mandarin Reference）：「${referenceMandarin}」
- 由上述中文原句翻譯出的英文題目（Pre-Generated English Sentence）："${word.english_prompt}"
- ${synonymsLine}

【四階段對話練習流程（請嚴格按順序執行）】
- **階段一（朗讀英文題目、比對預先產生的中文原句、給予回饋修正）**：
  1. 對話一開始，請直接用正常英文語速唸出預先產生的英文句子："${word.english_prompt}"，接著用對學習者說話的自然慢速台灣華語簡短說：「請試著把這句話翻成中文。」（千萬不要在開頭把目標詞「${word.traditional}」或中文原句唸出來！）
  2. 仔細聽學生的中文回答，並與預先產生的台灣華語原句「${referenceMandarin}」對照檢查：
     - **允許表達與句型上的自然差異（Allow Stylistic Variations — 極重要）**：「${referenceMandarin}」是標準參考原句，但**不是唯一死板標準答案**！只要學生說出的中文句子**語法正確、符合台灣華語自然口語習慣、表達出英文題目的意思、並且正確使用了目標詞「${word.traditional}」**（且發音聲調正確），就算他的措辭、語序、代名詞、時間詞位置、量詞或語氣助詞（如「了、嗎、吧、呢」）與「${referenceMandarin}」有些微風格差異，**請完全視為正確通過**，直接稱讚並進入階段二，不要強迫他一字不差地背出參考句！
     - 若學生用了近義詞而非「${word.traditional}」：先肯定他的句子很自然，並溫柔提示他換成今天要練習的目標詞（不要直接唸出目標詞讀音，且不計入發音或語法扣分）。
     - 若學生的「${word.traditional}」或句子其他部分有**聲調錯誤、發音不準、漏掉目標詞、或語法不自然**：請參考「${referenceMandarin}」，用自然慢速的台灣華語清楚給予回饋與糾正（明確指出哪個字幾聲或哪裡語法怎麼改比較自然），清楚示範正確唸法，並請學生**重新完整說一次正確的中文句子**。
     - 若學生問任何問題：請用簡單慢速的台灣華語清楚回答，然後引導他回到這句話的練習。
     - 若學生主動要求「提示 / Hint」或「直接給我答案」：可給他提示或直接示範「${referenceMandarin}」，但仍請他跟著親口唸出完整正確的句子一次。
  3. 持續互動直到學生親口完整說出包含「${word.traditional}」且語法自然、發音正確的句子為止。

- **階段二（老師延伸提問）**：
  當學生成功說出正確自然的句子後，先簡短肯定他（例如：「說得很好！」），並立刻根據這句話的情境，用**簡單、自然慢速的台灣華語**問他一個簡短的日常**延伸問題（follow-up question）**（使用基礎詞彙，6～12 個字以內）。

- **階段三（學生回答＋請學生反問老師）**：
  1. 學生會用中文回答你的問題，並且應該要順便反問你一個相關的問題。
  2. 如果學生的回答有明顯語法或發音錯誤，請簡短幫他修正一句。
  3. **關鍵規則**：如果學生只有回答你的問題、還沒反問你問題，**請絕對不要再問他新的問題**！請先簡短回應他一句，然後明確請他問你一個問題（例如：「聽起來不錯！現在換你問我一個問題吧！」），並等待他提問。如果學生已經反問你問題了，就直接進入階段四。

- **階段四（老師簡短回答並說出固定換題口令）**：
  當學生提出他的問題後，請用簡單、自然慢速的台灣華語**簡短回答他的問題（1 句短句即可）**，並在最後一字不差地說出固定換題口令：**「好，我們看下一題！」**。
  （注意：在階段一至階段三未完成前，絕對不可以說出「我們看下一題」；一說出「好，我們看下一題！」系統就會自動計分並切換到下一個單字！）

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
    this.onError = callbacks.onError || (() => {});

    this.audioCtx = null;
    this.micStream = null;
    this.workletNode = null;
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

    // Hybrid VAD (Server automaticActivityDetection + Client 2.8s silence backup)
    this.silenceWaitMs = 2800;
    this.listeningForUser = false;
    this.tutorTurnActive = false;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.hasUnflushedAudio = false;
    this.consecutiveSpeechFrames = 0;
    this.lastVoiceActivityTime = 0;
    this.lastCountdownText = '';
    this.noiseFloor = 0.005;
    this.currentTurnUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.interruptedTutorPartialText = '';
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
   * Initializes the persistent WebAudio context and microphone stream once when the user taps "Start Driving Session".
   */
  async initAudioHardware() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: 24000 });
      debugLogger.log('info', 'audio_ctx_init', `Initialized WebAudio (${this.audioCtx.sampleRate}Hz)`);
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    if (!this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const trackLabel = this.micStream.getAudioTracks()[0]?.label || 'default mic';
      debugLogger.log('info', 'mic_acquired', `Microphone ready (${trackLabel})`);

      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = this.audioCtx.createMediaStreamSource(this.micStream);
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-recorder-processor');

      this.workletNode.port.onmessage = (event) => {
        if (!this.isActive || this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        const float32Samples = event.data;
        const rms = this._computeMicLevel(float32Samples);
        this._processMicFrameWithVad(float32Samples, rms);
      };

      source.connect(this.workletNode);
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.value = 0;
      this.workletNode.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
    }
  }

  _processMicFrameWithVad(float32Samples, rms) {
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

    const pcm16Base64 = this._downsampleAndEncodePcm16(
      float32Samples,
      this.audioCtx.sampleRate,
      16000
    );

    const speechStartThreshold = Math.max(0.016, Math.min(0.05, this.noiseFloor * 2.8));
    const speechContinueThreshold = Math.max(0.011, Math.min(0.036, this.noiseFloor * 1.9));

    if (!this.userSpokeInTurn) {
      this._sendAudioChunk(pcm16Base64);

      if (rms >= speechStartThreshold) {
        this.consecutiveSpeechFrames += 1;
        if (this.consecutiveSpeechFrames >= 3) {
          this.userSpokeInTurn = true;
          this.lastVoiceActivityTime = now;
          this.lastCountdownText = '';
          debugLogger.log('info', 'user_speech_start', 'User started speaking Mandarin', {
            rms: Number(rms.toFixed(4)),
            noiseFloor: Number(this.noiseFloor.toFixed(4)),
            threshold: Number(speechStartThreshold.toFixed(4))
          });
          this._emitState('listening', 'Hearing your Mandarin... (auto-sends after pause)');
        }
      } else {
        this.consecutiveSpeechFrames = 0;
        this.noiseFloor = 0.93 * this.noiseFloor + 0.07 * rms;
      }
      return;
    }

    this._sendAudioChunk(pcm16Base64);

    if (rms >= speechContinueThreshold) {
      this.lastVoiceActivityTime = now;
      if (this.lastCountdownText !== '') {
        this.lastCountdownText = '';
        this._emitState('listening', 'Hearing your Mandarin... (auto-sends after pause)');
      }
    } else {
      const silenceElapsed = now - this.lastVoiceActivityTime;
      if (silenceElapsed >= this.silenceWaitMs) {
        this.commitUserSpeechTurn('auto_silence');
      } else if (silenceElapsed >= 600) {
        const remainSec = Math.max(0.1, (this.silenceWaitMs - silenceElapsed) / 1000).toFixed(1);
        const statusMsg = `Pause detected — sending in ${remainSec}s (or tap Done)`;
        if (statusMsg !== this.lastCountdownText) {
          this.lastCountdownText = statusMsg;
          this._emitState('listening', statusMsg);
        }
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

  commitUserSpeechTurn(reason = 'auto_silence') {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.tutorTurnActive || this.wordTerminalActionLocked) return;

    const hadUserSpeech = this.userSpokeInTurn;
    const chunksSent = this.sentAudioChunksInTurn;
    this.isPhase1InitialTurn = false;
    this.silentTurnRetries = 0;
    this.listeningForUser = false;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.consecutiveSpeechFrames = 0;
    this.sentAudioChunksInTurn = 0;
    this.lastCountdownText = '';
    this.turnCommitPerfMs = performance.now();

    debugLogger.finalizeStreamingEntries('input_transcript');
    debugLogger.log('info', 'user_turn_committed', `Committed user turn (${reason})`, {
      reason,
      audioChunksSent: chunksSent,
      transcriptSoFar: this.currentTurnUserTranscript.trim()
    });

    this._emitState('connecting', 'Processing your Mandarin...');
    this._flushAudioStreamEnd();

    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
    }

    const recoveryWaitMs = hadUserSpeech || this.currentTurnUserTranscript.trim() ? 8500 : 4500;
    this.noReplyRecoveryTimer = setTimeout(() => {
      this.noReplyRecoveryTimer = null;
      if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (
        this.wordTerminalActionLocked ||
        this.pendingActionAfterPlayback ||
        this.tutorTurnActive ||
        this.serverAckedCurrentUserTurn ||
        this.isTutorPlayingAudio()
      ) {
        return;
      }

      const latestTranscript = this.currentTurnUserTranscript.trim();
      if (latestTranscript) {
        debugLogger.log(
          'warn',
          'no_reply_timer_fired',
          `No server output after ${recoveryWaitMs}ms; sending single realtimeInput.text nudge`,
          { latestTranscript }
        );
        this.serverAckedCurrentUserTurn = true;
        try {
          this.ws.send(
            JSON.stringify({
              realtimeInput: {
                text: `（學生剛才回答：「${latestTranscript}」，請直接依目前練習階段用自然慢速台灣華語簡短回應。）`
              }
            })
          );
        } catch (_) {}
      } else {
        debugLogger.log(
          'info',
          'no_reply_timer_fired',
          `No speech transcribed after ${recoveryWaitMs}ms (ambient noise); resuming listening`
        );
        this._beginListeningTurn();
      }
    }, recoveryWaitMs);
  }

  finishUserTurnNow() {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.listeningForUser && !this.wordTerminalActionLocked) {
      this.commitUserSpeechTurn('manual_done');
      return true;
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
    this.currentTurnUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.interruptedTutorPartialText = '';
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
    const pendingUser = this.currentTurnUserTranscript.trim();
    if (pendingUser) {
      const last = this.wordTurns[this.wordTurns.length - 1];
      if (!last || last.role !== 'user' || last.text !== pendingUser) {
        this.wordTurns.push({ role: 'user', text: pendingUser });
      }
      this.currentTurnUserTranscript = '';
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
              silenceDurationMs: 2200
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
              debugLogger.log('info', 'reconnect_resume_listening', 'Tutor turn was already complete; resuming user listening');
              this._beginListeningTurn('Reconnected — speak in Mandarin');
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

  _beginListeningTurn(customLabel = null) {
    if (!this.isActive || this.wordTerminalActionLocked) return;
    this.tutorTurnActive = false;
    this.listeningForUser = true;
    this.userSpokeInTurn = false;
    this.serverAckedCurrentUserTurn = false;
    this.consecutiveSpeechFrames = 0;
    this.sentAudioChunksInTurn = 0;
    this.currentTurnUserTranscript = '';
    this.lastCountdownText = '';
    this.postPlaybackCooldownUntil = performance.now() + 500;
    this._emitState(
      'listening',
      customLabel || 'Your turn — speak in Mandarin (auto-sends after pause)'
    );
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

    const turnsSnapshot = this.wordTurns.slice();
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
        // Server-side automatic VAD committed the user's turn before the 2.8s client silence backup!
        this.isPhase1InitialTurn = false;
        this.silentTurnRetries = 0;
        debugLogger.finalizeStreamingEntries('input_transcript');
        this.turnCommitPerfMs = performance.now();
        debugLogger.log('info', 'server_vad_turn_committed', 'Server VAD detected end of user speech', {
          userTranscript: this.currentTurnUserTranscript.trim()
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

      if (sc.inputTranscription && sc.inputTranscription.text) {
        const text = sc.inputTranscription.text;
        this.currentTurnUserTranscript += text;
        debugLogger.appendStream('info', 'input_transcript', text);
        this.onTranscript('user', text);
        if (this.listeningForUser) {
          this.userSpokeInTurn = true;
          this.lastVoiceActivityTime = performance.now();
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

        // Guard 1: Detect completely silent tutor turn (0 audio chunks or all-zero `AAA=` chunks, e.g. Word #3 `可能`)
        if (
          this.isActive &&
          !this.wordTerminalActionLocked &&
          audibleSec < 0.45 &&
          !(pendingCue && this.silentTurnRetries >= 1)
        ) {
          this.currentTurnTutorTranscript = '';
          this.onTranscript('discard_last_tutor', '');

          if (this.silentTurnRetries === 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
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

          if (this.silentTurnRetries === 1 && this.currentWord && this.lastLiveConfig) {
            this.silentTurnRetries = 2;
            debugLogger.log(
              'warn',
              'silent_tutor_turn_rotate_model',
              'Second consecutive silent turn on socket; rotating to fallback Live model',
              { failedModel: this.activeModelId }
            );
            this._closeRawSocketOnly();
            this._openSocketWithFallbacks(
              this.currentWord,
              this.lastLiveConfig,
              this.wordTurns.length > 0,
              1
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
        // (e.g. Word #2 `正常`: 2.96s audio & truncated at `請試著`, or Word #1 try 1: 3.04s missing English audio)
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
          const hasChineseInstructionEnd = /中文|說說看|怎麼說|翻譯/.test(completedTutorText);
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
    setTimeout(cb, Math.ceil(remainingSec * 1000) + 220);
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

  async destroyAll() {
    this.closeCurrentWordSocket();
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch (_) {}
      this.audioCtx = null;
    }
  }

  _computeMicLevel(float32Samples) {
    let sum = 0;
    for (let i = 0; i < float32Samples.length; i += 4) {
      const s = float32Samples[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (float32Samples.length / 4));
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
