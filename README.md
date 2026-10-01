# eARC Volume Overlay for LG webOS

A small on-screen volume indicator for rooted LG webOS TVs connected to an
eARC/ARC soundbar or receiver. It restores the numeric volume display that LG's
built-in UI often omits for externally controlled audio devices.

The overlay is intentionally minimal: a large number in the bottom-right corner.
It updates while visible and disappears about two seconds after the final volume
change.

## Features

- Reads live volume and mute changes from `com.webos.service.audio`
- Activates only while the current sound output is `external_arc`
- Updates the existing overlay instead of opening duplicate windows
- Runs automatically after boot through the Homebrew Channel init directory
- Includes a TV-friendly setup screen with Enable, Disable, and Test buttons
- Keeps the startup hook inside the installed app, as recommended for Homebrew apps

## Requirements

- A rooted LG webOS TV
- Homebrew Channel installed
- `/usr/bin/node`, `/usr/bin/luna-send`, and `/usr/bin/script` on the TV
- An ARC/eARC device that reports a numeric volume through webOS

Not every HDMI-CEC receiver reports an absolute volume. If webOS only receives
volume-up/down acknowledgements, this project cannot infer the real number.

## Install from Homebrew Channel

Install both the overlay IPK and the companion settings IPK. Open
**eARC Volume Overlay** (the settings app) and select **Enable**. Select
**Test overlay** to preview the result. Use **Disable** before uninstalling.

The setup screen asks Homebrew Channel's root service to create a startup-link
to the watcher bundled inside the app. No SSH setup is required for normal use.

## Build

Install Node.js 18 or newer on your computer, then run:

```sh
npm install
npm run package
```

Two IPKs are written to `build/`: the overlay with its bundled watcher, and
`com.github.nikolay1243.earcvolume.settings`, which supplies the normal launcher icon and
setup screen. Install both. The settings app uses a normal card window because
webOS closes overlay windows when the home screen opens.

## Manual install on a rooted TV

For development or installation before the app is listed in Homebrew Channel:

```sh
TV_HOST=root@TV_IP_ADDRESS \
TV_SSH_KEY="/path/to/your/private_key" \
sh scripts/install.sh
```

The installer packages the app if needed, installs the IPK, creates the same
startup-link used by the setup screen, and starts the bundled watcher.

## Uninstall

Disable the watcher from the app first, or run:

```sh
TV_HOST=root@TV_IP_ADDRESS \
TV_SSH_KEY="/path/to/your/private_key" \
sh scripts/uninstall.sh
```

## Logs

On the TV:

```sh
tail -f /tmp/earc-volume-overlay.log
```

A healthy startup looks similar to:

```text
service starting
watching external_arc at 12:false
```

## How it works

The root-side Node.js watcher subscribes to the webOS master-volume service.
When the numeric ARC/eARC volume changes, it launches or relaunches the overlay
app with the new value. The transparent web app updates the number in place and
closes itself after its short timeout. Opening the app normally presents its
setup screen instead.

## Development disclosure

This project was developed with substantial assistance from OpenAI Codex. The
product direction, UI decisions, review, and iterative acceptance testing were
performed by the maintainer on a rooted LG webOS TV with an eARC soundbar.

## Safety

This is unofficial software for rooted TVs. Firmware updates can change private
webOS services or remove root access. Keep a known recovery path for your TV and
review scripts before running them.

## Licence

MIT
