const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('app/root-exec.js', 'utf8');
function run(response, expected) {
  let cancelled = false, calls = 0;
  const window = { setTimeout: () => 1, clearTimeout() {} };
  function PalmServiceBridge() {
    this.cancel = () => { cancelled = true; };
    this.call = () => { this.onservicecallback(response); this.onservicecallback(response); };
  }
  window.PalmServiceBridge = PalmServiceBridge;
  vm.runInNewContext(source, {window, PalmServiceBridge, Error});
  window.earcRootExec('test', (error, output) => {
    calls++;
    if (expected) assert.match(error.message, expected);
    else { assert.equal(error, null); assert.equal(output, 'enabled'); }
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
}
run(JSON.stringify({returnValue:true, stdoutString:'enabled'}));
run(JSON.stringify({returnValue:false, stdoutString:'app-not-found', error:'Command failed: SECRET'}), /Install eARC/);
run(JSON.stringify({returnValue:false, errorText:"Denied method call 'exec'"}), /root access was denied/);
run(JSON.stringify({returnValue:false, stderrString:'root-required'}), /not running as root/);
run(JSON.stringify({returnValue:false, error:'Command failed: SECRET'}), /Setup command failed/);
run('not json', /invalid response/);
console.log('Root execution response tests passed');
