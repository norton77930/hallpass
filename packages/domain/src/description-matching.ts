/**
 * 002/FR-026, R-025. Whether one element is what a natural-language description names.
 *
 * This is a language policy, not a runtime concern, so it lives here with the sibling policies and
 * is pure: the content runtime keeps liveness and the candidate bound, and hands each still-shown
 * record's three review-card facts - role, label, and a button's own text - to `matchDescription`.
 * Nothing else about an element is ever matched, so a description can only name what the user would
 * have seen on a card; in particular the wait baseline (`visibleText`) is not part of a candidate.
 *
 * Every word of the description must match. Words that carry no meaning ("the", "click", "請") are
 * dropped first - and, when they were all the description had, matched literally instead, so a
 * control whose whole label is "Click" is still reachable.
 *
 * A description names a word of a name, never a fragment of one: spaces say where a word ends in
 * one script and `Intl.Segmenter` says it in another, and where there is no segmenter at all the
 * honest fallback is plain containment - fewer descriptions resolve, none resolve to something else.
 * That single boundary rule is the whole of it; no further heuristic guesses at what a phrase meant.
 *
 * What the rule accepts, it accepts knowingly. A modifier the segmenter makes a segment of its own
 * leaves the base word on boundaries, so "安全動作" names the label "不安全動作" just as English
 * "safe action button" names a button reading "Not safe action"; where that covers sibling controls
 * the candidate bound answers, by saying too-broad rather than choosing one. A description the
 * segmenter glues to a content word is not noise-stripped, so it simply finds nothing. Both err
 * towards too-broad or no-match, never towards the wrong element.
 */

/** The three facts a review card would show about a candidate. */
export type DescriptionCandidate = {
  role?: string | undefined;
  label?: string | undefined;
  /** A button's visible text, which is one of its names. Never any other element's text. */
  text?: string | undefined;
};

export const NOISE_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "to", "on", "in", "of", "at", "this", "that", "please", "click", "press", "type",
  "into", "and", "for", "with", "my", "me", "it", "then", "now",
]);

/**
 * The same list for zh-TW: the verbs and particles a request is wrapped in. They are removed only
 * where the segmenter says a word ends, never as a substring of one, so the "的" inside "目的地" is
 * not mistaken for the particle.
 */
export const NOISE_WORDS_ZH_TW: ReadonlySet<string> = new Set([
  "請", "點", "按", "點擊", "點選", "輸入", "在", "的", "這個", "那個", "把", "然後", "一下", "幫我", "我要",
]);

/** Words a person uses for a control's kind; a role's own name is always among them. */
export const ROLE_WORDS: Record<string, readonly string[]> = {
  textbox: ["textbox", "text", "box", "field", "input", "entry", "textarea"],
  button: ["button", "btn"],
  combobox: ["combobox", "dropdown", "select", "selector", "picker", "list", "menu"],
};

/** The zh-TW half of the same vocabulary, entry for entry ("選單" mirrors "menu"). */
export const ROLE_WORDS_ZH_TW: Record<string, readonly string[]> = {
  textbox: ["文字框", "輸入框", "欄位", "輸入欄", "文字欄"],
  button: ["按鈕", "按鍵"],
  combobox: ["下拉", "下拉選單", "選單", "選擇器", "選項"],
};

export const ANY_ROLE_WORDS: readonly string[] = ["control", "element", "item", "thing"];
export const ANY_ROLE_WORDS_ZH_TW: readonly string[] = ["控制項", "元素", "項目", "東西"];

/** Every zh-TW word for a kind of control, whichever kind: what noise removal must not cut into. */
const KIND_WORDS_ZH_TW: readonly string[] = [
  ...Object.values(ROLE_WORDS_ZH_TW).flat(),
  ...ANY_ROLE_WORDS_ZH_TW,
];

/** Anything that is not a letter or a digit separates one word from the next. */
const SEPARATORS = /[^\p{L}\p{N}]+/u;

/** The scripts written without word breaks, where splitting on separators would yield one token. */
const UNSEGMENTED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Present in Node 20+ and in Chrome. Where it is missing, an unsegmented phrase stays one token and
 * is matched by containment alone: fewer descriptions resolve, none resolve to something else.
 */
const SEGMENTER =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : undefined;

/** The longest zh-TW noise word: no span longer than this needs testing against the vocabulary. */
const MAX_NOISE_CHARS = Math.max(...[...NOISE_WORDS_ZH_TW].map((word) => word.length));

/**
 * How many consecutive segments one run of noise may be spread over. A segmenter splits "點擊" into
 * two segments and glues "請在" into one, so neither a word nor a segment is the unit here.
 */
const MAX_NOISE_SEGMENTS = 4;

type Token = {
  /** `word`: a space-delimited word, matched whole. `phrase`: an unsegmented run, matched by containment. */
  readonly kind: "word" | "phrase";
  readonly value: string;
};

/** Splits one separator-free chunk into alternating unsegmented and space-delimited runs. */
function scriptRuns(chunk: string): Array<{ unsegmented: boolean; value: string }> {
  const runs: Array<{ unsegmented: boolean; value: string }> = [];
  for (const character of chunk) {
    const unsegmented = UNSEGMENTED.test(character);
    const last = runs[runs.length - 1];
    if (last && last.unsegmented === unsegmented) {
      last.value += character;
    } else {
      runs.push({ unsegmented, value: character });
    }
  }
  return runs;
}

function segmentsOf(run: string): string[] {
  if (!SEGMENTER) return [run];
  return [...SEGMENTER.segment(run)].filter((part) => part.isWordLike === true).map((part) => part.segment);
}

/**
 * Whether a stretch of text is nothing but noise words, end to end. Nothing partial counts: "按鈕"
 * opens with the noise word "按", and a rule that removed it would turn the name of a kind of
 * control into the fragment "鈕".
 */
function isAllNoise(text: string): boolean {
  if (text.length === 0) return false;
  const reachable = new Array<boolean>(text.length + 1).fill(false);
  reachable[0] = true;
  for (let end = 1; end <= text.length; end += 1) {
    for (let start = Math.max(0, end - MAX_NOISE_CHARS); start < end; start += 1) {
      if (reachable[start] === true && NOISE_WORDS_ZH_TW.has(text.slice(start, end))) {
        reachable[end] = true;
        break;
      }
    }
  }
  return reachable[text.length] === true;
}

/**
 * Whether a word for a kind of control begins here. "輸入框" begins where the noise word "輸入"
 * does, and removing the noise would leave the fragment "框", which names no kind at all.
 */
function kindWordOpensAt(segments: readonly string[], index: number): boolean {
  const rest = segments.slice(index).join("");
  return KIND_WORDS_ZH_TW.some((word) => rest.startsWith(word));
}

/** Whether any segment a span covers is where a word for a kind of control begins. */
function kindWordOpensWithin(segments: readonly string[], index: number, span: number): boolean {
  for (let at = index; at < index + span; at += 1) {
    if (kindWordOpensAt(segments, at)) return true;
  }
  return false;
}

/**
 * Whether a span is glued to half a word beside it. A segmenter that does not know a two-character
 * name splits it into single characters ("點餐" into "點"|"餐"), and one of them may be spelled like
 * a noise word; a lone character next to a lone character is that, not a word of its own.
 */
function gluedToWord(segments: readonly string[], index: number, span: number): boolean {
  const lone = (segment: string | undefined): boolean =>
    segment !== undefined && segment.length === 1 && !NOISE_WORDS_ZH_TW.has(segment);
  const opens = (segments[index] ?? "").length === 1 && lone(segments[index - 1]);
  const closes = (segments[index + span - 1] ?? "").length === 1 && lone(segments[index + span]);
  return opens || closes;
}

/**
 * How many segments from `index` are noise and nothing else *and* may be removed, longest span
 * first; 0 for none. A span the vocabulary claims stays: what a word for a kind of control is
 * written with is part of that word, and so is what a name is written with.
 *
 * The claim is tested at every segment the span covers, not only at the first: "點擊輸入框" is
 * segmented "點"|"擊"|"輸入"|"框", and a run that stopped only where it began would swallow the
 * "輸入" that "輸入框" opens with and leave the fragment "框".
 */
function noiseSpanAt(segments: readonly string[], index: number): number {
  for (let span = Math.min(MAX_NOISE_SEGMENTS, segments.length - index); span >= 1; span -= 1) {
    if (!isAllNoise(segments.slice(index, index + span).join(""))) continue;
    if (gluedToWord(segments, index, span)) continue;
    if (kindWordOpensWithin(segments, index, span)) continue;
    return span;
  }
  return 0;
}

/**
 * The phrases an unsegmented run asks for: what is left, in its original order, once every stretch
 * of segments that is nothing but noise is removed, one phrase per gap the removal opened.
 */
function phrasesOf(run: string, dropNoise: boolean): string[] {
  if (!dropNoise) return [run];
  const segments = segmentsOf(run);
  const phrases: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) phrases.push(current);
    current = "";
  };
  for (let index = 0; index < segments.length; ) {
    const span = noiseSpanAt(segments, index);
    if (span > 0) {
      flush();
      index += span;
      continue;
    }
    current += segments[index] ?? "";
    index += 1;
  }
  flush();
  return phrases;
}

function tokenize(value: string, dropNoise: boolean): Token[] {
  const tokens: Token[] = [];
  for (const chunk of value.toLowerCase().split(SEPARATORS)) {
    if (chunk.length === 0) continue;
    for (const run of scriptRuns(chunk)) {
      if (!run.unsegmented) {
        if (dropNoise && NOISE_WORDS.has(run.value)) continue;
        tokens.push({ kind: "word", value: run.value });
        continue;
      }
      for (const phrase of phrasesOf(run.value, dropNoise)) {
        tokens.push({ kind: "phrase", value: phrase });
      }
    }
  }
  return tokens;
}

function describedTokens(description: string): Token[] {
  const wanted = tokenize(description, true);
  // A description that was nothing but noise is matched literally rather than answered "no match":
  // "click" is a real name for a control labelled "Click", and so is "點擊".
  return wanted.length > 0 ? wanted : tokenize(description, false);
}

/**
 * The words and phrases a description asks for, in order: lower-cased, noise dropped, and
 * unsegmented text broken where a segmenter and the noise vocabulary agree it may be broken.
 * Exported for the tests that pin the tokenizer itself.
 */
export function describedWords(description: string): string[] {
  return describedTokens(description).map((token) => token.value);
}

/** What a review card would show as the candidate's names, and where its words begin and end. */
type ShownNames = {
  readonly value: string;
  /** Every offset a segment begins at, and the end; `undefined` where there is no segmenter. */
  readonly boundaries: ReadonlySet<number> | undefined;
};

function shownNamesOf(candidate: DescriptionCandidate): ShownNames {
  // The two names are kept apart so no phrase is found across the seam between them.
  const value = ((candidate.label ?? "") + " " + (candidate.text ?? "")).toLowerCase();
  if (!SEGMENTER) return { value, boundaries: undefined };
  const boundaries = new Set<number>([value.length]);
  // Every segment counts here, word-like or not, so that the offsets stay exact.
  for (const part of SEGMENTER.segment(value)) boundaries.add(part.index);
  return { value, boundaries };
}

/**
 * Whether a phrase occurs in the shown names as whole words of them rather than as a fragment of
 * one - the guarantee the space-delimited rule gets from the spaces, taken from where the segmenter
 * says a word ends. That is the whole rule, and it is deliberately no stricter: what the
 * segmenter's words allow is what a description may name, exactly as English "safe action button"
 * names a button reading "Not safe action". So "安全動作" does name the label "不安全動作", which
 * ICU segments "不"|"安全"|"動作" - and where such a description covers sibling controls, the
 * candidate bound is what answers it, by saying too-broad rather than picking one of them.
 *
 * Where there is no segmenter, containment alone answers: fewer descriptions resolve, none resolve
 * to something else.
 */
function occursAsWords(shown: ShownNames, phrase: string): boolean {
  // An empty phrase claims no name at all: it was the kind word itself.
  if (phrase.length === 0) return true;
  for (let at = shown.value.indexOf(phrase); at >= 0; at = shown.value.indexOf(phrase, at + 1)) {
    if (!shown.boundaries) return true;
    if (shown.boundaries.has(at) && shown.boundaries.has(at + phrase.length)) return true;
  }
  return false;
}

/**
 * Whether an unsegmented phrase names this candidate: it occurs among the names as whole words of
 * them, or it is a word for the candidate's kind, possibly carried as the affix such a word is
 * written as ("備註欄位" = the label "備註" plus the kind "欄位"), in which case what is left of it
 * must name them the same way. Containment is the honest rule for a segmenter that over-splits
 * short phrases, and it subsumes matching segment against segment; the boundaries are what keep it
 * from naming a fragment.
 */
function phraseNames(phrase: string, shown: ShownNames, kindWords: readonly string[]): boolean {
  if (occursAsWords(shown, phrase)) return true;
  for (const word of kindWords) {
    if (phrase.length < word.length) continue;
    if (phrase.endsWith(word) && occursAsWords(shown, phrase.slice(0, phrase.length - word.length))) return true;
    if (phrase.startsWith(word) && occursAsWords(shown, phrase.slice(word.length))) return true;
  }
  return false;
}

/**
 * Whether this candidate is what the description names. Every word of the description must match
 * the label, a button's text, or a word for the candidate's kind; a description that asks for
 * nothing at all names nothing.
 */
export function matchDescription(description: string, candidate: DescriptionCandidate): boolean {
  const wanted = describedTokens(description);
  if (wanted.length === 0) return false;
  const shown = shownNamesOf(candidate);
  // Whole words, so "save" does not find "unsaved" and "no" does not find "Notes": a description
  // names an element by its words, not by fragments of them.
  const shownWords = new Set(
    tokenize(shown.value, false)
      .filter((token) => token.kind === "word")
      .map((token) => token.value),
  );
  const role = (candidate.role ?? "").toLowerCase();
  const kindWords = [
    ...(ROLE_WORDS[role] ?? []),
    ...(ROLE_WORDS_ZH_TW[role] ?? []),
    ...ANY_ROLE_WORDS,
    ...ANY_ROLE_WORDS_ZH_TW,
  ];
  return wanted.every((token) =>
    token.kind === "word"
      ? shownWords.has(token.value) || kindWords.includes(token.value)
      : phraseNames(token.value, shown, kindWords),
  );
}
