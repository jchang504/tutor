/**
 * Persistent Structured Debug Logger for Mandarin Driving Tutor (`debug-logger.js`)
 *
 * Designed for hands-free mobile debugging on Pixel 9 without needing USB `chrome://inspect`:
 * - Persists a 400-event ring buffer of structured speech, cellular/network, audio routing,
 *   utterance replay, steering/button control, and WebSocket events in `localStorage`.
 * - Tracks live Android Chrome `navigator.connection` (cellular 4G/5G RTT, downlink Mbps,
 *   online/offline drops) and app visibility transitions for in-car diagnostics.
 * - Strictly redacts API keys, backend secrets, and private Apps Script URLs.
 * - Coalesces streaming transcript & model-thought deltas and formats a compact, truncation-proof
 *   Markdown diagnostic bundle (`<18KB`) for 1-tap sharing with Gemini.
 */

export const APP_VERSION = 'v26';
const LOG_STORAGE_KEY = 'tw_tutor_debug_logs_v1';
const MAX_LOG_ENTRIES = 400;
const MAX_STREAM_TEXT_LEN = 1600;
const MAX_THOUGHT_TEXT_LEN = 420;

export function redactSecrets(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]')
      .replace(/AIza[0-9A-Za-z\-_]{16,}/g, 'AIza[REDACTED]')
      .replace(
        /https:\/\/script\.google\.com\/macros\/s\/[^/\s"']+\/exec/gi,
        'https://script.google.com/macros/s/[REDACTED]/exec'
      );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(apiKey|secret|backend_secret|token|authorization)$/i.test(k)) {
        out[k] = v ? '[REDACTED]' : '';
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Captures a compact snapshot of the browser's current network / cellular radio state
 * (`navigator.onLine` + Android Chrome `NetworkInformation` API).
 */
export function getNetworkSnapshot() {
  if (typeof navigator === 'undefined') {
    return { online: true };
  }
  const snap = {
    online: navigator.onLine !== false
  };
  const conn =
    navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  if (conn) {
    if (conn.type && conn.type !== 'unknown') snap.type = conn.type;
    if (conn.effectiveType) snap.eff = conn.effectiveType;
    if (typeof conn.rtt === 'number' && conn.rtt >= 0) snap.rttMs = conn.rtt;
    if (typeof conn.downlink === 'number' && conn.downlink >= 0) {
      snap.dlMbps = Number(conn.downlink.toFixed(2));
    }
  }
  return snap;
}

export function formatNetworkSummary(snap = getNetworkSnapshot()) {
  if (!snap || snap.online === false) return 'OFFLINE';
  const parts = ['online'];
  if (snap.type) parts.push(snap.type);
  const details = [];
  if (snap.eff) details.push(snap.eff);
  if (typeof snap.rttMs === 'number') details.push(`rtt=${snap.rttMs}ms`);
  if (typeof snap.dlMbps === 'number') details.push(`dl=${snap.dlMbps}Mbps`);
  return details.length > 0 ? `${parts.join(' · ')} (${details.join(', ')})` : parts.join(' · ');
}

function shortModelTag(model = '') {
  const clean = String(model || '').replace(/^models\//, '');
  if (!clean) return '';
  if (clean === 'gemini-2.5-flash-native-audio-preview-12-2025') return '2.5-native-1225';
  if (clean === 'gemini-2.5-flash-native-audio-latest') return '2.5-native-latest';
  if (clean === 'gemini-3.1-flash-live-preview') return '3.1-flash-live';
  if (clean === 'gemini-3.8-live') return '3.8-live';
  return clean.replace(/^gemini-/, '');
}

class DebugLogger {
  constructor() {
    this.bootPerfMs = typeof performance !== 'undefined' ? performance.now() : 0;
    this.entries = [];
    this.seq = 0;
    this.context = {
      wordLabel: null,
      wordPrompt: null,
      model: null,
      phase: null,
      connectionState: 'idle',
      audioSummary: null
    };
    this.hasUnreadIssue = false;
    this.issueCount = 0;
    this.flushTimer = null;
    this.listeners = new Set();

    this._offlineSincePerfMs = null;
    this._hiddenSincePerfMs = null;
    this._lastNetSig = '';
    this._lastNetLogPerfMs = -10000;

    this._loadFromStorage();
    this._installGlobalHandlers();
  }

  _nowPerfMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  _loadFromStorage() {
    try {
      const raw = localStorage.getItem(LOG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.slice(-MAX_LOG_ENTRIES);
        for (const e of this.entries) {
          if (typeof e.seq === 'number' && e.seq > this.seq) {
            this.seq = e.seq;
          }
          if (e.level === 'error' || e.event === 'ws_close_unexpected') {
            this.issueCount += 1;
          }
        }
      }
    } catch (_) {
      this.entries = [];
    }
  }

  _saveToStorageImmediate() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const trimmed = this.entries.slice(-MAX_LOG_ENTRIES);
      this.entries = trimmed;
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (_) {
      // If quota exceeded, keep most recent half
      try {
        this.entries = this.entries.slice(-Math.floor(MAX_LOG_ENTRIES / 2));
        localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(this.entries));
      } catch (__) {}
    }
  }

  _scheduleSave(urgent = false) {
    if (urgent) {
      this._saveToStorageImmediate();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this._saveToStorageImmediate();
    }, 450);
  }

  _installGlobalHandlers() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    window.addEventListener('error', (ev) => {
      this.log('error', 'window_error', ev.message || 'Uncaught window error', {
        filename: ev.filename || '',
        lineno: ev.lineno || 0,
        colno: ev.colno || 0
      });
    });

    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason;
      const msg =
        reason && reason.message ? reason.message : String(reason || 'Unhandled rejection');
      this.log('error', 'unhandled_rejection', msg);
    });

    window.addEventListener('offline', () => {
      this._offlineSincePerfMs = this._nowPerfMs();
      this.log('warn', 'network_offline', 'Device lost internet connectivity', getNetworkSnapshot());
    });

    window.addEventListener('online', () => {
      const offlineMs =
        this._offlineSincePerfMs !== null
          ? Math.round(this._nowPerfMs() - this._offlineSincePerfMs)
          : null;
      this._offlineSincePerfMs = null;
      this.log('info', 'network_online', `Device regained internet${offlineMs !== null ? ` after ${offlineMs}ms` : ''}`, {
        ...(offlineMs !== null ? { offlineMs } : {}),
        ...getNetworkSnapshot()
      });
    });

    if (typeof navigator !== 'undefined') {
      const conn =
        navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
      if (conn && typeof conn.addEventListener === 'function') {
        const initSnap = getNetworkSnapshot();
        const initDegraded =
          (typeof initSnap.rttMs === 'number' && initSnap.rttMs >= 450) ||
          (typeof initSnap.dlMbps === 'number' && initSnap.dlMbps > 0 && initSnap.dlMbps < 0.8) ||
          initSnap.eff === '2g' ||
          initSnap.eff === 'slow-2g';
        this._lastNetSig = `${initSnap.type || ''}:${initSnap.eff || ''}:${initDegraded ? 'deg' : 'ok'}`;

        conn.addEventListener('change', () => {
          if (this.context.connectionState === 'idle') return;
          const snap = getNetworkSnapshot();
          const degraded =
            !snap.online ||
            (typeof snap.rttMs === 'number' && snap.rttMs >= 450) ||
            (typeof snap.dlMbps === 'number' && snap.dlMbps > 0 && snap.dlMbps < 0.8) ||
            snap.eff === '2g' ||
            snap.eff === 'slow-2g';
          const sig = `${snap.type || ''}:${snap.eff || ''}:${degraded ? 'deg' : 'ok'}`;
          const now = this._nowPerfMs();
          if (sig === this._lastNetSig || now - this._lastNetLogPerfMs < 2500) return;
          this._lastNetSig = sig;
          this._lastNetLogPerfMs = now;
          this.log(
            degraded ? 'warn' : 'info',
            degraded ? 'network_degraded' : 'network_changed',
            degraded
              ? `Cellular/network quality degraded (${formatNetworkSummary(snap)})`
              : `Network state changed (${formatNetworkSummary(snap)})`,
            snap
          );
        });
      }
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (this.context.connectionState === 'idle') return;
        if (document.visibilityState === 'hidden') {
          this._hiddenSincePerfMs = this._nowPerfMs();
          this.log('info', 'app_visibility', 'App moved to background (hidden)');
        } else if (document.visibilityState === 'visible') {
          const hiddenMs =
            this._hiddenSincePerfMs !== null
              ? Math.round(this._nowPerfMs() - this._hiddenSincePerfMs)
              : null;
          this._hiddenSincePerfMs = null;
          this.log(
            'info',
            'app_visibility',
            `App returned to foreground${hiddenMs !== null ? ` (${hiddenMs}ms hidden)` : ''}`,
            hiddenMs !== null ? { hiddenMs } : null
          );
        }
      });
    }

    window.addEventListener('pagehide', () => {
      this._saveToStorageImmediate();
    });
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn({
          count: this.entries.length,
          hasUnreadIssue: this.hasUnreadIssue,
          issueCount: this.issueCount,
          context: this.context
        });
      } catch (_) {}
    }
  }

  setContext(patch = {}) {
    Object.assign(this.context, patch);
  }

  markIssuesRead() {
    if (this.hasUnreadIssue) {
      this.hasUnreadIssue = false;
      this._notify();
    }
  }

  clear() {
    this.entries = [];
    this.issueCount = 0;
    this.hasUnreadIssue = false;
    this._saveToStorageImmediate();
    this.log('info', 'logs_cleared', `Logs cleared by user (${APP_VERSION})`);
    this._notify();
  }

  finalizeStreamingEntries(eventFilter = null) {
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - 8); i--) {
      const item = this.entries[i];
      if (item._streaming && (!eventFilter || item.event === eventFilter)) {
        delete item._streaming;
      }
    }
    this._scheduleSave(false);
  }

  /**
   * Coalesces streaming text fragments (`input_transcript`, `output_transcript`, `model_thought`)
   * into a single turn entry so logs remain compact and readable.
   */
  appendStream(level, event, deltaText, extraData = null) {
    if (!deltaText) return;
    const cleanDelta = redactSecrets(String(deltaText));
    const maxLen = event === 'model_thought' ? MAX_THOUGHT_TEXT_LEN : MAX_STREAM_TEXT_LEN;
    const nowIso = new Date().toISOString();
    const relMs = Math.round(this._nowPerfMs() - this.bootPerfMs);

    // Search last 4 entries for an active stream of the same event & word
    for (let i = this.entries.length - 1; i >= Math.max(0, this.entries.length - 4); i--) {
      const candidate = this.entries[i];
      if (
        candidate._streaming &&
        candidate.event === event &&
        candidate.word === this.context.wordLabel
      ) {
        candidate.tsEnd = nowIso;
        candidate.relEndMs = relMs;
        candidate.chunks = (candidate.chunks || 1) + 1;
        candidate.totalChars =
          (candidate.totalChars || candidate.summary.length) + cleanDelta.length;
        if (!candidate._capped && candidate.summary.length < maxLen) {
          const remaining = maxLen - candidate.summary.length;
          candidate.summary += cleanDelta.slice(0, remaining);
          if (cleanDelta.length > remaining) {
            candidate.summary += ' …';
            candidate._capped = true;
          }
        }
        if (extraData) {
          candidate.data = Object.assign({}, candidate.data || {}, redactSecrets(extraData));
        }
        this._scheduleSave(false);
        this._notify();
        return candidate;
      }
    }

    const cappedOnInit = cleanDelta.length > maxLen;
    const entry = {
      seq: ++this.seq,
      ts: nowIso,
      relMs,
      level,
      event,
      word: this.context.wordLabel || null,
      model: this.context.model || null,
      phase: this.context.phase || null,
      summary: cappedOnInit ? cleanDelta.slice(0, maxLen) + ' …' : cleanDelta,
      chunks: 1,
      totalChars: cleanDelta.length,
      _streaming: true
    };
    if (cappedOnInit) {
      entry._capped = true;
    }
    if (extraData) {
      entry.data = redactSecrets(extraData);
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.shift();
    }
    this._scheduleSave(false);
    this._notify();
    return entry;
  }

  log(level, event, summary, data = null) {
    const nowIso = new Date().toISOString();
    const relMs = Math.round(this._nowPerfMs() - this.bootPerfMs);

    const entry = {
      seq: ++this.seq,
      ts: nowIso,
      relMs,
      level,
      event,
      word: this.context.wordLabel || null,
      model: this.context.model || null,
      phase: this.context.phase || null,
      summary: redactSecrets(String(summary || event))
    };

    if (data !== null && data !== undefined) {
      entry.data = redactSecrets(data);
    }

    const isIssue = level === 'error' || event === 'ws_close_unexpected';
    if (isIssue) {
      this.hasUnreadIssue = true;
      this.issueCount += 1;
    }

    this.entries.push(entry);
    if (this.entries.length > MAX_LOG_ENTRIES) {
      this.entries.shift();
    }

    const urgent =
      isIssue || level === 'warn' || event.startsWith('ws_close') || event.startsWith('network_');
    this._scheduleSave(urgent);
    this._notify();
    return entry;
  }

  _isHighlightEntry(e) {
    return (
      e.level === 'error' ||
      e.level === 'warn' ||
      e.level === 'thought' ||
      (e.level === 'tool' && e.data?.cue?.type !== 'complete_word') ||
      e.event === 'ws_close_unexpected' ||
      e.event === 'word_completed' ||
      e.event === 'word_restarted' ||
      e.event === 'word_skipped' ||
      e.event === 'word_graded_ai' ||
      e.event === 'word_graded_heuristic_fallback' ||
      e.event === 'utterance_audio_replayed' ||
      e.event === 'repeat_last_prompt' ||
      e.event === 'no_reply_timer_fired' ||
      e.event === 'mic_acquired' ||
      e.event === 'audio_device_changed' ||
      e.event === 'mic_track_event' ||
      e.event.startsWith('network_') ||
      e.event.startsWith('media_session_')
    );
  }

  getEntries(filter = 'all') {
    if (filter === 'highlights') {
      return this.entries.filter(
        (e) =>
          this._isHighlightEntry(e) ||
          e.event === 'input_transcript' ||
          e.event === 'output_transcript'
      );
    }
    return this.entries.slice();
  }

  getSummaryStats() {
    const unexpectedCloses = this.entries.filter((e) => e.event === 'ws_close_unexpected');
    const lastUnexpected =
      unexpectedCloses.length > 0 ? unexpectedCloses[unexpectedCloses.length - 1] : null;
    const errors = this.entries.filter((e) => e.level === 'error');
    const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
    const countEvent = (ev) => this.entries.filter((e) => e.event === ev).length;

    let fallbackModel = null;
    let fallbackWord = null;
    let fallbackAudio = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!fallbackModel && e.model) fallbackModel = e.model;
      if (!fallbackWord && e.word) fallbackWord = e.word;
      if (!fallbackAudio && e.event === 'mic_acquired' && e.summary) {
        fallbackAudio = e.summary.replace(/^Microphone ready:\s*/, '');
      }
      if (fallbackModel && fallbackWord && fallbackAudio) break;
    }

    const rawAudio = this.context.audioSummary || '';
    const effectiveAudio =
      rawAudio && !rawAudio.includes('Not initialized')
        ? rawAudio
        : fallbackAudio || rawAudio || 'not initialized';

    return {
      version: APP_VERSION,
      totalEntries: this.entries.length,
      wordCompletedCount: countEvent('word_completed'),
      utteranceReplayCount: countEvent('utterance_audio_replayed'),
      stalledContinueCount: countEvent('stalled_turn_socket_continue'),
      wedgedAsrCount: countEvent('wedged_asr_socket_refresh'),
      setupTimeoutCount: countEvent('ws_setup_timeout'),
      offlineDropCount: countEvent('network_offline'),
      unexpectedCloseCount: unexpectedCloses.length,
      lastUnexpectedClose: lastUnexpected,
      errorCount: errors.length,
      lastError,
      thoughtTurnCount: countEvent('model_thought'),
      activeModel: this.context.model || fallbackModel || 'none',
      activeWord: this.context.wordLabel || fallbackWord || 'none',
      audioSummary: effectiveAudio,
      connectionState: this.context.connectionState || 'idle',
      networkSummary: formatNetworkSummary()
    };
  }

  /**
   * Formats a comprehensive, LLM-friendly Markdown diagnostic bundle ready to paste into Gemini.
   */
  formatForGemini(maxTimelineEntries = 130, maxTotalChars = 17800) {
    const stats = this.getSummaryStats();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

    const lines = [
      '## Mandarin Driving Tutor — Gemini Diagnostic Log',
      `- **Exported At:** ${new Date().toISOString()}`,
      `- **App Version:** ${APP_VERSION}`,
      `- **User Agent:** ${ua}`,
      `- **Network:** ${stats.networkSummary}`,
      `- **Audio Pipeline:** ${stats.audioSummary}`,
      `- **Active / Last Model:** ${stats.activeModel}`,
      `- **Current / Last Word:** ${stats.activeWord}${this.context.wordPrompt ? ` ("${this.context.wordPrompt}")` : ''}`,
      `- **Connection State:** ${stats.connectionState} (Phase: ${this.context.phase || 'n/a'})`,
      `- **Session Health (${stats.totalEntries} events):** Words=${stats.wordCompletedCount} | Auto-Replays=${stats.utteranceReplayCount} | Stalled-Continues=${stats.stalledContinueCount} | Wedged-ASR=${stats.wedgedAsrCount} | Setup-Timeouts=${stats.setupTimeoutCount} | Offline=${stats.offlineDropCount} | WS-Closes=${stats.unexpectedCloseCount} | Errors=${stats.errorCount}`
    ];

    if (stats.lastUnexpectedClose) {
      const d = stats.lastUnexpectedClose.data || {};
      lines.push(
        `- **Last Unexpected WS Close:** \`code=${d.code ?? '?'}\` \`reason="${d.reason || 'empty'}"\` \`wasClean=${d.wasClean}\` on \`${stats.lastUnexpectedClose.model || '?'}\` (${stats.lastUnexpectedClose.word || 'n/a'}) at ${stats.lastUnexpectedClose.ts}`
      );
    }
    if (stats.lastError) {
      lines.push(`- **Last Error:** ${stats.lastError.summary} (${stats.lastError.ts})`);
    }

    const highlights = this.entries.filter((e) => this._isHighlightEntry(e));
    // Reserve at most 26% of budget for top-level Highlights so the Chronological Timeline gets ~74%
    const maxHighlightBudget = Math.floor(maxTotalChars * 0.26);
    const approxTimelineStartIdx = Math.max(0, this.entries.length - 80);
    const approxTimelineCutoffSeq =
      this.entries.length > 0 ? this.entries[approxTimelineStartIdx].seq : 0;

    if (highlights.length > 0) {
      lines.push('', '### Key Diagnostic Highlights (Scores, Network, Audio, Controls & Errors)');
      lines.push('```text');
      const selectedHighlights = [];
      let highlightChars = 0;
      const candidateHighlights = highlights.slice(-30);
      for (let i = candidateHighlights.length - 1; i >= 0; i--) {
        const h = candidateHighlights[i];
        // Keep `turns` array for older words that scrolled off the timeline; omit for recent words shown in full below
        const formatted = this._formatSingleEntryLine(h, {
          omitTurnsArray: h.seq >= approxTimelineCutoffSeq
        });
        if (
          selectedHighlights.length > 0 &&
          highlightChars + formatted.length + 1 > maxHighlightBudget
        ) {
          break;
        }
        selectedHighlights.push(formatted);
        highlightChars += formatted.length + 1;
      }
      selectedHighlights.reverse();
      lines.push(...selectedHighlights);
      lines.push('```');
    }

    const headerSoFarLen = lines.join('\n').length + 120;
    const remainingBudget = Math.max(1200, maxTotalChars - headerSoFarLen);
    const candidateTimeline = this.entries.slice(-maxTimelineEntries);
    const selectedTimeline = [];
    let timelineChars = 0;
    for (let i = candidateTimeline.length - 1; i >= 0; i--) {
      // Full `input_transcript` and `output_transcript` entries already appear in the timeline, so omit duplicate `turns` array here
      const formatted = this._formatSingleEntryLine(candidateTimeline[i], {
        omitTurnsArray: true
      });
      if (selectedTimeline.length > 0 && timelineChars + formatted.length + 1 > remainingBudget) {
        break;
      }
      selectedTimeline.push(formatted);
      timelineChars += formatted.length + 1;
    }
    selectedTimeline.reverse();

    lines.push(
      '',
      `### Chronological Protocol Timeline (Last ${selectedTimeline.length} of ${this.entries.length} Events)`
    );
    lines.push('```text');
    lines.push(...selectedTimeline);
    lines.push('```');

    return lines.join('\n');
  }

  _formatSingleEntryLine(e, opts = {}) {
    const timeShort = e.ts ? e.ts.slice(11, 23) : '';
    const wordTag = e.word ? ` [${e.word}]` : '';
    const phaseTag = e.phase ? ` [P${e.phase}]` : '';
    const mShort = e.model ? shortModelTag(e.model) : '';
    const modelTag = mShort ? ` [${mShort}]` : '';
    const streamMeta =
      e.chunks && e.chunks > 1
        ? ` (${e.chunks} chunks, ${e.totalChars || e.summary.length} chars)`
        : '';
    const cleanSummary = String(e.summary || '').replace(/\s+/g, ' ').trim();
    let dataObj = e.data;
    if (opts.omitTurnsArray && dataObj && Array.isArray(dataObj.turns)) {
      const { turns: _omitted, ...rest } = dataObj;
      dataObj = rest;
    }
    const dataStr =
      dataObj && Object.keys(dataObj).length > 0 ? ` | ${JSON.stringify(dataObj)}` : '';
    return `${timeShort} (+${(e.relMs / 1000).toFixed(2)}s) [${e.level.toUpperCase()}] ${e.event}${wordTag}${phaseTag}${modelTag}: ${cleanSummary}${streamMeta}${dataStr}`;
  }
}

export const debugLogger = new DebugLogger();
