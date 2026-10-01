#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${TV_HOST:?Set TV_HOST, for example root@TV_IP_ADDRESS}"
APP_ID=org.webosbrew.earcvolume
REMOTE_IPK=/tmp/earc-volume-overlay.ipk

ssh_tv() {
	if [ -n "${TV_SSH_KEY:-}" ]; then ssh -i "$TV_SSH_KEY" -o StrictHostKeyChecking=accept-new "$TV_HOST" "$@"
	else ssh -o StrictHostKeyChecking=accept-new "$TV_HOST" "$@"; fi
}
scp_tv() {
	if [ -n "${TV_SSH_KEY:-}" ]; then scp -i "$TV_SSH_KEY" -o StrictHostKeyChecking=accept-new "$1" "$TV_HOST:$2"
	else scp -o StrictHostKeyChecking=accept-new "$1" "$TV_HOST:$2"; fi
}

IPK=$(ls build/org.webosbrew.earcvolume_*_all.ipk 2>/dev/null | head -n 1 || true)
if [ -z "$IPK" ]; then
	[ -d node_modules ] || npm install
	npm run package
	IPK=$(ls build/org.webosbrew.earcvolume_*_all.ipk | head -n 1)
fi

echo "Copying app to $TV_HOST..."
scp_tv "$IPK" "$REMOTE_IPK"
echo "Installing $APP_ID..."
if [ -n "${TV_SSH_KEY:-}" ]; then
	ssh -tt -i "$TV_SSH_KEY" -o StrictHostKeyChecking=accept-new "$TV_HOST" \
		"luna-send -w 60000 -i luna://com.webos.appInstallService/dev/install '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"$REMOTE_IPK\",\"subscribe\":true}' | grep -oE '\"state\":\"[^\"]*\"|\"errorText\":\"[^\"]*\"' | uniq"
else
	ssh -tt -o StrictHostKeyChecking=accept-new "$TV_HOST" \
		"luna-send -w 60000 -i luna://com.webos.appInstallService/dev/install '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"$REMOTE_IPK\",\"subscribe\":true}' | grep -oE '\"state\":\"[^\"]*\"|\"errorText\":\"[^\"]*\"' | uniq"
fi

echo "Enabling the bundled watcher..."
ssh_tv 'set -e
APP_ID=org.webosbrew.earcvolume
APP_DIR=
for BASE in /media/developer/apps/usr/palm/applications /media/cryptofs/apps/usr/palm/applications; do
	if [ -f "$BASE/$APP_ID/runtime/watcher.js" ]; then APP_DIR="$BASE/$APP_ID"; break; fi
done
[ -n "$APP_DIR" ]
if [ -f /var/lib/earc-volume-overlay/watcher.pid ]; then
	pid=$(cat /var/lib/earc-volume-overlay/watcher.pid 2>/dev/null || true)
	[ -z "$pid" ] || kill "$pid" 2>/dev/null || true
fi
rm -rf /var/lib/earc-volume-overlay
mkdir -p /var/lib/webosbrew/init.d
chmod 755 "$APP_DIR/runtime/91-earc-volume-overlay"
ln -sf "$APP_DIR/runtime/91-earc-volume-overlay" /var/lib/webosbrew/init.d/91-earc-volume-overlay
rm -f /tmp/earc-volume-overlay.pid /tmp/earc-volume-overlay.ipk
/var/lib/webosbrew/init.d/91-earc-volume-overlay'
echo "Installed and enabled. Log: /tmp/earc-volume-overlay.log"
