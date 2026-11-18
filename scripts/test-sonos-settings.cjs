// Exercise the CLI and watcher API without sending packets or using the TV's config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const code = fs.readFileSync('runtime/sonos-settings.js', 'utf8');
const load = new Function('require', 'module', 'process', 'console', 'setTimeout', 'clearTimeout', code);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sonos-settings-test-'));
const directory = path.join(sandbox, 'settings');
const localFs = {};
for (const method of ['readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
  localFs[method] = (...args) => fs[method](...args.map(arg => typeof arg === 'string' ?
    arg.replace('/var/lib/earc-volume-overlay-sonos', directory) : arg));
}

const actions = [];
const speaker = '10.77.42.55';
const surround = '10.77.42.56';
let volume = '8', mute = '1';
let failReads = false;
const http = {
  request(options, complete) {
    assert.equal(options.method, 'POST');
    assert.equal(options.port, 1400);
    assert.ok([speaker, surround].includes(options.hostname));
    const action = options.headers.SOAPAction.split('#')[1].slice(0, -1);
    actions.push(action);
    const request = new EventEmitter();
    request.abort = () => {};
    request.end = body => setImmediate(() => {
      const response = new EventEmitter();
      const isRoom = ['GetZoneAttributes', 'GetInvisible'].includes(action);
      assert.equal(options.path, isRoom ? '/DeviceProperties/Control' : '/MediaRenderer/RenderingControl/Control');
      if (!isRoom) assert.ok(body.includes('<Channel>Master</Channel>'));
      response.statusCode = failReads ? 500 : 200;
      response.setEncoding = () => {};
      complete(response);
      let tag, value;
      if (action === 'GetZoneAttributes') [tag, value] = ['CurrentZoneName', 'Kitchen &amp; Hall'];
      else if (action === 'GetInvisible') [tag, value] = ['CurrentInvisible', options.hostname === surround ? '1' : '0'];
      else if (action === 'GetVolume') [tag, value] = ['CurrentVolume', volume];
      else if (action === 'GetMute') [tag, value] = ['CurrentMute', mute];
      else assert.fail(action);
      response.emit('data', '<' + tag + '>' + value);
      response.emit('data', '</' + tag + '>');
      response.emit('end');
    });
    return request;
  }
};
const dgram = {
  createSocket() {
    const sock = new EventEmitter();
    sock.bind = (port, cb) => setImmediate(cb);
    sock.close = () => {};
    sock.send = (packet, port, host) => {
      assert.ok(packet.toString().includes('ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n'));
      assert.equal(host, '239.255.255.250');
      assert.equal(port, 1900);
      const reply = Buffer.from('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\nUSN: uuid:RINCON_123456\r\nLOCATION: http://localhost:42/ignored\r\n\r\n');
      for (const address of [speaker, speaker, surround, '203.0.113.9']) sock.emit('message', reply, { address });
      sock.emit('message', Buffer.from('invalid'), { address: '10.77.42.99' });
    };
    return sock;
  }
};

function run(args) {
  const module = { exports: {} };
  function localRequire(name) { return ({ fs: localFs, http, dgram })[name] || require(name); }
  const proc = { argv: ['node', 'cli'].concat(args || []) };
  if (!args) {
    load(localRequire, module, proc, console, setTimeout, clearTimeout);
    return module.exports;
  }
  localRequire.main = module;
  return new Promise(resolve => {
    load(localRequire, module, proc, { log: text => setImmediate(() => resolve({ result: JSON.parse(text), code: proc.exitCode || 0 })) },
      (fn, ms) => setTimeout(fn, ms === 1400 ? 30 : ms), clearTimeout);
  });
}

async function main() {
  const api = run();
  assert.deepEqual(api.getSettings(), { source: 'webos', host: '', displayMax: 100 });
  for (const invalid of ['localhost', '203.0.113.1', 'speaker.invalid', '10.77.42.55/somewhere', '10.77.42.999']) {
    assert.equal((await run(['probe', invalid])).code, 1);
  }
  assert.deepEqual(actions, [], 'untrusted hosts make no outbound request');
  assert.deepEqual((await run(['discover'])).result.rooms, [{ name: 'Kitchen & Hall', host: speaker }]);
  assert.deepEqual((await run(['probe', speaker])).result, { name: 'Kitchen & Hall', volume: 8, mute: true });
  assert.deepEqual((await run(['set', 'sonos', speaker])).result, { ok: true });
  assert.deepEqual((await run(['get'])).result, { source: 'sonos', host: speaker, displayMax: 100 });
  assert.equal(fs.statSync(path.join(directory, 'settings.json')).mode & 0o777, 0o600);

  await run(['set', 'sonos', speaker, '50']);
  await run(['set', 'sonos', speaker]);
  assert.deepEqual(api.getSettings(), { source: 'sonos', host: speaker, displayMax: 50 }, 'preserve scale for the same speaker');
  await run(['set', 'sonos', surround]);
  assert.equal(api.getSettings().displayMax, 100, 'a new speaker defaults to the native scale');
  await run(['set', 'sonos', surround, '50']);
  await run(['set', 'sonos', surround, '100']);
  assert.equal(api.getSettings().displayMax, 100);
  await run(['set', 'sonos', speaker, '100']);
  assert.equal((await run(['set', 'sonos', speaker, '25'])).code, 1);
  actions.length = 0;
  volume = '0'; mute = 'false';
  const current = () => new Promise((resolve, reject) => api.getStatus(speaker, (error, status) => error ? reject(error) : resolve(status)));
  assert.deepEqual(await current(), { volume: 0, mute: false });
  assert.deepEqual(actions, ['GetVolume', 'GetMute'], 'normal polling does not request metadata');
  mute = 'unknown';
  await assert.rejects(current, /boolean/);
  mute = '1'; volume = '101';
  await assert.rejects(current, /volume/);
  volume = '8'; failReads = true;
  assert.equal((await run(['set', 'sonos', surround])).code, 1);
  assert.equal(api.getSettings().host, speaker, 'failed connection leaves prior settings intact');
  assert.deepEqual((await run(['set', 'webos'])).result, { ok: true });
  assert.equal(api.getSettings().source, 'webos');
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
}

main().then(() => console.log('Sonos CLI, discovery, storage and volume/mute tests passed')).finally(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
}).catch(error => { console.error(error); process.exitCode = 1; });
