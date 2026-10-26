#!/usr/bin/env python3
"""Prepare free speech fixtures or measure the live proof's actual final MP4."""

import array
import csv
import json
import math
import pathlib
import statistics
import subprocess
import sys


def run(*args):
    return subprocess.check_output(args, stderr=subprocess.PIPE)


def fixtures(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for index, (voice, frequency, text) in enumerate([
        ("en-us", 997, "Speaker alpha. The first microphone is recorded through the real call."),
        ("en-sc", 1999, "Speaker bravo. My microphone returns after the temporary missing track."),
    ]):
        speech = directory / f"speech-{index}.wav"
        run("espeak-ng", "-v", voice, "-s", "150", "-w", str(speech), text)
        run("ffmpeg", "-v", "error", "-y", "-stream_loop", "-1", "-i", str(speech),
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000",
            "-filter_complex", "[0:a]volume=0.6[s];[1:a]volume=0.35[t];[s][t]amix=inputs=2:normalize=0",
            "-t", "20", "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-frame_duration", "20",
            "-page_duration", "20000", str(directory / f"speaker-{index}.ogg"))


def levels(path, frequency=None):
    args = ["ffmpeg", "-v", "error", "-i", str(path)]
    if frequency:
        args += ["-af", f"bandpass=f={frequency}:width_type=h:w=8"]
    raw = run(*args, "-f", "s16le", "-ar", "48000", "-ac", "1", "-")
    values = array.array("h", raw)
    return [round(20 * math.log10(max(1e-7, math.sqrt(sum(x*x for x in values[i:i+48000]) /
            len(values[i:i+48000])) / 32768)), 2) for i in range(0, len(values), 48000)]


def measure(directory):
    mp4 = directory / "recording.mp4"
    probe = json.loads(run("ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(mp4)))
    audio = [stream for stream in probe["streams"] if stream["codec_type"] == "audio"]
    assert len(audio) == 1 and audio[0]["codec_name"] == "aac", audio
    index = json.loads((directory / "decoded" / "decoded_media.json").read_text())
    sources = index["sources"]
    assert len(sources) == 2, sources
    traces = {"final_rms_dbfs": levels(mp4), "alpha_997_hz_dbfs": levels(mp4, 997),
              "bravo_1999_hz_dbfs": levels(mp4, 1999)}
    presentation = json.loads((directory / "presentation.json").read_text())
    names = {participant["id"]: participant["displayName"] for participant in presentation["initial"]["participants"]}
    source_levels = []
    for source in sources:
        path = pathlib.Path(source["path"])
        if not path.is_absolute():
            path = directory / "decoded" / path
        source_levels.append({"speaker": names[source["participant_id"]], "start_ms": source["start_ms"], "end_ms": source["end_ms"],
                              "rms_dbfs": levels(path)})
    # Measure the recovered final mix, not merely the source files or stream count.
    for name in ("alpha_997_hz_dbfs", "bravo_1999_hz_dbfs"):
        assert statistics.median(traces[name][6:-1]) > -45, traces
    summary = {"audio_codec": audio[0]["codec_name"], "audio_streams": len(audio),
               "duration_seconds": float(probe["format"]["duration"]),
               "source_count": len(sources), "source_levels": source_levels, "traces": traces}
    (directory / "audio-proof.json").write_text(json.dumps(summary, indent=2) + "\n")
    (directory / "ffprobe.json").write_text(json.dumps(probe, indent=2) + "\n")
    with (directory / "audio-levels.csv").open("w") as file:
        writer = csv.writer(file)
        writer.writerow(["second", *traces])
        for second in range(min(map(len, traces.values()))):
            writer.writerow([second, *(values[second] for values in traces.values())])
    run("ffmpeg", "-v", "error", "-y", "-i", str(mp4), "-lavfi",
        "showspectrumpic=s=1200x600:legend=1:scale=log:color=intensity", "-frames:v", "1",
        str(directory / "spectrogram.png"))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    action, destination = sys.argv[1:]
    {"fixtures": fixtures, "measure": measure}[action](pathlib.Path(destination).resolve())
