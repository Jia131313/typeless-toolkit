'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SUPPORTED = Object.freeze(['zh-CN', 'en', 'tr']);
const LOCALE_DIR = path.join(__dirname, '..', 'locales');
const catalogs = Object.fromEntries(SUPPORTED.map(code => [code, JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, code + '.json'), 'utf8'))]));
function normalizeLanguage(value) { return SUPPORTED.includes(value) ? value : 'zh-CN'; }
function format(text, values = []) { return text.replace(/\{p(\d+)\}/g, (all, n) => n < values.length ? String(values[n] ?? '') : all); }
function text(language, key, source = '', values = []) {
  const code = normalizeLanguage(language);
  return format(catalogs[code][key] || (code !== 'zh-CN' && catalogs.en[key]) || catalogs['zh-CN'][key] || source, values);
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c])); }
function safeJSON(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
const messagePatterns = Object.entries(catalogs['zh-CN']).filter(([key, value]) => key.startsWith('message.') && !/<[a-z]/i.test(value)).map(([key, value]) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = [];const regex = escaped.replace(/\\\{p(\d+)\\\}/g, (_, n) => {names.push(Number(n));return '([\\s\\S]*?)';});
  return {key, value, names, regex: new RegExp('^' + regex + '$')};
}).sort((a, b) => b.value.replace(/\{p\d+\}/g, '').length - a.value.replace(/\{p\d+\}/g, '').length);
function translateMessage(value, language) {
  if (typeof value !== 'string' || normalizeLanguage(language) === 'zh-CN') return value;
  for (const item of messagePatterns) {
    const match = item.regex.exec(value);if (!match) continue;
    const values = [];item.names.forEach((n, i) => {values[n] = match[i + 1];});
    return text(language, item.key, value, values);
  }
  return value;
}
// Only presentation fields are localized. Account names, dictionary terms,
// credentials, protocol states, IDs and filesystem paths are left untouched.
const MESSAGE_FIELDS = new Set(['msg', 'message', 'error', 'last_error', 'auto_switch_error', 'error_message', 'description', 'stage_label']);
function localizeResponse(value, language) {
  if (Array.isArray(value)) return value.map(v => localizeResponse(v, language));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    MESSAGE_FIELDS.has(key) && typeof item === 'string' ? translateMessage(item, language) : item && typeof item === 'object' ? localizeResponse(item, language) : item]));
}
function createPreferences(dataRoot) {
  const file = path.join(dataRoot, 'ui-preferences.json');
  function read() { try { return normalizeLanguage(JSON.parse(fs.readFileSync(file, 'utf8')).language); } catch { return 'zh-CN'; } }
  function write(language) {
    if (!SUPPORTED.includes(language)) throw Error('Unsupported interface language.');
    fs.mkdirSync(dataRoot, {recursive:true});let existing = {};try {existing = JSON.parse(fs.readFileSync(file, 'utf8'));} catch {}
    const temp = file + '.tmp';fs.writeFileSync(temp, JSON.stringify({...existing, language}, null, 2), {mode:0o600});fs.renameSync(temp, file);return language;
  }
  return {read, write, file};
}
function renderPage(html, language) {
  const code = normalizeLanguage(language);
  const boot = {language:code, messages:catalogs[code], english:catalogs.en, source:catalogs['zh-CN']};
  return html.replace(/__I18N_BOOTSTRAP__/g, () => safeJSON(boot))
    .replace(/__I18N\(([\w.]+)\)__/g, (_, key) => escapeHtml(text(code, key)))
    .replace(/<html lang="[^"]*"/, '<html lang="' + code + '"');
}
module.exports = {SUPPORTED, catalogs, normalizeLanguage, format, text, translateMessage, localizeResponse, createPreferences, renderPage, safeJSON};
