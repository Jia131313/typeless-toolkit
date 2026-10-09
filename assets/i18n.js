/* Native catalog localization. No network translation or DOM text scanner. */
(function (root) {
  'use strict';
  const boot = root.__TOOLKIT_I18N__ || {language:'zh-CN', messages:{}, english:{}, source:{}};
  function t(key, source = '', values = []) {
    const value = boot.messages[key] || (boot.language !== 'zh-CN' && boot.english[key]) || boot.source[key] || source;
    return value.replace(/\{p(\d+)\}/g, (all, n) => n < values.length ? String(values[n] ?? '') : all);
  }
  root.ToolkitI18n = {t, language:boot.language};
})(window);
