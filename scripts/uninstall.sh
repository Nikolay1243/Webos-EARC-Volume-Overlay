#!/bin/sh
set -eu
: "${TV_HOST:?Set TV_HOST, for example root@TV_IP_ADDRESS}"

ssh_tv() {
	if [ -n "${TV_SSH_KEY:-}" ]; then ssh -tt -i "$TV_SSH_KEY" -o StrictHostKeyChecking=accept-new "$TV_HOST" "$@"
	else ssh -tt -o StrictHostKeyChecking=accept-new "$TV_HOST" "$@"; fi
}

ssh_tv 'for PIDFILE in /tmp/earc-volume-overlay.pid /var/lib/earc-volume-overlay/watcher.pid; do
	if [ -f "$PIDFILE" ]; then
		pid=$(cat "$PIDFILE" 2>/dev/null || true)
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			cmd=$(tr "\000" " " < "/proc/$pid/cmdline" 2>/dev/null || true)
			case "$cmd" in *watcher.js*) kill "$pid" 2>/dev/null || true;; esac
		fi
	fi
	done
rm -f /tmp/earc-volume-overlay.pid /var/lib/webosbrew/init.d/91-earc-volume-overlay
rm -rf /var/lib/earc-volume-overlay
luna-send -n 1 luna://com.webos.appInstallService/dev/remove '"'"'{"id":"com.github.nikolay1243.earcvolume"}'"'"' >/dev/null 2>&1 || true
echo "eARC Volume Overlay removed"'

ssh_tv 'luna-send -n 1 luna://com.webos.appInstallService/dev/remove '"'"'{"id":"com.github.nikolay1243.earcvolume.settings"}'"'"''
