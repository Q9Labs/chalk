import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# What decides the Chalk SFU's media speed: the `media` paths in features.json, the latency kit and the stack it measures on.
LATENCY_EXTRA_PATHS = ('features/scorecard', 'perf/budgets.json', 'scripts/nightly-stack', 'scripts/prod-proof',
                       '.github/workflows/nightly-latency.yml', '.github/workflows/nightly-proofs.yml')


def latency_paths():
    features = json.loads((ROOT / 'features.json').read_text())['features']
    return tuple(next(item for item in features if item['name'] == 'media')['paths']) + LATENCY_EXTRA_PATHS
