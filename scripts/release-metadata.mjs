import fs from 'node:fs';
import crypto from 'node:crypto';

const repository = 'Nikolay1243/Webos-EARC-Volume-Overlay';
const version = JSON.parse(fs.readFileSync('app/appinfo.json')).version;
const base = `https://github.com/${repository}/releases/download/v${version}`;
fs.mkdirSync('build/release', { recursive: true });
for (const directory of ['app', 'settings']) {
  const app = JSON.parse(fs.readFileSync(`${directory}/appinfo.json`));
  const filename = `${app.id}_${app.version}_all.ipk`;
  const data = fs.readFileSync(`build/${filename}`);
  const manifest = {
    id: app.id, version: app.version, type: 'web',
    title: directory === 'settings' ? 'eARC Volume Overlay Settings' : app.title,
    appDescription: directory === 'settings' ? 'Enable, disable and preview the companion overlay. Install both packages.' : app.appDescription,
    iconUri: `https://raw.githubusercontent.com/${repository}/main/${directory}/largeIcon.png`,
    sourceUrl: `https://github.com/${repository}`, rootRequired: true,
    ipkUrl: `${base}/${filename}`,
    ipkHash: { sha256: crypto.createHash('sha256').update(data).digest('hex') },
    ipkSize: data.length
  };
  fs.writeFileSync(`build/release/${app.id}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}
