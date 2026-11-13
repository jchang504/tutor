/**
 * Persistent Structured Debug Logger for Mandarin Driving Tutor (`debug-logger.js`)
 *
 * Designed for hands-free mobile debugging on Pixel 9 without needing USB `chrome://inspect`:
 * - Persists a ring buffer of structured protocol, VAD, tool-call, hidden model-thought,
 *   and WebSocket close/error events in `localStorage` across disconnects and reloads.
 * - Strictly redacts API keys, backend secrets, and private Apps Script URLs.
 * - Coalesces streaming transcript & model-thought deltas into single turn entries so
 *   an entire multi-word session fits cleanly in storage and is easy for Gemini to analyze.
 * - Formats a paste-ready Markdown diagnostic bundle for 1-tap sharing with Gemini.
 */

export const APP_VERSION = 'v15';
const LOG_STORAGE_KEY = 'tw_tutor_debug_logs_v1';
const MAX_LOG_ENTRIES = 400;
const MAX_STREAM_TEXT_LEN = 1600;

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
      connectionState: 'idle'
    };
    this.hasUnreadIssue = false;
    this.issueCount = 0;
    this.flushTimer = null;
    this.listeners = new Set();

    this._loadFromStorage();
    this._installGlobalHandlers();
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
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (ev) => {
      this.log('error', 'window_error', ev.message || 'Uncaught window error', {
        filename: ev.filename || '',
        lineno: ev.lineno || 0,
        colno: ev.colno || 0
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason;
      const msg = reason && reason.message ? reason.message : String(reason || 'Unhandled rejection');
      this.log('error', 'unhandled_rejection', msg);
    });
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
    const nowIso = new Date().toISOString();
    const relMs = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - this.bootPerfMs);

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
        candidate.totalChars = (candidate.totalChars || candidate.summary.length) + cleanDelta.length;
        if (candidate.summary.length < MAX_STREAM_TEXT_LEN) {
          const remaining = MAX_STREAM_TEXT_LEN - candidate.summary.length;
          candidate.summary += cleanDelta.slice(0, remaining);
          if (cleanDelta.length > remaining) {
            candidate.summary += ' …[truncated]';
          }
        }
        this._scheduleSave(false);
        this._notify();
        return candidate;
      }
    }

    const entry = {
      seq: ++this.seq,
      ts: nowIso,
      relMs,
      level,
      event,
      word: this.context.wordLabel || null,
      model: this.context.model || null,
      phase: this.context.phase || null,
      summary:
        cleanDelta.length > MAX_STREAM_TEXT_LEN
          ? cleanDelta.slice(0, MAX_STREAM_TEXT_LEN) + ' …[truncated]'
          : cleanDelta,
      chunks: 1,
      totalChars: cleanDelta.length,
      _streaming: true
    };
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
    const relMs = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - this.bootPerfMs);

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

    const urgent = isIssue || level === 'warn' || event.startsWith('ws_close') || event.startsWith('tool_');
    this._scheduleSave(urgent);
    this._notify();
    return entry;
  }

  getEntries(filter = 'all') {
    if (filter === 'highlights') {
      return this.entries.filter(
        (e) =>
          e.level === 'error' ||
          e.level === 'warn' ||
          e.level === 'thought' ||
          e.level === 'tool' ||
          e.event.startsWith('ws_') ||
          e.event === 'input_transcript' ||
          e.event === 'output_transcript'
      );
    }
    return this.entries.slice();
  }

  getSummaryStats() {
    const unexpectedCloses = this.entries.filter((e) => e.event === 'ws_close_unexpected');
    const lastUnexpected = unexpectedCloses.length > 0 ? unexpectedCloses[unexpectedCloses.length - 1] : null;
    const errors = this.entries.filter((e) => e.level === 'error');
    const lastError = errors.length > 0 ? errors[errors.length - 1] : null;
    const thoughts = this.entries.filter((e) => e.event === 'model_thought');

    return {
      version: APP_VERSION,
      totalEntries: this.entries.length,
      unexpectedCloseCount: unexpectedCloses.length,
      lastUnexpectedClose: lastUnexpected,
      errorCount: errors.length,
      lastError,
      thoughtTurnCount: thoughts.length,
      activeModel: this.context.model || 'none',
      activeWord: this.context.wordLabel || 'none',
      connectionState: this.context.connectionState || 'idle'
    };
  }

  /**
   * Formats a comprehensive, LLM-friendly Markdown diagnostic bundle ready to paste into Gemini.
   */
  formatForGemini(maxTimelineEntries = 220) {
    const stats = this.getSummaryStats();
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

    const lines = [
      '## Mandarin Driving Tutor — Gemini Diagnostic Log',
      `- **Exported At:** ${new Date().toISOString()}`,
      `- **App Version:** ${APP_VERSION}`,
      `- **User Agent:** ${ua}`,
      `- **Active / Last Model:** ${stats.activeModel}`,
      `- **Current / Last Word:** ${stats.activeWord}${this.context.wordPrompt ? ` ("${this.context.wordPrompt}")` : ''}`,
      `- **Connection State:** ${stats.connectionState} (Phase: ${this.context.phase || 'n/a'})`,
      `- **Total Buffered Events:** ${stats.totalEntries} | **Unexpected WS Closes:** ${stats.unexpectedCloseCount} | **Errors:** ${stats.errorCount} | **Hidden Thought Blocks:** ${stats.thoughtTurnCount}`
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

    // Highlight section: errors, warnings, unexpected closes, tool calls, and hidden model thoughts
    const highlights = this.entries.filter(
      (e) =>
        e.level === 'error' ||
        e.level === 'warn' ||
        e.level === 'thought' ||
        e.level === 'tool' ||
        e.event === 'ws_close_unexpected' ||
        e.event === 'no_reply_timer_fired'
    );

    if (highlights.length > 0) {
      lines.push('', '### Key Diagnostic Highlights (Errors, WS Closes, Tool Calls & Model Thoughts)');
      lines.push('```text');
      for (const h of highlights.slice(-60)) {
        lines.push(this._formatSingleEntryLine(h));
      }
      lines.push('```');
    }

    const timeline = this.entries.slice(-maxTimelineEntries);
    lines.push('', `### Chronological Protocol Timeline (Last ${timeline.length} of ${this.entries.length} Events)`);
    lines.push('```text');
    for (const e of timeline) {
      lines.push(this._formatSingleEntryLine(e));
    }
    lines.push('```');

    return lines.join('\n');
  }

  _formatSingleEntryLine(e) {
    const timeShort = e.ts ? e.ts.slice(11, 23) : '';
    const wordTag = e.word ? ` [${e.word}]` : '';
    const phaseTag = e.phase ? ` [P${e.phase}]` : '';
    const modelShort = e.model ? ` [${String(e.model).replace(/^models\//, '')}]` : '';
    const streamMeta =
      e.chunks && e.chunks > 1 ? ` (${e.chunks} chunks, ${e.totalChars || e.summary.length} chars)` : '';
    const cleanSummary = String(e.summary || '').replace(/\s+/g, ' ').trim();
    const dataStr = e.data ? ` | ${JSON.stringify(e.data)}` : '';
    return `${timeShort} (+${(e.relMs / 1000).toFixed(2)}s) [${e.level.toUpperCase()}] ${e.event}${wordTag}${phaseTag}${modelShort}: ${cleanSummary}${streamMeta}${dataStr}`;
  }
}

export const debugLogger = new DebugLogger();
