'use strict';

var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;
var fs = require('fs');

var APP_ID = 'com.github.nikolay1243.earcvolume';
var LOG = '/tmp/earc-volume-overlay.log';
var DEBUG = process.env && process.env.EARC_VOLUME_DEBUG === '1';
var last = null;
var master = null;
var arcVolume = null;
var watchers = [];
var stopping = false;
var launching = false;
var queued = null;
var lastShownAt = 0;
var pollTimer = null;
var polling = false;
var activeUntil = 0;
var pollFailed = false;

function log(message) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\n'); } catch (e) {}
}

function debug(message) { if (DEBUG) log(message); }

// Keep only the newest update while a launch is in flight. Rapid key repeats
// must not build a queue of old values or launch concurrent luna-send processes.
function show(status) {
  lastShownAt = Date.now();
  queued = status;
  flush();
}

function flush() {
  if (launching || !queued || stopping) return;
  var status = queued;
  queued = null;
  launching = true;
  var payload = JSON.stringify({
    id: APP_ID,
    params: {
      volume: status.volume,
      mute: status.muteStatus,
      output: 'external_arc'
    }
  });
  var started = Date.now();
  debug('launch requested for ' + status.volume);
  execFile('/usr/bin/luna-send', [
    '-n', '1', 'luna://com.webos.applicationManager/launch', payload
  ], { timeout: 3000 }, function (error) {
    launching = false;
    if (error) log('launch failed: ' + error.message);
    else debug('launch request completed for ' + status.volume + ' in ' + (Date.now() - started) + 'ms');
    flush();
  });
}

function update(activity) {
  if (!master || master.soundOutput !== 'external_arc') {
    last = null;
    queued = null;
    return;
  }
  // EIM tracks received HDMI-CEC Report Audio Status messages. The master
  // volume can drift during held buttons and even ignore the soundbar remote.
  var volume = arcVolume === null ? master.volume : arcVolume;
  if (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 100) return;
  var status = { volume: volume, muteStatus: !!master.muteStatus };
  var current = String(volume) + ':' + String(status.muteStatus);
  if (last === null) {
    last = current;
    log('watching external_arc at ' + current);
    return;
  }
  if (current === last) {
    // Master activity keeps the indicator visible even when the soundbar sends
    // sparse reports or is already at its volume limit. Never use its number.
    if (activity && Date.now() - lastShownAt >= 800) show(status);
    return;
  }
  last = current;
  debug('changed to ' + current + (arcVolume === null ? ' (master fallback)' : ' (ARC reported)'));
  show(status);
}

function processResponse(response) {
  var status = response && response.volumeStatus;
  if (!status) return;
  var activity = master && (master.volume !== status.volume || master.muteStatus !== status.muteStatus);
  master = status;
  if (activity) wakeArcPoll();
  update(activity);
}

function processArcResponse(response) {
  var volume = response && response.Volume;
  // CEC's unknown-volume value (127) must never become an on-screen number.
  if (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 100) return;
  if (arcVolume === null) log('using ARC-reported volume');
  arcVolume = volume;
  update();
}

// EIM's subscription can omit low-volume updates even though its getter is
// current. Read the getter directly; each invocation needs a PTY on these TVs.
function pollArc() {
  pollTimer = null;
  if (stopping || polling) return;
  if (!master || master.soundOutput !== 'external_arc') {
    pollTimer = setTimeout(pollArc, 1000);
    return;
  }
  polling = true;
  var previous = arcVolume;
  var command = "/usr/bin/luna-send -n 1 'luna://com.webos.service.eim/getArcVolume' '{}'";
  execFile('/usr/bin/script', ['-q', '-c', command, '/dev/null'], { timeout: 1500 }, function (error, stdout) {
    polling = false;
    if (stopping) return;
    try {
      if (error) throw error;
      var match = String(stdout).match(/\{[^]*\}/);
      if (!match) throw new Error('missing ARC response');
      var response = JSON.parse(match[0]);
      if (typeof response.Volume !== 'number' || response.Volume < 0 || response.Volume > 100) throw new Error('ARC volume unavailable');
      processArcResponse(response);
      if (arcVolume !== previous) activeUntil = Date.now() + 2500;
      pollFailed = false;
    } catch (e) {
      if (!pollFailed) log('ARC getter failed: ' + e.message);
      pollFailed = true;
    }
    pollTimer = setTimeout(pollArc, Date.now() < activeUntil ? 150 : 1000);
  });
}

function wakeArcPoll() {
  var idle = Date.now() >= activeUntil;
  activeUntil = Date.now() + 2500;
  if (idle && !polling) {
    if (pollTimer) clearTimeout(pollTimer);
    pollArc();
  }
}

function subscribe(method, receive) {
  if (stopping) return;
  var command = "/usr/bin/luna-send -i 'luna://" + method + "' '{\"subscribe\":true}'";
  var watcher = spawn('/usr/bin/script', ['-q', '-f', '-c', command, '/dev/null']);
  watchers.push(watcher);
  var pending = '';
  watcher.stdout.on('data', function (chunk) {
    pending += String(chunk).replace(/\r/g, '');
    var lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) !== '{') return;
      try {
        var response = JSON.parse(line);
        if (response.returnValue === false) {
          log(method + ': ' + (response.errorText || 'subscription rejected'));
          return;
        }
        receive(response);
      } catch (e) { log('parse error: ' + e.message); }
    });
  });
  watcher.stderr.on('data', function (chunk) { log(method + ': ' + String(chunk).trim()); });
  watcher.on('error', function (error) { log(method + ': ' + error.message); });
  watcher.on('exit', function (code) {
    watchers = watchers.filter(function (item) { return item !== watcher; });
    if (!stopping) {
      log(method + ' exited (' + code + '), restarting');
      setTimeout(function () { subscribe(method, receive); }, 2000);
    }
  });
}

function processCECLine(line) {
  var key = /\bTX0544(41|42)\b/i.exec(line);
  if (!key || !master || master.soundOutput !== 'external_arc') return;
  wakeArcPoll();
  var atLimit = (key[1] === '41' && arcVolume === 100) ||
    (key[1] === '42' && arcVolume === 0);
  if (atLimit && Date.now() - lastShownAt >= 300) {
    debug('volume key at ARC limit ' + arcVolume);
    show({ volume: arcVolume, muteStatus: !!master.muteStatus });
  }
}

// Observe existing CEC logs only. No key interception or injected commands.
// Follow truncation/rotation and skip old entries when the watcher starts.
function watchCECKeys() {
  var path = '/var/log/cecmessages';
  var position, inode, pending = '';
  try {
    var initial = fs.statSync(path);
    position = initial.size;
    inode = initial.ino;
  } catch (e) {
    log('CEC key activity unavailable; limit presses will not refresh overlay');
    return;
  }
  function read() {
    if (stopping) return;
    var fd;
    try {
      fd = fs.openSync(path, 'r');
      var stat = fs.fstatSync(fd);
      if (stat.ino !== inode || stat.size < position) { position = 0; pending = ''; }
      inode = stat.ino;
      // Bound work if logging is unusually busy. Resume from a complete line.
      if (stat.size - position > 65536) { position = stat.size - 65536; pending = ''; }
      if (stat.size > position) {
        var buffer = Buffer.alloc(stat.size - position);
        var count = fs.readSync(fd, buffer, 0, buffer.length, position);
        position += count;
        var lines = (pending + buffer.toString('utf8', 0, count)).split('\n');
        pending = lines.pop();
        lines.forEach(processCECLine);
      }
    } catch (e) {
      // Rotation can briefly leave no file; retry without changing TV logging.
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    setTimeout(read, 150);
  }
  setTimeout(read, 150);
}

function stop() {
  stopping = true;
  watchers.forEach(function (watcher) { watcher.kill('SIGTERM'); });
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
log('service starting (ARC-reported volume preferred; master fallback until available)');
subscribe('com.webos.service.audio/master/getVolume', processResponse);
pollArc();

watchCECKeys();
