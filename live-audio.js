/**
 * Gemini Live WebSocket + WebAudio PCM 16kHz/24kHz Streaming Engine
 *
 * Key architectural guarantees:
 * 1. Opens a FRESH WebSocket connection per vocabulary word so the context window
 *    never accumulates multi-word audio history, eliminating context degradation and
 *    staying well under Free Tier / AI Pro 65k TPM limits.
 * 2. Streams 16kHz 16-bit mono PCM from the Pixel 9 / car Bluetooth microphone
 *    via an inline Blob AudioWorkletProcessor.
 * 3. Plays 24kHz 16-bit mono PCM audio chunks from Gemini Live seamlessly with
 *    instant barge-in cancellation when the user interrupts.
 * 4. Exposes deterministic tools (`complete_word` and `session_control`) and waits
 *    for the model's final spoken audio buffer to finish playing before advancing
 *    to the next word.
 */

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

export function buildWordSystemInstruction(word, priorTurns = []) {
  const synonymsLine = word.common_synonyms
    ? `常見近義詞（若學生誤用請溫柔引導換成目標詞，不要扣分）：${word.common_synonyms}`
    : '若學生使用了其他合法的近義詞，請肯定他的句子，並提示他換成我們今天要練習的目標詞，不要直接唸出目標詞的發音，也不扣分。';

  let resumeSection = '';
  if (Array.isArray(priorTurns) && priorTurns.length > 0) {
    const formattedTurns = priorTurns
      .map((t) => `${t.role === 'tutor' ? '老師' : '學生'}：${t.text}`)
      .join('\n');
    resumeSection = `\n\n【本題目前已完成的對話紀錄（剛才網路短暫重連，請直接從最後一句自然接續，絕對不要重頭出題！）】\n${formattedTurns}\n請根據上述對話進度直接接續目前的練習階段，完成剩餘步驟後呼叫 \`complete_word\`。`;
  }

  return `你是一位專業、親切、有耐心的台灣華語（Taiwanese Mandarin）口語家教。學生正在進行全免持（hands-free）口說練習。

【語速與難度原則（極重要）】
1. **中文請用對學習者說話的自然慢速**：當你說台灣華語（中文）時，請放慢語速，就像面對華語學習者說話一樣，發音清楚、語調自然流暢。請保持正常的句子連貫感，不要刻意一字一頓或在詞與詞之間做不自然的停頓。
2. **英文題目保持正常語速**：朗讀指定的「英文造句題目（English Prompt）」時，請維持正常的自然英文語速。
3. **全程使用與目標詞同等級的簡單日常詞彙**：你對學生說的所有中文回饋與延伸問題，請使用簡單、日常的基礎生活詞彙（TOCFL 1～2 級初級詞彙），句子簡短自然（每次 1～2 句短句），避免艱深詞彙、成語或複雜長句。
4. 除了朗讀指定的「英文造句題目（English Prompt）」之外，全程請 100% 使用自然的台灣華語（繁體中文、台灣日常用語，例如「聲調、四聲、三聲、餐廳、計程車、公車、早上/晚上」）與學生對話，不要用英文解釋。

【本題目標詞彙（內部資訊，在學生成功說出前請勿直接洩漏讀音）】
- 目標詞（繁體）：${word.traditional}
- 拼音 / 注音：${word.pinyin || ''} ${word.zhuyin ? '(' + word.zhuyin + ')' : ''}
- 英文詞義：${word.english_gloss || ''}
- 指定英文題目（English Prompt）："${word.english_prompt}"
- 參考台灣華語翻譯：${word.sample_mandarin || ''}
- ${synonymsLine}

【四階段對話練習流程（請嚴格按順序執行）】
- **階段一（出題與翻譯糾正）**：
  1. 對話一開始，請直接朗讀預先準備好的英文題目："${word.english_prompt}"，接著用對學習者說話的自然慢速台灣華語簡短說：「請試著把這句話翻成中文。」（千萬不要在開頭把目標詞「${word.traditional}」唸出來！）
  2. 仔細聽學生的中文翻譯：
     - 若學生用了近義詞而非「${word.traditional}」：稱讚句子通順，並溫柔提示他換成目標詞（不要直接唸出目標詞讀音，且不計入發音錯誤）。
     - 若學生的「${word.traditional}」或句子其他部分有**聲調錯誤、發音不準、或語法不自然**：請用自然慢速的台灣華語明確指出哪個字幾聲或哪裡語法要調整，清楚示範正確唸法，並請學生**重新完整說一次正確的中文句子**。
     - 若學生問任何旁支問題：請用簡單慢速的台灣華語清楚回答，然後引導他回到這句話的練習。
     - 若學生主動要求「提示 / Hint」或「直接給我答案」：請給他提示或示範正確句子（並在最後紀錄 \`needed_hint: true\`），但仍請他跟著唸出完整正確的句子一次。
  3. 持續互動直到學生親口完整說出包含「${word.traditional}」且發音與語法正確的句子為止。

- **階段二（老師延伸提問）**：
  當學生成功說出正確句子後，先簡短肯定他（例如：「說得很好！」），並立刻根據這句話的情境，用**簡單、自然慢速的台灣華語**問他一個簡短的日常**延伸問題（follow-up question）**（使用基礎詞彙，6～12 個字以內）。

- **階段三（學生回答＋反問老師）**：
  1. 學生會用中文回答你的問題，並且應該要**順便反問你一個相關的問題**。
  2. 如果學生的回答有明顯語法或發音錯誤，請簡短幫他修正。
  3. **關鍵檢查**：如果學生只有回答你的問題，卻忘記反問你問題，請溫柔提醒他：「很好！那你也問我一個問題吧！」並等待他提問。

- **階段四（老師回答並自動進入下一題）**：
  當學生提出他的問題後，請用簡單、自然慢速的台灣華語簡短回答他的問題，說聲「好，我們看下一題！」，並在同一個回合立刻呼叫工具函式 \`complete_word\` 記錄本詞彙的表現數據。

【免持語音控制指令】
如果學生隨時用中文或英文說：
- 「跳過 / 下一題 / Skip / Next word」 -> 簡短回應「好，跳過這題」並立刻呼叫 \`session_control(action="skip")\`
- 「這題怪怪的 / 標記問題卡片 / Flag card」 -> 呼叫 \`session_control(action="flag_bad_card")\`
- 「再說一次英文 / Repeat the English sentence」 -> 重新清楚唸一次英文題目："${word.english_prompt}"
- 「暫停 / Pause」 -> 呼叫 \`session_control(action="pause")\`
- 「結束練習 / 停止 / End session」 -> 呼叫 \`session_control(action="end_session")\`${resumeSection}`;
}

export const TUTOR_TOOLS_DECLARATION = [
  {
    functionDeclarations: [
      {
        name: 'complete_word',
        description:
          '在完成四階段練習（1.學生說出正確翻譯句 -> 2.老師問延伸問題 -> 3.學生回答並反問老師 -> 4.老師回答學生的問題）後呼叫此函式，紀錄學生的表現以計算 FSRS 間隔重複分數，並自動切換到下一個單字。',
        parameters: {
          type: 'OBJECT',
          properties: {
            target_word_recalled: {
              type: 'BOOLEAN',
              description: '學生是否在沒有直接偷看答案的情況下想出目標詞彙（若只是一開始猜到同義詞再換回來，仍視為 true）。'
            },
            needed_hint: {
              type: 'BOOLEAN',
              description: '學生是否明確要求提示（hint）或要求老師直接給出目標詞讀音才能完成。'
            },
            pronunciation_attempts: {
              type: 'INTEGER',
              description: '學生在階段一嘗試說出正確發音/聲調的次數（一次就唸對填 1）。'
            },
            grammar_errors: {
              type: 'INTEGER',
              description: '學生在翻譯或延伸對話中發生的語法錯誤次數（沒有錯誤填 0）。'
            },
            conversation_fluency: {
              type: 'STRING',
              enum: ['natural', 'good', 'struggled'],
              description: '學生在階段一至階段三整體的口語流暢度（natural=非常自然流暢, good=良好但有小修正, struggled=明顯卡頓吃力）。'
            },
            notes: {
              type: 'STRING',
              description: '簡短繁體中文備註：紀錄學生哪個字聲調或語法需要注意（例如：「餐館的三聲變調很準」或「需要注意量詞家/間」）。'
            }
          },
          required: [
            'target_word_recalled',
            'needed_hint',
            'pronunciation_attempts',
            'grammar_errors',
            'conversation_fluency'
          ]
        }
      },
      {
        name: 'session_control',
        description:
          '當學生口頭要求跳過單字（skip）、標記問題卡片（flag_bad_card）、暫停練習（pause）或結束練習（end_session）時呼叫。',
        parameters: {
          type: 'OBJECT',
          properties: {
            action: {
              type: 'STRING',
              enum: ['skip', 'flag_bad_card', 'pause', 'end_session'],
              description: '要執行的控制動作。'
            },
            reason: {
              type: 'STRING',
              description: '簡短原因說明。'
            }
          },
          required: ['action']
        }
      }
    ]
  }
];

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
    this.isMuted = false;
    this.isActive = false;
    this.intentionalClose = false;

    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.pendingActionAfterPlayback = null;

    // Hybrid VAD (Server automaticActivityDetection + Client 2.8s silence backup)
    this.silenceWaitMs = 2800;
    this.listeningForUser = false;
    this.tutorTurnActive = false;
    this.userSpokeInTurn = false;
    this.hasUnflushedAudio = false;
    this.consecutiveSpeechFrames = 0;
    this.lastVoiceActivityTime = 0;
    this.lastCountdownText = '';
    this.noiseFloor = 0.005;
    this.currentTurnUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.noReplyRecoveryTimer = null;
    this.reconnectTimer = null;
    this.postPlaybackCooldownUntil = 0;

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
    this.onStateChange(state, statusText);
  }

  isDisconnected() {
    return this.connectionState === 'disconnected';
  }

  isTutorPlayingAudio() {
    if (!this.audioCtx) return false;
    return this.activeSources.size > 0 || this.audioCtx.currentTime < this.nextPlayTime - 0.02;
  }

  isWaitingForUser() {
    return this.isActive && this.listeningForUser && !this.tutorTurnActive;
  }

  /**
   * Initializes the persistent WebAudio context and microphone stream once when the user taps "Start Driving Session".
   */
  async initAudioHardware() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: 24000 });
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

  /**
   * Hybrid VAD per Google's Gemini Live specification:
   * - Server-side `automaticActivityDetection` (`prefixPaddingMs: 300, silenceDurationMs: 2200`) handles primary
   *   speech-start lookback and natural 2.2s end-of-turn detection.
   * - Client-side VAD gates out mic frames while the tutor speaks (+ 500ms speaker reverb cooldown) and sends
   *   a single `{ realtimeInput: { audioStreamEnd: true } }` at 2.8s of silence if noisy car audio kept server VAD open.
   * - Never mixes `clientContent` on top of `realtimeInput` (which previously caused WebSocket close code `1007`).
   */
  _processMicFrameWithVad(float32Samples, rms) {
    const now = performance.now();

    // Gate mic input while the tutor is speaking or during the 500ms post-playback speaker echo cooldown
    if (this.tutorTurnActive || this.isTutorPlayingAudio() || now < this.postPlaybackCooldownUntil) {
      return;
    }

    if (!this.listeningForUser) {
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
      // Stream live 100ms PCM frames continuously so server `prefixPaddingMs` captures the very first syllable
      this._sendAudioChunk(pcm16Base64);

      if (rms >= speechStartThreshold) {
        this.consecutiveSpeechFrames += 1;
        // Require 300ms (3 x 100ms frames) of sustained voice energy so brief clicks/breaths don't false-trigger
        if (this.consecutiveSpeechFrames >= 3) {
          this.userSpokeInTurn = true;
          this.lastVoiceActivityTime = now;
          this.lastCountdownText = '';
          this._emitState('listening', 'Hearing your Mandarin... (auto-sends after pause)');
        }
      } else {
        this.consecutiveSpeechFrames = 0;
        this.noiseFloor = 0.93 * this.noiseFloor + 0.07 * rms;
      }
      return;
    }

    // User has started speaking in this turn
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.hasUnflushedAudio = true;
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
    } catch (_) {}
  }

  /**
   * Commits the user's spoken Mandarin turn using protocol-clean `realtimeInput.audioStreamEnd`.
   * If 4.0s pass with no server reply:
   * - If Mandarin speech was transcribed (`currentTurnUserTranscript`), sends a safe `realtimeInput.text` cue
   *   (never `clientContent`, avoiding 1007 role-alternation errors).
   * - If no speech was transcribed (ambient noise spike), quietly re-opens listening!
   */
  commitUserSpeechTurn(reason = 'auto_silence') {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.tutorTurnActive) return;

    this.listeningForUser = false;
    this.userSpokeInTurn = false;
    this.consecutiveSpeechFrames = 0;
    this.lastCountdownText = '';

    this._emitState('connecting', 'Processing your Mandarin...');
    this._flushAudioStreamEnd();

    if (this.noReplyRecoveryTimer) {
      clearTimeout(this.noReplyRecoveryTimer);
    }
    const capturedTranscript = this.currentTurnUserTranscript.trim();
    this.noReplyRecoveryTimer = setTimeout(() => {
      this.noReplyRecoveryTimer = null;
      if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.tutorTurnActive || this.isTutorPlayingAudio()) return;

      if (capturedTranscript) {
        // Safe realtimeInput.text nudge (stays within realtimeInput stream — never triggers 1007!)
        try {
          this.ws.send(
            JSON.stringify({
              realtimeInput: {
                text: `（學生剛才回答：「${capturedTranscript}」，請依練習流程用自然慢速台灣華語回應。）`
              }
            })
          );
        } catch (_) {}
      } else {
        // False noise trigger with zero transcribed speech — smoothly resume listening
        this._beginListeningTurn();
      }
    }, 4000);
  }

  /**
   * Allows the user to manually finish their speaking turn immediately (e.g. tapping "Done Speaking" or the Orb).
   */
  finishUserTurnNow() {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.listeningForUser) {
      this.commitUserSpeechTurn('manual_done');
      return true;
    }
    return false;
  }

  /**
   * Plays a subtle, eyes-free earcon chime when starting a word, scoring a word, or pausing.
   */
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
  async startWordSession(word, liveConfig = {}) {
    this.closeCurrentWordSocket();
    this.pendingActionAfterPlayback = null;
    this.isActive = true;
    this.intentionalClose = false;
    this.currentWord = word;
    this.lastLiveConfig = Object.assign({}, liveConfig);
    this.wordTurns = [];
    this.currentTurnUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.reconnectAttempts = 0;
    this.isReconnecting = false;

    await this._openSocketWithFallbacks(word, this.lastLiveConfig, false);
  }

  /**
   * Manually or automatically reconnects the active word session without losing conversation progress.
   */
  async reconnectCurrentWord() {
    if (!this.currentWord || !this.lastLiveConfig) return;
    this._commitPendingUserTranscriptToTurns();
    this._closeRawSocketOnly();
    this.isActive = true;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    await this._openSocketWithFallbacks(this.currentWord, this.lastLiveConfig, true);
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

  async _attemptAutoReconnect(closeCode) {
    if (!this.isActive || this.intentionalClose || this.pendingActionAfterPlayback || this.isReconnecting) {
      return;
    }
    if (!this.currentWord || !this.lastLiveConfig) {
      this._emitState('disconnected', `Connection closed (${closeCode})`);
      return;
    }

    this._commitPendingUserTranscriptToTurns();
    this.currentTurnTutorTranscript = '';

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._emitState('disconnected', `Connection lost (${closeCode}) — Tap Orb to retry`);
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts += 1;
    const delayMs = this.reconnectAttempts === 1 ? 450 : this.reconnectAttempts === 2 ? 1100 : 2200;
    this._emitState(
      'connecting',
      `Reconnecting voice (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isActive || this.intentionalClose || this.pendingActionAfterPlayback) {
        this.isReconnecting = false;
        return;
      }
      try {
        await this._openSocketWithFallbacks(this.currentWord, this.lastLiveConfig, true);
        this.isReconnecting = false;
      } catch (err) {
        this.isReconnecting = false;
        console.warn('Auto-reconnect attempt failed:', err);
        this._attemptAutoReconnect(closeCode);
      }
    }, delayMs);
  }

  async _openSocketWithFallbacks(word, liveConfig, isReconnect = false) {
    const apiKey = liveConfig.apiKey;
    if (!apiKey) {
      throw new Error('Missing Gemini API key.');
    }

    const candidateModels = [
      'models/gemini-2.5-flash-native-audio-preview-12-2025',
      'models/gemini-2.5-flash-native-audio-latest',
      liveConfig.liveModel,
      liveConfig.fallbackLiveModel
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

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
        // Retry same model once with minimal setup config in case a preview model rejects extended VAD/compression fields
        try {
          await this._connectSingleModelSocket(word, apiKey, modelId, voiceName, false, isReconnect);
          return;
        } catch (errMin) {
          lastErr = errMin;
          console.warn(`Live model ${modelId} failed during setup, trying next fallback:`, errMin);
        }
      }
    }
    throw lastErr || new Error('Unable to establish Gemini Live WebSocket connection.');
  }

  _connectSingleModelSocket(word, apiKey, modelId, voiceName, useExtendedConfig = true, isReconnect = false) {
    return new Promise((resolve, reject) => {
      this._closeRawSocketOnly();
      let setupCompleted = false;
      this.hasUnflushedAudio = false;
      const wsUrl = `${LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      if (!isReconnect) {
        this._emitState('connecting', `Connecting (${modelId.replace('models/', '')})...`);
      }

      const setupTimeout = setTimeout(() => {
        if (!setupCompleted) {
          try { ws.close(); } catch (_) {}
          reject(new Error(`Timeout waiting for setupComplete on ${modelId}`));
        }
      }, 8500);

      ws.onopen = () => {
        const setupObj = {
          model: modelId,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voiceName
                }
              }
            }
          },
          systemInstruction: {
            parts: [{ text: buildWordSystemInstruction(word, isReconnect ? this.wordTurns : []) }]
          },
          tools: TUTOR_TOOLS_DECLARATION,
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

            const lastTurn = this.wordTurns.length > 0 ? this.wordTurns[this.wordTurns.length - 1] : null;

            if (isReconnect && lastTurn && lastTurn.role === 'tutor') {
              // The tutor already finished speaking before the blip — seamlessly resume listening for the user!
              this._beginListeningTurn('Reconnected — speak in Mandarin');
              resolve();
              return;
            }

            if (isReconnect && lastTurn && lastTurn.role === 'user') {
              // The user had just spoken before the blip — prompt the tutor to respond directly without restarting Phase 1
              this.tutorTurnActive = true;
              this.listeningForUser = false;
              this._emitState('speaking', 'Tutor responding...');
              ws.send(
                JSON.stringify({
                  clientContent: {
                    turns: [
                      {
                        role: 'user',
                        parts: [
                          {
                            text: `剛才語音連線短暫重連。我最後說的是：「${lastTurn.text}」。請不要重新唸英文題目，直接根據系統提示中的對話紀錄接續回應我！`
                          }
                        ]
                      }
                    ],
                    turnComplete: true
                  }
                })
              );
              resolve();
              return;
            }

            // Fresh word start (or reconnect before Phase 1 completed): kick off Phase 1
            if (!isReconnect) {
              this.playChime('start');
            }
            this.tutorTurnActive = true;
            this.listeningForUser = false;
            this._emitState('speaking', 'Tutor reading English prompt...');

            ws.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text: `請開始第一階段：先用正常語速清楚唸出這題的英文句子 "${word.english_prompt}"，接著用對華語學習者說話的自然慢速台灣華語（語調自然連貫，不要刻意在詞與詞之間停頓）請我把這句話翻成中文（千萬不要先把目標詞「${word.traditional}」說出來）。`
                        }
                      ]
                    }
                  ],
                  turnComplete: true
                }
              })
            );
            resolve();
            return;
          }

          this._handleServerMessage(msg, ws);
        } catch (parseErr) {
          console.error('Error parsing Live WebSocket frame:', parseErr);
        }
      };

      ws.onerror = () => {
        if (!setupCompleted) {
          clearTimeout(setupTimeout);
          reject(new Error(`WebSocket error on ${modelId}`));
        }
      };

      ws.onclose = (ev) => {
        clearTimeout(setupTimeout);
        if (this.ws === ws) {
          this.ws = null;
        }
        if (!setupCompleted) {
          reject(new Error(`WebSocket closed (${ev.code}: ${ev.reason || 'setup rejected'}) on ${modelId}`));
          return;
        }
        if (this.isActive && !this.pendingActionAfterPlayback && !this.intentionalClose) {
          this._attemptAutoReconnect(ev.code);
        }
      };
    });
  }

  _beginListeningTurn(customLabel = null) {
    if (!this.isActive) return;
    this.tutorTurnActive = false;
    this.listeningForUser = true;
    this.userSpokeInTurn = false;
    this.consecutiveSpeechFrames = 0;
    this.currentTurnUserTranscript = '';
    this.lastCountdownText = '';
    this.postPlaybackCooldownUntil = performance.now() + 500;
    this._emitState(
      'listening',
      customLabel || 'Your turn — speak in Mandarin (auto-sends after pause)'
    );
  }

  _handleServerMessage(msg, ws) {
    // 0. Proactive GoAway handling before periodic server disconnect
    if (msg.goAway && this.isActive && !this.pendingActionAfterPlayback && !this.intentionalClose) {
      this._schedulePostPlaybackCallback(() => {
        if (this.isActive && !this.pendingActionAfterPlayback && !this.intentionalClose) {
          this._attemptAutoReconnect('goAway');
        }
      });
    }

    // 1. Handle Server Content (Audio chunks, interruption, spoken transcripts)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.interrupted) {
        if (this.userSpokeInTurn) {
          this.stopPlaybackImmediately();
          this._beginListeningTurn();
        }
      }

      if (sc.inputTranscription && sc.inputTranscription.text) {
        const text = sc.inputTranscription.text;
        this.currentTurnUserTranscript += text;
        this.onTranscript('user', text);
        if (this.listeningForUser) {
          this.userSpokeInTurn = true;
          this.lastVoiceActivityTime = performance.now();
        }
      }

      // Only show `outputTranscription.text` (the actual audio spoken to the user),
      // never internal `modelTurn.parts[].text` / `part.thought` reasoning traces!
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.currentTurnTutorTranscript += sc.outputTranscription.text;
        this.onTranscript('tutor', sc.outputTranscription.text);
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        if (this.noReplyRecoveryTimer) {
          clearTimeout(this.noReplyRecoveryTimer);
          this.noReplyRecoveryTimer = null;
        }
        if (!this.tutorTurnActive) {
          this._commitPendingUserTranscriptToTurns();
          this.tutorTurnActive = true;
          this.listeningForUser = false;
          this.hasUnflushedAudio = false;
        }

        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            this._emitState('speaking', 'Tutor speaking...');
            this._enqueuePcm24kAudio(part.inlineData.data);
          }
        }
      }

      if (sc.turnComplete) {
        const completedTutorText = this.currentTurnTutorTranscript.trim();
        if (completedTutorText) {
          this.wordTurns.push({ role: 'tutor', text: completedTutorText });
          this.currentTurnTutorTranscript = '';
        }
        // Reset auto-reconnect counter once a healthy model turn completes
        this.reconnectAttempts = 0;

        this.onTranscript('turn_end', '');
        this._schedulePostPlaybackCallback(() => {
          if (this.pendingActionAfterPlayback) {
            const fn = this.pendingActionAfterPlayback;
            this.pendingActionAfterPlayback = null;
            fn();
          } else if (this.isActive) {
            this._beginListeningTurn();
          }
        });
      }
    }

    // 2. Handle Tool Calls (`complete_word` or `session_control`)
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      if (this.noReplyRecoveryTimer) {
        clearTimeout(this.noReplyRecoveryTimer);
        this.noReplyRecoveryTimer = null;
      }
      const responses = [];
      for (const fc of msg.toolCall.functionCalls) {
        const args = fc.args || {};
        responses.push({
          id: fc.id,
          name: fc.name,
          response: { result: { ok: true } }
        });

        if (fc.name === 'complete_word') {
          this.pendingActionAfterPlayback = () => {
            this.playChime('complete');
            this.onCompleteWord(args);
          };
          this._schedulePostPlaybackCallback(() => {
            if (this.pendingActionAfterPlayback) {
              const fn = this.pendingActionAfterPlayback;
              this.pendingActionAfterPlayback = null;
              fn();
            }
          });
        } else if (fc.name === 'session_control') {
          this.pendingActionAfterPlayback = () => {
            this.playChime('skip');
            this.onSessionControl(args);
          };
          this._schedulePostPlaybackCallback(() => {
            if (this.pendingActionAfterPlayback) {
              const fn = this.pendingActionAfterPlayback;
              this.pendingActionAfterPlayback = null;
              fn();
            }
          });
        }
      }

      if (ws.readyState === WebSocket.OPEN && responses.length > 0) {
        ws.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: responses
            }
          })
        );
      }
    }
  }

  /**
   * Sends a text command into the active Live session (e.g., if the user taps "Repeat" or "Hint")
   * using `realtimeInput.text` (after flushing any open mic stream) so it never collides with `realtimeInput.audio`.
   */
  sendTextCommand(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.isDisconnected() && this.currentWord) {
        this.reconnectCurrentWord().catch(() => {});
      }
      return;
    }
    this._flushAudioStreamEnd();
    this.listeningForUser = false;
    this.tutorTurnActive = true;
    this._emitState('connecting', 'Requesting from tutor...');
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          text
        }
      })
    );
  }

  _enqueuePcm24kAudio(base64Data) {
    if (!this.audioCtx) return;
    const binary = atob(base64Data);
    const byteLen = binary.length;
    const samples = byteLen >> 1;
    if (samples === 0) return;

    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      let int16 = (hi << 8) | lo;
      if (int16 >= 0x8000) int16 -= 0x10000;
      float32[i] = int16 / 32768.0;
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
      try { src.stop(); } catch (_) {}
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
      try { await this.audioCtx.close(); } catch (_) {}
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
      // Anti-aliased averaging filter for crisp 16kHz Mandarin consonants and tones
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
