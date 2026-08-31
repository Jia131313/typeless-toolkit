const crypto = require('crypto');

const VAULT_VERSION = 1;
const VAULT_AAD = Buffer.from('typeless-toolkit-account-vault:v1', 'utf8');
const SCRYPT = Object.freeze({ name: 'scrypt', N: 16384, r: 8, p: 1, key_length: 32 });

function deriveKey(password, salt, kdf = SCRYPT) {
  if (!password) throw new Error('同步密码不能为空');
  return crypto.scryptSync(String(password), salt, kdf.key_length || 32, {
    N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024,
  });
}

function encryptVault(vault, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(VAULT_AAD);
  const plaintext = Buffer.from(JSON.stringify(vault), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    version: VAULT_VERSION,
    cipher: 'aes-256-gcm',
    kdf: SCRYPT,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptVault(content, password) {
  try {
    const envelope = JSON.parse(String(content));
    if (envelope.version !== VAULT_VERSION || envelope.cipher !== 'aes-256-gcm') {
      throw new Error('unsupported vault version');
    }
    const salt = Buffer.from(envelope.salt, 'base64');
    const iv = Buffer.from(envelope.iv, 'base64');
    const tag = Buffer.from(envelope.tag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    const key = deriveKey(password, salt, envelope.kdf);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const vault = JSON.parse(plaintext.toString('utf8'));
    if (vault.version !== VAULT_VERSION || !Array.isArray(vault.accounts)) throw new Error('invalid vault');
    return vault;
  } catch (error) {
    if (/同步密码不能为空/.test(error.message || '')) throw error;
    throw new Error('同步密码错误或远端账号库已损坏');
  }
}

function parseJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); }
  catch (error) { return null; }
}

function validRefreshToken(token, userId) {
  const payload = parseJwt(token);
  return !!(payload && payload.type === 'refresh' && payload.subject?.user_id === userId);
}

function iso(value, fallback = null) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

function portableRecords(accounts, tombstones, now = new Date().toISOString()) {
  const records = [];
  for (const account of accounts || []) {
    if (!account?.user_id || !validRefreshToken(account.refresh_token, account.user_id)) continue;
    records.push({
      user_id: account.user_id,
      nickname: account.nickname || '',
      email: account.email || '',
      client_user_id: account.client_user_id || null,
      refresh_token: account.refresh_token,
      updated_at: iso(account.updated_at || account.captured_at || account.added_at, now),
      deleted_at: null,
    });
  }
  for (const tombstone of tombstones || []) {
    if (!tombstone?.user_id || !iso(tombstone.deleted_at)) continue;
    records.push({
      user_id: tombstone.user_id,
      updated_at: iso(tombstone.updated_at || tombstone.deleted_at, now),
      deleted_at: iso(tombstone.deleted_at),
    });
  }
  return records;
}

function eventTime(record) {
  return Date.parse(record.deleted_at || record.updated_at || '') || 0;
}

function refreshRank(record) {
  if (!validRefreshToken(record.refresh_token, record.user_id)) return [-1, -1, -1];
  const payload = parseJwt(record.refresh_token);
  return [Number(payload.iat) || 0, Number(payload.exp) || 0, Date.parse(record.updated_at || '') || 0];
}

function laterRefresh(left, right) {
  const a = refreshRank(left);
  const b = refreshRank(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? left.refresh_token : right.refresh_token;
  }
  return String(left.refresh_token || '') >= String(right.refresh_token || '')
    ? left.refresh_token : right.refresh_token;
}

function mergeRecord(left, right) {
  if (!left) return { ...right };
  if (!right) return { ...left };
  const newer = eventTime(right) > eventTime(left) ? right : left;
  const older = newer === right ? left : right;
  if (newer.deleted_at) return { user_id: newer.user_id, updated_at: newer.updated_at, deleted_at: newer.deleted_at };
  if (older.deleted_at && eventTime(older) >= eventTime(newer)) {
    return { user_id: older.user_id, updated_at: older.updated_at, deleted_at: older.deleted_at };
  }
  return {
    user_id: newer.user_id,
    nickname: newer.nickname || older.nickname || '',
    email: newer.email || older.email || '',
    client_user_id: newer.client_user_id || older.client_user_id || null,
    refresh_token: laterRefresh(left, right),
    updated_at: newer.updated_at,
    deleted_at: null,
  };
}

function mergeVaults(vaults, now = new Date().toISOString()) {
  const byUser = new Map();
  for (const vault of vaults || []) {
    for (const raw of vault?.accounts || []) {
      if (!raw?.user_id) continue;
      const record = raw.deleted_at
        ? { user_id: raw.user_id, updated_at: iso(raw.updated_at || raw.deleted_at, now), deleted_at: iso(raw.deleted_at) }
        : {
          user_id: raw.user_id,
          nickname: raw.nickname || '', email: raw.email || '', client_user_id: raw.client_user_id || null,
          refresh_token: validRefreshToken(raw.refresh_token, raw.user_id) ? raw.refresh_token : null,
          updated_at: iso(raw.updated_at, now), deleted_at: null,
        };
      if (!record.deleted_at && !record.refresh_token) continue;
      byUser.set(record.user_id, mergeRecord(byUser.get(record.user_id), record));
    }
  }
  return { version: VAULT_VERSION, updated_at: iso(now, new Date().toISOString()), accounts: [...byUser.values()].sort((a, b) => a.user_id.localeCompare(b.user_id)) };
}

module.exports = {
  VAULT_VERSION,
  decryptVault,
  encryptVault,
  mergeVaults,
  portableRecords,
  validRefreshToken,
};
