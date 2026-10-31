const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
for (const id of ['overlay', 'volume-fill', 'value', 'status', 'enable', 'disable', 'test']) {
  elements[id] = { style: {}, className: '', textContent: '', focus() {} };
}
const listeners = {}, timers = new Map();
let nextTimer = 0, activations = 0, closes = 0;
const window = {
  PalmSystem: { launchParams: { volume: 6 }, activate() { activations++; } },
  setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearTimeout(id) { timers.delete(id); }, close() { closes++; }
};
const document = {
  body: { className: '' }, getElementById(id) { return elements[id]; },
  addEventListener(name, fn) { listeners[name] = fn; }
};
const html = fs.readFileSync('app/index.html', 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
vm.runInNewContext(script, { window, document, PalmSystem: window.PalmSystem });
function fire(ms) {
  for (const [id, timer] of [...timers]) if (timer.ms === ms) {
    timers.delete(id); timer.fn();
  }
}
fire(20);
assert.equal(elements.overlay.className, 'show');
assert.equal(elements.value.textContent, '6');
window.PalmSystem.launchParams = { volume: 7 };
window.webOSRelaunch();
assert.equal(elements.overlay.className, 'show', 'visible update must not hide the overlay');
assert.equal(elements.value.textContent, '7');
assert.equal(activations, 2, 'acknowledge each handled relaunch without hiding the window');
listeners.webOSRelaunch({ detail: { volume: 8 } });
assert.equal(elements.value.textContent, '8');
window.PalmSystem.launchParams = {};
listeners.webOSRelaunch({});
assert.equal(document.body.className, 'overlay-mode', 'empty event must not open setup');
assert.equal([...timers.values()].filter(t => t.ms === 1850).length, 1);
fire(1850);
assert.equal(elements.overlay.className, '');
listeners.webOSRelaunch({ detail: { volume: 9 } });
fire(220);
assert.equal(closes, 0, 'an update during fade-out cancels close');
fire(20);
assert.equal(elements.overlay.className, 'show');
fire(1850); fire(220);
assert.equal(closes, 1);
console.log('Overlay lifecycle tests passed');
