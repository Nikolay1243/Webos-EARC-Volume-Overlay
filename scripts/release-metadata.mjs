import fs from 'node:fs';
import crypto from 'node:crypto';

const repository = 'Nikolay1243/Webos-EARC-Volume-Overlay';
const version = JSON.parse(fs.readFileSync('app/appinfo.json')).version;
const base = `https://github.com/${repository}/releases/download/v${version}`;
fs.mkdirSync('build/release', { recursive: true });
fs.rmSync('build/release/com.github.nikolay1243.earcvolume.settings.manifest.json', { force: true });
for (const directory of ['app']) {
  const app = JSON.parse(fs.readFileSync(`${directory}/appinfo.json`));
  const filename = `${app.id}_${app.version}_all.ipk`;
  const data = fs.readFileSync(`build/${filename}`);
  const manifest = {
    id: app.id, version: app.version, type: 'web',
    title: app.title,
    appDescription: app.appDescription,
    iconUri: `https://raw.githubusercontent.com/${repository}/main/${directory}/${app.largeIcon}`,
    sourceUrl: `https://github.com/${repository}`, rootRequired: true,
    ipkUrl: `${base}/${filename}`,
    ipkHash: { sha256: crypto.createHash('sha256').update(data).digest('hex') },
    ipkSize: data.length
  };
  fs.writeFileSync(`build/release/${app.id}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
}
