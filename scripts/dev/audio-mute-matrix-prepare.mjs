import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// These are release source commits, not moving branches. No production endpoint is used.
export const revisions = {
  server: '0bca572b47d62bda2028dc2b39215e0fcf83c3dc',
  '5.2.4': 'eb792346d',
  '5.2.5': '7bc8139e3',
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
  console.log('Prepared pinned SDK sources and isolated server source.');
}
