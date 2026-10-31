const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const launches = [], children = [], callbacks = [];
let getterVolume = 6;
const context = {
  require(name) {
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
console.log('Watcher tests passed');
