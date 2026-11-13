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
import { GeminiLiveVoicePipeline } from './live-audio.js';
import { SAMPLE_TAIWAN_BATCH } from './sample-vocab.js';

const STORAGE_KEYS = {
  GAS_URL: 'tw_tutor_gas_url',
  SECRET: 'tw_tutor_backend_secret',
  DIRECT_API_KEY: 'tw_tutor_direct_gemini_key',
  REVEAL_TARGET: 'tw_tutor_reveal_target',
  TOCFL_LEVEL: 'tw_tutor_tocfl_level',
  BATCH_SIZE: 'tw_tutor_batch_size',
  NEW_RATIO: 'tw_tutor_new_ratio',
  VOICE_NAME: 'tw_tutor_voice_name',
  MANDARIN_SPEED: 'tw_tutor_mandarin_speed'
};

class MandarinTutorApp {
  constructor() {
    this.batch = [];
    this.currentIndex = 0;
    this.sessionActive = false;
    this.sessionPaused = false;
    this.revealTarget = localStorage.getItem(STORAGE_KEYS.REVEAL_TARGET) === 'true';

    this.liveAuth = {
      apiKey: localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '',
      liveModel: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
      fallbackLiveModel: 'models/gemini-2.5-flash-native-audio-latest',
      voiceName: localStorage.getItem(STORAGE_KEYS.VOICE_NAME) || 'Aoede'
    };

    this.wakeLockSentinel = null;
    this.transcriptHistory = [];
    this.sessionScores = [];

    const savedMandarinSpeed = Number(localStorage.getItem(STORAGE_KEYS.MANDARIN_SPEED) || 0.68);
    this.pipeline = new GeminiLiveVoicePipeline({
      mandarinSpeed: savedMandarinSpeed,
      onStateChange: (state, statusText) => this.handlePipelineState(state, statusText),
      onTranscript: (role, text) => this.handleTranscript(role, text),
      onCompleteWord: (telemetry) => this.handleWordCompleted(telemetry),
      onSessionControl: (cmd) => this.handleVoiceControlCommand(cmd),
      onAudioLevel: (lvl) => this.updateAudioMeter(lvl),
      onError: (err) => this.showToast(err.message || String(err), 'error')
    });

    this.bindDom();
    this.loadSavedConfigIntoInputs();
    this.setupMediaSessionControls();
    this.setupWakeLockLifecycle();
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
      inputMandarinSpeed: document.getElementById('input-mandarin-speed'),
      btnSaveSettings: document.getElementById('btn-save-settings'),
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
      importResultBox: document.getElementById('import-result-box'),

      toastContainer: document.getElementById('toast-container')
    };

    this.rawAnkiFileText = '';

    this.els.btnStartDriving.addEventListener('click', () => this.startDrivingSession());
    if (this.els.btnDoneSpeaking) {
      this.els.btnDoneSpeaking.addEventListener('click', () => {
        this.pipeline.finishUserTurnNow();
      });
    }
    this.els.btnPauseResume.addEventListener('click', () => this.togglePauseSession());
    this.els.btnRepeatPrompt.addEventListener('click', () => {
      this.pipeline.sendTextCommand('請再用正常語速清楚唸一次這題的英文句子。', true);
    });
    this.els.btnHint.addEventListener('click', () => {
      this.pipeline.sendTextCommand('請用簡單、慢速的台灣中文給我一點提示，但先不要直接講出整句答案。');
    });
    this.els.btnSkipWord.addEventListener('click', () => this.skipCurrentWord('manual_skip'));
    this.els.btnEndSession.addEventListener('click', () => this.stopDrivingSession());

    this.els.btnToggleReveal.addEventListener('click', () => {
      this.revealTarget = !this.revealTarget;
      localStorage.setItem(STORAGE_KEYS.REVEAL_TARGET, String(this.revealTarget));
      this.renderCurrentWordCard();
    });

    // Giant eyes-free tap zone on the main orb:
    // - If waiting for user speech, tapping the orb immediately commits the user's turn ("Done Speaking")
    // - Otherwise starts or pauses/resumes the session
    this.els.voiceOrb.addEventListener('click', () => {
      if (!this.sessionActive) {
        this.startDrivingSession();
      } else if (!this.sessionPaused && this.pipeline.isWaitingForUser()) {
        this.pipeline.finishUserTurnNow();
      } else {
        this.togglePauseSession();
      }
    });

    this.els.btnOpenSettings.addEventListener('click', () => this.els.drawerSettings.classList.remove('hidden'));
    this.els.btnCloseSettings.addEventListener('click', () => this.els.drawerSettings.classList.add('hidden'));
    this.els.btnOpenImport.addEventListener('click', () => this.els.drawerImport.classList.remove('hidden'));
    this.els.btnCloseImport.addEventListener('click', () => this.els.drawerImport.classList.add('hidden'));

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
  }

  loadSavedConfigIntoInputs() {
    this.els.inputGasUrl.value = localStorage.getItem(STORAGE_KEYS.GAS_URL) || '';
    this.els.inputSecret.value = localStorage.getItem(STORAGE_KEYS.SECRET) || '';
    this.els.inputDirectKey.value = localStorage.getItem(STORAGE_KEYS.DIRECT_API_KEY) || '';
    this.els.inputBatchSize.value = localStorage.getItem(STORAGE_KEYS.BATCH_SIZE) || '20';
    this.els.inputNewRatio.value = localStorage.getItem(STORAGE_KEYS.NEW_RATIO) || '10';
    this.els.inputTocflLevel.value = localStorage.getItem(STORAGE_KEYS.TOCFL_LEVEL) || '2';
    this.els.inputVoiceName.value = localStorage.getItem(STORAGE_KEYS.VOICE_NAME) || 'Aoede';
    if (this.els.inputMandarinSpeed) {
      this.els.inputMandarinSpeed.value = localStorage.getItem(STORAGE_KEYS.MANDARIN_SPEED) || '0.68';
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
    const mandarinSpeed = this.els.inputMandarinSpeed
      ? this.els.inputMandarinSpeed.value.trim() || '0.68'
      : '0.68';

    localStorage.setItem(STORAGE_KEYS.GAS_URL, gasUrl);
    localStorage.setItem(STORAGE_KEYS.SECRET, secret);
    localStorage.setItem(STORAGE_KEYS.DIRECT_API_KEY, directKey);
    localStorage.setItem(STORAGE_KEYS.BATCH_SIZE, batchSize);
    localStorage.setItem(STORAGE_KEYS.NEW_RATIO, newRatioPct);
    localStorage.setItem(STORAGE_KEYS.TOCFL_LEVEL, tocflLevel);
    localStorage.setItem(STORAGE_KEYS.VOICE_NAME, voiceName);
    localStorage.setItem(STORAGE_KEYS.MANDARIN_SPEED, mandarinSpeed);

    this.pipeline.setMandarinSpeed(Number(mandarinSpeed));
    this.liveAuth.voiceName = voiceName;
    if (directKey) {
      this.liveAuth.apiKey = directKey;
    }

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
  async callBackend(action, payload = {}) {
    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    if (!gasUrl || !secret) {
      throw new Error('Google Sheet Web App URL or Secret is not configured yet.');
    }

    const body = Object.assign({}, payload, { action, secret });
    const response = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(body),
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Apps Script HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data.ok) {
      throw new Error(data.error || 'Apps Script backend error.');
    }
    return data;
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
      const res = await this.callBackend('ping');
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

      this.handlePipelineState('connecting', `Loading ${batchSize} words & simple everyday sentences...`);
      const res = await this.callBackend('get_batch', {
        batchSize,
        newWordRatio: newRatio,
        tocflLevel
      });

      this.batch = res.batch || [];
      if (res.liveAuth && res.liveAuth.apiKey) {
        this.liveAuth = Object.assign({}, this.liveAuth, res.liveAuth);
      }
      if (directKey) {
        this.liveAuth.apiKey = directKey;
      }

      // Ensure all English sentences in the batch are short, simple, everyday sentences
      // with beginner-level vocabulary matching the target word (even if Apps Script hasn't been redeployed yet)
      await this.ensureSimpleBatchPrompts();

      const sum = res.batchSummary || {};
      this.showToast(
        `Loaded ${sum.total || this.batch.length} words (${sum.dueReviews || 0} due, ${sum.newWords || 0} new)`,
        'success'
      );
    } else if (directKey) {
      this.liveAuth.apiKey = directKey;
      this.batch = SAMPLE_TAIWAN_BATCH.map((w) => Object.assign({}, w));
      this.showToast('Loaded 5 sample Taiwanese Mandarin words (Direct Key Mode).', 'info');
    } else {
      this.els.drawerSettings.classList.remove('hidden');
      throw new Error('Please configure your Google Apps Script URL + Secret (or a Gemini API Key) in Settings first.');
    }
  }

  /**
   * Ensures every word in `this.batch` has a short, simple, everyday English sentence (6-10 words max)
   * where all surrounding words are basic beginner/elementary vocabulary (TOCFL Level 1-2 / A1-A2)
   * matching the target word's level. Runs client-side via `gemini-2.5-flash` whenever any sentence in the
   * batch looks complex (>10 words or fallback template), so it works immediately even before redeploying Apps Script.
   */
  async ensureSimpleBatchPrompts() {
    if (!this.batch || this.batch.length === 0) return;
    const apiKey = (this.liveAuth && this.liveAuth.apiKey) || '';
    if (!apiKey) return;

    const needsSimplification = this.batch.some((w) => {
      const p = String(w.english_prompt || '').trim();
      const wordCount = p.split(/\s+/).filter(Boolean).length;
      return !p || wordCount > 10 || p.includes('Can you tell me where the');
    });

    if (!needsSimplification) return;

    try {
      this.handlePipelineState('connecting', 'Simplifying English sentences to everyday beginner level...');
      const items = this.batch.map((w, idx) => ({
        idx,
        traditional: w.traditional,
        pinyin: w.pinyin || '',
        english_gloss: w.english_gloss || '',
        tocfl_level: w.tocfl_level || 2
      }));

      const prompt = [
        'You are a Taiwanese Mandarin (繁體中文) curriculum designer creating speaking prompts for an English-speaking learner.',
        'For each target word below, write ONE short, simple, everyday English sentence (6 to 10 words maximum) that naturally requires the learner to use the target Mandarin word when translating.',
        'STRICT LEVEL & SIMPLICITY RULES:',
        '1. Keep the sentence VERY SIMPLE and conversational (6 to 10 English words max, single clause).',
        '2. Every other word in the sentence MUST be basic, everyday beginner/elementary vocabulary (CEFR A1-A2 / TOCFL Level 1-2, such as I, you, today, want, go, eat, buy, work, home, friend, very, etc.) at the SAME or SIMPLER level than the target word.',
        '3. NEVER use idioms, literary phrasing, complex clauses, or advanced surrounding vocabulary.',
        '4. Set the sentence in normal everyday life in Taiwan.',
        '5. Also provide `sample_mandarin` in Traditional Chinese using natural Taiwanese Mandarin (台灣日常口語) with equally simple everyday words.',
        'Return ONLY a JSON array of objects with keys: `idx` (number), `english_prompt` (string), `sample_mandarin` (string).',
        '',
        JSON.stringify(items)
      ].join('\n');

      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!resp.ok) return;
      const json = await resp.json();
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!rawText) return;

      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const target = this.batch[item.idx];
          if (target && item.english_prompt) {
            target.english_prompt = String(item.english_prompt).trim();
            if (item.sample_mandarin) {
              target.sample_mandarin = String(item.sample_mandarin).trim();
            }
          }
        }
      }
    } catch (err) {
      console.warn('Client-side prompt simplification skipped:', err);
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
    this.transcriptHistory = [];
    this.renderTranscriptFeed();
    this.setPhaseIndicator(1);
    this.renderCurrentWordCard();
    this.updateMediaSessionMetadata(word);

    await this.pipeline.startWordSession(word, this.liveAuth);
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
      this.els.targetWordBox.classList.remove('spoiler-masked');
      this.els.targetHanzi.textContent = word.traditional;
      this.els.targetPhonetics.textContent = [word.pinyin, word.zhuyin].filter(Boolean).join(' · ');
      this.els.targetGloss.textContent = word.english_gloss || '';
      this.els.btnToggleReveal.textContent = 'Hide Target Word';
    } else {
      this.els.targetWordBox.classList.add('spoiler-masked');
      this.els.targetHanzi.textContent = '•••';
      this.els.targetPhonetics.textContent = 'Hidden while translating (tap to peek)';
      this.els.targetGloss.textContent = word.english_gloss ? `Hint: ${word.english_gloss}` : '';
      this.els.btnToggleReveal.textContent = 'Peek Target Word';
    }
  }

  /**
   * Called deterministically when Gemini Live invokes `complete_word(...)` at the end of Phase 4.
   * 1. Reveals the target word briefly and computes the deterministic 1-4 score + FSRS v5 interval.
   * 2. Sends the review asynchronously to the Google Sheet (`record_review`).
   * 3. Advances to the next word in a brand-new WebSocket session!
   */
  async handleWordCompleted(telemetry = {}) {
    const word = this.batch[this.currentIndex];
    if (!word) return;

    this.pipeline.closeCurrentWordSocket();
    this.setPhaseIndicator(4);

    const score = computeDeterministicScore(telemetry);
    const fsrsPreview = computeFsrsV5(word, score, 0.90);

    // Show score banner
    this.els.lastScoreBanner.classList.remove('hidden');
    this.els.lastScoreBanner.innerHTML = `
      <strong>${word.traditional} (${word.pinyin})</strong> →
      <span class="score-pill score-${score}">${scoreLabel(score)}</span>
      <span class="next-due-note">Next review in ${fsrsPreview.intervalDays}d ${telemetry.notes ? '· ' + telemetry.notes : ''}</span>
    `;

    // Fire-and-forget write to Google Sheets so the transition to the next word is fast
    const gasUrl = (localStorage.getItem(STORAGE_KEYS.GAS_URL) || '').trim();
    const secret = (localStorage.getItem(STORAGE_KEYS.SECRET) || '').trim();
    if (gasUrl && secret) {
      this.callBackend('record_review', {
        word_id: word.id,
        traditional: word.traditional,
        english_prompt: word.english_prompt,
        telemetry
      })
        .then(() => this.refreshBackendStatus(false))
        .catch((err) => console.warn('Failed to persist review to Sheet:', err));
    }

    this.currentIndex += 1;
    setTimeout(() => {
      if (this.sessionActive && !this.sessionPaused) {
        this.launchCurrentWord();
      }
    }, 900);
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

  async skipCurrentWord(reason = 'skip') {
    this.pipeline.closeCurrentWordSocket();
    const word = this.batch[this.currentIndex];
    if (word) {
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
      this.els.btnPauseResume.textContent = 'Resume Driving';
      this.handlePipelineState('paused', 'Paused — Tap Orb or Steering Play to Resume');
    } else {
      this.els.btnPauseResume.textContent = 'Pause';
      this.launchCurrentWord();
    }
  }

  stopDrivingSession() {
    this.sessionActive = false;
    this.sessionPaused = false;
    this.pipeline.closeCurrentWordSocket();
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
    if (!text || !text.trim()) return;
    const cleaned = text.trim();

    // Heuristic phase progress indicator based on conversation turns
    if (role === 'tutor') {
      if (cleaned.includes('？') || cleaned.includes('?')) {
        this.setPhaseIndicator(2);
      }
      if (cleaned.includes('問我') || cleaned.includes('問題')) {
        this.setPhaseIndicator(3);
      }
    }

    const last = this.transcriptHistory[this.transcriptHistory.length - 1];
    if (last && last.role === role) {
      last.text += ' ' + cleaned;
    } else {
      this.transcriptHistory.push({ role, text: cleaned });
      if (this.transcriptHistory.length > 6) {
        this.transcriptHistory.shift();
      }
    }
    this.renderTranscriptFeed();
  }

  renderTranscriptFeed() {
    if (this.transcriptHistory.length === 0) {
      this.els.liveTranscriptFeed.innerHTML =
        '<p class="transcript-placeholder">Hands-free voice transcript will appear here...</p>';
      return;
    }
    this.els.liveTranscriptFeed.innerHTML = this.transcriptHistory
      .map((item) => {
        const tag = item.role === 'user' ? 'You' : 'Tutor';
        const cls = item.role === 'user' ? 'turn-user' : 'turn-tutor';
        return `<div class="transcript-turn ${cls}"><span class="turn-tag">${tag}</span><span class="turn-text">${this.escapeHtml(item.text)}</span></div>`;
      })
      .join('');
    this.els.liveTranscriptFeed.scrollTop = this.els.liveTranscriptFeed.scrollHeight;
  }

  setPhaseIndicator(stepNum) {
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
      }
    });
  }

  /**
   * MediaSession API so steering wheel Play/Pause/Next/Previous buttons control the tutor!
   */
  setupMediaSessionControls() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.setActionHandler('play', () => {
      if (this.sessionActive && this.sessionPaused) this.togglePauseSession(false);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (this.sessionActive && !this.sessionPaused) this.togglePauseSession(true);
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (this.sessionActive) this.skipCurrentWord('steering_wheel_next');
    });
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (this.sessionActive) {
        this.pipeline.sendTextCommand('請再清楚唸一次這題的英文句子。');
      }
    });
  }

  updateMediaSessionMetadata(word) {
    if (!('mediaSession' in navigator) || !word) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: word.english_prompt,
        artist: 'Mandarin Driving Tutor',
        album: `Word ${this.currentIndex + 1} of ${this.batch.length}`
      });
    } catch (_) {}
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
        const pinyin = (cols[2] || '').trim();
        const gloss = ((cols[4] || cols[3] || '').replace(/%27/gi, "'")).trim();
        const tagsStr = row.tags.join(' ');
        cleanLines.push([trad, simp, pinyin, gloss, tagsStr].join('\t'));
      } else {
        cleanLines.push(row.rawLine);
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
      this.els.btnUploadHanping.textContent = `Importing ${matchedCount} Notes & Cross-Referencing TOCFL...`;
      const res = await this.callBackend('import_hanping', {
        csvText,
        tagFilter,
        pruneNonMatching
      });
      this.els.importResultBox.classList.remove('hidden');
      const tagSummary = tagFilter ? ` with tag "${tagFilter}"` : '';
      const prunedSummary = res.prunedCount ? `, removed ${res.prunedCount} non-matching unstudied words` : '';
      this.els.importResultBox.textContent =
        `Matched ${matchedCount} notes${tagSummary} (out of ${totalCount} in file): ${res.addedCount} newly added to Sheet, ${res.skippedDuplicate} already in Sheet${prunedSummary}.`;
      this.showToast(
        `Synced ${matchedCount} notes${tagSummary} (${res.addedCount} new, ${res.skippedDuplicate} existing${prunedSummary})!`,
        'success'
      );
      await this.refreshBackendStatus(false);
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnUploadHanping.disabled = false;
      this.els.btnUploadHanping.textContent = 'Import Filtered Notes to Sheet';
    }
  }

  async pullTocflSupplemental() {
    const tocflLevel = Number(this.els.selectSupplementLevel.value || 2);
    const count = Number(this.els.inputSupplementCount.value || 30);
    try {
      this.els.btnPullTocfl.disabled = true;
      this.els.btnPullTocfl.textContent = `Pulling Level ${tocflLevel} from PSeitz/tocfl...`;
      const res = await this.callBackend('supplement_tocfl', { tocflLevel, count });
      this.els.importResultBox.classList.remove('hidden');
      this.els.importResultBox.textContent =
        `Added ${res.addedCount} highest-spoken-frequency TOCFL Level ${res.tocflLevel} words from PSeitz/tocfl (${res.remainingInLevel} remaining in level).`;
      this.showToast(`Added ${res.addedCount} TOCFL L${tocflLevel} words!`, 'success');
      await this.refreshBackendStatus(false);
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnPullTocfl.disabled = false;
      this.els.btnPullTocfl.textContent = 'Supplement from PSeitz/tocfl';
    }
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

window.addEventListener('DOMContentLoaded', () => {
  window.tutorApp = new MandarinTutorApp();
});
