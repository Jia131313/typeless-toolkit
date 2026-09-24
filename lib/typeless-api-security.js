'use strict';
// ---------- Typeless 2.7.0+ 客户端请求签名 ----------
// 官方主进程从 2.7.0 起加入 TypelessRequestSecurityMiddleware:
// 每个 api.typeless.com 请求都要带 getAPIEncryptHeaders 生成的动态头,
// 否则服务端在进入业务逻辑前直接返回
//   403 "This client is not supported. Please use the official Typeless app."
//
// 本模块复刻该签名的构造过程。两个密钥(口令 / HMAC secret)不写进仓库,
// 而是在运行时从本机 Typeless 的 app.asar 中还原:
// 官方 bundle 把字符串池做成了「数组 + 索引访问」,密钥是池里的固定条目,
// 我们用 API host 这个池内唯一的字面量反推出索引偏移,再取回密钥。
// 官方每次改版都可能换密钥或调整索引,因此还原结果要过三项自校验;
// 任何一步不成立就抛错,由调用方决定降级策略(不阻断原有功能)。

const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const API_HOST = 'https://api.typeless.com';
/** 刷新接口不带签名(实测带签名反而返回 418),官方也在该路径上提前返回 */
const REFRESH_PATH = '/oauth/refresh_access_token';

/** 该路径是否需要附带签名头 */
function shouldSignApiPath(p) {
  if (!p) return false;
  return !String(p).includes(REFRESH_PATH);
}

// ---------- app.asar 读取 ----------

/**
 * 读取 asar 内指定文件。
 * 注意:Electron 打包版会把 .asar 当目录拦截,调用方需先复制成普通文件
 * (见 lib/common.js 的 asarToTmp),本函数只接受已解开的 Buffer 或普通路径。
 */
function readAsarEntry(buf, innerPath) {
  const jl = buf.readUInt32LE(12);
  const dataStart = 16 + jl + ((16 + jl) % 4 ? (4 - ((16 + jl) % 4)) : 0);
  const header = JSON.parse(buf.subarray(16, 16 + jl).toString('utf8'));
  let node = header;
  for (const part of String(innerPath).split('/').filter(Boolean)) {
    if (!node || !node.files) return null;
    node = node.files[part];
  }
  if (!node || node.offset === undefined || !node.size) return null;
  const offset = dataStart + (+node.offset);
  return buf.subarray(offset, offset + node.size);
}

// ---------- 混淆字符串池还原 ----------

/** 求值一个以 '=[' 开头的数组字面量,失败返回 null */
function evalArrayAt(src, arrStart) {
  let i = arrStart + 1, depth = 0, end = -1, inStr = false, quote = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try {
    return vm.runInNewContext('(' + src.slice(arrStart + 1, end + 1) + ')', {}, { timeout: 20000 });
  } catch (e) { return null; }
}

/**
 * 定位字符串池。新版可能把 API host 内联为字面量，因此同时接受包含官网地址
 * 与 prod 环境标记的池；最终仍由配置语义和密钥形态做二次校验。
 */
function locateStringPool(src) {
  const anchors = [
    API_HOST,
    'https://www.typeless.com',
    'TypelessRequestSecurityMiddleware',
    'prod',
    'typeless',
  ];
  for (const value of anchors) {
    for (const quote of ["'", '"']) {
      const anchor = `${quote}${value}${quote}`;
      let idx = src.indexOf(anchor);
      while (idx !== -1) {
        const start = src.lastIndexOf('=[', idx);
        if (start > 0) {
          const pool = evalArrayAt(src, start);
          if (Array.isArray(pool) && (
            pool.includes(API_HOST) ||
            (pool.includes('https://www.typeless.com') && pool.includes('prod')) ||
            pool.includes('TypelessRequestSecurityMiddleware') ||
            (pool.includes('prod') && (pool.includes('now.typeless.desktop') || pool.includes('typeless')))
          )) return pool;
        }
        idx = src.indexOf(anchor, idx + 1);
      }
    }
  }
  return null;
}

function normalizedPoolIndex(index, offset, length) {
  return ((index + offset) % length + length) % length;
}

function sourceConfig(src, pool) {
  const prefix = src.slice(0, Math.min(src.length, 30000));
  const decodedAssignments = [];
  const decodedRe = /\b([_$A-Za-z][\w$]*)\s*=\s*([_$A-Za-z][\w$]*)\(\s*(0x[0-9a-f]+|\d+)\s*\)/gi;
  let match;
  while ((match = decodedRe.exec(prefix))) {
    decodedAssignments.push({ name: match[1], decoder: match[2], index: Number(match[3]) });
  }
  if (!decodedAssignments.length) throw new Error('未能在主进程 bundle 中定位签名配置声明');

  const candidateAnchors = [
    API_HOST,
    'https://www.typeless.com',
    'prod',
    'now.typeless.desktop',
    'Typeless',
  ];
  const anchorValues = candidateAnchors.filter(value => pool.includes(value));
  let best = null;
  for (const assignment of decodedAssignments) {
    for (const anchor of anchorValues) {
      const offset = pool.indexOf(anchor) - assignment.index;
      const decoded = decodedAssignments.map(item => pool[normalizedPoolIndex(item.index, offset, pool.length)]);
      let score = 0;
      for (const value of decoded) {
        if (value === API_HOST) score += 10;
        else if (value === 'https://www.typeless.com') score += 5;
        else if (value === 'prod') score += 5;
        else if (value === 'Typeless') score += 2;
        else if (value === 'now.typeless.desktop') score += 2;
        else if (/^(mac_|win_)$/.test(String(value))) score += 2;
        else if (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(value))) score += 2;
        else if (/^[0-9a-f]{32,128}$/.test(String(value))) score += 3;
      }
      if (!best || score > best.score) best = { score, offset };
    }
  }
  if (!best || best.score < 12) throw new Error('未能用官方地址校准签名配置字符串池');

  const values = new Map();
  for (const item of decodedAssignments) {
    values.set(item.name, pool[normalizedPoolIndex(item.index, best.offset, pool.length)]);
  }
  const literalRe = /\b([_$A-Za-z][\w$]*)\s*=\s*(['"])([^'"\\]*)\2/g;
  while ((match = literalRe.exec(prefix))) values.set(match[1], match[3]);
  return {
    offset: best.offset,
    values,
    at: index => pool[normalizedPoolIndex(index, best.offset, pool.length)],
  };
}

function variableContexts(src, name, radius = 320) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'g');
  const contexts = [];
  let match;
  while ((match = re.exec(src)) && contexts.length < 30) {
    contexts.push(src.slice(Math.max(0, match.index - radius), Math.min(src.length, match.index + radius)));
  }
  return contexts;
}

function semanticSecretRoles(src, values) {
  const candidates = [...values.entries()].filter(([, value]) =>
    typeof value === 'string' && /^[0-9a-f]{32,128}$/.test(value)
  );
  if (candidates.length < 2) throw new Error('签名配置中未找到两项合法密钥');

  const ranked = candidates.map(([name, value]) => {
    const contexts = variableContexts(src, name);
    let aes = 0;
    let hmac = 0;
    for (const context of contexts) {
      if (/\[['"](?:encrypt|decrypt)['"]\]|\.(?:encrypt|decrypt)\b/.test(context)) aes += 4;
      if (new RegExp(`\\+['"]:['"]\\+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(context)) hmac += 6;
      if (/HmacSHA1|hmac-sha1/i.test(context)) hmac += 2;
    }
    return { name, value, aes, hmac };
  });
  const aes = [...ranked].sort((a, b) => b.aes - a.aes)[0];
  const hmac = [...ranked].filter(item => item.name !== aes.name).sort((a, b) => b.hmac - a.hmac)[0];
  if (!aes || !hmac || aes.aes <= 0 || hmac.hmac <= 0) {
    throw new Error('未能从签名构造语义区分 AES 与 HMAC 密钥');
  }
  return { aesPassphrase: aes.value, hmacSecret: hmac.value };
}

// ---------- 密钥提取 ----------

/**
 * 从主进程 bundle 还原签名参数。
 * @param {Buffer} asarBuf app.asar 内容
 * @returns {{aesPassphrase:string,hmacSecret:string,appVersion:string,platformPrefix:string,xEnv:string,offset:number}}
 */
function extractSignatureKeys(asarBuf, options = {}) {
  const entry = readAsarEntry(asarBuf, '/dist/main/index.js');
  if (!entry) throw new Error('app.asar 内未找到主进程 /dist/main/index.js');
  const src = entry.toString('utf8');

  const pool = locateStringPool(src);
  if (!pool) throw new Error('未能在主进程 bundle 中定位签名参数声明或官方字符串池');
  const config = sourceConfig(src, pool);

  // 保留两种已经实测过的 2.7 声明结构；若官方重新排列配置，则转入下方
  // 基于 AES/HMAC 实际使用位置的语义角色识别，而不是继续增加版本号分支。
  let format = 'semantic-usage';
  const legacy = src.match(
    /(\w+)=(\w+)\((0x[0-9a-f]+)\),(\w+)=\2\((0x[0-9a-f]+)\),(\w+)=\2\((0x[0-9a-f]+)\),(\w+)=\6!=='prod'/
  );
  const inlined = !legacy && src.match(
    /(\w+)=(\w+)\((0x[0-9a-f]+)\),(\w+)=\2\((0x[0-9a-f]+)\),(\w+)='prod',(\w+)=\6!==\2\((0x[0-9a-f]+)\)/
  );
  let aesPassphrase;
  let hmacSecret;
  let xEnv;
  if (legacy) {
    format = 'legacy-sequence';
    aesPassphrase = config.at(parseInt(legacy[3], 16));
    hmacSecret = config.at(parseInt(legacy[5], 16));
    xEnv = config.at(parseInt(legacy[7], 16));
  } else if (inlined) {
    format = 'inlined-sequence';
    aesPassphrase = config.at(parseInt(inlined[3], 16));
    hmacSecret = config.at(parseInt(inlined[5], 16));
    xEnv = config.at(parseInt(inlined[8], 16));
  } else {
    ({ aesPassphrase, hmacSecret } = semanticSecretRoles(src, config.values));
    xEnv = [...config.values.values()].find(value => value === 'prod');
  }

  // 自校验:任一项不成立说明官方改版,宁可报错也不要发出注定 403 的请求
  if (xEnv !== 'prod') throw new Error(`字符串池校准失败(X-Env 还原为 ${JSON.stringify(xEnv)})`);
  for (const [name, v] of [['AES 口令', aesPassphrase], ['HMAC secret', hmacSecret]]) {
    if (typeof v !== 'string' || !/^[0-9a-f]{32,128}$/.test(v)) {
      throw new Error(`${name} 还原结果不合法`);
    }
  }

  const configuredValues = [...config.values.values()];
  const platformPrefix = options.platformPrefix || configuredValues.find(value => /^(win_|mac_)$/.test(String(value))) || '';
  const appVersion = options.appVersion || configuredValues.find(value =>
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(String(value))
  ) || '';
  if (!/^(win_|mac_)$/.test(platformPrefix)) throw new Error('未能还原客户端平台前缀');
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(appVersion)) throw new Error('未能还原客户端版本号');

  return {
    aesPassphrase,
    hmacSecret,
    appVersion,
    platformPrefix,
    xEnv,
    offset: config.offset,
    format,
  };
}

// ---------- 加解密(Node 内置实现,与官方 crypto-js 互通) ----------

/** OpenSSL EVP_BytesToKey(MD5, 单轮),等价于 CryptoJS 从口令派生 key/iv 的方式 */
function evpBytesToKey(password, salt, keyLen, ivLen) {
  const pass = Buffer.from(password, 'utf8');
  let derived = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  while (derived.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(prev).update(pass).update(salt).digest();
    derived = Buffer.concat([derived, prev]);
  }
  return { key: derived.subarray(0, keyLen), iv: derived.subarray(keyLen, keyLen + ivLen) };
}

/** 等价于 CryptoJS.AES.encrypt(text, passphrase).toString():OpenSSL salted 格式的 base64 */
function aesEncryptOpenSSL(text, passphrase, salt) {
  const s = salt || crypto.randomBytes(8);
  const { key, iv } = evpBytesToKey(passphrase, s, 32, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), s, body]).toString('base64');
}

/** 等价于 CryptoJS.HmacSHA1(message, key).toString() */
function hmacSha1Hex(message, key) {
  return crypto.createHmac('sha1', key).update(message).digest('hex');
}

// ---------- 构造签名头 ----------

/**
 * 生成与官方 getAPIEncryptHeaders 等价的请求头。
 * @param {object} o
 * @param {string} o.url      完整请求 URL(签名只取 pathname,不含 query)
 * @param {string} o.userId   签名串要求与 Bearer token 归属一致,由调用方从 token 解析
 * @param {object} o.keys     extractSignatureKeys 的结果
 * @param {number} [o.now]    毫秒时间戳,便于测试注入
 * @param {number} [o.randomInt] 100000-999999,便于测试注入
 */
function buildSignatureHeaders({ url, userId, keys, now, randomInt }) {
  if (!keys) throw new Error('缺少签名密钥');
  if (!userId) throw new Error('缺少 userId,无法构造签名');
  const ts = now === undefined ? Date.now() : now;
  const appVersion = keys.platformPrefix + String(keys.appVersion || '').split('-')[0];
  const pathname = new URL(url).pathname;

  const signString = `${ts}:${appVersion}:${pathname}:${userId}`;
  const hmacKey = `${ts}:${keys.hmacSecret}`;
  const p = hmacSha1Hex(signString, hmacKey);
  const random = randomInt === undefined
    ? Math.floor(100000 + Math.random() * 900000)
    : randomInt;

  const payload = {
    'X-Env': keys.xEnv,
    'X-Client-Domain': 'unknown',
    'X-Client-Path': '',
    'X-Random': String(random),
    't': ts,
    'p': p,
    'd': 'UNKNOWN',
    // 官方还带一个混淆命名的附加字段,值恒为空串
    '3c86e26ccbb7274f752e7d868a1541ebfb7f37e7': { a: '' },
  };

  return {
    'X-App-Version': appVersion,
    'X-Authorization': aesEncryptOpenSSL(JSON.stringify(payload), keys.aesPassphrase),
    'X-Browser-Name': 'unknown',
    'X-Browser-Version': 'unknown',
    'X-Browser-Major': 'unknown',
  };
}

module.exports = {
  API_HOST,
  REFRESH_PATH,
  shouldSignApiPath,
  readAsarEntry,
  locateStringPool,
  extractSignatureKeys,
  evpBytesToKey,
  aesEncryptOpenSSL,
  hmacSha1Hex,
  buildSignatureHeaders,
};
