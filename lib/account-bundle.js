const FORMAT = 'typeless-account-bundle';
const VERSION = 1;
const BACKUP_FORMAT = 'typeless-toolkit-backup';

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('当前时间无效');
  return date.toISOString();
}

function safeUserId(userId) {
  return typeof userId === 'string' && /^[A-Za-z0-9_-]+$/.test(userId);
}

function refreshClaims(token, userId, nowMs) {
  if (typeof token !== 'string') return { error: '缺少 refresh token' };
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part || !/^[A-Za-z0-9_-]+$/.test(part))) {
    return { error: 'refresh token 不是 JWT' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { error: 'refresh token 无法解析' };
  }
  if (payload?.type !== 'refresh') return { error: '凭证不是 refresh 类型' };
  if (payload.subject?.user_id !== userId) return { error: '凭证所属账号不匹配' };
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp * 1000) || payload.exp * 1000 <= nowMs) {
    return { error: 'refresh token 已过期或缺少有效期' };
  }
  return { iat: Number.isFinite(payload.iat) ? payload.iat : 0, exp: payload.exp };
}

function credentialOrder(left, right, userId, nowMs) {
  const a = refreshClaims(left, userId, nowMs);
  const b = refreshClaims(right, userId, nowMs);
  if (a.error) return b.error ? 0 : -1;
  if (b.error) return 1;
  return Math.sign(a.iat - b.iat) || Math.sign(a.exp - b.exp);
}

function displayName(record) {
  const email = typeof record.email === 'string' ? record.email : '';
  return email.includes('@') ? email.split('@')[0] : record.user_id;
}

function portableFields(record) {
  return {
    user_id: record.user_id,
    nickname: typeof record.nickname === 'string' ? record.nickname : '',
    email: typeof record.email === 'string' ? record.email : '',
    refresh_token: record.refresh_token,
    client_user_id: typeof record.client_user_id === 'string' ? record.client_user_id : null,
    role: typeof record.role === 'string' ? record.role : '',
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
  };
}

function parseBundle(content, now = new Date()) {
  let bundle;
  try { bundle = typeof content === 'string' || Buffer.isBuffer(content) ? JSON.parse(String(content).replace(/^\uFEFF/, '')) : content; }
  catch { throw new Error('账号文件不是有效的 JSON'); }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || bundle.format !== FORMAT) {
    throw new Error('账号文件格式不受支持');
  }
  if (bundle.version !== VERSION) throw new Error('账号文件版本不受支持');
  if (typeof bundle.exported_at !== 'string' || !Number.isFinite(Date.parse(bundle.exported_at))
    || !Array.isArray(bundle.accounts)) throw new Error('账号文件结构无效');

  const nowMs = Date.parse(timestamp(now));
  const records = new Map();
  const rejected = [];
  let duplicates = 0;
  bundle.accounts.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !safeUserId(raw.user_id)) {
      rejected.push({ index: index + 1, reason: '缺少有效的账号 ID' });
      return;
    }
    const claims = refreshClaims(raw.refresh_token, raw.user_id, nowMs);
    if (claims.error) {
      rejected.push({ index: index + 1, user_id: raw.user_id, reason: claims.error });
      return;
    }
    const incoming = portableFields(raw);
    const previous = records.get(incoming.user_id);
    if (previous) {
      duplicates++;
      const newer = credentialOrder(incoming.refresh_token, previous.refresh_token, incoming.user_id, nowMs) > 0
        ? incoming : previous;
      const older = newer === incoming ? previous : incoming;
      records.set(incoming.user_id, {
        ...newer,
        nickname: newer.nickname || older.nickname,
        email: newer.email || older.email,
        client_user_id: newer.client_user_id || older.client_user_id,
        role: newer.role || older.role,
      });
    } else records.set(incoming.user_id, incoming);
  });
  return { records: [...records.values()], total: bundle.accounts.length, duplicates, rejected };
}

function parseLegacyBackup(content, now = new Date()) {
  let accounts;
  try { accounts = typeof content === 'string' || Buffer.isBuffer(content) ? JSON.parse(String(content).replace(/^\uFEFF/, '')) : content; }
  catch { throw new Error('旧备份不是有效的 JSON'); }
  if (!Array.isArray(accounts)) throw new Error('旧备份应为 accounts.json 账号数组');
  return parseBundle({ format: FORMAT, version: VERSION, exported_at: timestamp(now), accounts }, now);
}

function parseBackup(content, now = new Date()) {
  let value;
  try { value = typeof content === 'string' || Buffer.isBuffer(content) ? JSON.parse(String(content).replace(/^\uFEFF/, '')) : content; }
  catch { throw new Error('备份文件不是有效的 JSON'); }
  if (Array.isArray(value)) return { ...parseLegacyBackup(value, now), dictionary: [] };
  if (value?.format !== BACKUP_FORMAT) return { ...parseBundle(value, now), dictionary: [] };
  if (value.version !== VERSION) throw new Error('备份文件版本不受支持');
  if (typeof value.exported_at !== 'string' || !Number.isFinite(Date.parse(value.exported_at))
    || !Array.isArray(value.dictionary) || value.dictionary.some(term => typeof term !== 'string')) {
    throw new Error('备份文件结构无效');
  }
  return { ...parseBundle(value.account_bundle, now), dictionary: value.dictionary.map(term => term.trim()).filter(Boolean) };
}

function createBackup(accounts, dictionary, now = new Date()) {
  const result = createBundle(accounts, now);
  return {
    ...result,
    backup: {
      format: BACKUP_FORMAT,
      version: VERSION,
      exported_at: timestamp(now),
      account_bundle: result.bundle,
      dictionary,
    },
  };
}

function mergeBundle(localAccounts, tombstones, parsed, now = new Date()) {
  const at = timestamp(now);
  const nowMs = Date.parse(at);
  const accounts = (localAccounts || []).map(account => ({ ...account }));
  const byId = new Map(accounts.map((account, index) => [account.user_id, index]));
  const restored = new Set(parsed.records.map(record => record.user_id));
  const tombstoneIds = new Set((tombstones || []).map(item => item.user_id));
  const remainingTombstones = (tombstones || []).filter(item => !restored.has(item.user_id));
  let added = 0, updated = 0, credential_updated = 0, unchanged = 0, resurrected = 0;

  for (const record of parsed.records) {
    const existingIndex = byId.get(record.user_id);
    if (existingIndex === undefined) {
      accounts.push({
        user_id: record.user_id,
        nickname: record.nickname || displayName(record),
        email: record.email,
        role: record.role,
        client_user_id: record.client_user_id,
        refresh_token: record.refresh_token,
        token: null,
        cloud_only: true,
        added_at: at,
        updated_at: at,
      });
      byId.set(record.user_id, accounts.length - 1);
      added++;
    } else {
      const local = accounts[existingIndex];
      const merged = { ...local };
      let changed = tombstoneIds.has(record.user_id);
      if (credentialOrder(record.refresh_token, local.refresh_token, record.user_id, nowMs) > 0) {
        merged.refresh_token = record.refresh_token;
        credential_updated++;
        changed = true;
      }
      for (const field of ['nickname', 'email', 'role', 'client_user_id']) {
        if (!merged[field] && record[field]) { merged[field] = record[field]; changed = true; }
      }
      if (changed) { merged.updated_at = at; accounts[existingIndex] = merged; updated++; }
      else unchanged++;
    }
    if (tombstoneIds.has(record.user_id)) resurrected++;
  }

  return {
    accounts,
    tombstones: remainingTombstones,
    summary: {
      total: parsed.total,
      duplicates: parsed.duplicates,
      added,
      updated,
      credential_updated,
      unchanged,
      resurrected,
      rejected: parsed.rejected.length,
      rejection_details: parsed.rejected,
    },
  };
}

function createBundle(accounts, now = new Date()) {
  const at = timestamp(now);
  const nowMs = Date.parse(at);
  const exported = [];
  const skipped = [];
  (accounts || []).forEach((account, index) => {
    if (!safeUserId(account?.user_id)) {
      skipped.push({ index: index + 1, reason: '缺少有效的账号 ID' });
      return;
    }
    const claims = refreshClaims(account.refresh_token, account.user_id, nowMs);
    if (claims.error) {
      skipped.push({ index: index + 1, user_id: account.user_id, reason: claims.error });
      return;
    }
    const record = portableFields(account);
    exported.push({
      ...record,
      nickname: record.nickname || displayName(record),
      updated_at: Number.isFinite(Date.parse(record.updated_at || '')) ? record.updated_at : at,
    });
  });
  return {
    bundle: { format: FORMAT, version: VERSION, exported_at: at, source: 'typeless-toolkit', accounts: exported },
    total: (accounts || []).length,
    exported: exported.length,
    skipped,
  };
}

module.exports = { FORMAT, VERSION, BACKUP_FORMAT, parseBundle, parseLegacyBackup, parseBackup, mergeBundle, createBundle, createBackup };
