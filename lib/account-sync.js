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

function compareRefreshRank(left, right) {
  const a = refreshRank(left);
  const b = refreshRank(right);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return String(left.refresh_token || '').localeCompare(String(right.refresh_token || ''));
}

function laterRefresh(left, right) {
  return compareRefreshRank(left, right) >= 0 ? left.refresh_token : right.refresh_token;
}

function mergeRecord(left, right) {
  if (!left) return { ...right };
  if (!right) return { ...left };
  const leftTime = eventTime(left);
  const rightTime = eventTime(right);
  let newer;
  if (rightTime !== leftTime) newer = rightTime > leftTime ? right : left;
  else if (!!left.deleted_at !== !!right.deleted_at) newer = left.deleted_at ? left : right;
  else {
    const credentialOrder = compareRefreshRank(left, right);
    if (credentialOrder !== 0) newer = credentialOrder > 0 ? left : right;
    else {
      const stable = record => JSON.stringify([record.nickname || '', record.email || '', record.client_user_id || '']);
      newer = stable(left).localeCompare(stable(right)) >= 0 ? left : right;
    }
  }
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

const NUTSTORE_URL = 'https://dav.jianguoyun.com/dav/';
const DEFAULT_REMOTE_PATH = 'TypelessToolkit/accounts.vault.json';

function normalizeSyncConfig(input = {}) {
  const provider = ['webdav', 'nutstore'].includes(input.provider) ? input.provider : 'disabled';
  const enabled = input.enabled === true && provider !== 'disabled';
  const urlText = provider === 'nutstore' && !input.url ? NUTSTORE_URL : String(input.url || '');
  let url = urlText;
  if (enabled) {
    let parsed;
    try { parsed = new URL(urlText); } catch (error) { throw new Error('WebDAV URL 无效'); }
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('WebDAV 必须使用 HTTPS（本机回环测试除外）');
    }
    parsed.pathname = parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/';
    url = parsed.toString();
  }
  const remotePath = String(input.remote_path || DEFAULT_REMOTE_PATH).replace(/^\/+/, '');
  if (!remotePath || remotePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('远端文件路径无效');
  }
  return {
    enabled,
    provider,
    url,
    username: String(input.username || ''),
    password: String(input.password || ''),
    sync_password: String(input.sync_password || ''),
    remote_path: remotePath,
  };
}

function redactSyncConfig(config) {
  const normalized = normalizeSyncConfig(config);
  return {
    enabled: normalized.enabled,
    provider: normalized.provider,
    url: normalized.url,
    username: normalized.username,
    remote_path: normalized.remote_path,
    password_configured: !!normalized.password,
    sync_password_configured: !!normalized.sync_password,
  };
}

function webDavError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function createWebDavProvider(configInput, fetchImpl = globalThis.fetch) {
  const config = normalizeSyncConfig(configInput);
  if (!config.enabled) throw new Error('账号同步尚未启用');
  if (!config.username || !config.password) throw new Error('WebDAV 用户名和应用密码不能为空');
  const baseUrl = new URL(config.url);
  const fileUrl = new URL(config.remote_path.split('/').map(encodeURIComponent).join('/'), baseUrl);
  const authorization = 'Basic ' + Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64');
  const headers = extra => ({ Authorization: authorization, ...extra });

  async function request(url, options) {
    try { return await fetchImpl(url, options); }
    catch (error) { throw webDavError('无法连接 WebDAV 服务器', 'WEBDAV_NETWORK'); }
  }

  async function ensureCollections() {
    const parts = config.remote_path.split('/').slice(0, -1);
    let current = baseUrl;
    for (const part of parts) {
      current = new URL(encodeURIComponent(part) + '/', current);
      const response = await request(current, { method: 'MKCOL', headers: headers({}) });
      if (![201, 405].includes(response.status) && !response.ok) {
        throw webDavError(`无法创建 WebDAV 同步目录（HTTP ${response.status}）`, 'WEBDAV_HTTP', response.status);
      }
    }
  }

  return {
    async testConnection() {
      const response = await request(baseUrl, { method: 'PROPFIND', headers: headers({ Depth: '0' }) });
      if (!response.ok && response.status !== 207) {
        throw webDavError(`WebDAV 连接测试失败（HTTP ${response.status}）`, response.status === 401 ? 'WEBDAV_AUTH' : 'WEBDAV_HTTP', response.status);
      }
      return { ok: true, provider: config.provider, status: response.status };
    },
    async readVault() {
      const response = await request(fileUrl, { method: 'GET', headers: headers({ Accept: 'application/json' }) });
      if (response.status === 404) return { exists: false, content: null, revision: null };
      if (!response.ok) {
        throw webDavError(`读取远端账号库失败（HTTP ${response.status}）`, response.status === 401 ? 'WEBDAV_AUTH' : 'WEBDAV_HTTP', response.status);
      }
      return { exists: true, content: await response.text(), revision: response.headers.get('etag') };
    },
    async writeVault(content, expectedRevision) {
      await ensureCollections();
      const conditional = expectedRevision ? { 'If-Match': expectedRevision } : { 'If-None-Match': '*' };
      const response = await request(fileUrl, {
        method: 'PUT',
        headers: headers({ 'Content-Type': 'application/json', ...conditional }),
        body: content,
      });
      if ([409, 412].includes(response.status)) throw webDavError('远端账号库已被其他设备更新', 'WEBDAV_CONFLICT', response.status);
      if (!response.ok) {
        throw webDavError(`写入远端账号库失败（HTTP ${response.status}）`, response.status === 401 ? 'WEBDAV_AUTH' : 'WEBDAV_HTTP', response.status);
      }
      return { revision: response.headers.get('etag') || null };
    },
  };
}

function materializeLocalState(localAccounts, merged) {
  const localById = new Map((localAccounts || []).map(account => [account.user_id, account]));
  const activeIds = new Set();
  const accounts = [];
  const tombstones = [];
  for (const record of merged.accounts) {
    if (record.deleted_at) {
      tombstones.push({ user_id: record.user_id, deleted_at: record.deleted_at, updated_at: record.updated_at });
      continue;
    }
    activeIds.add(record.user_id);
    const local = localById.get(record.user_id);
    accounts.push({
      ...(local || {}),
      user_id: record.user_id,
      nickname: record.nickname,
      email: record.email,
      client_user_id: record.client_user_id,
      refresh_token: record.refresh_token,
      updated_at: record.updated_at,
      token: local?.token || null,
      cloud_only: local ? !!local.cloud_only : true,
      added_at: local?.added_at || record.updated_at,
    });
  }
  for (const local of localAccounts || []) {
    if (!activeIds.has(local.user_id) && !merged.accounts.some(record => record.user_id === local.user_id)) accounts.push(local);
  }
  accounts.sort((a, b) => a.user_id.localeCompare(b.user_id));
  return { accounts, tombstones };
}

function createAccountSyncService({
  readConfigFn,
  readAccountsFn,
  writeAccountsFn,
  readTombstonesFn,
  writeTombstonesFn,
  providerFactory = createWebDavProvider,
  nowFn = () => new Date(),
  maxAttempts = 3,
}) {
  let inFlight = null;
  let currentStatus = { state: 'idle', last_reason: null, last_sync_at: null, error: null };

  async function perform(reason) {
    const config = normalizeSyncConfig(readConfigFn());
    if (!config.enabled) throw new Error('账号同步尚未启用');
    if (!config.sync_password) throw new Error('同步密码不能为空');
    currentStatus = { ...currentStatus, state: 'syncing', last_reason: reason, error: null };
    const provider = providerFactory(config);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const remoteRead = await provider.readVault();
        const remoteVault = remoteRead.exists
          ? decryptVault(remoteRead.content, config.sync_password)
          : { version: VAULT_VERSION, updated_at: null, accounts: [] };
        const now = nowFn().toISOString();
        const localVault = { version: VAULT_VERSION, updated_at: now, accounts: portableRecords(readAccountsFn(), readTombstonesFn(), now) };
        const merged = mergeVaults([remoteVault, localVault], now);
        const encrypted = encryptVault(merged, config.sync_password);
        const written = await provider.writeVault(encrypted, remoteRead.revision);
        const next = materializeLocalState(readAccountsFn(), merged);
        writeAccountsFn(next.accounts);
        writeTombstonesFn(next.tombstones);
        const result = { account_count: next.accounts.length, deleted_count: next.tombstones.length, revision: written.revision, attempts: attempt };
        currentStatus = { state: 'success', last_reason: reason, last_sync_at: now, error: null, result };
        return result;
      } catch (error) {
        if (error.code === 'WEBDAV_CONFLICT' && attempt < maxAttempts) continue;
        const state = error.code === 'WEBDAV_CONFLICT' ? 'conflict'
          : error.code === 'WEBDAV_AUTH' ? 'authentication_failure'
          : /同步密码错误|已损坏/.test(error.message || '') ? 'decryption_failure'
          : 'network_failure';
        currentStatus = { ...currentStatus, state, error: error.message || String(error) };
        throw error;
      }
    }
  }

  return {
    sync(reason = 'manual') {
      if (!inFlight) inFlight = perform(reason).finally(() => { inFlight = null; });
      return inFlight;
    },
    status() { return JSON.parse(JSON.stringify(currentStatus)); },
  };
}

module.exports = {
  VAULT_VERSION,
  decryptVault,
  encryptVault,
  createAccountSyncService,
  createWebDavProvider,
  mergeVaults,
  normalizeSyncConfig,
  portableRecords,
  redactSyncConfig,
  validRefreshToken,
};
