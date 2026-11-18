'use strict';
/**
 * 快照身份校验:防止 profiles/<A> 里实际存的是 B 的登录态,
 * 导致 UI 点 A 却切到 B。
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离运行时数据:快照写到临时目录,不在仓库根目录或真实数据目录留下 profiles/
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-snapshot-'));
process.env.TYPELESS_DATA_DIR = dataRoot;

const C = require('../lib/common');

const uidA = '00000000-test-snap-aaaa-aaaaaaaaaaaa';
const uidB = '00000000-test-snap-bbbb-bbbbbbbbbbbb';

function writeProfile(uid, storageUserId, email) {
  const dir = path.join(C.PROFILES_DIR, uid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'app-storage.json'),
    JSON.stringify({ userData: { user_id: storageUserId, email } }, null, '\t')
  );
  fs.writeFileSync(path.join(dir, 'user-data.json'), JSON.stringify({ token: 'test-' + storageUserId }));
}

describe('snapshot identity', () => {
  after(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it('exports inspect / valid helpers', () => {
    assert.equal(typeof C.inspectSnapshot, 'function');
    assert.equal(typeof C.hasValidSnapshot, 'function');
  });

  it('flags 串号 when profile storage user_id != directory uid', () => {
    writeProfile(uidA, uidB, 'typeB@example.com');
    const meta = C.inspectSnapshot(uidA);
    assert.equal(meta.has_snapshot, true);
    assert.equal(meta.snapshot_mismatch, true);
    assert.equal(meta.snapshot_ok, false);
    assert.equal(meta.snapshot_user_id, uidB);
    assert.equal(C.hasValidSnapshot(uidA), false);
  });

  it('accepts matching profile identity', () => {
    writeProfile(uidB, uidB, 'typeB@example.com');
    const meta = C.inspectSnapshot(uidB);
    assert.equal(meta.has_snapshot, true);
    assert.equal(meta.snapshot_mismatch, false);
    assert.equal(meta.snapshot_ok, true);
    assert.equal(C.hasValidSnapshot(uidB), true);
  });

  it('restoreSnapshot rejects mismatched profile before copy', () => {
    writeProfile(uidA, uidB, 'typeB@example.com');
    assert.throws(
      () => C.restoreSnapshot(uidA),
      /串号/
    );
  });

  it('saveSnapshot rejects writing live identity into another account folder', () => {
    // 不依赖真实 Typeless 登录:若当前 live 无 user_id,应拒绝;若有且不等于目标,也应拒绝
    const live = C.readLiveUserIdentity();
    const target = '00000000-test-snap-cccc-cccccccccccc';
    if (!live.user_id) {
      assert.throws(() => C.saveSnapshot(target), /user_id|登录/);
    } else if (live.user_id !== target) {
      assert.throws(() => C.saveSnapshot(target), /拒绝写入快照/);
    }
  });
});
