"""The existing Promote override accepts any reason containing non-whitespace text."""

import os
import sys


def override_reason(value):
    return value if value.strip() else ''


if __name__ == '__main__':
    sys.stdout.write(override_reason(os.environ.get('SCORECARD_OVERRIDE', '')))
