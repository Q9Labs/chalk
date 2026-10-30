"""One-time source relocation, run from the repository root before the move.

This is a migration codemod, not a build step or a generated source tree.
"""
from pathlib import Path
import json
import os
import re
import subprocess

root = Path.cwd()
if (root / "features/whiteboard").exists():
 raise SystemExit("This one-time codemod runs only on a fresh pre-move checkout.")
tracked = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', 'HEAD'], text=True).splitlines()
directories = {
 'packages/whiteboard': 'features/whiteboard/packages/canvas',
 'apps/api/internal/whiteboardfiles': 'features/whiteboard/api/internal/files',
 'apps/api/internal/objectstorage': 'platform/objectstorage',
 'apps/api/internal/synctokens': 'platform/synctokens',
 'apps/api/internal/utilities': 'platform/utilities',
 'apps/api/internal/ratelimit': 'platform/ratelimit',
 'apps/sync/lib/chalk_sync/whiteboard_v1': 'features/whiteboard/sync/lib/chalk_sync/whiteboard_v1',
 'apps/sync/test/chalk_sync/whiteboard_v1': 'features/whiteboard/tests/sync/chalk_sync/whiteboard_v1',
 'sdks/typescript/client/src/whiteboard': 'features/whiteboard/sdk/client/src/whiteboard',
 'sdks/typescript/react/src/components/whiteboard-view': 'features/whiteboard/sdk/react/src/components/whiteboard-view',
 'sdks/typescript/react/src/whiteboard': 'features/whiteboard/sdk/react/src/whiteboard',
 'sdks/typescript/react-native/src/whiteboard': 'features/whiteboard/sdk/react-native/src/whiteboard',
}
individual = {
 'apps/api/go.mod': 'go.mod', 'apps/api/go.sum': 'go.sum',
 'apps/api/internal/httpapi/whiteboard_files.go': 'features/whiteboard/api/transport.go',
 'apps/api/internal/adapters/postgres/whiteboard_files.go': 'features/whiteboard/api/internal/postgres/files.go',
 'apps/api/internal/adapters/postgres/sqlc/whiteboard_files.sql.go': 'features/whiteboard/api/internal/sqlc/whiteboard_files.sql.go',
 'apps/api/db/queries/whiteboard_files.sql': 'features/whiteboard/api/db/queries/whiteboard_files.sql',
 'apps/web/src/docs/content/whiteboard.mdx': 'features/whiteboard/docs/whiteboard.mdx',
 'docs/recording-whiteboard.md': 'features/whiteboard/docs/recording.md',
 'contract/schema/whiteboard-v1.json': 'features/whiteboard/contract/whiteboard-v1.json',
 'apps/recording-renderer/src/compose/whiteboard.ts': 'features/whiteboard/web/recording/whiteboard.ts',
 'apps/recording-renderer/src/compose/whiteboard.test.ts': 'features/whiteboard/web/recording/whiteboard.test.ts',
}
for file in tracked:
 if file.startswith('apps/api/db/migrations/') and 'whiteboard' in file:
  individual[file] = file.replace('apps/api/db/migrations/', 'features/whiteboard/api/db/migrations/')
 elif file.startswith('apps/sync/') and 'whiteboard' in file and file.endswith(('.ex', '.exs')):
  individual[file] = file.replace('apps/sync/lib/', 'features/whiteboard/sync/lib/').replace('apps/sync/test/', 'features/whiteboard/tests/sync/')
 elif file.startswith('sdks/typescript/') and 'whiteboard' in file.lower():
  individual[file] = file.replace('sdks/typescript/', 'features/whiteboard/sdk/')
 elif file.startswith('apps/web/src/lib/whiteboard'):
  individual[file] = file.replace('apps/web/src/lib/', 'features/whiteboard/web/')
 elif file.startswith('tools/contract-fixture-proof/src/emitters/whiteboard-'):
  individual[file] = file.replace('tools/contract-fixture-proof/src/', 'features/whiteboard/tools/')

def moved(file):
 if file in individual:
  return individual[file]
 for old, new in directories.items():
  if file == old or file.startswith(old + '/'):
   return new + file[len(old):]
 return file

moves = {file: moved(file) for file in tracked if moved(file) != file}
text_files = {}
for file in tracked:
 try:
  text_files[file] = subprocess.check_output(['git', 'show', 'HEAD:' + file]).decode()
 except (UnicodeError, OSError):
  pass
for old, new in moves.items():
 Path(new).parent.mkdir(parents=True, exist_ok=True)
 if Path(old).exists():
  subprocess.run(['git', 'mv', old, new], check=True)

# Resolve relative source/config references against their ORIGINAL owner first.
# Then rewrite repository-root paths. Preserve import extensions and glob suffixes.
relative = re.compile(r'''(["'`])((?:\.\.?/)[^\s"'`]+)\1''')
root_paths = dict(directories)
root_paths.update(individual)
for old, source in text_files.items():
 new = moved(old)
 if old == 'scripts/refactors/whiteboard-move.py' or new.endswith(('.sum', '.lock')):
  continue
 def relative_reference(match):
  quote, spec = match.groups()
  base, sep, suffix = spec.partition('*')
  resolved = os.path.normpath(os.path.join(os.path.dirname(old), base))
  exists = (root / resolved).exists() or resolved in tracked or any(resolved + ext in tracked for ext in ['.ts','.tsx','.mjs','.js'])
  extension = next((ext for ext in ['.ts','.tsx','.mjs','.js'] if resolved + ext in tracked), '')
  destination = moved(resolved + extension)
  if extension:
   destination = destination[:-len(extension)]
  if not exists and destination == resolved:
   return match.group(0)
  if old == new and destination == resolved:
   return match.group(0)
  replacement = os.path.relpath(destination, os.path.dirname(new) or '.')
  if not replacement.startswith('.'):
   replacement = './' + replacement
  if base.endswith('/') and not replacement.endswith('/'):
   replacement += '/'
  return quote + replacement + sep + suffix + quote
 if new.endswith(('.ts','.tsx','.mjs','.js','.cjs','.json','.jsonc','.md','.mdx')):
  source = relative.sub(relative_reference, source)
 # Keep Go instrumentation names stable: rewrite Go import paths, not telemetry IDs.
 if new.endswith('.go'):
  def imports(match):
   block = match.group(0)
   for old_dir, new_dir in directories.items():
    target = 'features/whiteboard/api' if old_dir.endswith('/whiteboardfiles') else new_dir
    block = block.replace('github.com/q9labs/chalk/' + old_dir, 'github.com/q9labs/chalk/' + target)
   return block
  source = re.sub(r'(?m)^import\s*(?:\([\s\S]*?\)|"[^"\n]+")', imports, source)
 else:
  for before, after in sorted(root_paths.items(), key=lambda item: -len(item[0])):
   source = source.replace(before, after)
 if Path(new).read_text() != source:
  Path(new).write_text(source)
# Root module preserves every unmoved API import path.
p = Path('go.mod')
p.write_text(p.read_text().replace('module github.com/q9labs/chalk/apps/api', 'module github.com/q9labs/chalk'))
Path('features/whiteboard/docs/moves.json').write_text(json.dumps(moves, indent=2) + '\n')
print(f'Moved {len(moves)} tracked files; rewrote source references without copying source.')
