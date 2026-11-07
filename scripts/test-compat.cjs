const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const window = {};
vm.runInNewContext(fs.readFileSync('app/compat-check.js', 'utf8'), { window });
const { parse, classify, startCommand, endCommand } = window.earcCompat;

const arc = v => `{"returnValue":true,"Volume":${v}}`;
const out = o => `{"returnValue":true,"volumeStatus":{"volume":8,"soundOutput":"${o}"}}`;
const start = (extra = {}) => ({ size: '100', inode: '7', arc: arc(16), out: out('external_arc'), cec: [], ...extra });
const end = (cec, v = 16, extra = {}) => ({ cec, arc: arc(v), ...extra });

// LG C3 + Polk Signa S4: every press answered.
let r = classify(start(), end(['TX054442', 'RX507A0E', 'TX054441', 'RX507A10', 'RX507A12']));
assert.equal(r.kind, 'good'); assert.equal(r.title, 'Compatible'); assert.match(r.detail, /last: 18/);
// LG C2 + Samsung HW-Q990B: presses sent, nothing comes back.
r = classify(start(), end(['TX054441', 'TX054441', 'TX054441', 'TX054442', 'TX054442', 'TX054442']));
assert.equal(r.kind, 'bad'); assert.equal(r.title, 'Not compatible');
// Some presses answered.
r = classify(start(), end(['TX054441', 'TX054441', 'TX054441', 'TX054441', 'TX054441', 'RX507A10']));
assert.equal(r.title, 'Mostly compatible');
// Only the stored value follows the soundbar.
r = classify(start(), end(['TX054441', 'TX054441'], 20));
assert.equal(r.title, 'Compatible (slower mode)'); assert.match(r.detail, /16 → 20/);
// Nothing pressed.
assert.equal(classify(start(), end([])).title, 'No volume presses detected');
// TV speakers selected.
assert.equal(classify(start({ out: out('tv_speaker') }), end([])).title, 'Sound is not going to a soundbar');
// No CEC log on this TV.
assert.equal(classify(start({ size: 'none' }), end([], 16, { log: 'none' })).title, 'Could not confirm');
// Unknown-volume reports (0x7F) are ignored.
assert.equal(classify(start(), end(['TX054441', 'RX507A7F'])).title, 'Not compatible');

// Run the real shell commands against a fake CEC log and fake luna-send.
const dir = fs.mkdtempSync('/tmp/compat-');
const log = `${dir}/cecmessages`, bin = `${dir}/bin`;
fs.mkdirSync(bin);
fs.writeFileSync(log, '2026-11-07T07:44:00Z [CECMSG] TM1 RX507A05\n');
fs.writeFileSync(`${bin}/luna-send`, '#!/bin/sh\ncase "$*" in *getArcVolume*) echo \'{"returnValue":true,"Volume":16}\';; *) echo \'{"volumeStatus":{"soundOutput":"external_arc"}}\';; esac\n', { mode: 0o755 });
const sh = cmd => execFileSync('sh', ['-c', cmd.split('/var/log/cecmessages').join(log).split('/usr/bin/luna-send').join(`${bin}/luna-send`)], { encoding: 'utf8' });
const s = parse(sh(startCommand()));
assert.equal(s.size, String(fs.statSync(log).size));
assert.equal(soundOut(s.out), 'external_arc');
fs.appendFileSync(log, '2026-11-07T07:44:24Z [CECMSG] TM9 TX054442\n2026-11-07T07:44:24Z [CECMSG] TM9 TX0545\n2026-11-07T07:44:25Z [CECMSG] TM3 RX507A0E\n');
const e = parse(sh(endCommand(s)));
assert.deepEqual(Array.from(e.cec), ['TX054442', 'RX507A0E'], 'only lines written during the check are read');
assert.equal(classify(s, e).title, 'Compatible');
fs.rmSync(dir, { recursive: true });
function soundOut(json) { return (/"soundOutput"\s*:\s*"([^"]+)"/.exec(json) || [])[1]; }
console.log('Compatibility check tests passed');
