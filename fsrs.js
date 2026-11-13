/**
 * FSRS v5 (Free Spaced Repetition Scheduler) + Hybrid 1-4 Deterministic Rubric
 * Shared client-side module so the PWA can compute & display real-time FSRS intervals
 * and also run a standalone Demo / Offline test mode.
 */

export const FSRS_DEFAULT_WEIGHTS = [
  0.40255, 1.18385, 3.173, 15.69105,
  7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395,
  0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621
];

/**
 * Deterministic 1-4 score rubric computed from the structured telemetry
 * reported by Gemini Live's `complete_word` tool call.
 *
 * 1 = Again (Forgot target word or required explicit spoiler hint)
 * 2 = Hard  (>2 pronunciation/tone retries, >=2 grammar errors, or struggled in follow-up conversation)
 * 3 = Good  (Recalled target word, 1-2 attempts or minor correction, solid follow-up conversation)
 * 4 = Easy  (First-try recall & accurate pronunciation, 0 grammar errors, natural follow-up conversation)
 */
export function computeDeterministicScore(telemetry = {}) {
  if (telemetry.override_score && [1, 2, 3, 4].includes(Number(telemetry.override_score))) {
    return Number(telemetry.override_score);
  }
  const recalled = telemetry.target_word_recalled !== false;
  const neededHint = Boolean(telemetry.needed_hint);
  const attempts = Number(telemetry.pronunciation_attempts ?? 1);
  const grammarErrors = Number(telemetry.grammar_errors ?? 0);
  const fluency = String(telemetry.conversation_fluency || 'good').toLowerCase();

  if (!recalled || neededHint) {
    return 1; // Again
  }
  if (attempts > 2 || grammarErrors >= 2 || fluency === 'struggled') {
    return 2; // Hard
  }
  if (attempts <= 1 && grammarErrors === 0 && (fluency === 'natural' || fluency === 'excellent')) {
    return 4; // Easy
  }
  return 3; // Good
}

export function scoreLabel(score) {
  switch (Number(score)) {
    case 1: return '1 · Again';
    case 2: return '2 · Hard';
    case 3: return '3 · Good';
    case 4: return '4 · Easy';
    default: return `${score}`;
  }
}

export function computeFsrsV5(card, rating, desiredRetention = 0.90) {
  const w = FSRS_DEFAULT_WEIGHTS;
  const DECAY = -0.5;
  const FACTOR = 19 / 81;

  const now = new Date();
  const reps = Number(card.reps || 0);
  let lapses = Number(card.lapses || 0);
  let S = Number(card.stability || 0);
  let D = Number(card.difficulty || 0);

  let elapsedDays = 0;
  if (card.last_review) {
    const lastDate = new Date(card.last_review);
    if (!Number.isNaN(lastDate.getTime())) {
      elapsedDays = Math.max(0, (now.getTime() - lastDate.getTime()) / (1000 * 3600 * 24));
    }
  }

  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  if (reps === 0 || S <= 0 || D <= 0) {
    S = w[rating - 1];
    D = clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
  } else {
    const R = Math.pow(1 + FACTOR * (elapsedDays / S), DECAY);
    const deltaD = -w[6] * (rating - 3);
    const dPrime = D + deltaD * ((10 - D) / 9);
    const d0Easy = w[4] - Math.exp(w[5] * 3) + 1;
    D = clamp(w[7] * d0Easy + (1 - w[7]) * dPrime, 1, 10);

    if (rating === 1) {
      lapses += 1;
      const sForgot = w[11] *
        Math.pow(D, -w[12]) *
        (Math.pow(S + 1, w[13]) - 1) *
        Math.exp(w[14] * (1 - R));
      S = Math.max(0.2, Math.min(S, sForgot));
    } else {
      const hardPenalty = rating === 2 ? w[15] : 1;
      const easyBonus = rating === 4 ? w[16] : 1;
      const inc = Math.exp(w[8]) *
        (11 - D) *
        Math.pow(S, -w[9]) *
        (Math.exp(w[10] * (1 - R)) - 1) *
        hardPenalty *
        easyBonus;
      S = S * (1 + inc);
    }
  }

  S = Math.round(S * 1000) / 1000;
  D = Math.round(D * 1000) / 1000;

  const retention = clamp(desiredRetention || 0.90, 0.75, 0.97);
  let intervalDays = (S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
  if (rating === 1) {
    intervalDays = Math.min(1, Math.max(0.04, intervalDays));
  } else {
    intervalDays = Math.max(1, Math.round(intervalDays * 10) / 10);
  }

  const dueDate = new Date(now.getTime() + intervalDays * 24 * 3600 * 1000);
  const status = rating === 1 ? (reps === 0 ? 'learning' : 'relearning') : 'review';

  return {
    status,
    stability: S,
    difficulty: D,
    intervalDays: Math.round(intervalDays * 10) / 10,
    reps: reps + 1,
    lapses,
    nowIso: now.toISOString(),
    dueDateIso: dueDate.toISOString()
  };
}
