'use strict';
/**
 * 功能快捷键规范化:单键 / 双键,拒绝三键与非法键名。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/common');

describe('feature shortcuts', () => {
  it('exports helpers and feature defs', () => {
    assert.equal(typeof C.normalizeShortcutBinding, 'function');
    assert.equal(typeof C.parseShortcutBinding, 'function');
    assert.equal(typeof C.getFeatureShortcuts, 'function');
    assert.equal(typeof C.setFeatureShortcuts, 'function');
    assert.ok(Array.isArray(C.FEATURE_SHORTCUT_DEFS));
    assert.equal(C.FEATURE_SHORTCUT_DEFS.length, 4);
    assert.equal(C.SHORTCUT_MAX_PARTS, 2);
  });

  it('normalizes single and dual key bindings', () => {
    assert.equal(C.normalizeShortcutBinding('RightCtrl'), 'RightCtrl');
    assert.equal(C.normalizeShortcutBinding(['RightCtrl', 'RightShift']), 'RightCtrl+RightShift');
    assert.equal(C.normalizeShortcutBinding('LeftCtrl+Space'), 'LeftCtrl+Space');
    assert.equal(C.normalizeShortcutBinding('  Insert  '), 'Insert');
  });

  it('rejects empty, oversized, or invalid names', () => {
    assert.throws(() => C.normalizeShortcutBinding(''), /不能为空/);
    assert.throws(() => C.normalizeShortcutBinding('A+B+C'), /最多 2/);
    assert.throws(() => C.normalizeShortcutBinding('Right Ctrl'), /无法识别/);
    assert.throws(() => C.normalizeShortcutBinding('Ctrl+@'), /无法识别/);
  });

  it('parses plus-joined bindings', () => {
    assert.deepEqual(C.parseShortcutBinding('RightCtrl+RightShift'), ['RightCtrl', 'RightShift']);
    assert.deepEqual(C.parseShortcutBinding('Insert'), ['Insert']);
  });

  it('reads current feature shortcuts without throwing', () => {
    const data = C.getFeatureShortcuts();
    assert.equal(typeof data.bindings, 'object');
    assert.ok(data.path.includes('app-settings.json'));
    for (const def of C.FEATURE_SHORTCUT_DEFS) {
      assert.ok(Array.isArray(data.bindings[def.id]));
    }
  });
});
