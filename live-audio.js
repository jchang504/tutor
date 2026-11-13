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
    this.bufferSize = 2048;
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

export function buildWordSystemInstruction(word) {
  const synonymsLine = word.common_synonyms
    ? `常見近義詞（若學生誤用請溫柔引導換成目標詞，不要扣分）：${word.common_synonyms}`
    : '若學生使用了其他合法的近義詞，請肯定他的句子，並提示他換成我們今天要練習的目標詞，不要直接唸出目標詞的發音，也不扣分。';

  return `你是一位專業、親切、有耐心的台灣華語（Taiwanese Mandarin）口語家教。學生正在開車或閉眼進行全免持（hands-free & eyes-free）口說練習。

【語言與口音鐵則】
1. 除了朗讀指定的「英文造句題目（English Prompt）」之外，你全程必須 100% 使用自然的台灣華語（繁體中文、台灣慣用詞彙與台灣聲調發音，例如說「聲調、四聲、三聲、餐廳、計程車、公車、腳踏車、早上/晚上」）與學生對話。絕對不要說英文解釋！
2. 每次回應請保持簡潔、自然、口語化（約 1～3 句話），適合開車聆聽。

【本題目標詞彙（內部資訊，在學生成功說出前請勿直接洩漏讀音）】
- 目標詞（繁體）：${word.traditional}
- 拼音 / 注音：${word.pinyin || ''} ${word.zhuyin ? '(' + word.zhuyin + ')' : ''}
- 英文詞義：${word.english_gloss || ''}
- 指定英文題目（English Prompt）："${word.english_prompt}"
- 參考台灣華語翻譯：${word.sample_mandarin || ''}
- ${synonymsLine}

【四階段對話練習流程（請嚴格按順序執行）】
- **階段一（出題與翻譯糾正）**：
  1. 對話一開始，請直接清楚朗讀一次英文題目："${word.english_prompt}"，接著用台灣華語簡短說：「請試著翻成中文。」（千萬不要在開頭把目標詞「${word.traditional}」唸出來！）
  2. 仔細聽學生的中文翻譯：
     - 若學生用了近義詞而非「${word.traditional}」：稱讚句子通順，並提示他換成目標詞（不要直接唸出目標詞讀音，且不計入發音錯誤）。
     - 若學生的「${word.traditional}」或句子其他部分有**聲調錯誤、發音不準、或語法不自然**：請用台灣華語明確指出哪個字幾聲或哪裡語法要調整，示範正確唸法，並請學生**重新完整說一次正確的中文句子**。
     - 若學生問任何旁支問題（例如詞義、語法差異、怎麼說某個詞）：請用台灣華語清楚回答，然後引導他回到這句話的練習。
     - 若學生主動要求「提示 / Hint」或「直接給我答案」：請給他提示或示範正確句子（並在最後紀錄 \`needed_hint: true\`），但仍請他跟著唸出完整正確的句子一次。
  3. 持續互動直到學生親口完整說出包含「${word.traditional}」且發音與語法正確的句子為止。

- **階段二（老師延伸提問）**：
  當學生成功說出正確句子後，先簡短肯定他（例如：「說得很自然！」），並立刻根據這句話的情境，用台灣華語問他一個自然的**延伸問題（follow-up question）**，就像真實聊天一樣延續話題。

- **階段三（學生回答＋反問老師）**：
  1. 學生會用中文回答你的問題，並且應該要**順便反問你一個相關的問題**。
  2. 如果學生的回答有明顯語法或發音錯誤，請簡短幫他修正。
  3. **關鍵檢查**：如果學生只有回答你的問題，卻忘記反問你問題，請用台灣華語溫柔提醒他：「那你也問我一個相關的問題吧！」並等待他提問。

- **階段四（老師回答並自動進入下一題）**：
  當學生提出他的問題後，請用台灣華語自然、簡短地回答他的問題，說聲「好，我們看下一題！」，並在同一個回合立刻呼叫工具函式 \`complete_word\` 記錄本詞彙的表現數據。

【免持語音控制指令】
如果學生隨時用中文或英文說：
- 「跳過 / 下一題 / Skip / Next word」 -> 簡短回應「好，跳過這題」並立刻呼叫 \`session_control(action="skip")\`
- 「這題怪怪的 / 標記問題卡片 / Flag card」 -> 呼叫 \`session_control(action="flag_bad_card")\`
- 「再說一次英文 / Repeat the English sentence」 -> 重新清楚唸一次英文題目："${word.english_prompt}"
- 「暫停 / Pause」 -> 呼叫 \`session_control(action="pause")\`
- 「結束練習 / 停止 / End session」 -> 呼叫 \`session_control(action="end_session")\``;
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

    this.nextPlayTime = 0;
    this.activeSources = new Set();
    this.pendingActionAfterPlayback = null;
  }

  /**
   * Initializes the persistent WebAudio context and microphone stream once when the user taps "Start Driving Session".
   * Keeping the AudioContext + MediaStream alive across word WebSocket resets ensures Chrome on Pixel 9
   * never re-prompts for mic permission or drops Bluetooth SCO audio between words!
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
        this._computeMicLevel(float32Samples);
        const pcm16Base64 = this._downsampleAndEncodePcm16(
          float32Samples,
          this.audioCtx.sampleRate,
          16000
        );
        this.ws.send(
          JSON.stringify({
            realtimeInput: {
              mediaChunks: [
                {
                  mimeType: 'audio/pcm;rate=16000',
                  data: pcm16Base64
                }
              ]
            }
          })
        );
      };

      source.connect(this.workletNode);
      // Connect worklet to a zero-gain node into destination so Chrome Android keeps the audio graph active
      const silentGain = this.audioCtx.createGain();
      silentGain.gain.value = 0;
      this.workletNode.connect(silentGain);
      silentGain.connect(this.audioCtx.destination);
    }
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
   * Automatically tries fallback Live model IDs if the primary model closes on setup.
   */
  async startWordSession(word, liveConfig = {}) {
    this.closeCurrentWordSocket();
    this.pendingActionAfterPlayback = null;
    this.isActive = true;

    const apiKey = liveConfig.apiKey;
    if (!apiKey) {
      throw new Error('Missing Gemini API key.');
    }

    const candidateModels = [
      liveConfig.liveModel || 'models/gemini-3.8-live',
      liveConfig.fallbackLiveModel || 'models/gemini-3.1-flash-live-preview',
      'models/gemini-2.5-flash-native-audio-preview-12-2025',
      'models/gemini-2.5-flash-native-audio-latest'
    ].filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    const voiceName = liveConfig.voiceName || 'Aoede';

    let lastErr = null;
    for (let i = 0; i < candidateModels.length; i++) {
      const modelId = candidateModels[i].startsWith('models/')
        ? candidateModels[i]
        : `models/${candidateModels[i]}`;
      try {
        await this._connectSingleModelSocket(word, apiKey, modelId, voiceName);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`Live model ${modelId} failed during setup, trying next fallback:`, err);
      }
    }
    throw lastErr || new Error('Unable to establish Gemini Live WebSocket connection.');
  }

  _connectSingleModelSocket(word, apiKey, modelId, voiceName) {
    return new Promise((resolve, reject) => {
      let setupCompleted = false;
      const wsUrl = `${LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      this.onStateChange('connecting', `Connecting (${modelId.replace('models/', '')})...`);

      const setupTimeout = setTimeout(() => {
        if (!setupCompleted) {
          try { ws.close(); } catch (_) {}
          reject(new Error(`Timeout waiting for setupComplete on ${modelId}`));
        }
      }, 8500);

      ws.onopen = () => {
        const setupPayload = {
          setup: {
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
              parts: [{ text: buildWordSystemInstruction(word) }]
            },
            tools: TUTOR_TOOLS_DECLARATION,
            inputAudioTranscription: {},
            outputAudioTranscription: {}
          }
        };
        ws.send(JSON.stringify(setupPayload));
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
            this.playChime('start');
            this.onStateChange('listening', 'Tutor starting word...');
            // Kick off Phase 1 immediately so the tutor speaks the English sentence right away
            ws.send(
              JSON.stringify({
                clientContent: {
                  turns: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text: `請開始第一階段：先清楚唸出這題的英文句子 "${word.english_prompt}"，然後用台灣華語請我翻譯（請勿先把目標詞「${word.traditional}」說出來）。`
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
        if (!setupCompleted) {
          reject(new Error(`WebSocket closed (${ev.code}: ${ev.reason || 'setup rejected'}) on ${modelId}`));
          return;
        }
        if (this.isActive && !this.pendingActionAfterPlayback) {
          this.onStateChange('disconnected', `Connection closed (${ev.code})`);
        }
      };
    });
  }

  _handleServerMessage(msg, ws) {
    // 1. Handle Server Content (Audio chunks, interruption, transcripts)
    if (msg.serverContent) {
      const sc = msg.serverContent;

      if (sc.interrupted) {
        this.stopPlaybackImmediately();
        this.onStateChange('listening', 'Listening...');
      }

      if (sc.inputTranscription && sc.inputTranscription.text) {
        this.onTranscript('user', sc.inputTranscription.text);
      }
      if (sc.outputTranscription && sc.outputTranscription.text) {
        this.onTranscript('tutor', sc.outputTranscription.text);
      }

      if (sc.modelTurn && Array.isArray(sc.modelTurn.parts)) {
        for (const part of sc.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            this.onStateChange('speaking', 'Tutor speaking...');
            this._enqueuePcm24kAudio(part.inlineData.data);
          }
          if (part.text) {
            this.onTranscript('tutor_thought', part.text);
          }
        }
      }

      if (sc.turnComplete) {
        // When tutor finishes a turn and no more audio is playing, switch state to listening
        this._schedulePostPlaybackCallback(() => {
          if (this.pendingActionAfterPlayback) {
            const fn = this.pendingActionAfterPlayback;
            this.pendingActionAfterPlayback = null;
            fn();
          } else if (this.isActive) {
            this.onStateChange('listening', 'Your turn — speak in Mandarin');
          }
        });
      }
    }

    // 2. Handle Tool Calls (`complete_word` or `session_control`)
    if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
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
   * Sends a text nudge into the active Live session (e.g., if the user taps "Repeat English" or "Hint").
   */
  sendTextCommand(text) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true
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

    const audioBuffer = this.audioCtx.createBuffer(1, samples, 24000);
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

  closeCurrentWordSocket() {
    this.isActive = false;
    this.stopPlaybackImmediately();
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
  }

  _downsampleAndEncodePcm16(buffer, inputRate, outputRate) {
    let samples = buffer;
    if (inputRate !== outputRate) {
      const ratio = inputRate / outputRate;
      const newLength = Math.round(buffer.length / ratio);
      samples = new Float32Array(newLength);
      for (let i = 0; i < newLength; i++) {
        const idx = Math.min(buffer.length - 1, Math.floor(i * ratio));
        samples[i] = buffer[idx];
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
