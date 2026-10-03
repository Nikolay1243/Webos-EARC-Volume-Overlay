(function () {
  function messageFor(response) {
    var detail = [response.stdoutString, response.stderrString, response.errorText, response.error].join('\n');
    if (/app-not-found/.test(detail)) return 'Install eARC Volume Overlay as well as this settings app, then try Enable again.';
    if (/Denied method call|not permitted|permission denied/i.test(detail)) return 'Homebrew root access was denied. Check root status in Homebrew Channel. If this firmware blocks the setup service, use the SSH installer described in the README.';
    if (/not.*root|root-required/.test(detail)) return 'Homebrew Channel is not running as root. Enable requires a rooted TV.';
    return 'Setup command failed. Use the SSH installer in the README to see the full diagnostic output.';
  }
  window.earcRootExec = function (command, callback) {
    if (!window.PalmServiceBridge) { callback(new Error('Homebrew root service is unavailable. Run this app on a rooted TV.')); return; }
    var bridge = new PalmServiceBridge(), finished = false;
    var timer = window.setTimeout(function () { finish(new Error('Homebrew service timed out. Open Homebrew Channel and check its root status.')); }, 15000);
    function finish(error, output) {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      try { if (bridge.cancel) bridge.cancel(); } catch (ignore) {}
      callback(error, output);
    }
    bridge.onservicecallback = function (raw) {
      var response;
      try { response = JSON.parse(raw); } catch (ignore) { finish(new Error('Homebrew service returned an invalid response.')); return; }
      if (response.returnValue === false || response.error) finish(new Error(messageFor(response)));
      else finish(null, response.stdoutString || '');
    };
    try { bridge.call('luna://org.webosbrew.hbchannel.service/exec', JSON.stringify({ command: command })); }
    catch (error) { finish(new Error(messageFor({ errorText: error.message }))); }
  };
}());
