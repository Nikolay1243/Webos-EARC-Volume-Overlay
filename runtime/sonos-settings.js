'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

const settingsDir = '/var/lib/earc-volume-overlay-sonos';
const settingsFile = path.join(settingsDir, 'settings.json');
const zonePlayer = 'urn:schemas-upnp-org:device:ZonePlayer:1';
const renderArgs = '<InstanceID>0</InstanceID><Channel>Master</Channel>';
const deadlineMs = 1500;

function privateHost(host) {
  if (typeof host !== 'string' || net.isIP(host) !== 4) return false;
  const octets = host.split('.').map(Number);
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function normalized(source, host, displayMax) {
  if (source === 'webos') return { source: 'webos', host: '', displayMax: 100 };
  if (source !== 'sonos' || !privateHost(host)) throw new Error('Choose webOS or enter a private IPv4 address for the Sonos speaker.');
  if (displayMax === undefined) displayMax = 100;
  if (displayMax !== 50 && displayMax !== 100) throw new Error('Choose the 0–50 or 0–100 display scale.');
  return { source, host, displayMax };
}

function getSettings() {
  let json;
  try {
    json = fs.readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return normalized('webos');
    throw error;
  }
  const settings = JSON.parse(json);
  return normalized(settings.source, settings.host, settings.displayMax);
}

function saveSettings(settings) {
  try {
    fs.mkdirSync(settingsDir, 0o700);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const temp = path.join(settingsDir, '.settings-' + crypto.randomBytes(10).toString('hex'));
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(settings) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, settingsFile);
  } catch (error) {
    fs.unlinkSync(temp);
    throw error;
  }
}

function soapAction(host, service, action, args, field) {
  if (!privateHost(host)) return Promise.reject(new Error('Enter a private IPv4 address.'));
  const ns = 'urn:schemas-upnp-org:service:' + service + ':1';
  const body = '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
    ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:' + action + ' xmlns:u="' + ns + '">' + args +
    '</u:' + action + '></s:Body></s:Envelope>';
  const base = service === 'RenderingControl' ? '/MediaRenderer/' : '/';
  return new Promise(function (resolve, reject) {
    let responseTimer;
    function fail(error) {
      clearTimeout(responseTimer);
      reject(error);
    }
    const request = http.request({
      hostname: host, port: 1400, method: 'POST', path: base + service + '/Control',
      headers: { SOAPAction: '"' + ns + '#' + action + '"',
        'Content-Type': 'text/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }
    }, function (response) {
      let data = '', bytes = 0;
      response.setEncoding('utf8');
      response.on('error', fail);
      response.on('aborted', function () { fail(new Error('Sonos closed its response early.')); });
      response.on('data', function (chunk) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16384) {
          fail(new Error('Sonos response is too large.'));
          request.abort();
          return;
        }
        data += chunk;
      });
      response.on('end', function () {
        clearTimeout(responseTimer);
        if (response.statusCode !== 200) return reject(new Error(action + ' returned HTTP ' + response.statusCode));
        const value = new RegExp('<' + field + '>([^<]*)</' + field + '>').exec(data);
        if (!value) return reject(new Error('Missing ' + field + ' from Sonos.'));
        resolve(value[1].trim());
      });
    });
    responseTimer = setTimeout(function () {
      fail(new Error('Sonos did not respond in time.'));
      request.abort();
    }, deadlineMs);
    request.on('error', fail);
    request.end(body);
  });
}

function booleanValue(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new Error('Invalid boolean from Sonos.');
}

function volumeValue(value) {
  if (!/^\d{1,3}$/.test(value) || Number(value) > 100) throw new Error('Invalid Sonos volume.');
  return Number(value);
}

async function readStatus(host) {
  const values = await Promise.all([
    soapAction(host, 'RenderingControl', 'GetVolume', renderArgs, 'CurrentVolume'),
    soapAction(host, 'RenderingControl', 'GetMute', renderArgs, 'CurrentMute')
  ]);
  return { volume: volumeValue(values[0]), mute: booleanValue(values[1]) };
}

function getStatus(host, callback) {
  readStatus(host).then(function (status) { callback(null, status); }, callback);
}

async function roomName(host) {
  const raw = await soapAction(host, 'DeviceProperties', 'GetZoneAttributes', '', 'CurrentZoneName');
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const name = raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, function (_, entity) {
    if (entity[0] !== '#') return entities[entity];
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  }).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!name) throw new Error('No room name returned by Sonos.');
  return name.slice(0, 128);
}

async function probe(host) {
  const results = await Promise.all([roomName(host), readStatus(host)]);
  return { name: results[0], volume: results[1].volume, mute: results[1].mute };
}

function findPlayers() {
  return new Promise(function (resolve, reject) {
    const udp = dgram.createSocket('udp4');
    const hosts = new Set();
    let closed = false;
    function finish(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      udp.close();
      if (error) reject(error);
      else resolve(Array.from(hosts));
    }
    const timer = setTimeout(function () { finish(); }, 1400);
    udp.on('error', finish);
    udp.on('message', function (packet, remote) {
      if (hosts.size >= 24 || packet.length > 4096 || !privateHost(remote.address)) return;
      const text = packet.toString('ascii');
      if (/^HTTP\/1\.1 200\b/i.test(text) &&
          /^ST:\s*urn:schemas-upnp-org:device:ZonePlayer:1\s*$/im.test(text) &&
          /^USN:\s*uuid:RINCON_/im.test(text)) {
        // The UDP sender is the peer. Never follow an advertised LOCATION.
        hosts.add(remote.address);
      }
    });
    udp.bind(0, function () {
      const packet = Buffer.from(['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"', 'MX: 1', 'ST: ' + zonePlayer, '', ''].join('\r\n'));
      udp.send(packet, 1900, '239.255.255.250');
    });
  });
}

async function findRooms() {
  const hosts = await findPlayers();
  const rooms = await Promise.all(hosts.map(async function (host) {
    try {
      const nameAndFlags = await Promise.all([roomName(host),
        soapAction(host, 'DeviceProperties', 'GetInvisible', '', 'CurrentInvisible').then(booleanValue).catch(function () { return false; })]);
      return nameAndFlags[1] ? null : { name: nameAndFlags[0], host };
    } catch (error) {
      return null;
    }
  }));
  return rooms.filter(Boolean).sort(function (a, b) { return a.name.localeCompare(b.name) || a.host.localeCompare(b.host); });
}

async function command(args) {
  if (args[0] === 'get' && args.length === 1) return getSettings();
  if (args[0] === 'discover' && args.length === 1) return { rooms: await findRooms() };
  if (args[0] === 'probe' && args.length === 2) return probe(args[1]);
  if (args[0] === 'set' && args[1] === 'webos' && args.length === 2) {
    saveSettings(normalized('webos'));
    return { ok: true };
  }
  if (args[0] === 'set' && args[1] === 'sonos' && (args.length === 3 || args.length === 4)) {
    if (args.length === 4 && args[3] !== '50' && args[3] !== '100') throw new Error('Choose the 0–50 or 0–100 display scale.');
    const settings = normalized('sonos', args[2], args[3] === '50' ? 50 : 100);
    await probe(settings.host);
    if (args.length === 3) {
      const old = getSettings();
      if (old.source === 'sonos' && old.host === settings.host) settings.displayMax = old.displayMax;
    }
    saveSettings(settings);
    return { ok: true };
  }
  throw new Error('Usage: get | discover | probe IP | set webos | set sonos IP [50|100]');
}

module.exports = { getSettings, getStatus };

if (require.main === module) {
  command(process.argv.slice(2)).then(function (result) {
    console.log(JSON.stringify(result));
  }, function (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
