// The voice fast path: match a transcript against the command registry's phrases without a model
// round-trip. Deliberately conservative: only whole-utterance matches count, destructive commands
// never match here (they go to Hermes for the approval card), and anything unmatched is handed to
// Hermes unchanged. Pure, so the grammar is unit-tested in node.
import { t } from '../../store/i18n.ts'
import { type CommandPhrase, type CommandSummary, listCommands } from '../../store/os-commands.ts'
import { dictationRemainder } from './dictation.ts'

export interface IntentMatch {
  command: string
  args: Record<string, unknown>
  title: string
  /** 1 for a literal phrase, lower for slot matches and looser grammars. */
  confidence: number
}

const FILLERS = [
  // The wake phrase as transcribers hear it: "hey Hermes", "hey herpes", "hey, …" with the name lost.
  /^(hey|ok|okay|hi|hello|yo|hallo|hej)(?:[,!\s]|\.(?=\s|$))+((hermes|herm[eèi]s|herpes|hermies|harmes|her mess)(?:[,!\s]|\.(?=\s|$))*)?/i,
  /^(hermes|herm[eè]s)(?:[,!\s]|\.(?=\s|$))+/i,
  /^(please|now)[,\s]+/i,
  /^(bitte|jetzt)[,\s]+/i,
  /^(kannst|könntest|würdest) du (mir )?(bitte )?(mal )?/i,
  /^(ich möchte|ich will|ich würde gerne?|lass uns|lasst uns|los|einfach|doch)[,\s]+/i,
  /^(can|could|would|will) you (please )?/i,
  /^(i want to|i['’‘]?d like to|i would like to|i need to|let['’‘]?s|just)\s+/i,
  /^(go ahead and|please go ahead and)\s+/i
]

const TRAILERS = [/[,\s]+(please|bitte)$/i, /[,\s]+(for me|now|thanks|thank you|danke)$/i, /,\s*hermes$/i, /[,\s]+(für mich|danke schön|vielen dank)$/i]

/** Drop the wake word and leading politeness, keeping the user's casing and punctuation. */
export function stripFillers(text: string): string {
  let out = text.trim()

  for (let i = 0; i < 3; i++) {
    for (const filler of FILLERS) {
      out = out.replace(filler, '')
    }
  }

  return out.trim()
}

/** American spellings for the few verbs British speakers (and transcribers) spell differently. */
const SPELLINGS: Array<[RegExp, string]> = [
  [/\bminimi[sz]e\b/g, 'minimize'],
  [/\bmaximi[sz]e\b/g, 'maximize'],
  [/\bcolour\b/g, 'color'],
  [/\bfavourites\b/g, 'favorites'],
  [/\bfavourite\b/g, 'favorite'],
  [/\bfull ?screen\b/g, 'fullscreen']
]

/** Lower-case, strip punctuation, drop leading/trailing politeness and the wake word. */
export function normaliseUtterance(text: string): string {
  let out = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”"`]/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  for (let i = 0; i < 3; i++) {
    for (const filler of FILLERS) {
      out = out.replace(filler, '')
    }

    for (const trailer of TRAILERS) {
      out = out.replace(trailer, '')
    }
  }

  for (const [pattern, replacement] of SPELLINGS) {
    out = out.replace(pattern, replacement)
  }

  // Slots compare against plain words; drop remaining apostrophes ("I'm" -> "im") consistently.
  return out.replace(/'/g, '').replace(/[.!?,;:]+$/g, '').trim()
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface CompiledPhrase {
  command: CommandSummary
  regex: RegExp
  slots: string[]
  literalWords: number
  presetArgs: Record<string, unknown>
  /** The phrase says the slot is a name ("find files named {query}"), whatever its words. */
  byName: boolean
  /** One of the command's German phrases (`phrasesDe`). */
  german: boolean
}

/** Slots that hold the person's own words: a German phrase keeps their articles ("merke dir {text}" remembers "die Katze schläft"). */
const CONTENT_SLOTS = new Set(['text', 'goal', 'query', 'match', 'title', 'question', 'content', 'message', 'prompt', 'find', 'replacement', 'path', 'url', 'name', 'place'])

const ARTICLES = 'the |my |a |an '
const ARTICLES_DE = 'der |die |das |den |dem |des |mein |meine |meinen |meinem |meiner |dein |deine |deinen |ein |eine |einen |einem |einer |unser |unsere |unseren '

function compile(command: CommandSummary, phrase: CommandPhrase, german = false): CompiledPhrase {
  const text = typeof phrase === 'string' ? phrase : phrase.phrase
  const presetArgs = typeof phrase === 'string' ? {} : phrase.args
  const slots: string[] = []
  const parts = text.split(/(\{[a-zA-Z]+\})/).map(part => {
    const slot = /^\{([a-zA-Z]+)\}$/.exec(part)

    if (slot) {
      slots.push(slot[1])

      // Slots swallow optional articles so "open the missions" and "open missions" both match; a German
      // phrase swallows German ones, except where the slot is what the person said word for word.
      return german ? (CONTENT_SLOTS.has(slot[1]) ? '(.+?)' : `(?:${ARTICLES_DE})?(.+?)`) : `(?:${ARTICLES})?(.+?)`
    }

    // A transcriber's comma between German words ("merke dir, dass …") does not change the phrase.
    return escape(part.toLowerCase()).replace(/\s+/g, german ? ',?\\s+' : '\\s+')
  })
  const literalWords = text
    .replace(/\{[a-zA-Z]+\}/g, '')
    .split(/\s+/)
    .filter(Boolean).length

  return { command, regex: new RegExp(`^${parts.join('')}$`, 'i'), slots, literalWords, presetArgs, byName: /\b(named|called|namens|genannt)\b/i.test(text), german }
}

let cache: { key: string; compiled: CompiledPhrase[] } | null = null

/**
 * What `compile` captures from the commands, so the cache is stale the moment any of it changes: a
 * title in another language, a phrase replaced by another of the same count, a preset argument.
 */
function contentKey(commands: readonly CommandSummary[]): string {
  return JSON.stringify(commands.map(c => [c.id, c.title, c.tier, c.args.map(arg => [arg.name, arg.type, Boolean(arg.required)]), c.phrases, c.phrasesDe ?? []]))
}

/** Where a command's German phrases start in `phrases`, which lists them after the English ones. */
function germanStart(command: CommandSummary): number {
  const german = command.phrasesDe ?? []
  const start = command.phrases.length - german.length

  return german.length > 0 && german.every((phrase, index) => command.phrases[start + index] === phrase) ? start : command.phrases.length
}

function compiledFor(commands: readonly CommandSummary[]): CompiledPhrase[] {
  const key = contentKey(commands)

  if (cache?.key === key) {
    return cache.compiled
  }

  const compiled: CompiledPhrase[] = []

  for (const command of commands) {
    if (command.tier === 'destructive') {
      continue
    }

    const start = germanStart(command)

    command.phrases.forEach((phrase, index) => compiled.push(compile(command, phrase, index >= start)))
  }

  // Most specific first: more literal words, then fewer slots.
  compiled.sort((a, b) => b.literalWords - a.literalWords || a.slots.length - b.slots.length)
  cache = { key, compiled }

  return compiled
}

/** A single token ending in a common document/media extension. */
const BARE_FILE = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:[.-][\w-]+)*\.(?:pdf|docx?|xlsx?|pptx?|key|pages|numbers|txt|md|csv|json|png|jpe?g|gif|heic|webp|svg|mp4|mov|mp3|wav|m4a|rtf|epub)$/i

/**
 * "create / build / make (me) a [few words] website|app|page|store|game …": a request to build
 * something new. Needs "a"/"an" so "make the app icon bigger" (an edit) never matches.
 * Group 1 is the goal ("a website for a hair salon").
 */
const BUILD_REQUEST = /^(?:create|build|make|design|code|develop|generate|put together|spin up)(?: me| us| for me)? ((?:an?|some) (?:[\w'&-]+ ){0,4}?(?:website|web site|site|web page|webpage|landing page|web app|app|application|online store|store|shop|portfolio|blog|game|dashboard|page)\b.*)$/

/** Words that mean the utterance is a request for Hermes to think, not a shell command. */
const HERMES_MARKERS = /\b(why|how come|explain|summari[sz]e|write|draft|fix|debug|refactor|research|compare|analy[sz]e|tell me about|what do you think)\b/i

/**
 * Sorting, renaming or filing documents ("rename it properly and put it where it belongs", "file the
 * invoices in this folder"): Hermes has to read the files first, so no command matches these.
 */
const FILING_REQUEST = /\b(renam(?:e|ing)|organi[sz]e|tidy up|sort (?:out|through)|where (?:it|they|this|these|those|that) (?:belongs?|goes|go|should go))\b|(?:^|\b(?:and|then|to|please|also)\s+)file (?:it|them|this|these|those|that|the|my|all|every|everything)\b/i

/** What Herald Docs, Sheets and Slides make, and the parts of one that a request changes. */
const DOCUMENTS = 'spreadsheet|sheet|workbook|document|doc|report|letter|memo|essay|resume|cv|invoice|quote|estimate|budget|forecast|itinerary|plan|schedule|timetable|rota|agenda|outline|summary|proposal|presentation|deck|slideshow|slide|chart|graph|table|list|checklist|tracker|calendar|timeline|newsletter|brochure|flyer|poster|template|form|minutes|notes'
const PARTS = 'row|column|cell|heading|title|subtitle|header|footer|paragraph|section|sentence|bullet points?|bullets|page numbers|footnote|caption|formula|total|text|words?|line|selection|numbers|values|dates|names'
const LINKS = 'for|about|on|of|with|that|to|from|in|by|and|so|called|named|titled|showing|comparing|listing|covering|tracking|using|based|per|at'
/** A describing word before the noun ("a monthly sales report"), never a link or an article ("a website with a table" is a website). */
const MODIFIER = `(?!(?:${LINKS}|an?|the|my|our|this|it)\\b)[\\w'&-]+`
const THING = `(?:${DOCUMENTS}|${PARTS})s?\\b`

/**
 * Making or changing what a document holds: Hermes does that work in Herald Docs, Sheets and
 * Slides, so these never fill a command's slot ("build me {goal}", "make {name} bigger") or start a
 * build; a whole command phrase ("new document", "make it bigger") still runs.
 */
const OFFICE_REQUESTS: readonly RegExp[] = [
  // "Make a budget for my trip", "create a presentation about volcanoes", "put together an itinerary".
  new RegExp(`^(?:i (?:need|want) |(?:make|create|build|design|generate|prepare|produce|put together|set up|start|draft|write|do|give|get)(?: me| us| for me)? )(?:(?:an?|some|the|my|our|this|that|new) )?(?:${MODIFIER} ){0,3}?(?:${DOCUMENTS})s?(?=$|[,;:]| (?:${LINKS})\\b)`),
  // "Turn this into slides", "make this a table", "put my budget table on a slide".
  new RegExp(`^(?:turn|convert|change|make|format|reformat|transform|put|present|lay out|split|merge) (?:it|this|that|these|those|them|everything|(?:the|this|that|my|our) (?:${MODIFIER} ){0,3}?[\\w'-]+)(?: (?:into|in to|onto|on|to|as|in))? (?:(?:an?|some|the) )?(?:${MODIFIER} ){0,2}?${THING}`),
  // A part by its number or letter: "make slide 3 a two-column comparison", "go to cell B5", "hide column C".
  /^(?:make|turn|change|convert|format|style|move|put|merge|split|duplicate|delete|remove|hide|unhide|show|go to|jump to|select) (?:slide|page|sheet|row|column|cell)s? (?:\d+|[a-z]{1,3}\d*)\b/,
  // "Add a total row", "add a column for tax", "insert a chart"; "add … to my memory" is memory's.
  new RegExp(`^(?:add|insert|append|include) (?!.*\\bto (?:my )?memory$)(?:(?:an?|some|the|another|one more|a new|new|two|three|four|five|\\d+) )?(?:${MODIFIER} ){0,3}?${THING}`),
  // "Sum the March sales", "sort this by date", "translate this paragraph into Spanish", "fill in the rest of this column".
  /^(?:bold|unbold|italici[sz]e|underline|highlight|cent(?:er|re)|align|justify|indent|outdent|capitali[sz]e|uppercase|lowercase|strike ?through|merge|wrap|freeze|unfreeze|sum|total|add up|average|count|calculate|work out|sort|filter|dedupe|de-?duplicate|transpose|translate|proofread|rephrase|reword|rewrite|shorten|lengthen|condense|simplify|reformat|restyle|clean up|fill)\b/,
  // "Make the heading bold", "set the title to Q3 results", "make the first row bigger".
  new RegExp(`^(?:make|set|turn|change|colou?r|format|style|resize) (?:the|this|that|these|those|all the|all|every|each|my) (?:${MODIFIER} ){0,3}?${THING}`),
  // "Make this bold", "make it more formal".
  /^(?:make|turn) (?:it|this|that|these|those|them|everything|the selection) (?:bold|italics?|italici[sz]ed|underlined|bigger|smaller|larger|shorter|longer|uppercase|lowercase|all caps|capitals|cent(?:ered|red)|justified|(?:left|right)[ -]aligned|red|orange|yellow|green|blue|purple|pink|black|white|gr[ae]y|more|less)\b/
]

/*
 * The German side of the same guards. Everything here only sends more requests to Hermes (or skips a
 * German phrase); none of it lets a command run that the English grammar would not.
 */

/** Words that mean the utterance is a request for Hermes to think, not a shell command. */
const HERMES_MARKERS_DE = /\b(warum|wieso|weshalb|wie kommt es|erkläre|erklär|erklären|zusammenfassen|recherchiere|recherchieren|vergleiche|vergleichen|analysiere|analysieren|behebe|beheben|repariere|debugge|refaktoriere|verfasse|was denkst du|was meinst du|sag mir|erzähl mir|erzähle mir|schreibe mir)\b|\bfasse?\b.*\bzusammen\b/i

/** Renaming, sorting or filing documents: Hermes has to read the files first ("ordne" but not "Ordner"). */
const FILING_REQUEST_DE = /\b(umbenennen|sortiere|sortieren|organisiere|organisieren|aufräumen|ablegen|abheften|ordn(?:e|en)|benenne\b.*\bum|räume\b.*\bauf|lege\b.*\bab|wohin (?:es|sie|das) gehört|dorthin,? wo)\b/i

const DE_DOCUMENTS = '[\\wäöüß-]*(?:tabelle|tabellenkalkulation|arbeitsmappe|dokument|bericht|brief|lebenslauf|rechnung|angebot|budget|haushaltsplan|reiseplan|zeitplan|stundenplan|dienstplan|tagesordnung|agenda|gliederung|zusammenfassung|präsentation|vortrag|folie|diagramm|liste|checkliste|kalender|zeitleiste|newsletter|broschüre|flyer|plakat|vorlage|formular|protokoll|notizen|übersicht|kalkulation|entwurf)(?:e|en|n|s)?(?=$|[\\s,;:])'
const DE_PARTS = '(?:zeile|spalte|zelle|überschrift|titel|untertitel|kopfzeile|fußzeile|absatz|abschnitt|satz|aufzählung|aufzählungspunkte|seitenzahlen|fußnote|beschriftung|formel|summe|wörter|wort|auswahl|zahlen|werte|daten|namen)(?:e|en|n|s)?(?=$|[\\s,;:])'
const DE_LINKS = 'für|über|mit|von|zu|zum|zur|aus|in|auf|und|so|namens|genannt|betitelt|nach|pro|bei'
const DE_MODIFIER = `(?!(?:${DE_LINKS}|ein|eine|einen|der|die|das|den|mein|meine|unser|unsere|dieses?|diesen|es)\\s)[\\wäöüß'&-]+`
/** Words before a German "Website"/"App" that make it something else ("einen Ordner für meine App"). */
const BUILD_MODIFIER_DE = `(?!(?:${DE_LINKS}|ordner|datei|verzeichnis|projektordner)\\s)[\\wäöüß'&-]+`
const DE_END = '(?=$|[\\s,;:])'

/** Making or changing what a document holds is Hermes's work in Herald Docs, Sheets and Slides. */
const OFFICE_REQUESTS_DE: readonly RegExp[] = [
  // "Erstelle mir ein Budget für meine Reise", "mach eine Präsentation über Vulkane".
  new RegExp(`^(?:ich (?:brauche|möchte|will) |(?:erstelle|erzeuge|mache|mach|baue|entwirf|entwerfe|verfasse|schreibe|schreib|gestalte|bereite|stelle|setze|lege|generiere|produziere)(?: mir| uns| für mich)? )(?:(?:ein|eine|einen|das|die|den|mein|meine|unser|unsere|neue|neues|neuen|diese[nrs]?) )?(?:${DE_MODIFIER} ){0,3}?${DE_DOCUMENTS}${DE_END}`),
  // "Mach daraus Folien", "wandle das in eine Tabelle um", "setze das in eine Tabelle".
  new RegExp(`^(?:mach|mache|wandle|verwandle|forme|formatiere|setze|stelle|packe|teile|führe) (?:das|dies|diese[ns]?|es|sie|alles|(?:den|die|das|mein|meine|unser|unsere) (?:${DE_MODIFIER} ){0,3}?[\\wäöüß'-]+)(?: (?:daraus|draus))? ?(?:in|zu|als|auf)? ?(?:eine?|einen|die|den|das)? ?(?:${DE_MODIFIER} ){0,2}?(?:${DE_DOCUMENTS}|${DE_PARTS}|folien?|tabelle)`),
  // A part by its number or letter: "Folie 3", "gehe zu Zelle B5", "blende Spalte C aus".
  /^(?:mach|mache|ändere|wandle|formatiere|verschiebe|dupliziere|lösche|entferne|blende|zeige|gehe|springe|wähle) (?:zu )?(?:folie|seite|blatt|zeile|spalte|zelle)n? (?:\d+|[a-z]{1,3}\d*)(?=$|\s)/,
  // "Füge eine Summenzeile hinzu", "füge eine Spalte für Steuern ein".
  new RegExp(`^(?:füge|hänge|setze|trage|baue) (?!.*\\bzu (?:meinem )?gedächtnis hinzu$)(?:(?:ein|eine|einen|das|die|den|noch eine?|eine neue|einen neuen|zwei|drei|vier|fünf|\\d+) )?(?:${DE_MODIFIER} ){0,3}?(?:${DE_DOCUMENTS}|${DE_PARTS})`),
  // "Summiere die Märzumsätze", "sortiere das nach Datum", "übersetze diesen Absatz".
  /^(?:fett|kursiv|unterstreiche|zentriere|richte|summiere|addiere|mittle|zähle|berechne|rechne|sortiere|filtere|dedupliziere|übersetze|korrigiere|formuliere|kürze|verlängere|vereinfache|bereinige|fülle|hebe|setze fett)(?=$|\s)/,
  // "Mach die Überschrift fett", "setze den Titel auf Q3 Ergebnisse".
  new RegExp(`^(?:mach|mache|setze|ändere|färbe|formatiere|stelle|gestalte) (?:die|den|das|diese[nrs]?|alle|jede[nrs]?|meine|mein) (?:${DE_MODIFIER} ){0,3}?(?:${DE_PARTS}|${DE_DOCUMENTS})`),
  // "Mach das fett", "mach es formeller".
  /^mach(?:e)? (?:das|es|dies|diese[ns]?|alles|die auswahl) (?:fett|kursiv|unterstrichen|größer|kleiner|länger|kürzer|großgeschrieben|kleingeschrieben|zentriert|blocksatz|rot|orange|gelb|grün|blau|lila|rosa|schwarz|weiß|grau|formeller|lockerer|höflicher)(?=$|\s)/
]

/** "Erstelle eine Website für …": a request to build something new; needs "ein/eine" so "mach das App-Symbol größer" never matches. */
const BUILD_REQUEST_DE = new RegExp(
  `^(?:erstelle|baue|bau|erzeuge|entwickle|programmiere|gestalte|mach|mache|entwirf|generiere)(?: mir| uns| für mich)? ((?:ein|eine|einen) (?:${BUILD_MODIFIER_DE} ){0,4}?(?:website|webseite|web-seite|seite|landingpage|landing-page|webapp|web-app|app|anwendung|onlineshop|online-shop|webshop|shop|portfolio|blog|spiel|dashboard)(?=$|[\\s,;:]).*)$`
)

/** Joined requests ("öffne Dateien und lösche …", "… danach …"): a German phrase never runs one part of them. */
const COMPOUND_DE = /(?:^|\s)(?:dann|danach|anschließend|außerdem|zusätzlich|und dann|und danach)(?=$|\s)|(?:^|\s)(?:und|sowie|plus)\s+(?:dann\s+)?(?:bitte\s+)?(?:lösch|entfern|vergiss|deinstalli|überschreib|formatier|leer|pausier|stopp|beend|schließ|öffn|zeig|start|erstell|leg|setz|schalt|stell|änder|verschieb|kopier|füg|schreib|tipp|send|schick|installier|aktivier|deaktivier|wechsl|geh|gib|nimm|mach|spiel|speicher|sicher|sperr|verbind|trenn|such|find|lad|bring)/

/** A destructive verb inside what a German slot captured: the words are for Hermes's approval card. */
const DESTRUCTIVE_DE = /(?:^|\s)(?:lösch|entfern|vergiss|deinstalli|überschreib|formatier|zurücksetz|leere|setz\w* zurück)/

/** A slot that describes a document by what it is or who sent it ("the invoice from Acme") rather than naming it. */
const DOCUMENT_DESCRIPTION = /\b(invoices?|receipts?|bills|statements?|payslips?|contracts?|from|sent by|dated|rechnung(?:en)?|belege?|quittung(?:en)?|abrechnung(?:en)?|kontoauszug|kontoauszüge|verträge?|von|vom|gesendet von|datiert)\b/i
const NAMED_FILE = /\.[a-z0-9]{1,5}$|\s+dot\s+[a-z0-9]{1,5}$/i

/** Commands that look a file, folder or app up by its name: a description is no name. */
const LOOKUP_COMMANDS = new Set(['open.any', 'file.open', 'files.search'])

/** Commands whose "that" is ambiguous right after Hermes acted. */
const UNDO_COMMANDS = new Set(['edit.undo', 'edit.redo'])

export interface MatchContext {
  /**
   * The previous turn of the conversation was Hermes using its tools (it moved a file, say). "Undo
   * that" then means Hermes's change, so it goes to Hermes instead of the text field's undo.
   */
  afterHermesAction?: boolean
}

/**
 * Match one utterance against the registry. Returns null when nothing matches confidently; the
 * caller then sends the utterance to Hermes. `commands` defaults to the live registry.
 */
export function matchIntent(text: string, commands: readonly CommandSummary[] = listCommands({ includeHidden: true }), context: MatchContext = {}): IntentMatch | null {
  // Dictation first: "type …" keeps the exact words (any length, any question) for the text field.
  const dictated = dictationRemainder(stripFillers(text))
  const typeCommand = commands.find(c => c.id === 'text.type')

  if (dictated && typeCommand) {
    return { command: 'text.type', args: { text: dictated }, title: t('commands.intent.type', { text: dictated.slice(0, 60) }), confidence: 1 }
  }

  const utterance = normaliseUtterance(text)

  // A joined German request belongs to Hermes as a whole, including the build fast path
  // and older German phrases in the original phrase list. Explicit dictation above stays literal.
  if (COMPOUND_DE.test(utterance)) {
    return null
  }

  // A lone file name ("hello.pdf", or a transcriber's "www.openhello.pdf") means "open that file".
  const bareFile = BARE_FILE.exec(utterance)

  if (bareFile && commands.some(c => c.id === 'file.open')) {
    const name = restoreCasing(text, utterance).replace(/^(?:https?:\/\/)?(?:www\.)?(?:open\s*)?/i, '')

    return { command: 'file.open', args: { name }, title: t('commands.intent.openFile', { name }), confidence: 0.8 }
  }

  const office = OFFICE_REQUESTS.some(pattern => pattern.test(utterance)) || OFFICE_REQUESTS_DE.some(pattern => pattern.test(utterance))

  // "Create a website for a hair salon where people can book": any length, the Studio takes it from here.
  const build = office ? null : BUILD_REQUEST.exec(utterance) ?? BUILD_REQUEST_DE.exec(utterance)

  if (build && commands.some(c => c.id === 'build.start')) {
    // People repeat themselves ("create a website, create a website for a hair salon"): keep the last ask.
    const repeated = /\b(?:create|build|make)(?: me| us)? ((?:an?|some) .+)$/.exec(build[1])
    const goal = restoreCasing(text, repeated ? repeated[1] : build[1]).trim()

    return { command: 'build.start', args: { goal }, title: t('commands.intent.build', { goal: goal.slice(0, 60) }), confidence: 0.85 }
  }

  if (!utterance || utterance.split(' ').length > 14 || HERMES_MARKERS.test(utterance) || HERMES_MARKERS_DE.test(utterance) || FILING_REQUEST.test(utterance) || FILING_REQUEST_DE.test(utterance)) {
    return null
  }

  for (const entry of compiledFor(commands)) {
    if (office && entry.slots.length > 0) {
      continue
    }

    // German content slots must keep punctuation, articles and trailing words such as
    // "für mich". Use normalization for admission above, not to rewrite their payload.
    const literalFileName = ['file.open', 'files.newFolder'].includes(entry.command.id) || (entry.command.id === 'open.any' && /\.[a-z0-9]{1,6}["”“]?[.!?]?$/i.test(text.trim()))
    const literalContent = entry.german && entry.slots.some(slot => CONTENT_SLOTS.has(slot) && (slot !== 'name' || literalFileName))
    const literalSource = entry.slots.includes('text') ? stripFillers(text) : stripFillers(text).replace(/[.!?]+$/, '')
    const match = entry.regex.exec(literalContent ? literalSource : utterance)

    if (!match) {
      continue
    }

    // A window-name slot must not swallow German negation ("beende den Chat nicht").
    // Ambiguous names containing these words go to Hermes instead of a native window action.
    if (entry.german && entry.command.id.startsWith('window.') && /(?:^|\s)(?:nicht|kein|keine|keinen|keinem|keiner)(?=$|\s)/.test(utterance)) {
      continue
    }

    if (context.afterHermesAction && UNDO_COMMANDS.has(entry.command.id)) {
      return null
    }

    const args: Record<string, unknown> = { ...entry.presetArgs }
    let valid = true

    entry.slots.forEach((slot, index) => {
      const value = (match[index + 1] ?? '').trim()

      if (!value) {
        valid = false
      }

      // Paired presentation quotes delimit a filesystem argument; internal apostrophes
      // remain part of its exact name. Memory/dictation content keeps its own quotes.
      const pathValue = literalContent && (slot === 'path' || slot === 'place' || (slot === 'name' && literalFileName))
        ? value.replace(/^"([\s\S]*)"$|^“([\s\S]*)”$|^„([\s\S]*)“$/, (_, straight, english, german) => straight ?? english ?? german) : value
      args[slot] = literalContent ? pathValue : restoreCasing(text, value)
    })

    if (!valid) {
      continue
    }

    // Slot values that are themselves whole requests ("open the file I edited yesterday") are for Hermes.
    if (entry.slots.some(slot => String(args[slot]).split(' ').length > 6)) {
      continue
    }

    if (entry.german && entry.slots.some(slot => DESTRUCTIVE_DE.test(String(args[slot]).toLowerCase()))) {
      continue
    }

    // "Show me the invoice from Acme": only Hermes can find a document by what it says.
    if (LOOKUP_COMMANDS.has(entry.command.id) && !entry.byName && entry.slots.some(slot => describesDocument(String(args[slot])))) {
      continue
    }

    const confidence = entry.slots.length === 0 ? 1 : entry.literalWords >= 2 ? 0.9 : 0.75

    return { command: entry.command.id, args, title: describe(entry.command, args), confidence }
  }

  return null
}

function describesDocument(value: string): boolean {
  return DOCUMENT_DESCRIPTION.test(value) && !NAMED_FILE.test(value.trim())
}

/** Slot values come out of the lower-cased utterance; give them back the user's casing when it is findable. */
export function restoreCasing(original: string, value: string): string {
  const source = original.replace(/[’‘]/g, "'").replace(/'/g, '')
  const index = source.toLowerCase().indexOf(value)

  return index >= 0 ? source.slice(index, index + value.length) : value
}

function describe(command: CommandSummary, args: Record<string, unknown>): string {
  const first = command.args.find(arg => args[arg.name] !== undefined && arg.type === 'string')

  return first ? `${command.title}: ${String(args[first.name])}` : command.title
}
