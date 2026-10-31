import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// These are release source commits, not moving branches. No production endpoint is used.
export const revisions = {
  server: '0bca572b47d62bda2028dc2b39215e0fcf83c3dc',
  '5.2.4': '73274076f80f03b917db8fc397a554b01ac7a409',
  '5.2.5': '0bca572b47d62bda2028dc2b39215e0fcf83c3dc',
  '5.2.6': '2ec22c54b',
  '5.3.1': '4ba4e38e9705da0b626ac63d99bd23f3633e6cfb',
};

if (process.argv[1] === import.meta.filename) {
  for (const [version, revision] of Object.entries(revisions)) {
    const destination = resolve('.private/audio-mute-matrix', version);
    await mkdir(destination, { recursive: true });
    const args = ['archive', revision];
    if (version !== 'server') args.push('sdks/typescript/client', 'sdks/typescript/react');
    const archive = execFileSync('git', args, { maxBuffer: 100 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
  }
  await writeFile('.private/audio-mute-matrix/revisions.json', JSON.stringify(revisions, null, 2));
  const packages = [];
  for (const version of ['5.2.4', '5.2.5', '5.2.6']) {
    const metadataResponse = await fetch(`https://registry.npmjs.org/@q9labsai%2fchalk-client/${version}`);
    if (!metadataResponse.ok) throw new Error(`SDK metadata ${version}: HTTP ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    const response = await fetch(metadata.dist.tarball);
    if (!response.ok) throw new Error(`SDK package ${version}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    if (integrity !== metadata.dist.integrity) throw new Error(`SDK package ${version}: integrity mismatch`);
    const destination = resolve('.private/audio-mute-matrix/packages', version);
    await mkdir(destination, { recursive: true });
    execFileSync('tar', ['-xf', '-', '-C', destination, '--strip-components=1'], { input: archive });
    packages.push({ version, integrity, tarball: metadata.dist.tarball });
  }
  await writeFile('.private/audio-mute-matrix/published-packages.json', JSON.stringify(packages, null, 2));
  console.log('Prepared pinned SDK sources and isolated server source.');
}
