/**
 * How long Auto mode holds a line before advancing.
 *
 * The old rule was `text.length * 45ms`, which counts UTF-16 units rather
 * than characters and treats a comma the same as a letter. Reading is not
 * uniform: a CJK glyph carries more than a Latin character, punctuation is
 * where a reader actually pauses, and a voiced line must never be cut off.
 *
 * The function is pure and deterministic so the pacing can be tested rather
 * than eyeballed; everything it needs comes in through its arguments.
 */

export type AutoSpeed = "fast" | "normal" | "slow";

/** Multiplier applied to the reading estimate for each speed setting. */
export const AUTO_SPEED_FACTORS: Record<AutoSpeed, number> = {
  fast: 0.65,
  normal: 1,
  slow: 1.6,
};

export interface AutoPauseWeights {
  /** `，` `、` `,` `:` `;` - a breath inside a sentence. */
  comma: number;
  /** `。` `.` - the end of a thought. */
  sentence: number;
  /** `？` `！` - carry a beat more than a full stop. */
  exclamation: number;
  /** `……` `...` - the longest pause in Japanese/Chinese prose. */
  ellipsis: number;
  /** `—` `―` `~` - a trailing or interrupted line. */
  dash: number;
  /** An authored line break inside one message. */
  lineBreak: number;
}

export interface AutoTimingSettings {
  speed: AutoSpeed;
  /** Reading cost of one CJK glyph. */
  msPerGlyph?: number;
  /** Reading cost of one Latin word. */
  msPerLatinWord?: number;
  pauses?: Partial<AutoPauseWeights>;
  /** Held after a voice line finishes before advancing. */
  postVoicePauseMs?: number;
  /** Floor and ceiling for the computed delay. */
  minDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_PAUSES: AutoPauseWeights = {
  comma: 140,
  sentence: 320,
  exclamation: 380,
  ellipsis: 480,
  dash: 260,
  lineBreak: 200,
};

const DEFAULTS = {
  msPerGlyph: 95,
  msPerLatinWord: 240,
  postVoicePauseMs: 550,
  minDelayMs: 900,
  maxDelayMs: 14_000,
};

/** Scripts whose glyphs are read one at a time rather than as words. */
const CJK =
  /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ々〆]/;
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+/g;

/**
 * Engine and formatting artifacts that are not read aloud or on screen:
 * C0 controls other than newline, zero-width joiners and marks, and the BOM.
 */
export function stripFormatting(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, "")
    .replace(/\r/g, "");
}

/**
 * Count user-perceived characters. Intl.Segmenter is the correct tool where
 * it exists; the fallback iterates code points, which is still far better
 * than `.length` for anything outside the BMP.
 */
export function segmentGraphemes(text: string): string[] {
  const Segmenter = (
    Intl as {
      Segmenter?: new (
        l?: string,
        o?: { granularity: string },
      ) => { segment(s: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (Segmenter) {
    const out: string[] = [];
    for (const s of new Segmenter(undefined, { granularity: "grapheme" }).segment(text)) out.push(s.segment);
    return out;
  }
  return [...text];
}

export function countGraphemes(text: string): number {
  return segmentGraphemes(text).length;
}

export interface AutoTimingBreakdown {
  delayMs: number;
  /** Time attributed to reading the text itself. */
  readingMs: number;
  /** Time attributed to punctuation and line breaks. */
  pauseMs: number;
  /** Floor imposed by the voice clip, when there is one. */
  voiceFloorMs: number;
  glyphs: number;
  latinWords: number;
}

/**
 * Compute the Auto delay for one line, with its parts exposed so tests (and
 * anyone reasoning about pacing) can see where the time went.
 */
export function computeAutoAdvanceDelay(
  text: string,
  voiceDurationMs: number | null,
  settings: AutoTimingSettings,
): AutoTimingBreakdown {
  const msPerGlyph = settings.msPerGlyph ?? DEFAULTS.msPerGlyph;
  const msPerLatinWord = settings.msPerLatinWord ?? DEFAULTS.msPerLatinWord;
  const postVoice = settings.postVoicePauseMs ?? DEFAULTS.postVoicePauseMs;
  const minDelay = settings.minDelayMs ?? DEFAULTS.minDelayMs;
  const maxDelay = settings.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const pauses: AutoPauseWeights = { ...DEFAULT_PAUSES, ...settings.pauses };
  const factor = AUTO_SPEED_FACTORS[settings.speed] ?? 1;

  const clean = stripFormatting(text);

  // --- what is there to read
  let glyphs = 0;
  let pauseMs = 0;
  const counted = { ellipsis: 0 };

  // Ellipses first: they are runs, and their dots must not also count as
  // sentence stops.
  const withoutEllipses = clean.replace(/(?:…|⋯|\.{2,}|。{2,})+/g, (run) => {
    counted.ellipsis += 1;
    void run;
    return "";
  });
  pauseMs += counted.ellipsis * pauses.ellipsis;

  for (const ch of segmentGraphemes(withoutEllipses)) {
    if (CJK.test(ch)) glyphs += 1;
    else if (/[，、,:：;；]/.test(ch)) pauseMs += pauses.comma;
    else if (/[。.｡]/.test(ch)) pauseMs += pauses.sentence;
    else if (/[？?！!]/.test(ch)) pauseMs += pauses.exclamation;
    else if (/[—―－~～—―]/.test(ch)) pauseMs += pauses.dash;
    else if (ch === "\n") pauseMs += pauses.lineBreak;
  }
  const latinWords = (withoutEllipses.match(LATIN_WORD) ?? []).length;

  const readingMs = glyphs * msPerGlyph + latinWords * msPerLatinWord;
  const estimate = (readingMs + pauseMs) * factor;

  // --- a voiced line is never cut short
  const voiceMs = voiceDurationMs !== null && voiceDurationMs > 0 ? voiceDurationMs : 0;
  const voiceFloorMs = voiceMs > 0 ? voiceMs + postVoice * factor : 0;

  let delayMs = Math.max(estimate, voiceFloorMs);
  delayMs = Math.min(delayMs, maxDelay);
  // The ceiling bounds *reading* time, never a voice line: a voiced line
  // still gets its clip plus the pause that follows it, and nothing advances
  // faster than the floor - a one-word line still gets a beat.
  delayMs = Math.max(delayMs, minDelay, voiceFloorMs);

  return {
    delayMs: Math.round(delayMs),
    readingMs: Math.round(readingMs),
    pauseMs: Math.round(pauseMs),
    voiceFloorMs: Math.round(voiceFloorMs),
    glyphs,
    latinWords: latinWords,
  };
}
