#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict

from transcriber import WhisperTranscriber


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe a local audio file with faster-whisper.")
    parser.add_argument("audio_path", help="Path to a local audio file")
    parser.add_argument("--language", default=None, help="Optional language hint")
    parser.add_argument(
        "--batched",
        action="store_true",
        help="Force batched inference path regardless of queue depth",
    )
    parser.add_argument(
        "--expect-contains",
        default=None,
        help="Fail if transcript does not contain this substring (case-insensitive)",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    transcriber = WhisperTranscriber()
    result = transcriber.transcribe(
        args.audio_path,
        language=args.language,
        use_batched=args.batched,
    )
    print(json.dumps(asdict(result), indent=2, ensure_ascii=True))

    if args.expect_contains:
        actual = (result.text or "").casefold()
        expected = args.expect_contains.casefold()
        if expected not in actual:
            print(
                json.dumps(
                    {
                        "event": "transcribe.expectation_failed",
                        "expected": args.expect_contains,
                        "actual": result.text or "",
                    },
                    ensure_ascii=True,
                ),
                file=sys.stderr,
            )
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
