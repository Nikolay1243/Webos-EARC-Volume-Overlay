# eARC Volume Overlay for LG webOS

A small on-screen volume indicator for rooted LG webOS TVs connected to an
eARC/ARC soundbar or receiver. It restores the numeric volume display that LG's
built-in UI often omits for externally controlled audio devices.

The overlay is intentionally minimal: a large number and a smooth volume bar in
the bottom-right corner.
It updates while visible and disappears about two seconds after the final volume
change.

![v1.4.0 volume display showing 42 and its volume bar in the bottom-right corner](docs/overlay-preview-v1.4.0.jpg)

Preview rendered from the v1.4.0 app's HTML/CSS at 1920×1080 against a neutral
background. The number shows the reported level; the bar animates between updates.

## Features

- Reads soundbar-reported ARC volume from `com.webos.service.eim/getArcVolume`,
  with sound output and mute changes from `com.webos.service.audio`
- Activates only while the current sound output is `external_arc`
- Updates the existing overlay instead of opening duplicate windows
- Re-shows 0/100 on limit presses when the TV exposes volume commands in
  `/var/log/cecmessages`
- Shows a smooth volume bar beneath the accurate numeric level
- Follows soundbar and Apple TV remote changes when reported over HDMI-CEC
- Runs automatically after boot through the Homebrew Channel init directory
- One launcher app and one IPK for setup and volume display
- Keeps pointer and directional/OK controls available to the app underneath
- Includes a TV-friendly setup screen with Enable, Disable, and Test buttons
- Keeps the startup hook inside the installed app, as recommended for Homebrew apps

## Requirements

- A rooted LG webOS TV
- Homebrew Channel installed
- `/usr/bin/luna-send` and `/usr/bin/script` on the TV (`/usr/bin/node` only for the fallback watcher)
- An ARC/eARC device that reports a numeric volume through webOS

Not every HDMI-CEC receiver reports an absolute volume. If webOS only receives
volume-up/down acknowledgements, this project cannot infer the real number.
On firmware without the ARC volume interface, the watcher falls back to webOS's
master volume. That value can drift from the soundbar during held volume buttons;
it is a compatibility fallback, not a confirmed soundbar reading.

## Install from Homebrew Channel

1. Open Homebrew Channel and go to **Settings → Repositories → Add repository**.
2. Enter this exact URL (the GitHub repository page itself will not work):

   ```text
   https://raw.githubusercontent.com/Nikolay1243/Webos-EARC-Volume-Overlay/main/repo.json
   ```

3. Add and enable the repository, then return to the app browser and refresh it.
4. Install **eARC Volume Overlay**.
5. Open **eARC Volume Overlay** from your TV's app list and select **Enable**.

You do not need to wait for this app to be accepted into the central repository.
If using manual installation, download the single IPK from the [official releases](https://github.com/Nikolay1243/Webos-EARC-Volume-Overlay/releases/latest).

Install the single overlay IPK. Open **eARC Volume Overlay** from the launcher
for its Enable, Disable, and Test menu. The same app switches to a transparent
overlay when launched by its background watcher. Volume events leave an open
settings menu in place. Use **Disable** before uninstalling.

### Upgrading from v1.3.0 or earlier

1. Install/update the main **eARC Volume Overlay** app using the single v1.4.0
   IPK or the refreshed Homebrew listing.
2. Open it and select **Enable**, then check the menu and volume display.
3. Uninstall the old **eARC Volume Overlay Settings** companion
   (`com.github.nikolay1243.earcvolume.settings`). Do not select **Disable** in
   that old app first: it controls the same watcher.

New installations need only the main app. No companion package is required.

The setup screen asks Homebrew Channel's root service to create a startup-link
to the watcher bundled inside the app. No SSH setup is required for normal use.

## Build

Install Node.js 18 or newer, Rust (rustup) and `cargo-zigbuild`
(`pip install ziglang cargo-zigbuild`) on your computer, then run:

```sh
npm install
npm run package
```

One IPK is written to `build/`, containing the launcher menu, overlay, and
background watcher. The launcher uses a card window; volume launches switch it
to a passive floating window using `PalmSystem.setWindowProperty`. Native
focus and pointer-input settings keep the display non-interactive. These are
private webOS APIs and need testing across firmware versions.

## Enabled state and power-off

Enable creates a persistent startup-link in `/var/lib/webosbrew/init.d/` and
starts the watcher. Closing the menu does not stop it. After a hard reboot,
Homebrew Channel runs that hook to start the watcher again. Disable stops the
watcher and removes the startup-link, so it stays disabled across reboots.
Root and Homebrew startup support must remain available. The watcher may start
after a short Homebrew startup delay following a full reboot.

## Manual install on a rooted TV

For development or installation before the app is listed in Homebrew Channel:

```sh
TV_HOST=root@TV_IP_ADDRESS \
TV_SSH_KEY="/path/to/your/private_key" \
sh scripts/install.sh
```

The installer packages the app if needed, installs the IPK, creates the same
startup-link used by the setup screen, and starts the bundled watcher.

### Setup troubleshooting

If Enable reports a missing overlay, reinstall the main app package.
If it reports `Denied method call`, check Homebrew Channel's root status. Some
firmware blocks access to its root execution service from other apps; the setup
screen cannot bypass that restriction. Use the SSH installer above instead.
The screen now reports concise errors rather than displaying the entire command.

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
service starting (ARC-reported volume preferred; master fallback until available)
watching external_arc at 12:false
using ARC-reported volume
```

Routine volume and launch-timing diagnostics are disabled by default. For
development, start the watcher with `EARC_VOLUME_DEBUG=1` to enable them.
Startup, volume-source selection, and errors remain logged normally.

## How it works

A small native watcher (Rust, static ARM binary) follows the TV's own CEC log,
`/var/log/cecmessages`, with inotify. It reads the soundbar's HDMI-CEC Report
Audio Status messages (`RX507Axx`: volume in bits 0-6, mute in bit 7) and the
TV's volume key presses to the soundbar (`TX0544xx`). Nothing is sent on the
CEC bus. A key press shows the overlay at once with the last known level,
dimmed; the soundbar's reply fills in the confirmed number. Changes made with
the soundbar's own remote are shown as soon as it reports them.

A single long-lived `luna-send` subscription tells the watcher whether sound
goes to the ARC/eARC device, and the ARC getter is read once to seed the value.
The overlay app is launched or relaunched with each update. After fading out
it stays resident and hidden, so later updates avoid a cold web-app start.
Opening the app from the launcher presents its setup screen instead.

If the native binary cannot run, the startup hook falls back to the previous
Node.js watcher (`runtime/watcher.js`), which polls the ARC getter.

### Volume steps

The displayed number is the ARC/eARC device's reported level, not a count of
remote presses. On the tested soundbar, reported levels step by one at low
volumes and make larger jumps higher up (for example, 23 → 27 → 31 → 34).
Other devices may use different scales. This is device-dependent, not a universal
eARC rule. The bar animates between reported values while the number updates
immediately.

## Tested behavior and compatibility

On the maintainer's setup, the unified app was tested for Enable/Back, preview
returning to settings, volume display over YouTube, pointer and arrow/OK controls
while visible, hard reboot with automatic startup, standby/wake, mute, and sound
output switching.

Results can vary by firmware and audio device. The original reporter's Samsung
HW-M550 has not yet been verified with these changes. Actual volume reporting
requires the ARC getter and soundbar feedback; limit-press refreshes additionally
require `/var/log/cecmessages`. The app does not send volume commands or assume
that every rapid remote press was accepted by the soundbar.

## Releases

The single installable IPK and its checksummed Homebrew manifest are published
as GitHub Release assets. The repository's old `release/` downloads are retired; only two compatibility manifests remain there for existing Homebrew listing URLs. Maintainers can
publish from Actions → Publish release → Run workflow; its write permission is
limited to the publishing job and it does not run on pull requests.

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
