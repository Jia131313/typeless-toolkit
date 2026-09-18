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
 * 定位字符串池。bundle 里可能有多处数组字面量,用「池内必须含 API host」
 * 这一条件筛选,避免认错数组。
 */
function locateStringPool(src) {
  for (const anchor of [`'${API_HOST}'`, "'2.7.0'", "'typeless'"]) {
    let idx = src.indexOf(anchor);
    while (idx !== -1) {
      const start = src.lastIndexOf('=[', idx);
      if (start > 0) {
        const pool = evalArrayAt(src, start);
        if (Array.isArray(pool) && pool.includes(API_HOST)) return pool;
      }
      idx = src.indexOf(anchor, idx + 1);
    }
  }
  return null;
}

// ---------- 密钥提取 ----------

/**
 * 从主进程 bundle 还原签名参数。
 * @param {Buffer} asarBuf app.asar 内容
 * @returns {{aesPassphrase:string,hmacSecret:string,appVersion:string,platformPrefix:string,xEnv:string,offset:number}}
 */
function extractSignatureKeys(asarBuf) {
  const entry = readAsarEntry(asarBuf, '/dist/main/index.js');
  if (!entry) throw new Error('app.asar 内未找到主进程 /dist/main/index.js');
  const src = entry.toString('utf8');

  // 配置声明序列形如:
  //   vn=F(0x500),Eu=F(0x7a),Di=F(0x20c),tr=Di!=='prod'
  // 变量名每次混淆都不同,因此只依赖结构:连续三个同函数索引取值,
  // 且第三个随后立即与 'prod' 比较。
  const seq = src.match(
    /(\w+)=(\w+)\((0x[0-9a-f]+)\),(\w+)=\2\((0x[0-9a-f]+)\),(\w+)=\2\((0x[0-9a-f]+)\),(\w+)=\6!=='prod'/
  );
  if (!seq) throw new Error('未能在主进程 bundle 中定位签名参数声明');
  const [, , , vnIdxRaw, , euIdxRaw, , diIdxRaw] = seq;
  const vnIdx = parseInt(vnIdxRaw, 16);
  const euIdx = parseInt(euIdxRaw, 16);
  const diIdx = parseInt(diIdxRaw, 16);

  // API host 的取值索引,用作校准锚点(该字符串在池内唯一)
  const hostDecl = src.match(/(\w+)=(\w+)\((0x[0-9a-f]+)\),\w+='https:\/\/www\.typeless\.com'/);
  if (!hostDecl) throw new Error('未能定位 API host 声明,无法校准字符串池');
  const hostIdx = parseInt(hostDecl[3], 16);

  // 版本号取值索引(紧随 API host 声明之后)
  const verDecl = src.match(/\w+='https:\/\/www\.typeless\.com',(\w+)=\w+\((0x[0-9a-f]+)\)/);
  const verIdx = verDecl ? parseInt(verDecl[2], 16) : null;

  const pool = locateStringPool(src);
  if (!pool) throw new Error('未能定位官方字符串池');

  const hostPos = pool.indexOf(API_HOST);
  if (hostPos < 0) throw new Error('字符串池中未找到 API host');
  const offset = hostPos - hostIdx;
  const at = idx => (idx === null || idx === undefined ? undefined : pool[(idx + offset) % pool.length]);

  const aesPassphrase = at(vnIdx);
  const hmacSecret = at(euIdx);
  const xEnv = at(diIdx);

  // 自校验:任一项不成立说明官方改版,宁可报错也不要发出注定 403 的请求
  if (xEnv !== 'prod') throw new Error(`字符串池校准失败(X-Env 还原为 ${JSON.stringify(xEnv)})`);
  for (const [name, v] of [['AES 口令', aesPassphrase], ['HMAC secret', hmacSecret]]) {
    if (typeof v !== 'string' || !/^[0-9a-f]{32,128}$/.test(v)) {
      throw new Error(`${name} 还原结果不合法`);
    }
  }

  // 平台前缀:官方写死 win_ / mac_,版本号拼在后面
  const prefixDecl = src.match(/\w+='(win_|mac_)'/);
  const appVersion = at(verIdx);

  return {
    aesPassphrase,
    hmacSecret,
    appVersion: typeof appVersion === 'string' ? appVersion : '',
    platformPrefix: prefixDecl ? prefixDecl[1] : '',
    xEnv,
    offset,
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
