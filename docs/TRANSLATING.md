# Translating Herald OS

## Where the strings are

| File | Holds |
| --- | --- |
| `apps/desktop/shared/locales/en.ts` | English: the source of every message, and what shows when a language lacks one |
| `apps/desktop/shared/locales/zh-CN.ts` | Simplified Chinese |
| `apps/desktop/shared/locales/de-DE.ts` | German: every existing catalog message, including plural forms |
| `apps/desktop/shared/i18n.ts` | The languages, how one is chosen from the setting and the system, `translate` |

Electron main (the menus it builds) and the renderer use the same catalogs.

With the default `system` setting, any German system language (`de`, `de-DE`, `de-AT`, `de-CH`,
or a glibc tag such as `de_DE.UTF-8`) selects German. An explicit saved choice wins over the
system language and persists across preference updates. Unsupported languages fall back to English;
the existing Traditional Chinese fallback remains unchanged. Regional date and number formatting is
preserved when available. Search for `Deutsch`, `German` or `Sprache` to find the language setting.

This is catalog coverage, not complete German coverage of the application. Hardcoded text outside
these surfaces and untranslated third-party editors remain outside this change. User text, command
identifiers, voice phrases and Hermes model-language settings are unchanged.

Some settings content still comes from other owned modules: command titles/descriptions, audio-device
explanations, local speech-model descriptions, software catalog text, plugin permission descriptions,
theme metadata and the model-provider fallback warning. These are controlled UI gaps, not exemptions
from the full localization objective. Raw service diagnostics and user-supplied names are preserved.
Boot, setup, sign-in, workspace, dialogs, Office/Canvas and native messages need a separate exact
file-level extension approval. D2 must not be described as a completely German application or as
complete German settings coverage. Voice grammar, recognition and synthesis remain a separate mission.

D2 keeps technical IDs, preference payloads and action handlers. Pet installation icons depend on the
technical `install` action, independently of the displayed label. Settings rows wrap their controls
at narrow widths without changing focus order. Windows microphone-denial text names Windows Settings;
storage uses a neutral system-drive label and the plugin folder uses Windows profile notation on Windows.
These are presentation changes; they do not alter OS permissions, routes or productive Hermes settings.

On Windows, internal Herald windows use right-aligned minimize, maximize/restore and close controls;
the main internal window's close action still hides it. These are renderer controls, including the
separate chat surface opened from Herald, not changes to Hermes Core or the outer Electron titlebar.
The menu bar reserves traffic-light space only on macOS. Windows settings no longer advertise
unregistered global dictation/emoji shortcuts: dictation retains direct Office insertion with clipboard fallback,
and the existing Open button opens Herald's emoji picker. Linux and macOS keep their existing hints.

## Messages

Each message has a key and English text, sometimes with slots or plural forms:

```ts
'menuBar.battery': 'Battery {percent}%',
'overview.mission.files': { one: '{count} file', other: '{count} files' },
```

- Keep every `{slot}`, spelled as in English, wherever your language puts it. One may go:
  `{device}` ("Mac" or "computer"), where your language says "this computer" without it.
- Plural forms follow the language's own categories: English and German have `one` and `other`, Chinese only
  `other`. The code chooses by `{count}`.
- A comment above a message in `en.ts` says what a slot holds or what must stay English (the words
  the voice and dictation listen for).
- Product names stay as they are: Herald OS, Hermes, Herald Canvas, Docs, Sheets and Slides.
  Hermes Desktop's German catalog is a linguistic reference, not a source of compatible keys.
  The local reference inspected for D2 was `HERMES-UPGRADE-Q1/apps/desktop/src/i18n/de.ts` outside
  this repository. Explicit mappings include Hermes `settings.nav.providers` → Herald's
  provider labels ("Anbieter"), `settings.nav.notifications` → `settings.section.notifications`
  ("Benachrichtigungen"), and its cancel labels → `settings.detail.cancel.19766` ("Abbrechen").
  No Hermes source or catalog was modified or copied wholesale; Herald retains its own keys and slots.

## Translating

Edit your language's file, then check it from `apps/desktop`:

```bash
npx vitest run shared/locales shared/i18n.test.ts
npx tsc -p tsconfig.json --noEmit
```

The test fails when a key is not in English, a slot is missing or added, a plural category is not
one your language has, or a message is empty; the type check catches a misspelled key. A message
your file lacks shows in English, never as its key: compare the keys of `en.ts` with yours to find
them. German additionally requires complete catalog coverage and required slots in every plural form.
For a separately approved, isolated GUI check, run the shell (`npm run dev`), pick the language in Settings > General >
Language, and look over the surfaces above. Screenshots of anything that reads wrong, is cut off or
overflows are welcome in the pull request.

Automated catalog and static-render tests do not verify actual Windows mouse/keyboard interaction,
text overflow, native menus or live chat. Do not launch or replace the protected R3 runtime for this
source-only change; a live update and GUI acceptance require their separate deployment gate.

The isolated D2 browser fixture uses actual components with in-memory service stubs. It checks German
search, language switching, unchanged notification payloads, a rejected save, keyboard activation and
narrow layouts. It is not an Electron, Explorer-start, native DPI, screen-reader or productive
backend acceptance test. The full Windows suite and Windows packaging have separately documented
baseline blockers; passing focused localization tests does not authorize release or promotion.

## Moving more of the shell into the catalogs

- Add the English message to `en.ts` first: the keys, and the values each message takes, are typed
  from it. Then add its translations.
- In a component, `const t = useT()` (from `src/store/i18n.ts`) and `t('area.key', { slot: value })`.
  Elsewhere (a store, a notification, a table of labels), use `t` from the same module; the
  component that shows the text calls `useT()`, so it renders again when the language changes.
  Tables hold keys (`TextKey`), not text.
- Dates and numbers: pass `$locale` to `toLocaleDateString` and the like, as `src/lib/format.ts`
  does.
- In main, `translate(menuLanguage(), 'area.key')` (`electron/i18n.ts`) as the menu is built.
- Text Herald sends Hermes on the person's behalf, such as a quick action's prompt, is a message
  too, so Hermes answers in their language.
- Preserve command IDs, agent-facing command metadata, executable voice phrases and the app registry's
  `name`, which the Dock and commands match on (show `appName(app)`). Visible command names and
  descriptions still need a separate display mapping by command ID; keeping the execution contract
  unchanged is not a reason to leave their user-facing presentation English permanently.

## Adding a language

1. In `shared/i18n.ts`, add it to `Language` and `LANGUAGES` (under its own name), teach
   `tagLanguage` which system language tags mean it, and register its catalog in `CATALOGS`.
2. Copy `shared/locales/zh-CN.ts` to `shared/locales/<tag>.ts`, translate it, and add it to
   `shared/locales/locales.test.ts`.
3. Add it to the `language.set` command (`src/commands/system.ts`) and to the search words of the
   Language setting (`LANGUAGE_KEYWORDS` in `GeneralSection.tsx`).

## What Herald does not translate itself

- The macOS app menu (Herald OS, Edit, Window) is Electron's default, whose items Electron names in
  English. The items macOS adds to it, such as Services and the window list, follow the system's
  language, as does Chromium's own text (a form's "Please fill out this field").
- What Hermes writes is in whatever language it writes: it answers in the language you use.
