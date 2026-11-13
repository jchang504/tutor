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
  VOICE_NAME: 'tw_tutor_voice_name'
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
      liveModel: 'models/gemini-3.8-live',
      fallbackLiveModel: 'models/gemini-3.1-flash-live-preview',
      voiceName: localStorage.getItem(STORAGE_KEYS.VOICE_NAME) || 'Aoede'
    };

    this.wakeLockSentinel = null;
    this.transcriptHistory = [];
    this.sessionScores = [];

    this.pipeline = new GeminiLiveVoicePipeline({
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
      btnSaveSettings: document.getElementById('btn-save-settings'),
      btnTestConnection: document.getElementById('btn-test-connection'),

      fileHanpingCsv: document.getElementById('file-hanping-csv'),
      textareaHanpingCsv: document.getElementById('textarea-hanping-csv'),
      btnUploadHanping: document.getElementById('btn-upload-hanping'),
      selectSupplementLevel: document.getElementById('select-supplement-level'),
      inputSupplementCount: document.getElementById('input-supplement-count'),
      btnPullTocfl: document.getElementById('btn-pull-tocfl'),
      importResultBox: document.getElementById('import-result-box'),

      toastContainer: document.getElementById('toast-container')
    };

    this.els.btnStartDriving.addEventListener('click', () => this.startDrivingSession());
    this.els.btnPauseResume.addEventListener('click', () => this.togglePauseSession());
    this.els.btnRepeatPrompt.addEventListener('click', () => {
      this.pipeline.sendTextCommand('請再清楚唸一次這題的英文句子。');
    });
    this.els.btnHint.addEventListener('click', () => {
      this.pipeline.sendTextCommand('請給我一點提示，但先不要直接講出整句答案。');
    });
    this.els.btnSkipWord.addEventListener('click', () => this.skipCurrentWord('manual_skip'));
    this.els.btnEndSession.addEventListener('click', () => this.stopDrivingSession());

    this.els.btnToggleReveal.addEventListener('click', () => {
      this.revealTarget = !this.revealTarget;
      localStorage.setItem(STORAGE_KEYS.REVEAL_TARGET, String(this.revealTarget));
      this.renderCurrentWordCard();
    });

    // Giant eyes-free tap zone on the main orb toggles Pause/Resume during active driving
    this.els.voiceOrb.addEventListener('click', () => {
      if (!this.sessionActive) {
        this.startDrivingSession();
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

    localStorage.setItem(STORAGE_KEYS.GAS_URL, gasUrl);
    localStorage.setItem(STORAGE_KEYS.SECRET, secret);
    localStorage.setItem(STORAGE_KEYS.DIRECT_API_KEY, directKey);
    localStorage.setItem(STORAGE_KEYS.BATCH_SIZE, batchSize);
    localStorage.setItem(STORAGE_KEYS.NEW_RATIO, newRatioPct);
    localStorage.setItem(STORAGE_KEYS.TOCFL_LEVEL, tocflLevel);
    localStorage.setItem(STORAGE_KEYS.VOICE_NAME, voiceName);

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
   * 2. Fetches a 20-word batch from Google Sheets (with `gemini-3.8-flash` pre-generated English sentences),
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

      this.handlePipelineState('connecting', `Generating ${batchSize} English sentences with Gemini 3.8 Flash...`);
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
   * File picker for AnkiDroid Plain Text (.txt) exports, Hanping local backups (.bak/.gz/.json), or CSV/TSV.
   */
  async handleFilePicked(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let text = '';

      // 1. Check for GZIP magic bytes (0x1f 0x8b) used by Hanping local backups (.bak / .gz)
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && 'DecompressionStream' in window) {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = new Blob([bytes]).stream().pipeThrough(ds);
        const decompressedBuf = await new Response(decompressedStream).arrayBuffer();
        text = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(decompressedBuf));
      } else {
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      }

      // 2. If the decoded content contains null bytes (e.g. a binary SQLite backup file),
      // extract clean printable lines / CJK + Pinyin segments
      if (text.includes('\u0000')) {
        text = this.extractVocabFromBinaryText(text);
      }

      this.els.textareaHanpingCsv.value = text;
      const lineCount = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      this.showToast(`Loaded ${file.name} (${lineCount} entries ready to import).`, 'info');
    } catch (err) {
      this.showToast(`Could not read ${file.name}: ${err.message}`, 'error');
    }
  }

  /**
   * Fallback extractor if a user selects a binary SQLite / Anki / Hanping backup file:
   * pulls out `\x1f`-delimited Anki note fields or CJK headwords.
   */
  extractVocabFromBinaryText(raw) {
    const outLines = [];
    // Anki SQLite `notes.flds` separates fields with ASCII Unit Separator (0x1f)
    if (raw.includes('\x1f')) {
      const chunks = raw.split(/[\x00-\x08\x0b-\x1e]+/);
      for (const chunk of chunks) {
        if (chunk.includes('\x1f') && /[\u4e00-\u9fff]/.test(chunk)) {
          const tabLine = chunk.replace(/\x1f/g, '\t').replace(/[^\x09\x20-\x7e\u00a0-\uffff]/g, '').trim();
          if (tabLine) outLines.push(tabLine);
        }
      }
      if (outLines.length > 0) return outLines.join('\n');
    }

    // Otherwise extract unique CJK vocabulary tokens
    const matches = raw.match(/[\u4e00-\u9fff]{1,8}/g) || [];
    const unique = [...new Set(matches)];
    return unique.join('\n');
  }

  async uploadHanpingCsv() {
    const csvText = this.els.textareaHanpingCsv.value.trim();
    if (!csvText) {
      this.showToast('Please select an AnkiDroid .txt export, Hanping backup, or paste rows first.', 'error');
      return;
    }
    try {
      this.els.btnUploadHanping.disabled = true;
      this.els.btnUploadHanping.textContent = 'Importing & Cross-Referencing TOCFL...';
      const res = await this.callBackend('import_hanping', { csvText });
      this.els.importResultBox.classList.remove('hidden');
      this.els.importResultBox.textContent =
        `Imported ${res.addedCount} new words into Google Sheet (${res.skippedDuplicate} existing duplicates preserved).`;
      this.showToast(`Added ${res.addedCount} words to Sheet!`, 'success');
      await this.refreshBackendStatus(false);
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      this.els.btnUploadHanping.disabled = false;
      this.els.btnUploadHanping.textContent = 'Import Vocab to Sheet';
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
