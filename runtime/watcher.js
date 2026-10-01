'use strict';

var spawn = require('child_process').spawn;
var execFile = require('child_process').execFile;
var fs = require('fs');

var APP_ID = 'com.github.nikolay1243.earcvolume';
var LOG = '/tmp/earc-volume-overlay.log';
var last = null;
var watcher = null;
var stopping = false;

function log(message) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\n'); } catch (e) {}
}

function show(status) {
  var payload = JSON.stringify({
    id: APP_ID,
    params: {
      volume: Number(status.volume) || 0,
      mute: !!status.muteStatus,
      output: status.soundOutput || 'external_arc'
    }
  });
  execFile('/usr/bin/luna-send', [
    '-n', '1', 'luna://com.webos.applicationManager/launch', payload
  ], function (error) {
    if (error) log('launch failed: ' + error.message);
  });
}

function processResponse(response) {
  var status = response && response.volumeStatus;
  if (!status || status.soundOutput !== 'external_arc') return;
  var current = String(status.volume) + ':' + String(!!status.muteStatus);
  if (last === null) {
    last = current;
    log('watching external_arc at ' + current);
    return;
  }
  if (current === last) return;
  last = current;
  log('changed to ' + current);
  show(status);
}

function start() {
  if (stopping) return;
  var command = "/usr/bin/luna-send -i 'luna://com.webos.service.audio/master/getVolume' '{\"subscribe\":true}'";
  watcher = spawn('/usr/bin/script', ['-q', '-f', '-c', command, '/dev/null']);
  var pending = '';
  watcher.stdout.on('data', function (chunk) {
    pending += String(chunk).replace(/\r/g, '');
    var lines = pending.split('\n');
    pending = lines.pop();
    lines.forEach(function (line) {
      line = line.trim();
      if (!line || line.charAt(0) !== '{') return;
      try { processResponse(JSON.parse(line)); } catch (e) { log('parse error: ' + e.message); }
    });
  });
  watcher.stderr.on('data', function (chunk) { log('watcher: ' + String(chunk).trim()); });
  watcher.on('exit', function (code) {
    watcher = null;
    if (!stopping) {
      log('subscription exited (' + code + '), restarting');
      setTimeout(start, 2000);
    }
  });
}

function stop() {
  stopping = true;
  if (watcher) watcher.kill('SIGTERM');
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
log('service starting');
start();
