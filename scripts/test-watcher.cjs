const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const launches = [], children = [], callbacks = [];
let getterVolume = 6;
const defaultSource = { source: 'webos', host: '', displayMax: 100 };
const context = {
  require(name) {
    if (name === './sonos-settings') return { getSettings() { return defaultSource; } };
    if (name === 'fs') return { appendFileSync() {} };
    if (name === 'child_process') return {
      spawn(command, args) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        children.push({ child, command: args[3] });
        return child;
      },
      execFile(command, args, options, callback) {
        if (command === '/usr/bin/script') { callback(null, JSON.stringify({ Volume: getterVolume })); return; }
        launches.push(JSON.parse(args[3]).params);
        callbacks.push(callback);
      }
    };
    throw new Error(name);
  },
  process: { on() {}, exit() {} }, setTimeout() {}, clearTimeout() {}
};
vm.runInNewContext(fs.readFileSync('runtime/watcher.js', 'utf8'), context);
assert.equal(children.length, 1);
function master(volume, soundOutput = 'external_arc', muteStatus = false) {
  context.processResponse({ volumeStatus: { volume, soundOutput, muteStatus } });
}
function arc(Volume) { context.processArcResponse({ Volume }); }
function finish() { callbacks.shift()(null); }
master(5);
arc(6);
assert.equal(launches.at(-1).volume, 6, 'ARC corrects a drifting master value');
finish();
master(20);
assert.equal(launches.length, 1, 'held-button master updates cannot override ARC');
arc(7);
arc(8);
arc(9);
assert.equal(launches.length, 2, 'only one launch can be in flight');
finish();
assert.equal(launches.at(-1).volume, 9, 'pending values coalesce to newest');
finish();
for (const invalid of [127, -1, null, '10', NaN, 101]) arc(invalid);
assert.equal(launches.length, 3);
master(20, 'external_arc', true);
assert.equal(launches.at(-1).mute, true, 'master mute is retained');
assert.equal(launches.at(-1).volume, 9);
finish();
master(20, 'tv_speaker');
arc(10);
assert.equal(launches.length, 4, 'no overlay for another output');
master(20);
assert.equal(launches.length, 4, 'returning to ARC establishes baseline');
arc(11);
assert.equal(launches.at(-1).volume, 11);
finish();
// Exercise the stream parser with a response split across chunks.
children[0].child.stdout.emit('data', '{"volumeStatus":{"volume":99,');
children[0].child.stdout.emit('data', '"soundOutput":"external_arc"}}\r\n');
arc(12);
assert.equal(launches.at(-1).volume, 12);
finish();
// Reproduce the TV's missing subscription updates using only getter reads.
for (getterVolume of [0, 1, 2, 3, 4, 5]) {
  context.pollArc();
  assert.equal(launches.at(-1).volume, getterVolume, 'getter corrects missing low-volume notifications');
  finish();
}
arc(100); finish();
let before = launches.length;
context.lastShownAt = 0;
context.processCECLine('[CECMSG] TX054441');
assert.equal(launches.length, before + 1, 'up at 100 refreshes overlay');
assert.equal(launches.at(-1).volume, 100);
finish();
context.processCECLine('[CECMSG] TX054441');
assert.equal(launches.length, before + 1, 'limit repeat refreshes are throttled');
arc(0); finish();
before = launches.length;
context.lastShownAt = 0;
context.processCECLine('[CECMSG] TX054442');
assert.equal(launches.length, before + 1, 'down at zero refreshes overlay');
assert.equal(launches.at(-1).volume, 0);
finish();
before = launches.length;
context.lastShownAt = 0;
context.processCECLine('[CECMSG] TX054441');
context.processCECLine('[CECMSG] TX0545');
assert.equal(launches.length, before, 'opposite direction and key releases do not fake changes');
master(0, 'tv_speaker');
context.processCECLine('[CECMSG] TX054442');
assert.equal(launches.length, before, 'limit activity is ignored on other outputs');

let config = { source: 'sonos', host: '10.77.42.55', displayMax: 100 };
let pendingRead;
const roomsRead = [];
const sourceApi = {
  getSettings() {
    if (config instanceof Error) throw config;
    return config;
  },
  getStatus(host, callback) {
    assert.equal(pendingRead, undefined, 'only one speaker request in flight');
    roomsRead.push(host);
    pendingRead = callback;
  }
};
const sonos = {
  ...context,
  require(name) { return name === './sonos-settings' ? sourceApi : context.require(name); }
};
vm.runInNewContext(fs.readFileSync('runtime/watcher.js', 'utf8'), sonos);
function lg(volume, soundOutput = 'external_arc', muteStatus = false) {
  sonos.processResponse({ volumeStatus: { volume, soundOutput, muteStatus } });
}
function reply(volume, mute = false, error) {
  if (!pendingRead) sonos.pollArc();
  const receive = pendingRead;
  pendingRead = undefined;
  receive(error, { volume, mute });
}
const start = launches.length;
lg(4);
assert.equal(launches.length, start, 'no LG fallback at startup');
reply(8);
assert.equal(launches.length, start, 'startup merely establishes the Sonos baseline');
lg(0);
assert.equal(launches.length, start, 'a key press waits for a fresh speaker response');
reply(4);
assert.equal(launches.at(-1).volume, 4, 'LG 0 / Sonos 4 shows 4');
finish();
reply(0);
assert.equal(launches.at(-1).volume, 0, 'zero reported by Sonos is valid');
finish();
lg(3);
const beforeFailure = launches.length;
reply(null, false, new Error('timeout'));
lg(2);
assert.equal(launches.length, beforeFailure, 'unavailable speaker never falls back to LG');
reply(8);
assert.equal(launches.at(-1).volume, 8, 'recovers when the speaker returns');
finish();
lg(2, 'external_arc', true);
const beforeMute = launches.length;
reply(8, false);
assert.equal(launches.length, beforeMute, 'a muted LG cannot change the Sonos mute state');
reply(8, true);
assert.equal(launches.at(-1).mute, true, 'Sonos mute follows the speaker');
assert.equal(launches.at(-1).volume, 8, 'mute does not zero the stored volume');
finish();
reply(8, false);
assert.equal(launches.at(-1).mute, false, 'unmuting Sonos while LG stays muted');
finish();
sonos.pollArc();
lg(12, 'tv_speaker');
const beforeSwitch = launches.length;
reply(9);
assert.equal(launches.length, beforeSwitch, 'ignore in-flight response after leaving ARC');
lg(4);
sonos.pollArc();
config = { source: 'sonos', host: '10.77.42.56', displayMax: 50 };
sonos.refreshSettings();
reply(75);
assert.equal(launches.length, beforeSwitch, 'old room cannot launch while a changed source is pending');
reply(15, false);
assert.equal(roomsRead.at(-1), config.host);
assert.equal(sonos.arcVolume, 15);
assert.equal(sonos.halfScale, true);
const chosen = config;
config = new Error('bad setting');
sonos.refreshSettings();
assert.equal(sonos.sonosHost, chosen.host, 'keep the last valid room after a bad read');
config = { ...chosen, displayMax: 100 };
sonos.refreshSettings();
assert.equal(sonos.halfScale, false, 'apply a scale-only change');
reply(15, false);
config = { ...config, displayMax:50 };
sonos.refreshSettings();
reply(15);
for (const raw of [8,10,12,14,13,11,9,1,0,98,100]) {
  sonos.processResponse({ volumeStatus: { volume: 4, soundOutput: 'external_arc', muteStatus: false, cause: 'volumeUp' } });
  assert.equal(typeof pendingRead, 'function', 'a remote key starts an immediate read');
  reply(raw);
  assert.equal(launches.at(-1).volume, Math.round(raw / 2));
  assert.equal(launches.at(-1).volumePercent, raw, 'the bar tracks actual volume');
  finish();
}
reply(100,true);
assert.equal(launches.at(-1).volume,50);
assert.equal(launches.at(-1).mute,true);
finish();
config = defaultSource;
sonos.refreshSettings();
const beforeCec = launches.length;
sonos.processArcResponse({ Volume: 100 });
if (launches.length > beforeCec) finish();
const beforeLimit = launches.length;
sonos.lastShownAt = 0;
sonos.processCECLine('[CECMSG] TX054441');
assert.equal(launches.length, beforeLimit + 1, 'returning to webOS re-enables CEC limit feedback');
finish();

console.log('Watcher tests passed');
