(function () {
  'use strict';

  window.createVolumeSourceSettings = function (rootExec, findApp) {
    function byId(id) { return document.getElementById(id); }

    var webos = byId('source-webos');
    var sonos = byId('source-sonos');
    var host = byId('sonos-host');
    var options = byId('sonos-options');
    var rooms = byId('room-list');
    var message = byId('source-message');
    var displayMax = 100;
    var source = 'webos';
    var generation = 0;
    var saving = false;

    function notify(text, error) {
      message.className = error ? 'error' : '';
      message.textContent = text;
    }

    function privateIp(value) {
      if (typeof value !== 'string') return false;
      var parts = value.split('.');
      if (parts.length !== 4) return false;
      for (var i = 0; i < parts.length; i++) {
        var octet = Number(parts[i]);
        if (parts[i] !== String(octet) || !isFinite(octet) || Math.floor(octet) !== octet || octet < 0 || octet > 255) return false;
      }
      return parts[0] === '10' || (parts[0] === '192' && parts[1] === '168') ||
        (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31);
    }

    function run(args, callback) {
      // args consists only of fixed verbs and a validated dotted-decimal IPv4.
      var cmd = findApp + '\n/usr/bin/node "$APP_DIR/runtime/sonos-settings.js" ' + args + ' || :';
      rootExec(cmd, function (error, output) {
        if (error) return callback(error);
        var data;
        try { data = JSON.parse(output); } catch (ignore) {}
        if (!data || typeof data !== 'object') return callback(new Error('Settings service returned an invalid response.'));
        if (data.error) return callback(new Error(String(data.error)));
        callback(null, data);
      });
    }

    function selectSource(next) {
      source = next;
      options.hidden = next !== 'sonos';
      webos.setAttribute('aria-pressed', String(next === 'webos'));
      sonos.setAttribute('aria-pressed', String(next === 'sonos'));
    }

    function selectScale(maximum) {
      displayMax = maximum;
      byId('scale-native').setAttribute('aria-pressed', String(maximum === 100));
      byId('scale-half').setAttribute('aria-pressed', String(maximum === 50));
    }
    function chooseScale(maximum) {
      if (saving) return;
      selectScale(maximum);
      edit();
    }
    byId('scale-native').onclick = function () { chooseScale(100); };
    byId('scale-half').onclick = function () { chooseScale(50); };

    function previewVolume(nativeVolume) {
      return source === 'sonos' && displayMax === 50 ? Math.round(nativeVolume / 2) : nativeVolume;
    }

    function edit() {
      generation++;
      notify('');
      markRoom();
    }

    function markRoom() {
      for (var i = 0; i < rooms.children.length; i++) {
        var button = rooms.children[i];
        button.setAttribute('aria-pressed', String(button.getAttribute('data-host') === host.value.trim()));
      }
    }

    function choose(next) {
      if (saving) return;
      selectSource(next);
      edit();
    }
    webos.onclick = function () { choose('webos'); };
    sonos.onclick = function () { choose('sonos'); };
    host.oninput = edit;

    function load() {
      var request = ++generation;
      run('get', function (error, result) {
        if (request !== generation) return;
        if (error) return notify(error.message, true);
        if (result.source !== 'webos' && result.source !== 'sonos') return notify('Unknown saved source.', true);
        host.value = privateIp(result.host) ? result.host : '';
        selectScale(result.displayMax === 50 ? 50 : 100);
        selectSource(result.source);
        markRoom();
        notify('');
      });
    }

    function showRooms(found) {
      rooms.textContent = '';
      var valid = [];
      found.forEach(function (room) {
        if (!room || !privateIp(room.host) || valid.indexOf(room.host) >= 0) return;
        valid.push(room.host);
        var button = document.createElement('button');
        button.textContent = room.name || room.host;
        button.setAttribute('data-host', room.host);
        button.onclick = function () {
          if (saving) return;
          host.value = room.host;
          edit();
        };
        rooms.appendChild(button);
      });
      markRoom();
      return valid.length;
    }

    byId('find-rooms').onclick = function () {
      if (saving) return;
      var request = ++generation;
      notify('Finding Sonos rooms…');
      run('discover', function (error, result) {
        if (request !== generation) return;
        if (error) return notify(error.message, true);
        var count = showRooms(Array.isArray(result.rooms) ? result.rooms : []);
        notify(count ? 'Choose a room, then save.' : 'No rooms found. Enter the speaker IP to connect.');
      });
    };

    function selectedHost() {
      var ip = host.value.trim();
      if (privateIp(ip)) return ip;
      notify('Choose a room or enter a private IPv4 address.', true);
      host.focus();
      return '';
    }

    byId('test-room').onclick = function () {
      if (saving) return;
      var ip = selectedHost();
      if (!ip) return;
      var request = ++generation;
      notify('Reading volume…');
      run('probe ' + ip, function (error, result) {
        if (request !== generation) return;
        if (error) return notify(error.message, true);
        if (typeof result.volume !== 'number' || !isFinite(result.volume) || Math.floor(result.volume) !== result.volume || result.volume < 0 || result.volume > 100) {
          return notify('The speaker returned an invalid volume.', true);
        }
        var level = 'Sonos ' + result.volume;
        if (displayMax === 50) level += ' · TV ' + previewVolume(result.volume);
        notify((result.name || ip) + ' · ' + level + (result.mute ? ' · Muted' : ''));
      });
    };

    byId('save-source').onclick = function () {
      if (saving) return;
      var ip = source === 'sonos' ? selectedHost() : '';
      if (source === 'sonos' && !ip) return;
      generation++;
      saving = true;
      host.readOnly = true;
      notify('Saving…');
      run(source === 'sonos' ? 'set sonos ' + ip + ' ' + displayMax : 'set webos', function (error, result) {
        saving = false;
        host.readOnly = false;
        if (error || !result.ok) return notify(error ? error.message : 'Could not save the source.', true);
        notify('Saved.');
      });
    };

    function navigate(event) {
      var key = event.keyCode;
      if (key < 37 || key > 40) return;
      var current = document.activeElement;
      if (!current || !current.getBoundingClientRect) return;
      var horizontal = key === 37 || key === 39;
      // Keep native caret movement until it reaches the edge of the IP field.
      if (horizontal && current === host) {
        if (host.selectionStart !== host.selectionEnd) return;
        if (key === 37 && host.selectionStart > 0) return;
        if (key === 39 && host.selectionEnd < host.value.length) return;
      }
      var forward = key === 39 || key === 40;
      var from = current.getBoundingClientRect();
      var best = null;
      var closest = Infinity;
      var perpendicular = Infinity;
      var controls = document.querySelectorAll('button, input');
      for (var i = 0; i < controls.length; i++) {
        var target = controls[i];
        if (target === current || target.disabled) continue;
        var rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        var dx = (rect.left + rect.right - from.left - from.right) / 2;
        var dy = (rect.top + rect.bottom - from.top - from.bottom) / 2;
        if (horizontal && (rect.bottom <= from.top || rect.top >= from.bottom)) continue;
        if (!horizontal && rect.top < from.bottom && rect.bottom > from.top) continue;
        var distance = (horizontal ? dx : dy) * (forward ? 1 : -1);
        var cross = Math.abs(horizontal ? dy : dx);
        if (distance <= 0) continue;
        if (distance < closest - 3 || (Math.abs(distance - closest) <= 3 && cross < perpendicular)) {
          best = target;
          closest = distance;
          perpendicular = cross;
        }
      }
      if (best) {
        best.focus();
        event.preventDefault();
      }
    }

    return { load: load, navigate: navigate, previewVolume: previewVolume };
  };
}());
