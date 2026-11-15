"""Names the slow steps of Promote's select and recheck in the log."""

import time


def timed(label, step, *args, **kwargs):
    # Promote's select and recheck run for minutes; the log must say which step took them.
    start = time.monotonic()
    try:
        return step(*args, **kwargs)
    finally:
        print(f'{label}: {time.monotonic() - start:.1f}s', flush=True)
