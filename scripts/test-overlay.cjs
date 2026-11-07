const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
let focused = null;
for (const id of ['overlay', 'volume-fill', 'value', 'status', 'enable', 'disable', 'test', 'size-small', 'size-medium', 'size-large', 'check', 'result', 'result-title', 'result-detail']) {
  elements[id] = { id, style: {}, className: '', textContent: '', focus() { focused = id; document.activeElement = this; } };
}
const storage = new Map([['earc.overlaySize', 'medium']]);
const listeners = {}, timers = new Map();
let nextTimer = 0, activations = 0, closes = 0;
const windowTypes = [], inputRegions = [], focusModes = [], keyMasks = [];
const window = {
  localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)) },
  earcRootExec(command, callback) { callback(null, 'enabled-running'); },
  PalmSystem: { launchParams: { volume: 6 }, activate() { activations++; }, setWindowProperty(key, type) { if(key==='_WEBOS_WINDOW_TYPE')windowTypes.push(type); if(key==='needFocus')focusModes.push(type); }, setInputRegion(region) { inputRegions.push(JSON.parse(JSON.stringify(region))); }, setKeyMask(mask) { keyMasks.push(Array.from(mask)); } },
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
fire(20); fire(60);
assert.equal(elements.overlay.className, 'show');
assert.equal(elements.value.textContent, '6');
assert.equal(elements.overlay.style.fontSize, '15px', 'saved overlay size is applied on start');
assert.equal(elements['size-medium'].className, 'selected');
window.PalmSystem.launchParams = { volume: 7 };
window.webOSRelaunch();
assert.equal(elements.overlay.className, 'show', 'visible update must not hide the overlay');
assert.equal(elements.value.textContent, '7');
assert.equal(activations, 1, 'updates to a visible overlay must not reacquire native keyboard focus');
listeners.webOSRelaunch({ detail: { volume: 8 } });
assert.equal(elements.value.textContent, '8');
listeners.webOSRelaunch({});
assert.equal(document.body.className, 'overlay-mode', 'empty event must not open setup');
assert.equal([...timers.values()].filter(t => t.ms === 1850).length, 1);
fire(1850);
assert.equal(elements.overlay.className, '');
listeners.webOSRelaunch({ detail: { volume: 9 } });
fire(220);
assert.equal(closes, 0, 'an update during fade-out cancels close');
fire(20); fire(60);
assert.equal(elements.overlay.className, 'show');
fire(1850); fire(220);
assert.equal(closes, 0, 'the overlay stays resident after fading out');
assert.equal(document.body.className, 'overlay-mode');
listeners.webOSRelaunch({ detail: { volume: 9, pending: true } });
assert.equal(elements.value.className, 'pending', 'unconfirmed key presses are dimmed');
listeners.webOSRelaunch({ detail: { volume: 10, pending: false } });
assert.equal(elements.value.className, '');
assert.equal(elements.value.textContent, '10');
fire(20); fire(60); fire(1850); fire(220);
// The latest appearance also schedules a focus release.
assert.equal(windowTypes[0], '_WEBOS_WINDOW_TYPE_FLOATING');
assert.equal(focusModes.at(-1), 'false', 'overlay releases input focus after native window creation');
assert.equal(inputRegions[0][0].width, 0, 'native input region must be a zero-size rectangle');
assert.deepEqual(keyMasks.at(-1), ['KeyMaskDefault']);
window.PalmSystem.launchParams = {};
window.webOSRelaunch();
assert.equal(document.body.className, 'setup-mode', 'opening the launcher shows settings');
assert.equal(windowTypes.at(-1), '_WEBOS_WINDOW_TYPE_CARD');
listeners.webOSRelaunch({ detail: { volume: 20 } });
assert.equal(document.body.className, 'setup-mode', 'background updates do not dismiss settings');
elements.test.onclick();
assert.equal(windowTypes.at(-1), '_WEBOS_WINDOW_TYPE_FLOATING');
fire(20); fire(1850); fire(220);
assert.equal(document.body.className, 'setup-mode', 'preview returns to settings');
assert.equal(windowTypes.at(-1), '_WEBOS_WINDOW_TYPE_CARD');
// Opening settings during a live overlay cancels its pending window close.
listeners.webOSRelaunch({ detail: { volume: 21 } });
listeners.webOSRelaunch({ detail: {} });
fire(1850); fire(220);
assert.equal(document.body.className, 'setup-mode');
assert.equal(closes, 0);
assert.equal(focusModes.at(-1), 'true', 'settings restores input focus');
assert.deepEqual(keyMasks.at(-1), ['KeyMaskDefault']);
assert.equal(inputRegions.at(-1)[0].width, 1920);
let prevented = false;
listeners.keydown({keyCode:461, preventDefault() { prevented = true; }});
assert.equal(prevented, true);
assert.equal(closes, 1, 'Back closes settings instead of leaving hidden settings state');
document.hidden = true;
listeners.visibilitychange();
assert.equal(closes, 2, 'system hiding settings also closes it');
listeners.webOSRelaunch({detail:{volume:22}});
assert.equal(document.body.className, 'overlay-mode', 'a watcher launch can recover a hidden settings instance');
assert.equal(elements.value.textContent, '22');
fire(60);
assert.equal(focusModes.at(-1), 'false');
assert.equal(inputRegions.at(-1)[0].width, 0);
assert.deepEqual(keyMasks.at(-1), ['KeyMaskDefault']);
console.log('Overlay lifecycle tests passed');

// Overlay size setting: choosing a size saves it, applies it and previews it.
window.PalmSystem.launchParams = {};
window.webOSRelaunch();
assert.equal(document.body.className, 'setup-mode');
elements['size-small'].onclick();
assert.equal(storage.get('earc.overlaySize'), 'small');
assert.equal(elements.overlay.style.fontSize, '11px');
assert.equal(elements['size-small'].className, 'selected');
assert.equal(elements['size-medium'].className, '');
assert.equal(document.body.className, 'overlay-mode', 'choosing a size previews the overlay');
fire(20); fire(60); fire(1850); fire(220);
assert.equal(document.body.className, 'setup-mode', 'preview returns to setup');
fire(30);
assert.equal(focused, 'size-small', 'focus returns to the chosen size');
// Remote navigation between the two button rows.
listeners.keydown({ keyCode: 38, preventDefault() {} });
assert.equal(focused, 'enable');
listeners.keydown({ keyCode: 39, preventDefault() {} });
assert.equal(focused, 'disable');
listeners.keydown({ keyCode: 40, preventDefault() {} });
assert.equal(focused, 'size-small', 'down goes to the selected size');
listeners.keydown({ keyCode: 39, preventDefault() {} });
assert.equal(focused, 'size-medium');
console.log('Overlay size tests passed');
