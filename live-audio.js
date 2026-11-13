/**
 * Gemini Live WebSocket + WebAudio PCM 16kHz/24kHz Streaming Engine
 *
 * Key architectural guarantees:
 * 1. Opens a FRESH WebSocket connection per vocabulary word so the context window
 *    never accumulates multi-word audio history, eliminating context degradation and
 *    staying well under Free Tier / AI Pro 65k TPM limits.
 * 2. Streams 16kHz 16-bit mono PCM from the Pixel 9 / car Bluetooth microphone
 *    via an inline Blob AudioWorkletProcessor, gated strictly during tutor speech,
 *    turn commits, and tool calls so leaked mic frames never cause `1007` disconnects.
 * 3. Plays 24kHz 16-bit mono PCM audio chunks from Gemini Live seamlessly.
 * 4. Handles terminal tools (`complete_word` and `session_control`) deterministically:
 *    once the tutor's farewell audio is queued and `complete_word` is emitted, closes
 *    the WebSocket immediately without sending a redundant `toolResponse` (preventing
 *    post-tool generation/thinking loops and `1007` errors) while letting WebAudio
 *    finish playing naturally before advancing to the next word.
 * 5. Records structured protocol, VAD, tool-call, WebSocket close reason, and hidden
 *    model-thought traces into `debugLogger` (`localStorage`) for 1-tap Gemini debugging.
 */

import { debugLogger } from './debug-logger.js?v=12';

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
  const referenceMandarin = (word.mandarin_sentence || word.sample_mandarin || '').trim();
  const synonymsLine = word.common_synonyms
    ? `常見近義詞（若學生誤用請溫柔引導換成目標詞，不要扣分）：${word.common_synonyms}`
    : '若學生使用了其他合法的近義詞，請肯定他的句子，並提示他換成我們今天要練習的目標詞，不要直接唸出目標詞的發音，也不扣分。';

  let resumeSection = '';
  if (Array.isArray(priorTurns) && priorTurns.length > 0) {
    const formattedTurns = priorTurns
      .map((t) => `${t.role === 'tutor' ? '老師' : '學生'}：${t.text}`)
      .join('\n');
    resumeSection = `\n\n【本題目前已完成的對話紀錄（剛才網路短暫重連，請直接從最後一句自然接續，絕對不要重頭出題或重複已經說過的話！）】\n${formattedTurns}\n請根據上述對話進度直接接續目前的練習階段，若學生已反問問題則簡短回答一句並呼叫一次 \`complete_word\`。`;
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
     - 若學生主動要求「提示 / Hint」或「直接給我答案」：可給他提示或直接示範「${referenceMandarin}」（並在最後紀錄 \`needed_hint: true\`），但仍請他跟著親口唸出完整正確的句子一次。
  3. 持續互動直到學生親口完整說出包含「${word.traditional}」且語法自然、發音正確的句子為止。

- **階段二（老師延伸提問）**：
  當學生成功說出正確自然的句子後，先簡短肯定他（例如：「說得很好！」），並立刻根據這句話的情境，用**簡單、自然慢速的台灣華語**問他一個簡短的日常**延伸問題（follow-up question）**（使用基礎詞彙，6～12 個字以內）。

- **階段三（學生回答＋反問老師）**：
  1. 學生會用中文回答你的問題，並且應該要**順便反問你一個相關的問題**。
  2. 如果學生的回答有明顯語法或發音錯誤，請簡短幫他修正。
  3. **關鍵檢查**：如果學生只有回答你的問題，卻忘記反問你問題，請溫柔提醒他：「很好！那你也問我一個問題吧！」並等待他提問。

- **階段四（老師簡短回答並立刻結束本題）**：
  當學生提出他的問題後，請不要過度思考或重複說話——請先用簡單、自然慢速的台灣華語**簡短回答他的問題（1 句短句即可）**，接著說聲「好，我們看下一題！」，**在把話講完的最後立刻呼叫一次工具函式 \`complete_word\`**。呼叫 \`complete_word\` 後本題連線就會立刻結束，請絕對不要重複回答或再次呼叫工具。

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
          '在完成四階段練習、且老師已經用口語回答完學生的反問並說出「好，我們看下一題！」之後，於該回合最後呼叫一次此函式以紀錄學生的表現並切換到下一個單字（呼叫後本題即結束，請勿重複呼叫或繼續說話）。',
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
    this.activeModelId = null;
    this.isMuted = false;
    this.isActive = false;
    this.intentionalClose = false;
    this.wordTerminalActionLocked = false;

    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.pendingActionAfterPlayback = null;
    this.terminalFallbackTimer = null;

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
    this.noReplyRecoveryTimer = null;
    this.reconnectTimer = null;
    this.postPlaybackCooldownUntil = 0;

    // Diagnostics & timing per turn
    this.turnCommitPerfMs = 0;
    this.sentAudioChunksInTurn = 0;
    this.turnAudioChunks = 0;
    this.turnAudioSec = 0;

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

  /**
   * Hybrid VAD per Google's Gemini Live specification:
   * - Server-side `automaticActivityDetection` (`prefixPaddingMs: 300, silenceDurationMs: 2200`) handles primary
   *   speech-start lookback and natural 2.2s end-of-turn detection.
   * - Client-side VAD gates out mic frames while the tutor speaks, during post-playback echo cooldown, or once a
   *   terminal tool call (`complete_word`) is locked — closing the audio leakage gap that causes `1007` disconnects.
   */
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
      // Stream live 100ms PCM frames continuously so server `prefixPaddingMs` captures the very first syllable
      this._sendAudioChunk(pcm16Base64);

      if (rms >= speechStartThreshold) {
        this.consecutiveSpeechFrames += 1;
        // Require 300ms (3 x 100ms frames) of sustained voice energy so brief clicks/breaths don't false-trigger
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
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.listeningForUser ||
      this.wordTerminalActionLocked
    ) {
      return;
    }
    this.hasUnflushedAudio = true;
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

  /**
   * Commits the user's spoken Mandarin turn using protocol-clean `realtimeInput.audioStreamEnd`.
   * - Uses an 8.5s recovery window when speech was detected (and cancels immediately if ANY server
   *   thought, transcription, audio chunk, or tool call arrives) so it NEVER fires mid-thinking!
   */
  commitUserSpeechTurn(reason = 'auto_silence') {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.tutorTurnActive || this.wordTerminalActionLocked) return;

    const hadUserSpeech = this.userSpokeInTurn;
    const chunksSent = this.sentAudioChunksInTurn;
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

  /**
   * Allows the user to manually finish their speaking turn immediately (e.g. tapping "Done Speaking" or the Orb).
   */
  finishUserTurnNow() {
    if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    if (this.listeningForUser && !this.wordTerminalActionLocked) {
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
  async startWordSession(word, liveConfig = {}, wordNumberLabel = '') {
    this.closeCurrentWordSocket();
    this.pendingActionAfterPlayback = null;
    this.wordTerminalActionLocked = false;
    this.isActive = true;
    this.intentionalClose = false;
    this.currentWord = word;
    this.lastLiveConfig = Object.assign({}, liveConfig);
    this.wordTurns = [];
    this.currentTurnUserTranscript = '';
    this.currentTurnTutorTranscript = '';
    this.serverAckedCurrentUserTurn = false;
    this.sentAudioChunksInTurn = 0;
    this.turnAudioChunks = 0;
    this.turnAudioSec = 0;
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
   * Manually or automatically reconnects the active word session without losing conversation progress.
   */
  async reconnectCurrentWord() {
    if (!this.currentWord || !this.lastLiveConfig) return;
    this._commitPendingUserTranscriptToTurns();
    this._commitPendingTutorTranscriptToTurns();
    this._closeRawSocketOnly();
    this.isActive = true;
    this.intentionalClose = false;
    this.wordTerminalActionLocked = false;
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    debugLogger.log('info', 'manual_reconnect', 'User triggered manual reconnect for current word', {
      wordTurnsCount: this.wordTurns.length
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

  _commitPendingTutorTranscriptToTurns() {
    const pendingTutor = this.currentTurnTutorTranscript.trim();
    if (pendingTutor) {
      const last = this.wordTurns[this.wordTurns.length - 1];
      if (!last || last.role !== 'tutor' || last.text !== pendingTutor) {
        this.wordTurns.push({ role: 'tutor', text: pendingTutor });
      }
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

    // Preserve BOTH user and partial tutor transcripts so reconnecting never repeats an already-spoken answer!
    this._commitPendingUserTranscriptToTurns();
    this._commitPendingTutorTranscriptToTurns();

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
    const delayMs = this.reconnectAttempts === 1 ? 500 : this.reconnectAttempts === 2 ? 1200 : 2200;

    // If a specific model failed mid-word with 1007/1008/1011, rotate model candidates on attempt >= 2
    const modelRotationOffset =
      (closeCode === 1007 || closeCode === 1008 || closeCode === 1011) && this.reconnectAttempts >= 2
        ? this.reconnectAttempts - 1
        : 0;

    debugLogger.log(
      'warn',
      'auto_reconnect_scheduled',
      `Scheduling reconnect ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delayMs}ms`,
      {
        closeCode,
        closeReason,
        modelRotationOffset,
        wordTurnsCount: this.wordTurns.length
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

    // Apply optional rotation offset when recovering from a model-specific 1007/1011 error
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
        // Retry same model once with minimal setup config in case a preview model rejects extended VAD/thinking/compression fields
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

  _connectSingleModelSocket(word, apiKey, modelId, voiceName, useExtendedConfig = true, isReconnect = false) {
    return new Promise((resolve, reject) => {
      this._closeRawSocketOnly();
      let setupCompleted = false;
      const connectStartMs = performance.now();
      this.hasUnflushedAudio = false;
      this.turnAudioChunks = 0;
      this.turnAudioSec = 0;

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

        // Disable unconstrained dynamic thinking on Gemini 2.5 Native Audio models so Phase 4
        // tool calls (`complete_word`) never spiral into multi-paragraph internal reasoning loops!
        // (Omitted on 3.1/3.8 Live models per Google's docs, where minimal/interleaved reasoning is default.)
        if (useExtendedConfig && modelId.includes('2.5')) {
          generationConfig.thinkingConfig = {
            thinkingBudget: 0
          };
        }

        const setupObj = {
          model: modelId,
          generationConfig,
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

        debugLogger.log('ws', 'ws_setup_sent', `Sent BidiGenerateContentSetup`, {
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

            if (isReconnect && lastTurn && lastTurn.role === 'tutor') {
              // The tutor already spoke before the blip — resume listening directly without repeating tutor speech!
              this._beginListeningTurn('Reconnected — speak in Mandarin');
              resolve();
              return;
            }

            if (isReconnect && lastTurn && lastTurn.role === 'user') {
              // The user had just spoken before the blip — use universal `realtimeInput.text` (never `clientContent`)
              this.tutorTurnActive = true;
              this.listeningForUser = false;
              this.turnCommitPerfMs = performance.now();
              this._emitState('speaking', 'Tutor responding...');
              const resumePrompt = `剛才語音連線短暫重連。我最後說的是：「${lastTurn.text}」。請不要重新唸英文題目，也不要重複說過的話，直接根據系統提示中的對話紀錄接續回應我！`;
              debugLogger.log('ws', 'realtime_text_sent', 'Sent reconnect continuation prompt', {
                lastUserText: lastTurn.text
              });
              ws.send(
                JSON.stringify({
                  realtimeInput: {
                    text: resumePrompt
                  }
                })
              );
              resolve();
              return;
            }

            // Fresh word start: kick off Phase 1 using universal `realtimeInput.text`
            // (compatible with Gemini 2.5 Native Audio, 3.1 Flash Live, and 3.8 Live without clientContent 1007 issues)
            if (!isReconnect) {
              this.playChime('start');
            }
            this.tutorTurnActive = true;
            this.listeningForUser = false;
            this.turnCommitPerfMs = performance.now();
            this._emitState('speaking', 'Tutor reading English prompt...');

            const kickoffText = `請開始第一階段：先用正常語速清楚唸出這題的英文句子 "${word.english_prompt}"，接著用對華語學習者說話的自然慢速台灣華語（語調自然連貫，不要刻意在詞與詞之間停頓）請我把這句話翻成中文（千萬不要先把目標詞「${word.traditional}」說出來）。`;
            debugLogger.log('ws', 'realtime_text_sent', 'Sent Phase 1 kick-off prompt');
            ws.send(
              JSON.stringify({
                realtimeInput: {
                  text: kickoffText
                }
              })
            );
            resolve();
            return;
          }

          this._handleServerMessage(msg, ws);
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

        // If `complete_word` or `session_control` was already locked in, any socket close is benign:
        // just let any queued farewell audio finish playing and fire the completion callback!
        if (this.wordTerminalActionLocked || this.intentionalClose || !this.isActive) {
          debugLogger.log('ws', 'ws_close_clean', `WebSocket closed cleanly (${code})`, {
            code,
            reason,
            wasClean,
            wordTerminalActionLocked: this.wordTerminalActionLocked
          });
          if (this.pendingActionAfterPlayback) {
            const fn = this.pendingActionAfterPlayback;
            this.pendingActionAfterPlayback = null;
            this._schedulePostPlaybackCallback(fn);
          }
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
            turnAudioChunks: this.turnAudioChunks
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

  _handleServerMessage(msg, ws) {
    // 0. Proactive GoAway handling before periodic server disconnect
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

    // 1. Handle Server Content (Audio chunks, interruption, spoken transcripts, and hidden model thoughts)
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

      // Only show `outputTranscription.text` (the actual audio spoken to the user) in the UI transcript feed,
      // while also logging it to `debugLogger`!
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.serverAckedCurrentUserTurn = true;
        if (this.noReplyRecoveryTimer) {
          clearTimeout(this.noReplyRecoveryTimer);
          this.noReplyRecoveryTimer = null;
        }
        const spokenText = sc.outputTranscription.text;
        this.currentTurnTutorTranscript += spokenText;
        debugLogger.appendStream('info', 'output_transcript', spokenText);
        this.onTranscript('tutor', spokenText);
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        this.serverAckedCurrentUserTurn = true;
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
          // Capture internal model thoughts (`part.thought` or non-audio `part.text`) STRICTLY in debug logs
          // so we can diagnose any reasoning/loop behavior without polluting the user's transcript UI!
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
            const dur = this._enqueuePcm24kAudio(part.inlineData.data);
            this.turnAudioChunks += 1;
            this.turnAudioSec += dur;
          }
        }
      }

      if (sc.turnComplete) {
        debugLogger.finalizeStreamingEntries();
        const completedTutorText = this.currentTurnTutorTranscript.trim();
        debugLogger.log('info', 'tutor_turn_complete', 'Server signaled turnComplete', {
          audioChunks: this.turnAudioChunks,
          audioSec: Number(this.turnAudioSec.toFixed(2)),
          spokenChars: completedTutorText.length
        });

        this.turnAudioChunks = 0;
        this.turnAudioSec = 0;

        if (completedTutorText) {
          this.wordTurns.push({ role: 'tutor', text: completedTutorText });
          this.currentTurnTutorTranscript = '';
        }
        // Reset auto-reconnect counter once a healthy model turn completes
        this.reconnectAttempts = 0;

        this.onTranscript('turn_end', '');

        if (this.pendingActionAfterPlayback) {
          if (this.terminalFallbackTimer) {
            clearTimeout(this.terminalFallbackTimer);
            this.terminalFallbackTimer = null;
          }
          const fn = this.pendingActionAfterPlayback;
          this.pendingActionAfterPlayback = null;
          // Close the WebSocket now that the final spoken turn is complete; WebAudio keeps playing buffered farewell!
          this.intentionalClose = true;
          this._closeRawSocketOnly();
          this._schedulePostPlaybackCallback(fn);
        } else {
          this._schedulePostPlaybackCallback(() => {
            if (this.isActive && !this.wordTerminalActionLocked) {
              this._beginListeningTurn();
            }
          });
        }
      }
    }

    // 2. Handle Terminal Tool Calls (`complete_word` or `session_control`)
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
      this.serverAckedCurrentUserTurn = true;
      if (this.noReplyRecoveryTimer) {
        clearTimeout(this.noReplyRecoveryTimer);
        this.noReplyRecoveryTimer = null;
      }
      debugLogger.finalizeStreamingEntries();

      if (this.wordTerminalActionLocked) {
        debugLogger.log(
          'warn',
          'tool_call_duplicate_ignored',
          'Ignored duplicate toolCall after word terminal action was already locked',
          { functionCalls: msg.toolCall.functionCalls.map((f) => f.name) }
        );
        return;
      }

      for (const fc of msg.toolCall.functionCalls) {
        const args = fc.args || {};
        debugLogger.log('tool', 'tool_call_received', `Received toolCall: ${fc.name}`, {
          id: fc.id || null,
          name: fc.name,
          args
        });

        if (fc.name === 'complete_word' || fc.name === 'session_control') {
          this.wordTerminalActionLocked = true;
          this.intentionalClose = true;
          this.listeningForUser = false;
          this.tutorTurnActive = true;

          let callbackFired = false;
          const runTerminalOnce = () => {
            if (callbackFired) return;
            callbackFired = true;
            if (this.terminalFallbackTimer) {
              clearTimeout(this.terminalFallbackTimer);
              this.terminalFallbackTimer = null;
            }
            this.pendingActionAfterPlayback = null;
            if (fc.name === 'complete_word') {
              this.playChime('complete');
              this.onCompleteWord(args);
            } else {
              this.playChime('skip');
              this.onSessionControl(args);
            }
          };

          const hasSpokenInTurn =
            this.currentTurnTutorTranscript.trim().length > 0 ||
            this.turnAudioChunks > 0 ||
            this.isTutorPlayingAudio();

          if (hasSpokenInTurn || fc.name === 'session_control') {
            // CRITICAL FIX: The tutor already streamed its farewell audio into `this.audioCtx`!
            // Do NOT send `toolResponse` (which triggers a brand-new post-tool generation turn,
            // causing the model to repeat itself or crash with 1007 while farewell audio plays).
            // Instead, close the WebSocket immediately while letting WebAudio finish playback!
            this._commitPendingTutorTranscriptToTurns();
            this.onTranscript('turn_end', '');
            const remainSec = Number(this._getRemainingPlaybackSec().toFixed(2));
            debugLogger.log(
              'tool',
              'tool_terminal_socket_closed',
              `Closed WebSocket on ${fc.name} without toolResponse (playing ${remainSec}s buffered farewell)`,
              { name: fc.name, remainingAudioSec: remainSec }
            );
            this._closeRawSocketOnly();
            this._schedulePostPlaybackCallback(runTerminalOnce);
          } else {
            // Rare edge case: model invoked `complete_word` BEFORE speaking its Phase 4 answer.
            // Send exactly one clean `toolResponse` so it can speak 1 short sentence, then close on `turnComplete`.
            this.pendingActionAfterPlayback = runTerminalOnce;
            const fnResp = {
              name: fc.name,
              response: {
                result: {
                  ok: true,
                  instruction:
                    '已記錄分數。請用一句簡短台灣華語回答學生的問題並說「好，我們看下一題！」，講完即停止，請勿再次呼叫 complete_word。'
                }
              }
            };
            if (fc.id !== undefined && fc.id !== null) {
              fnResp.id = fc.id;
            }

            debugLogger.log(
              'tool',
              'tool_response_sent',
              'Model called complete_word before speaking; sent single toolResponse for short farewell',
              { id: fc.id || null }
            );

            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(
                  JSON.stringify({
                    toolResponse: {
                      functionResponses: [fnResp]
                    }
                  })
                );
              } catch (_) {}
            }

            // Safety fallback so even if the model sends no follow-up turnComplete, we still advance cleanly
            this.terminalFallbackTimer = setTimeout(() => {
              this.terminalFallbackTimer = null;
              debugLogger.log(
                'warn',
                'tool_terminal_fallback_timer',
                'Advancing word via 8s post-tool safety timer'
              );
              this._closeRawSocketOnly();
              this._schedulePostPlaybackCallback(runTerminalOnce);
            }, 8000);
          }
          return;
        }
      }
    }
  }

  /**
   * Sends a text command into the active Live session (e.g., if the user taps "Repeat" or "Hint")
   * using `realtimeInput.text` (after flushing any open mic stream) so it never collides with `realtimeInput.audio`.
   */
  sendTextCommand(text) {
    if (this.wordTerminalActionLocked) return;
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
    debugLogger.log('ws', 'realtime_text_sent', `User button command: ${text}`);
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          text
        }
      })
    );
  }

  _enqueuePcm24kAudio(base64Data) {
    if (!this.audioCtx) return 0;
    const binary = atob(base64Data);
    const byteLen = binary.length;
    const samples = byteLen >> 1;
    if (samples === 0) return 0;

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

    return audioBuffer.duration;
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
    if (this.terminalFallbackTimer) {
      clearTimeout(this.terminalFallbackTimer);
      this.terminalFallbackTimer = null;
    }
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
