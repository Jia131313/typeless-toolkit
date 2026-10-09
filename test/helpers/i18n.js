const I18N = require('../../lib/i18n');
exports.localizedContext = (values = {}) => ({ i18nText: (key, source, args) => I18N.text('zh-CN', key, source, args), ToolkitI18n: {language: 'zh-CN'}, ...values });
exports.sourcePage = source => source.replace(/__I18N\(([\w.]+)\)__/g, (_, key) => I18N.text('zh-CN', key));
