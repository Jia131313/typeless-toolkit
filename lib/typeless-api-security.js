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

// ---------- 混淆字符串池解码 ----------
// 2.7.0:数组是静态的,密钥字面量直接躺在池里,按索引取即可。
// 2.8.0:混淆升级为「旋转池」——开头有一个 IIFE 反复把池首个元素搬到末尾,
//        直到某个校验和对上;校验表达式里的索引会随旋转整体位移一格。
//        因此静态取索引会拿错条目,必须先复现这次旋转。

/** 六个字符的 hex 转义(如 \x582d41)在 UTF-16 下按 latin1 还原 */
function unescapeSixHex(s) {
  return String(s).replace(/\\x([0-9a-fA-F]{6})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 取以 from 处为起点的函数定义全文(按大括号配对,跳过字符串字面量) */
function extractFunctionAt(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let i = open, depth = 0, inStr = false, quote = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === "'" || c === '"') { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  return null;
}

/** 求值一个数组字面量,失败返回 null */
function evalArrayLiteral(literal) {
  try {
    const arr = vm.runInNewContext('(' + literal + ')', {}, { timeout: 20000 });
    return Array.isArray(arr) ? arr : null;
  } catch (e) { return null; }
}

/**
 * 还原「数组工厂 + 解码器 + 旋转 IIFE」形式的字符串池。
 * 返回 { table, decode } 或 null;table 是旋转后的池,decode 把 hex 索引转成实际字符串。
 *
 * 安全边界:不执行官方任何函数定义。旋转校验表达式先被重写成「本地数组下标 + 算术」,
 * 过白名单后再交由 new Function 求值,官方代码始终没有被加载。
 */
function decodeRotatedPool(src) {
  // 1. 数组工厂:函数体是 `const x=[...]; return x;`
  //    变量名在不同版本里可能是 hex(如 _0x2f877b)或短名,只用结构匹配
  const factory = src.match(/function (_0x[0-9a-f]+)\(\)\s*\{\s*const \w+\s*=\s*\[/);
  if (!factory) return null;
  const factoryName = factory[1];
  const factorySrc = extractFunctionAt(src, src.indexOf('function ' + factoryName + '('));
  if (!factorySrc) return null;
  const literal = factorySrc.slice(factorySrc.indexOf('['), factorySrc.lastIndexOf(']') + 1);
  const raw = evalArrayLiteral(literal);
  if (!raw) return null;
  const table = raw.map(v => (typeof v === 'string' ? unescapeSixHex(v) : v));

  // 2. 解码器:引用数组工厂,且形如 `return table[index - 偏移]`。
  //    不同版本参数个数不一(官方为双参数),因此只按结构与引用关系判定。
  let decoderBody = null, decoderName = null;
  for (const m of src.matchAll(/function (_0x[0-9a-f]+)\s*\(([^)]*)\)\s*\{/g)) {
    if (m[1] === factoryName) continue;
    const body = extractFunctionAt(src, m.index);
    if (!body || body.length >= 4000) continue;
    if (!body.includes(factoryName + '()')) continue;
    // 取值形态官方与变体各一种:`let v=t[i]; return v;` / `return t[i-0xd2];`
    const takesFromTable = /=\s*\w+\[\s*\w+\s*\]/.test(body) || /return\s+\w+\[[^\]]*-\s*0x[0-9a-f]+\]/.test(body);
    if (!takesFromTable) continue;
    decoderBody = body;
    decoderName = m[1];
    break;
  }
  if (!decoderBody) return null;
  // 偏移量两种写法都有:
  //   官方 `_0x5150b5=_0x5150b5-0xd2; ... return t[_0x5150b5];`
  //   变体 `return t[i-0xd2];`
  const shiftMatch = decoderBody.match(/=\s*\w+\s*-\s*(0x[0-9a-f]+)/)
    || decoderBody.match(/\[[^\]]*-\s*(0x[0-9a-f]+)\]/);
  if (!shiftMatch) return null;
  const shift = parseInt(shiftMatch[1], 16);
  const tableIndex = hexIndex => hexIndex - shift;

  // 3. 旋转 IIFE:解析校验表达式与目标值
  const iifeStart = src.indexOf('(function(');
  if (iifeStart < 0) return null;
  const iifeEnd = src.indexOf('}(', iifeStart);
  if (iifeEnd < 0) return null;
  const iife = src.slice(iifeStart, src.indexOf(');', iifeEnd) + 2);
  // 目标校验值可能是十六进制(官方)或十进制(混淆器变体)
  const targetMatch = iife.match(/\}\((?:0x[0-9a-f]+|_0x[0-9a-f]+),(\d+|0x[0-9a-f]+)\)/);
  if (!targetMatch) return null;
  const target = targetMatch[1].startsWith('0x')
    ? parseInt(targetMatch[1], 16)
    : parseInt(targetMatch[1], 10);

  // alias 是指向解码器的局部常量。它可能声明在 IIFE 内部(官方形态),
  // 也可能声明在模块级再被 IIFE 引用,两处都找一次。
  const aliasRe = new RegExp('(\\w+)\\s*=\\s*' + decoderName.replace('$', '\\$') + '\\b');
  const aliasMatch = iife.match(aliasRe) || src.slice(0, iifeStart).match(aliasRe);
  if (!aliasMatch) return null;
  const alias = aliasMatch[1];

  const tryStart = iife.indexOf('try{');
  const tryEnd = iife.indexOf(';if(');
  if (tryStart < 0 || tryEnd < 0) return null;
  const tryBlock = iife.slice(tryStart + 4, tryEnd);

  // 把解码调用换成本地下标访问,parseInt 换成受控函数 N
  const rewritten = tryBlock
    .replace(new RegExp(alias.replace('$', '\\$') + '\\((0x[0-9a-f]+)\\)', 'g'),
      (m, hex) => 'cur[' + tableIndex(parseInt(hex, 16)) + ']')
    .replace(/parseInt\(\s*cur\[(-?\d+)\]\s*\)/g, 'N(cur[$1])');
  // 去掉 `const x=` 声明前缀,只保留右侧表达式
  const eq = rewritten.indexOf('=');
  if (eq < 0) return null;
  const expression = rewritten.slice(eq + 1);

  // 白名单校验:重写后只应剩 parseInt 换出的 N、下标访问、数字与运算符
  if (!/^[0-9a-zA-Z_+\-*/().\[\]\s]+$/.test(expression)) return null;
  if (!/\bN\(/.test(expression)) return null;
  for (const bad of ['require', 'eval', 'Function', 'process', 'global', 'import', 'this']) {
    if (expression.includes(bad)) return null;
  }

  let evaluate;
  try {
    // eslint-disable-next-line no-new-func
    evaluate = new Function('cur', 'N', 'return ' + expression + ';');
  } catch (e) { return null; }

  const toNumber = s => parseInt(s, 10);
  const cur = table.slice();
  for (let k = 0; k < cur.length; k++) {
    let value = NaN;
    try { value = evaluate(cur, toNumber); } catch (e) { value = NaN; }
    if (value === target) {
      return { table: cur, decode: hexIndex => cur[tableIndex(hexIndex)], rotations: k };
    }
    cur.push(cur.shift());
  }
  return null;
}

/** 在声明区里找出解码后形如 x.y.z 的版本号(与声明顺序无关) */
function pickVersion(at, declarationRegion) {
  for (const m of declarationRegion.matchAll(/\((0x[0-9a-f]+)\)/g)) {
    const value = at(parseInt(m[1], 16));
    if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) return value;
  }
  return '';
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

  // 2.8.0 起池会旋转,必须先把解码器与旋转复现出来;2.7.0 走静态索引
  const rotated = decodeRotatedPool(src);

  // 各代混淆的取值方式统一收敛成:取索引 + 可选的 secret 字面量 / 版本号
  let at, offset, vnIdx, euIdx = null, diIdx, verIdx = null, secretLiteral = null, appVersion = '';
  if (seq) {
    // 2.7.0:静态池。用 API host 这个池内唯一字面量反推索引偏移。
    // 捕获组:1=变量名 2=函数名 3=索引 4=变量名 5=索引 6=变量名 7=索引 8=变量名
    vnIdx = parseInt(seq[3], 16);
    euIdx = parseInt(seq[5], 16);
    diIdx = parseInt(seq[7], 16);
    // HMAC secret 是变量声明区的裸 hex 字面量
    const secretDecl = src.slice(0, 20000).match(/(\w+)='([0-9a-f]{32,128})'/);
    if (secretDecl) secretLiteral = secretDecl[2];
    const hostDecl = src.match(/(\w+)=(\w+)\((0x[0-9a-f]+)\),\w+='https:\/\/www\.typeless\.com'/);
    if (!hostDecl) throw new Error('未能定位 API host 声明,无法校准字符串池');
    const hostIdx = parseInt(hostDecl[3], 16);
    const verDecl = src.match(/\w+='https:\/\/www\.typeless\.com',(\w+)=\w+\((0x[0-9a-f]+)\)/);
    if (verDecl) verIdx = parseInt(verDecl[2], 16);
    const pool = locateStringPool(src);
    if (!pool) throw new Error('未能定位官方字符串池');
    const hostPos = pool.indexOf(API_HOST);
    if (hostPos < 0) throw new Error('字符串池中未找到 API host');
    offset = hostPos - hostIdx;
    at = idx => (idx === null || idx === undefined ? undefined : pool[(idx + offset) % pool.length]);
  } else if (rotated) {
    // 2.8.0:旋转池。声明形如 `Sn=D(0x92a),Cu='<hex>',Fi=D(0x4b4),tr=Fi!==D(0x4b4)`。
    // 版本号另有单独声明(如 `is=D(0xb23)`),它就在密钥组之前,单独抓。
    const head = src.slice(0, 20000);
    const group = head.match(
      /(\w+)=\w+\((0x[0-9a-f]+)\),(\w+)='([0-9a-f]{32,128})',(\w+)=\w+\((0x[0-9a-f]+)\),\w+=\5!==\w+\((0x[0-9a-f]+)\)/
    );
    if (!group) throw new Error('未能定位 2.8.0 的签名参数声明');
    vnIdx = parseInt(group[2], 16);
    secretLiteral = group[4];
    diIdx = parseInt(group[6], 16);
    offset = rotated.rotations;
    at = idx => (idx === null || idx === undefined ? undefined : rotated.decode(idx));
    // 版本号:与位置无关地挑出解码后形如 x.y.z 的那个索引
    appVersion = pickVersion(at, head.slice(0, head.indexOf(group[0])));
  } else {
    throw new Error('未能在主进程 bundle 中定位签名参数声明(既非静态字符串池,也未匹配旋转移位)');
  }

  const aesPassphrase = at(vnIdx);
  const hmacSecret = secretLiteral || at(euIdx);
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
  const resolvedVersion = appVersion || at(verIdx);

  return {
    aesPassphrase,
    hmacSecret,
    appVersion: typeof resolvedVersion === 'string' ? resolvedVersion : '',
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
