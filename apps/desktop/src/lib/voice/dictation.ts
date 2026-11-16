// Dictation: turn "type how are you question mark and press enter" into the text to type and
// whether to submit it. Pure, unit-tested; used by the voice matcher and the `text.type` command.

// German adds only the marks whose words are not everyday words: "Punkt" and "Komma" stay as typed ("der Punkt", "drei Komma fünf").
const SPOKEN_MARKS: ReadonlyArray<readonly [words: string, mark: string]> = [
  ['question\\s+mark|fragezeichen', '?'],
  ['exclamation\\s+(?:mark|point)|ausrufezeichen', '!'],
  ['full\\s+stop|period', '.'],
  ['comma', ','],
  ['colon|doppelpunkt', ':'],
  ['semicolon|semikolon|strichpunkt', ';']
]

/** The mark a dictation starts with, unless it starts a run (an ellipsis). */
const LEADING_MARK = /^([?!.,:;])(?![?!.,:;])/

// A spoken mark takes the place of the same mark the transcriber wrote beside it ("Hello, comma world",
// "Hello comma, world"); any other mark beside it stays.
const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  ...SPOKEN_MARKS.map(([words, mark]): [RegExp, string] => {
    const literal = mark.replace(/[.?]/g, '\\$&')

    return [new RegExp(`\\s*(?:${literal}[ \\t]*)?\\b(?:${words})\\b(?:[ \\t]*${literal})?`, 'gi'), mark]
  }),
  [/\s*\b(new line|newline|next line|neue zeile|nächste zeile)\b\s*/gi, '\n'],
  [/\s*\b(new paragraph|neuer absatz|neuen absatz)\b\s*/gi, '\n\n']
]

// The German endings need "und" and an imperative ("und drücke Enter"), as the English ones need "and press".
const SUBMIT_SUFFIX = /[,.\s]*\b(?:and |then )*(?:press|hit) (?:enter|return)\b[.!]?$|[,.\s]*\band (?:send|submit) it\b[.!]?$|[,.\s]*\band send\b[.!]?$|[,.\s]*\bund (?:dann )?(?:drücke|drück) (?:die )?(?:eingabetaste|enter|return)\b[.!]?$|[,.\s]*\bund (?:sende|schicke|schick) (?:es|das) ab\b[.!]?$/i

/**
 * Leading verbs that mean "type the rest"; the capture group is the text. The German verbs take no
 * lead-in words with them: "tippe die Katze schläft" types "die Katze schläft", articles and all.
 */
const DICTATION = /^(?:(?:please|bitte)\s+)?(?:(?:type|dictate|write down|enter the text|type in|type out)\s*[:,]?\s+(?:the (?:text|words?)\s+)?|(?:tippe(?!\s+auf\b)|diktiere|schreibe auf|schreib auf)\s*[:,]?\s+)([\s\S]+)$/i

export interface Dictation {
  text: string
  submit: boolean
}

/** Replace spoken punctuation words ("comma", "question mark") with the characters. */
export function applySpokenPunctuation(text: string): string {
  let out = text

  for (const [pattern, replacement] of SPOKEN_PUNCTUATION) {
    out = out.replace(pattern, replacement)
  }

  return out.replace(/[ \t]+([?!.,:;])/g, '$1')
}

/** Split off "and press enter" / "and send it" and clean the text the user wants typed. */
export function parseDictationText(raw: string): Dictation {
  let text = raw.trim()
  const submit = SUBMIT_SUFFIX.test(text)

  if (submit) {
    text = text.replace(SUBMIT_SUFFIX, '')
  }

  // Strip quotes the transcriber sometimes adds around dictated text.
  text = text.replace(/^["“'‘]+|["”'’]+$/g, '').trim()
  // Transcribers end most utterances with a period the user did not dictate; keep ? and !. Before the
  // spoken marks, so a "period" said at the end stays.
  text = text.replace(/(?<![.])\.$/, '')
  text = applySpokenPunctuation(text)

  return { text, submit }
}

/**
 * Consecutive dictations read as one sentence: the space the person did not say when the caret follows
 * a word, and not the mark the caret follows already ("Hello," then "comma world").
 */
export function withLeadingSpace(before: string | null, text: string): string {
  const words = before && LEADING_MARK.exec(text)?.[1] === before ? text.slice(1) : text

  return before && !/\s/.test(before) && /^[\p{L}\p{N}"'(]/u.test(words) ? ` ${words}` : words
}

/** The raw words after "type …" (original casing and punctuation), or null when not a dictation. */
export function dictationRemainder(utterance: string): string | null {
  const match = DICTATION.exec(utterance.trim())

  return match ? match[1].trim() || null : null
}

/** When the utterance is a dictation ("type …"), the text to type; null otherwise. */
export function matchDictation(utterance: string): Dictation | null {
  const raw = dictationRemainder(utterance)

  if (!raw) {
    return null
  }

  const dictation = parseDictationText(raw)

  return dictation.text || dictation.submit ? dictation : null
}
