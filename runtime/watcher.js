'use strict';

var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;
var fs = require('fs');
var sonos = require('./sonos-settings');
var APP_ID = 'com.github.nikolay1243.earcvolume';
var LOG = '/tmp/earc-volume-overlay.log';
var DEBUG = process.env && process.env.EARC_VOLUME_DEBUG === '1';
var sonosHost = null;
var halfScale = false;
var sonosMute = false;
var settingsReady = false;
var settingsError = null;
var sourceVersion = 0;
var readVersion = 0;
var refreshOnRead = false;
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
  var params = { volume: status.volume, mute: status.muteStatus, output: 'external_arc' };
  if (halfScale) {
    params.volumePercent = status.volume;
    params.volume = Math.round(status.volume / 2);
  }
  var payload = JSON.stringify({ id: APP_ID, params: params });
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
  if (!settingsReady) return;
  var volume = arcVolume === null && !sonosHost ? master.volume : arcVolume;
  if (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 100) return;
  var status = { volume: volume, muteStatus: sonosHost ? sonosMute : !!master.muteStatus };
  var current = String(volume) + ':' + String(status.muteStatus);
  if (last === null) {
    last = current;
    log('watching external_arc at ' + current);
    if (sonosHost && activity) show(status);
    return;
  }
  if (current === last) {
    // Master activity keeps the indicator visible even when the soundbar sends
    // sparse reports or is already at its volume limit. Never use its number.
    if (activity && Date.now() - lastShownAt >= 800) show(status);
    return;
  }
  last = current;
  debug('changed to ' + current);
  show(status);
}

function processResponse(response) {
  var status = response && response.volumeStatus;
  if (!status) return;
  var activity = master && (master.volume !== status.volume || master.muteStatus !== status.muteStatus);
  var enteringArc = !master || master.soundOutput !== 'external_arc';
  if (master && master.soundOutput !== status.soundOutput) readVersion++;
  master = status;
  if (sonosHost) {
    var keyUp = status.cause === 'volumeUp';
    var keyDown = status.cause === 'volumeDown';
    var key = keyUp || keyDown;
    if (status.soundOutput !== 'external_arc') {
      arcVolume = null;
      refreshOnRead = false;
      update();
    } else if (enteringArc || activity || key) {
      if (!enteringArc && (activity || key)) {
        // Wait for the speaker before showing the scaled number after a key.
        // At either limit a confirmed, unchanged reading still merits a display.
        var atLimit = (keyUp && arcVolume === 100) || (keyDown && arcVolume === 0);
        refreshOnRead = !halfScale || !key || atLimit;
      }
      wakeArcPoll(key);
    }
    return;
  }
  if (activity) wakeArcPoll();
  update(activity);
}

function processArcResponse(response, activity) {
  var volume = response && response.Volume;
  // CEC's unknown-volume value (127) must never become an on-screen number.
  if (typeof volume !== 'number' || !isFinite(volume) || volume < 0 || volume > 100) return;
  if (arcVolume === null) log(sonosHost ? 'using Sonos volume' : 'using ARC-reported volume');
  arcVolume = volume;
  update(activity);
}

// Settings are a small, atomically replaced JSON file. Keep the previous valid
// source on a read error, and discard outstanding reads from any former room.
function refreshSettings() {
  var settings;
  try {
    settings = sonos.getSettings();
    settingsError = null;
  } catch (e) {
    if (settingsError !== e.message) log('volume settings unavailable: ' + e.message);
    settingsError = e.message;
    return;
  }
  var host = settings.source === 'sonos' ? settings.host : null;
  var nextHalfScale = Boolean(host && settings.displayMax === 50);
  if (settingsReady && host === sonosHost && halfScale === nextHalfScale) return;
  settingsReady = true;
  sonosHost = host;
  halfScale = nextHalfScale;
  sourceVersion++;
  readVersion++;
  arcVolume = null;
  sonosMute = false;
  last = null;
  queued = null;
  refreshOnRead = false;
  pollFailed = false;
  activeUntil = 0;
  log(sonosHost ? 'source selected: Sonos' : 'source selected: webOS');
  if (!sonosHost) watchCECKeys(sourceVersion);
  if (master && master.soundOutput === 'external_arc') wakeArcPoll();
}

function checkSettings() {
  if (stopping) return;
  refreshSettings();
  setTimeout(checkSettings, 1000);
}

function readWebOsVolume(callback) {
  var command = "/usr/bin/luna-send -n 1 'luna://com.webos.service.eim/getArcVolume' '{}'";
  execFile('/usr/bin/script', ['-q', '-c', command, '/dev/null'], { timeout: 1500 }, function (error, stdout) {
    if (error) return callback(error);
    var match = String(stdout).match(/\{[^]*\}/);
    var volume;
    try { volume = match && JSON.parse(match[0]).Volume; } catch (e) { return callback(e); }
    if (typeof volume !== 'number' || volume < 0 || volume > 100) return callback(new Error('ARC volume unavailable'));
    callback(null, { volume: volume });
  });
}

function pollArc() {
  pollTimer = null;
  if (stopping || polling) return;
  if (!settingsReady || !master || master.soundOutput !== 'external_arc') {
    pollTimer = setTimeout(pollArc, 1000);
    return;
  }
  polling = true;
  var previous = arcVolume;
  var version = readVersion;
  function received(error, status) {
    polling = false;
    if (stopping) return;
    if (readVersion !== version) {
      pollTimer = setTimeout(pollArc, 0);
      return;
    }
    if (error) {
      if (!pollFailed) log((sonosHost ? 'Sonos' : 'ARC') + ' getter failed: ' + error.message);
      pollFailed = true;
      if (sonosHost) {
        arcVolume = null;
        queued = null;
      }
    } else if (master && master.soundOutput === 'external_arc') {
      if (sonosHost) sonosMute = status.mute;
      processArcResponse({ Volume: status.volume }, refreshOnRead);
      if (arcVolume !== previous) activeUntil = Date.now() + 2500;
      pollFailed = false;
    }
    refreshOnRead = false;
    pollTimer = setTimeout(pollArc, !pollFailed && Date.now() < activeUntil ? 150 : 1000);
  }
  if (sonosHost) sonos.getStatus(sonosHost, received);
  else readWebOsVolume(received);
}

function wakeArcPoll(immediate) {
  var idle = Date.now() >= activeUntil;
  activeUntil = Date.now() + 2500;
  if ((idle || immediate) && !polling) {
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
    master = null;
    update();
    readVersion++;
    watchers = watchers.filter(function (item) { return item !== watcher; });
    if (!stopping) {
      log(method + ' exited (' + code + '), restarting');
      setTimeout(function () { subscribe(method, receive); }, 2000);
    }
  });
}

function processCECLine(line) {
  var key = /\bTX0544(41|42)\b/i.exec(line);
  if (sonosHost || !key || !master || master.soundOutput !== 'external_arc') return;
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
function watchCECKeys(version) {
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
    if (stopping || version !== sourceVersion) return;
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
log('service starting (configurable volume source)');
checkSettings();
subscribe('com.webos.service.audio/master/getVolume', processResponse);
if (!polling && !pollTimer) pollArc();
