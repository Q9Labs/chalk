"""Counts o200k tokens of every golden and records them with the file's sha256 in tokens.json.

Run from the repo root after the goldens change:
    uv run -q --no-project --with tiktoken python scripts/diagnose-call/golden/count_tokens.py
The node test compares the shas, so a stale count fails the suite instead of passing quietly.
"""

import hashlib
import json
import pathlib

import tiktoken

here = pathlib.Path(__file__).parent
encoding = tiktoken.get_encoding("o200k_base")
counts = {}
for path in sorted(here.glob("*.txt")) + sorted(here.glob("*.json")):
    if path.name == "tokens.json":
        continue
    data = path.read_bytes()
    counts[path.name] = {"sha256": hashlib.sha256(data).hexdigest(), "o200k": len(encoding.encode(data.decode("utf-8")))}
(here / "tokens.json").write_text(json.dumps(dict(sorted(counts.items())), indent=1) + "\n")
for name, entry in sorted(counts.items()):
    print(f"{entry['o200k']:5d}  {name}")
