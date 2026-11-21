#!/bin/sh
set -eu
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-"$HOME/Library/Android/sdk"}}
tools="$sdk/build-tools/35.0.0"
platform="$sdk/platforms/android-35/android.jar"
src=$(cd "$(dirname "$0")" && pwd)
out=${1:?Pass an output directory}
mkdir -p "$out"
out=$(cd "$out" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ ! -f "$out/probe.jks" ]; then
  keytool -genkeypair -keystore "$out/probe.jks" -alias probe -storepass android -keypass android \
    -dname CN=ChalkProbe -keyalg RSA -validity 365
fi

build() {
  manifest=$1
  package=$2
  shift 2
  rm -rf "$work/classes" "$work/dex"
  mkdir "$work/classes" "$work/dex"
  javac --release 17 -Xlint:-deprecation -classpath "$platform" -d "$work/classes" "$@"
  jar cf "$work/classes.jar" -C "$work/classes" .
  "$tools/d8" --min-api 34 --lib "$platform" --output "$work/dex" "$work/classes.jar"
  "$tools/aapt2" link -I "$platform" --manifest "$manifest" --rename-manifest-package "$package" \
    --min-sdk-version 34 --target-sdk-version 35 -o "$work/unsigned.apk"
  (cd "$work/dex" && zip -q "$work/unsigned.apk" classes.dex)
  "$tools/zipalign" -f 4 "$work/unsigned.apk" "$work/aligned.apk"
  "$tools/apksigner" sign --ks "$out/probe.jks" --ks-pass pass:android \
    --out "$out/$package.apk" "$work/aligned.apk"
}

build "$src/AndroidManifest.xml" ai.chalk.probe "$src/ProbeActivity.java" "$src/ProbeService.java"
build "$src/TargetManifest.xml" ai.chalk.probe.target "$src/TargetActivity.java"
