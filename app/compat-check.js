// Compatibility check: watches the TV's CEC log while the user presses the
// volume keys, then says whether this TV and soundbar can show a real number.
// Read-only: it never sends anything on the CEC bus.
(function (root) {
  var LOG = '/var/log/cecmessages';

  function luna(uri) {
    return "/usr/bin/script -q -c \"/usr/bin/luna-send -n 1 " + uri + " '{}'\" /dev/null 2>/dev/null | tr -d '\\r\\n'";
  }
  var ARC = 'echo "arc=$(' + luna('luna://com.webos.service.eim/getArcVolume') + ')"';
  var OUTPUT = 'echo "out=$(' + luna('luna://com.webos.service.audio/master/getVolume') + ')"';

  function startCommand() {
    return [
      'LOG=' + LOG,
      'if [ -f "$LOG" ]; then echo "size=$(wc -c < "$LOG")"; echo "inode=$(ls -i "$LOG" | awk \'{print $1}\')"; else echo "size=none"; fi',
      ARC,
      OUTPUT
    ].join('\n');
  }

  function endCommand(start) {
    var size = /^\d+$/.test(start.size || '') ? start.size : '0';
    var inode = /^\d+$/.test(start.inode || '') ? start.inode : '';
    return [
      'LOG=' + LOG,
      'if [ -f "$LOG" ]; then',
      '  SIZE=$(wc -c < "$LOG"); INO=$(ls -i "$LOG" | awk \'{print $1}\'); OFF=' + size,
      '  if [ "$INO" != "' + inode + '" ] || [ "$SIZE" -lt "$OFF" ]; then OFF=0; fi',
      '  tail -c +$((OFF+1)) "$LOG" | grep -oE "TX0544(41|42|43)|RX507A[0-9A-Fa-f]{2}" | tail -n 300 | sed "s/^/cec=/"',
      'else echo "log=none"; fi',
      ARC
    ].join('\n');
  }

  function parse(output) {
    var result = { cec: [] };
    String(output || '').split('\n').forEach(function (line) {
      var i = line.indexOf('=');
      if (i < 1) return;
      var key = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
      if (key === 'cec') result.cec.push(value.toUpperCase());
      else result[key] = value;
    });
    return result;
  }

  function arcVolume(json) {
    var m = /"Volume"\s*:\s*(\d+)/.exec(json || '');
    if (!m) return null;
    var v = Number(m[1]);
    return v >= 0 && v <= 100 ? v : null;
  }

  function soundOutput(json) {
    var m = /"soundOutput"\s*:\s*"([^"]+)"/.exec(json || '');
    return m ? m[1] : null;
  }

  // Returns { kind: 'good' | 'warn' | 'bad', title, detail }.
  function classify(start, end) {
    var output = soundOutput(start.out);
    if (output && output !== 'external_arc') {
      return { kind: 'warn', title: 'Sound is not going to a soundbar',
        detail: 'Set Sound Out to your HDMI ARC/eARC soundbar or receiver, then run the check again.' };
    }
    var keys = 0, reports = [];
    end.cec.forEach(function (token) {
      if (token.indexOf('TX0544') === 0) keys++;
      else if (token.indexOf('RX507A') === 0) {
        var v = parseInt(token.slice(6), 16) & 0x7f;
        if (v <= 100) reports.push(v);
      }
    });
    var before = arcVolume(start.arc), after = arcVolume(end.arc);
    var storedChanged = before !== null && after !== null && before !== after;
    var noLog = start.size === 'none' || end.log === 'none';

    if (reports.length && reports.length * 2 >= keys) {
      return { kind: 'good', title: 'Compatible',
        detail: 'Your soundbar reported its volume ' + (keys ? 'after your presses' : 'when it changed') +
          ' (last: ' + reports[reports.length - 1] + '). The overlay will show the exact level.' };
    }
    if (reports.length) {
      return { kind: 'good', title: 'Mostly compatible',
        detail: 'The soundbar answered ' + reports.length + ' of ' + keys + ' presses (last: ' +
          reports[reports.length - 1] + '). The overlay works but may sometimes skip a step.' };
    }
    if (storedChanged) {
      return { kind: 'good', title: 'Compatible (slower mode)',
        detail: 'The soundbar does not report directly, but the TV’s stored value followed it (' +
          before + ' → ' + after + '). The overlay will update with a short delay.' };
    }
    if (noLog) {
      return { kind: 'warn', title: 'Could not confirm',
        detail: 'This TV keeps no HDMI-CEC log and the stored soundbar volume did not change. If you did change the volume, this setup cannot show a number.' };
    }
    if (keys) {
      return { kind: 'bad', title: 'Not compatible',
        detail: 'Your soundbar accepts the TV’s volume commands but never reports its level, so the overlay cannot show a number. You can disable and uninstall the app.' };
    }
    return { kind: 'warn', title: 'No volume presses detected',
      detail: 'Press volume up and down on the TV remote while the check runs. Make sure Sound Out is set to your HDMI ARC/eARC device.' };
  }

  root.earcCompat = { startCommand: startCommand, endCommand: endCommand, parse: parse, classify: classify };
}(typeof window !== 'undefined' ? window : this));
