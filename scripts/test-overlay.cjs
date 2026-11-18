const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const elements = {};
function element() {
  return {
    style: {}, className: '', textContent: '', value: '', children: [], attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; }, getAttribute(name) { return this.attrs[name]; },
    appendChild(child) { this.children.push(child); }, focus() { document.activeElement = this; }
  };
}
for (const id of ['overlay', 'mute-icon', 'volume-fill', 'value', 'status', 'enable', 'disable', 'test',
  'source-webos', 'source-sonos', 'sonos-options', 'sonos-host', 'find-rooms', 'room-list',
  'test-room', 'save-source', 'source-message', 'scale-native', 'scale-half']) elements[id] = element();
const commands = [];
let settings = {source:'webos', host:'', displayMax:100};
const listeners = {}, timers = new Map();
let nextTimer = 0, activations = 0, closes = 0;
const windowTypes = [], inputRegions = [], focusModes = [], keyMasks = [];
const window = {
  earcRootExec(command, callback) {
    const args = command.match(/sonos-settings\.js" ([^\n]+) \|\| :$/);
    if (!args) return callback(null, 'enabled-running');
    commands.push(args[1]);
    let result;
    switch (args[1]) {
      case 'get': result = settings; break;
      case 'discover': result = {rooms:[{name:'Living room', host:'10.77.42.17'}]}; break;
      case 'probe 10.77.42.17': result = {name:'Living room', volume:8, mute:true}; break;
      case 'set sonos 10.77.42.17 100': settings = {source:'sonos',host:'10.77.42.17',displayMax:100}; result = {ok:true}; break;
      case 'set sonos 10.77.42.17 50': settings = {source:'sonos',host:'10.77.42.17',displayMax:50}; result = {ok:true}; break;
      case 'set webos': settings = {source:'webos',host:'',displayMax:100}; result = {ok:true}; break;
      default: throw new Error('Unexpected helper operation ' + args[1]);
    }
    callback(null, JSON.stringify(result));
  },
  PalmSystem: { launchParams: { volume: 6 }, activate() { activations++; }, setWindowProperty(key, type) { if(key==='_WEBOS_WINDOW_TYPE')windowTypes.push(type); if(key==='needFocus')focusModes.push(type); }, setInputRegion(region) { inputRegions.push(JSON.parse(JSON.stringify(region))); }, setKeyMask(mask) { keyMasks.push(Array.from(mask)); } },
  setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
  clearTimeout(id) { timers.delete(id); }, close() { closes++; }
};
const document = {
  createElement:element, body: { className: '' }, getElementById(id) { return elements[id]; },
  addEventListener(name, fn) { listeners[name] = fn; }
};
const html = fs.readFileSync('app/index.html', 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({ window, document, PalmSystem: window.PalmSystem });
vm.runInContext(fs.readFileSync('app/source-settings.js', 'utf8'), context);
vm.runInContext(script, context);
assert.deepEqual(commands, [], 'a volume overlay must never load setup or trigger Sonos discovery');
function fire(ms) {
  for (const [id, timer] of [...timers]) if (timer.ms === ms) {
    timers.delete(id); timer.fn();
  }
}
assert.equal(elements.overlay.className, 'show', 'volume is visible on the first render');
fire(60);
assert.equal(elements.overlay.className, 'show');
assert.equal(elements.value.textContent, '6');
window.PalmSystem.launchParams = { volume: 7 };
window.webOSRelaunch();
assert.equal(elements.overlay.className, 'show', 'visible update must not hide the overlay');
assert.equal(elements.value.textContent, '7');
assert.equal(activations, 1, 'updates to a visible overlay must not reacquire native keyboard focus');
listeners.webOSRelaunch({ detail: { volume: 8 } });
assert.equal(elements.value.textContent, '8');
listeners.webOSRelaunch({ detail: { volume: 8, mute: true } });
assert.equal(elements.value.textContent, '8', 'mute preserves the real numeric volume');
assert.equal(elements['mute-icon'].hidden, false);
assert.equal(elements['volume-fill'].style.transform, 'scaleX(0.08)');
listeners.webOSRelaunch({ detail: { volume: 4, volumePercent: 8, mute: true } });
assert.equal(elements.value.textContent, '4');
assert.equal(elements['mute-icon'].hidden, false);
assert.equal(elements['volume-fill'].style.transform, 'scaleX(0.08)');
listeners.webOSRelaunch({ detail: { volume: 8, mute: false } });
assert.equal(elements['mute-icon'].hidden, true);
listeners.webOSRelaunch({});
assert.equal(document.body.className, 'overlay-mode', 'empty event must not open setup');
assert.equal([...timers.values()].filter(t => t.ms === 1850).length, 1);
fire(1850);
assert.equal(elements.overlay.className, '');
listeners.webOSRelaunch({ detail: { volume: 9 } });
fire(220);
assert.equal(closes, 0, 'an update during fade-out cancels close');
assert.equal(elements.overlay.className, 'show', 'volume is visible on the first render');
fire(60);
assert.equal(elements.overlay.className, 'show');
fire(1850); fire(220);
assert.equal(closes, 1);
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
assert.equal(elements['sonos-options'].hidden, true);
elements['source-sonos'].onclick();
assert.equal(elements['sonos-options'].hidden, false);
elements['find-rooms'].onclick();
const roomButton = elements['room-list'].children[0];
assert.equal(roomButton.textContent, 'Living room');
roomButton.onclick();
assert.equal(elements['sonos-host'].value, '10.77.42.17');
elements['test-room'].onclick();
assert.match(elements['source-message'].textContent, /Living room.*8.*Muted/);
elements['save-source'].onclick();
assert.equal(commands.at(-1), 'set sonos 10.77.42.17 100');
elements['scale-half'].onclick();
assert.equal(elements['scale-half'].getAttribute('aria-pressed'), 'true');
elements['test-room'].onclick();
assert.match(elements['source-message'].textContent, /Sonos 8.*TV 4.*Muted/);
elements.test.onclick();
assert.equal(elements.value.textContent,'21', 'preview follows the draft scale');
assert.equal(elements['volume-fill'].style.transform,'scaleX(0.42)');
assert.equal(windowTypes.at(-1), '_WEBOS_WINDOW_TYPE_FLOATING');
fire(1850); fire(220);
assert.equal(document.body.className, 'setup-mode', 'preview returns to settings');
assert.equal(elements['scale-half'].getAttribute('aria-pressed'), 'true', 'preview preserves unsaved changes');
elements['save-source'].onclick();
assert.equal(commands.at(-1), 'set sonos 10.77.42.17 50');
const beforeInvalid = commands.length;
for (const invalid of ['10.77.42.17; id','10.77.42\n.17','10.77.42.256']) {
  elements['sonos-host'].value = invalid;
  elements['test-room'].onclick();
  elements['save-source'].onclick();
}
assert.equal(commands.length, beforeInvalid, 'invalid manual IP cannot reach a shell');
assert.equal(elements['source-message'].className, 'error');
window.PalmSystem.launchParams = {};
window.webOSRelaunch();
assert.equal(elements['sonos-host'].value, '10.77.42.17', 'reopened settings read the saved host');
assert.equal(elements['source-sonos'].getAttribute('aria-pressed'), 'true');
assert.equal(elements['scale-half'].getAttribute('aria-pressed'), 'true');
elements['scale-native'].onclick();
elements.test.onclick();
assert.equal(elements.value.textContent,'42', 'native scale previews the full Sonos level');
assert.equal(elements['volume-fill'].style.transform,'scaleX(0.42)');
fire(1850); fire(220);
const ipField = elements['sonos-host'], probeButton = elements['test-room'];
ipField.getBoundingClientRect = () => ({left:0,right:200,top:0,bottom:40,width:200,height:40});
probeButton.getBoundingClientRect = () => ({left:220,right:370,top:0,bottom:40,width:150,height:40});
document.querySelectorAll = () => [ipField, probeButton];
ipField.focus();
function right() { listeners.keydown({keyCode:39,preventDefault(){}}); }
ipField.selectionStart = ipField.selectionEnd = 0;
right();
assert.equal(document.activeElement, ipField, 'the right arrow moves the caret inside an IP');
ipField.selectionStart = ipField.selectionEnd = ipField.value.length;
right();
assert.equal(document.activeElement, probeButton, 'the remote can reach the check button at the end of the field');
elements['source-webos'].onclick();
elements['save-source'].onclick();
assert.equal(commands.at(-1), 'set webos');
assert.equal(windowTypes.at(-1), '_WEBOS_WINDOW_TYPE_CARD');
// Opening settings during a live overlay cancels its pending window close.
listeners.webOSRelaunch({ detail: { volume: 21 } });
listeners.webOSRelaunch({ detail: {} });
fire(1850); fire(220);
assert.equal(document.body.className, 'setup-mode');
assert.equal(closes, 1);
assert.equal(focusModes.at(-1), 'true', 'settings restores input focus');
assert.deepEqual(keyMasks.at(-1), ['KeyMaskDefault']);
assert.equal(inputRegions.at(-1)[0].width, 1920);
let prevented = false;
listeners.keydown({keyCode:461, preventDefault() { prevented = true; }});
assert.equal(prevented, true);
assert.equal(closes, 2, 'Back closes settings instead of leaving hidden settings state');
document.hidden = true;
listeners.visibilitychange();
assert.equal(closes, 3, 'system hiding settings also closes it');
listeners.webOSRelaunch({detail:{volume:22}});
assert.equal(document.body.className, 'overlay-mode', 'a watcher launch can recover a hidden settings instance');
assert.equal(elements.value.textContent, '22');
fire(60);
assert.equal(focusModes.at(-1), 'false');
assert.equal(inputRegions.at(-1)[0].width, 0);
assert.deepEqual(keyMasks.at(-1), ['KeyMaskDefault']);
console.log('Overlay lifecycle tests passed');
