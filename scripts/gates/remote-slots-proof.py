#!/usr/bin/env python3
"""M4-only tiny three-slot PostgreSQL/isolation proof; run from a prepared checkout."""
import json
import os
from pathlib import Path
import runpy
import shlex
import unittest

QueueTest = runpy.run_path(str(Path(__file__).with_name('remote-queue-test.py')))['QueueTest']
repository = Path(__file__).resolve().parents[2]


class PostgresSlotsProof(QueueTest):
    # Inherit the fixture helpers, not the ordinary regression cases.
    def test_postgres_slots(self):
        os.environ['CHALK_REMOTE_SLOTS'] = '3'
        callback = self.root / 'postgres-callback.py'
        callback.write_text('''import json, os, pathlib, socket, subprocess, time
slot = int(os.environ['CHALK_REMOTE_SLOT'])
url = os.environ['CHALK_DATABASE_URL']
psql = '/opt/homebrew/opt/postgresql@18/bin/psql'
sql = f'CREATE TABLE queue_proof(value integer); INSERT INTO queue_proof VALUES ({slot}); SELECT value FROM queue_proof'
result = subprocess.check_output([psql, url, '-Atc', sql], text=True).splitlines()[-1]
assert result == str(slot), result
ports = sorted({int(value) for name,value in os.environ.items() if name.endswith('_PORT') and value.isdigit() and 21000 <= int(value) < 31000})
sockets = []
for port in ports:
    server = socket.socket(); server.bind(('127.0.0.1', port)); server.listen(); sockets.append(server)
root = pathlib.Path(os.environ['PROOF_ROOT'])
(root / f'slot-{slot}.json').write_text(json.dumps({'slot': slot, 'database': url, 'tmp': os.environ['TMPDIR'], 'ports': ports}))
deadline = time.monotonic() + 30
while not (root / 'release').exists():
    assert time.monotonic() < deadline, 'proof release timed out'
    time.sleep(.05)
print(f'PASS slot={slot}: isolated SQL, {len(ports)} port listeners, tmp={os.environ["TMPDIR"]}', flush=True)
''')
        script = (f'mkdir -p "$1/tmp"; export TMPDIR="$1/tmp" PROOF_ROOT={shlex.quote(str(self.root))}; '
                  f'source {shlex.quote(str(repository / "scripts/gates/remote-slot-env.sh"))}; '
                  f'bash {shlex.quote(str(repository / "scripts/gates/with-postgres.sh"))} -- python3 {shlex.quote(str(callback))}')
        for name in ('pg-one', 'pg-two', 'pg-three'):
            self.submit(name, script)
        self.release_dispatcher()
        import time
        deadline = time.monotonic() + 90
        while len(list(self.root.glob('slot-*.json'))) < 3 and time.monotonic() < deadline:
            time.sleep(.1)
        try:
            receipts = [json.loads(path.read_text()) for path in sorted(self.root.glob('slot-*.json'))]
            self.assertEqual(len(receipts), 3, [(name, self.status(name)) for name in ('pg-one', 'pg-two', 'pg-three')])
            for key in ('database', 'tmp'):
                self.assertEqual(len({item[key] for item in receipts}), 3)
            self.assertEqual(len({port for item in receipts for port in item['ports']}), sum(len(item['ports']) for item in receipts))
            for item in receipts:
                print(json.dumps(item), flush=True)
        finally:
            (self.root / 'release').touch()
        for name in ('pg-one', 'pg-two', 'pg-three'):
            self.assertEqual(self.wait(name)['result'], 0, (self.root / 'jobs' / name / 'output.log').read_text())
            print((self.root / 'jobs' / name / 'output.log').read_text(), flush=True)


if __name__ == '__main__':
    unittest.main(defaultTest='PostgresSlotsProof.test_postgres_slots')
