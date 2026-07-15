const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TYPELESS_EXE = '/path/that/does/not/exist';
const { currentUserFromStorage, locatePaywallTarget, resolvePaywallReplacements } = require('../lib/common');

test('reads the current account from local Typeless storage without CDP', () => {
  assert.deepEqual(currentUserFromStorage({ userData: { user_id: 'user-1', email: 'user@example.com' } }), {
    user_id: 'user-1',
    user_info: { user_id: 'user-1', email: 'user@example.com' },
    source: 'local-storage',
  });
  assert.equal(currentUserFromStorage({ userData: {} }), null);
});

test('derives two equal-length replacements from current handler structure', () => {
  const source = [
    "'onImportantNotification':_0x4931cd=>{if(_0x4931cd['type']==='paywall')_n(_0x4931cd);}",
    "'onSessionInterrupt':(_0x5b741f,_0x348c9a)=>{if(_0x5b741f['type']==='paywall')_n(_0x5b741f);}",
  ].join(',');

  assert.deepEqual(resolvePaywallReplacements(source), {
    replacements: [
      ['_n(_0x4931cd)', '(0,_0x4931cd)'],
      ['_n(_0x5b741f)', '(0,_0x5b741f)'],
    ],
    alreadyPatched: false,
    detected: true,
  });
});

test('recognises dynamically detected replacements after patching', () => {
  const source = [
    "'onImportantNotification':_0x4931cd=>{if(_0x4931cd['type']==='paywall')(0,_0x4931cd);}",
    "'onSessionInterrupt':(_0x5b741f,_0x348c9a)=>{if(_0x5b741f['type']==='paywall')(0,_0x5b741f);}",
  ].join(',');

  assert.deepEqual(resolvePaywallReplacements(source), {
    replacements: [],
    alreadyPatched: true,
    detected: true,
  });
});

test('rejects handler shapes that cannot preserve byte length', () => {
  const source = [
    "'onImportantNotification':notice=>{if(notice['type']==='paywall')show(notice);}",
    "'onSessionInterrupt':(event,retry)=>{if(event['type']==='paywall')show(event);}",
  ].join(',');

  assert.throws(
    () => resolvePaywallReplacements(source),
    /无法推导两个等长替换标记/,
  );
});

test('prefers handler definitions over a message dispatcher with the same keywords', () => {
  const dispatcher = "if(payload['paywall'])this['handlers']['onSessionInterrupt'](payload);else this['handlers']['onImportantNotification'](payload);";
  const handler = [
    "'onImportantNotification':notice=>{if(notice['type']==='paywall')mn(notice);}",
    "'onSessionInterrupt':(event,retry)=>{if(event['type']==='paywall')mn(event);}",
  ].join(',');
  const header = { files: {
    'dispatcher.js': { offset: '0', size: Buffer.byteLength(dispatcher) },
    'handler.mjs': { offset: String(Buffer.byteLength(dispatcher)), size: Buffer.byteLength(handler) },
  } };

  const target = locatePaywallTarget(header, Buffer.from(dispatcher + handler), 0);
  assert.equal(target.filePath.join('/'), 'handler.mjs');
});
