# Interface localization

Choose **Settings → General → Interface language** to use Simplified Chinese,
English, or Turkish. Changing the language asks for confirmation and reloads the
page; save pending form changes first. The selection is stored separately in
`data/ui-preferences.json` and survives application restarts. Chinese remains
the default for existing installations.

Translations are bundled, so no Google Translate service, API key, or internet
connection is needed. Account names, dictionary terms, credentials and paths
are never translated. Windows tray labels use the same preference as the web UI.

## Maintaining translations

`locales/zh-CN.json`, `locales/en.json`, and `locales/tr.json` contain matching
flat keys. Prefixes distinguish UI text, API messages and Windows native text.
Add the same key in every catalog when adding a feature. Use `i18nText(key,
ChineseFallback, values)` for browser strings, `__I18N(key)__` for static HTML,
and `ToolkitLocale.Text(key, ChineseFallback)` in the Windows host.

Keep `{p0}`, `{p1}`, etc. exactly as in the source and do not change HTML tags,
IDs, styles, event handlers or executable attributes. Escape user text before
passing it into an HTML template, as the existing renderer does. Missing Turkish
entries fall back to English, then Chinese. Backend presentation messages are
matched against their original catalog patterns; unknown upstream messages are
shown unchanged rather than sending private data to a translation service.

Run `npm ci` and `npm run check`. Tests cover catalog parity, placeholders,
HTML-template invariants, browser fallback, bootstrap escaping, preference
persistence and preservation of user content. Public Windows and macOS build
scripts include the catalogs and browser helper. `Localization Windows preview`
can be run manually on the feature branch to build sanitized preview packages
without creating a GitHub Release.

## Review status

The catalogs include machine-assisted initial translations with manual review
of primary navigation, settings, dialogs and Windows tray notifications. Further
native-speaker review of less common diagnostic messages is welcome. Linux
browser checks cover Chinese/English/Turkish at 1200px and 880px in light/dark
mode; actual Windows WebView2/tray and macOS native-host acceptance still need
those platforms. This change does not localize macOS Rust-host native dialogs
or installer wizard resources.
