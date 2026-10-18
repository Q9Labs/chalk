#!/usr/bin/env python3
"""Task-owned M4 captures. Prepared native builds persist until --cleanup; processes do not."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import uuid
import socket
import hashlib
import fcntl

SSH = ['ssh', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']

def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def remote(args):
    path = Path(args.remote)
    if path.parent != Path('/tmp') or not path.name.startswith('chalk-mobile-') or path.is_symlink():
        raise ValueError('Expected a task-owned /tmp/chalk-mobile-* directory')
    if args.cleanup:
        import shutil
        shutil.rmtree(path)
        return
    import time
    import signal
    processes = []
    device = None
    emulator = None
    avd_created = False
    # Both native clients use the same compiled Metro port; serialize across platforms.
    lock = open("/tmp/chalk-mobile-capture.lock", "a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    recorder = None
    manager = None
    avd = None
    owner_state = Path('/tmp/chalk-mobile-owner-' + uuid.uuid4().hex + '.json')
    def remember():
        temporary = owner_state.with_suffix('.pending')
        temporary.write_text(json.dumps({'groups': [proc.pid for proc in processes if proc.poll() is None], 'device': device, 'avd': avd if avd_created else None, 'manager': str(manager) if manager else None}))
        temporary.replace(owner_state)
    remember()
    watcher = subprocess.Popen([sys.executable, str(Path(__file__).with_name('capture-owner-watch.py')), str(owner_state)], stdin=subprocess.PIPE, start_new_session=True)
    def run(command, **kwargs):
        data = kwargs.pop('input', None)
        if data is not None:
            kwargs['stdin'] = subprocess.PIPE
        proc = subprocess.Popen(command, start_new_session=True, **kwargs)
        processes.append(proc)
        remember()
        try:
            proc.communicate(data)
            if proc.returncode:
                raise subprocess.CalledProcessError(proc.returncode, command)
            return proc
        finally:
            remember()
    def stop(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGHUP, stop)
    # An owner-loss timeout bounds every remote session, including SSH interruption.
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(2400)
    def start(command, log):
        handle = open(path / log, 'w')
        proc = subprocess.Popen(command, cwd=path, stdout=handle, stderr=subprocess.STDOUT, start_new_session=True)
        handle.close()
        processes.append(proc)
        remember()
        return proc
    def terminate(proc):
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
    try:
        os.chdir(path)
        run(['df', '-h', '/'])
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', args.port))
        # Always reconcile the lockfile. pnpm reuses unchanged dependencies cheaply.
        run(['pnpm', 'install', '--frozen-lockfile'])
        if not os.environ.get('JAVA_HOME'):
            existing_java = Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
            if (existing_java / 'bin/java').exists():
                os.environ['JAVA_HOME'] = str(existing_java)
                os.environ['PATH'] = str(existing_java / 'bin') + ':' + os.environ['PATH']
        os.environ['MAESTRO_CLI_NO_ANALYTICS'] = 'true'
        os.environ['MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED'] = 'true'
        os.environ['MAESTRO_DISABLE_UPDATE_CHECK'] = 'true'
        # Expo's localhost otherwise binds only ::1 on this host; adb reverse uses IPv4.
        os.environ['NODE_OPTIONS'] = (os.environ.get('NODE_OPTIONS', '') + ' --dns-result-order=ipv4first').strip()
        app = path / 'apps/mobile'
        # Package exports resolve dist: rebuilding it is required even when native binaries are cached.
        run(['pnpm', '--dir', str(app), 'run', 'prepare:native-dependencies'])
        native_inputs = [path / item for item in ['pnpm-lock.yaml', 'apps/mobile/package.json', 'apps/mobile/app.config.ts', 'sdks/typescript/react-native/package.json']]
        native_inputs += sorted((app / 'assets').rglob('*'))
        signature = hashlib.sha256(b''.join(item.read_bytes() for item in native_inputs if item.is_file())).hexdigest()
        stamp = path / ('native-' + args.platform + '.stamp')
        prepared = stamp.exists() and stamp.read_text() == signature
        bundle = 'ai.q9labs.chalk.mobile'
        if args.platform == 'ios':
            inventory = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'booted', '-j']))
            if any(inventory['devices'].values()):
                raise RuntimeError('Another simulator is booted; refusing to start a second one')
            runtimes = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'runtimes', '-j']))['runtimes']
            runtime = next(r['identifier'] for r in runtimes if r['isAvailable'] and r['name'].startswith('iOS'))
            device = subprocess.check_output(['xcrun', 'simctl', 'create', path.name, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16', runtime], text=True).strip()
            remember()
            run(['xcrun', 'simctl', 'boot', device])
            run(['xcrun', 'simctl', 'bootstatus', device, '-b'])
            built = path / 'native-build/Build/Products/Debug-iphonesimulator/Chalk.app'
            if not prepared or not built.exists():
                run(['pnpm', '--dir', str(app), 'exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install'])
                run(['pod', 'install'], cwd=app / 'ios')
                workspaces = list((app / 'ios').glob('*.xcworkspace'))
                if len(workspaces) != 1:
                    raise RuntimeError('Expected exactly one generated Xcode workspace')
                run(['xcodebuild', '-workspace', str(workspaces[0]), '-scheme', 'Chalk', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', f'id={device}', '-derivedDataPath', str(path / 'native-build'), 'IPHONEOS_DEPLOYMENT_TARGET=15.1', 'build'], stdout=open(path / 'xcodebuild.log', 'w'), stderr=subprocess.STDOUT)
                stamp.write_text(signature)
            run(['xcrun', 'simctl', 'install', device, str(built)])
        else:
            sdk = Path.home() / 'Library/Android/sdk'
            os.environ['ANDROID_HOME'] = str(sdk)
            os.environ['ANDROID_SDK_ROOT'] = str(sdk)
            java_homes = [Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home'), Path('/Applications/Android Studio.app/Contents/jbr/Contents/Home')]
            if not os.environ.get('JAVA_HOME'):
                java_home = next((home for home in java_homes if (home / 'bin/java').exists()), None)
                if not java_home:
                    raise RuntimeError('Android capture requires JAVA_HOME pointing to an installed JDK')
                os.environ['JAVA_HOME'] = str(java_home)
                os.environ['PATH'] = str(java_home / 'bin') + ':' + os.environ['PATH']
            adb = str(sdk / 'platform-tools/adb')
            if 'emulator-' in subprocess.check_output([adb, 'devices'], text=True):
                raise RuntimeError('Another emulator is running; refusing to start a second one')
            images = list((sdk / 'system-images').glob('*/google_apis/arm64-v8a'))
            if not images:
                raise RuntimeError('No Android ARM64 Google APIs system image is installed')
            image = sorted(images)[-1]
            avd = path.name
            manager = next((sdk / 'cmdline-tools').glob('*/bin/avdmanager'))
            run([str(manager), 'create', 'avd', '-n', avd, '-k', ';'.join(image.relative_to(sdk).parts)], input='no\n', text=True)
            avd_created = True
            remember()
            emulator = start([str(sdk / 'emulator/emulator'), '-avd', avd, '-no-snapshot', '-no-window', '-port', '5580'], 'emulator.log')
            run([adb, '-s', 'emulator-5580', 'wait-for-device'])
            deadline = time.monotonic() + 180
            while subprocess.check_output([adb, '-s', 'emulator-5580', 'shell', 'getprop', 'sys.boot_completed'], text=True).strip() != '1':
                if emulator.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Emulator failed to boot')
                time.sleep(1)
            run([adb, '-s', 'emulator-5580', 'shell', 'wm', 'size', '1236x2745'])
            run([adb, '-s', 'emulator-5580', 'shell', 'wm', 'density', '480'])
            apk = app / 'android/app/build/outputs/apk/debug/app-debug.apk'
            if not prepared or not apk.exists():
                run(['pnpm', '--dir', str(app), 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'])
                run(['./gradlew', 'assembleDebug'], cwd=app / 'android')
                stamp.write_text(signature)
            run([adb, '-s', 'emulator-5580', 'install', '-r', str(apk)])
        metro = start(['pnpm', '--dir', str(app), 'exec', 'expo', 'start', '--localhost', '--port', str(args.port)], 'metro.log')
        import urllib.request
        deadline = time.monotonic() + 120
        while True:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/status', timeout=2) as response:
                    if b'packager-status:running' in response.read():
                        break
            except OSError:
                if metro.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Metro did not become ready; see metro.log')
                time.sleep(1)
        out = path / 'captures'
        out.mkdir(exist_ok=True)
        for index, codes in enumerate(args.states):
            from urllib.parse import urlencode
            query = {'codes': codes}
            if args.dump:
                query.update(dump=args.dump, ids=args.ids)
            url = 'chalk://dev/states?' + urlencode(query)
            light = 'V2' in codes.split(',')
            if args.platform == 'ios':
                run(['xcrun', 'simctl', 'ui', device, 'appearance', 'light' if light else 'dark'])
                start(['xcrun', 'simctl', 'launch', '--console', device, bundle], 'app-console.log')
                import shutil
                if not shutil.which(args.maestro):
                    raise RuntimeError('iOS deep-link confirmation requires Maestro; pass --maestro /path/on/M4')
                opening = path / 'open-link.yaml'
                opening.write_text('appId: ' + bundle + '\n---\n- openLink:\n    link: ' + json.dumps(url) + '\n- tapOn:\n    text: Open\n    optional: true\n- extendedWaitUntil:\n    visible:\n      id: harness.ready\n    timeout: 120000\n')
                run([args.maestro, '--device', device, 'test', str(opening)])
            else:
                run([adb, '-s', 'emulator-5580', 'reverse', f'tcp:{args.port}', f'tcp:{args.port}'])
                run([adb, '-s', 'emulator-5580', 'shell', 'cmd', 'uimode', 'night', 'no' if light else 'yes'])
                run([adb, '-s', 'emulator-5580', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, bundle])
                opening = path / 'android-ready.yaml'
                opening.write_text('appId: ' + bundle + '\n---\n- extendedWaitUntil:\n    visible:\n      id: harness.ready\n    timeout: 120000\n')
                run([args.maestro, '--device', 'emulator-5580', 'test', str(opening)])
            time.sleep(args.settle)
            if args.flow:
                import shutil
                if not shutil.which(args.maestro):
                    raise RuntimeError('Scripted tap/drag capture needs Maestro on the M4')
                if args.platform == 'ios':
                    recorder = start(['xcrun', 'simctl', 'io', device, 'recordVideo', str(out / f'{index}.mp4')], 'recording.log')
                else:
                    recorder = start([adb, '-s', 'emulator-5580', 'shell', 'screenrecord', '--time-limit', '120', '/sdcard/chalk-feel.mp4'], 'recording.log')
                try:
                    run([args.maestro, '--device', device if args.platform == 'ios' else 'emulator-5580', 'test', args.flow])
                finally:
                    if recorder.poll() is None:
                        if args.platform == 'android':
                            run([adb, '-s', 'emulator-5580', 'shell', 'pkill', '-2', 'screenrecord'])
                        else:
                            os.killpg(recorder.pid, signal.SIGINT)
                        recorder.wait(timeout=15)
                if args.platform == 'android':
                    run([adb, '-s', 'emulator-5580', 'pull', '/sdcard/chalk-feel.mp4', str(out / f'{index}.mp4')])
            target = out / f'{index}-{codes.replace(",", "-")}.png'
            if args.platform == 'ios':
                run(['xcrun', 'simctl', 'io', device, 'screenshot', str(target)])
            else:
                with target.open('wb') as output:
                    run([adb, '-s', 'emulator-5580', 'exec-out', 'screencap', '-p'], stdout=output)
        (out / 'manifest.json').write_text(json.dumps({'platform': args.platform, 'states': args.states, 'screen': [393, 852] if args.platform == 'ios' else [412, 915], 'scale': 3}, indent=2))
    finally:
        for proc in reversed(processes):
            terminate(proc)
        if device:
            subprocess.run(['xcrun', 'simctl', 'shutdown', device])
            subprocess.run(['xcrun', 'simctl', 'delete', device])
        if avd_created:
            subprocess.run([str(manager), 'delete', 'avd', '-n', avd])
        device = None
        avd_created = False
        remember()
        watcher.stdin.close()
        watcher.wait(timeout=30)
        lock.close()


def owned_copy(args, dest, host):
    # Hold a per-copy lease BEFORE rsync, including cleanup. EOF releases it after owner loss.
    lease_code = "import fcntl,sys; f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('READY',flush=True); sys.stdin.read()"
    lease = subprocess.Popen([*SSH, host, shlex.join(['python3', '-c', lease_code, dest + '.lease'])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        if lease.stdout.readline().strip() != 'READY':
            raise RuntimeError('Prepared copy is in use; choose a unique --name')
        perform_copy(args, dest, host)
    finally:
        lease.stdin.close()
        lease.wait(timeout=15)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--worktree', default=str(Path(__file__).resolve().parents[3]))
    p.add_argument('--name', default='harness-' + uuid.uuid4().hex[:8])
    p.add_argument('--platform', choices=['ios', 'android'], default='ios')
    p.add_argument('--states', nargs='+', default=['D1,P3,A2,V1'])
    p.add_argument('--output', default='artifacts/mobile-captures')
    p.add_argument('--port', type=int, default=8081)
    p.add_argument('--settle', type=float, default=4)
    p.add_argument('--dump')
    p.add_argument('--ids', default='')
    p.add_argument('--maestro', default='maestro', help='Maestro executable path on the M4')
    p.add_argument('--flow', help='Maestro YAML: tapOn accessibility text, swipe and waitForAnimationToEnd')
    p.add_argument('--cleanup', action='store_true')
    p.add_argument('--remote', help=argparse.SUPPRESS)
    args = p.parse_args()
    if args.port != 8081:
        p.error('Only port 8081 is supported by the cached native clients')
    if args.remote:
        remote(args)
        return
    if not args.name.replace('-', '').isalnum():
        p.error('--name must be alphanumeric with hyphens')
    dest = '/tmp/chalk-mobile-' + args.name
    host = 'agents-macmini'
    owned_copy(args, dest, host)


def perform_copy(args, dest, host):
    run([*SSH, host, 'df -h /'])
    if not args.cleanup:
        run(['rsync', '-az', '-e', shlex.join(SSH), '--delete', '--exclude=/native-build', '--exclude=/native-*.stamp', '--exclude=/captures', '--exclude=*.log', '--exclude=.expo', '--exclude=node_modules', '--exclude=.git', '--exclude=.worktrees', '--exclude=.env*', '--exclude=scratchpad', '--exclude=/apps/mobile/ios', '--exclude=/apps/mobile/android', '--exclude=artifacts', '--exclude=dist', str(Path(args.worktree).resolve()) + '/', host + ':' + dest + '/'])
    command = ['python3', dest + '/apps/mobile/scripts/capture-states.py', '--remote', dest, '--platform', args.platform, '--port', str(args.port), '--settle', str(args.settle), '--maestro', args.maestro, '--states', *args.states]
    if args.cleanup:
        command.append('--cleanup')
    if args.dump:
        command += ['--dump', args.dump, '--ids', args.ids]
    if args.flow:
        run(['scp', args.flow, host + ':' + dest + '/capture-flow.yaml'])
        command += ['--flow', dest + '/capture-flow.yaml']
    try:
        run([*SSH, host, shlex.join(command)])
    finally:
        if not args.cleanup:
            Path(args.output).mkdir(parents=True, exist_ok=True)
            subprocess.run(['rsync', '-az', host + ':' + dest + '/captures/', args.output + '/'])
            subprocess.run(['rsync', '-az', '--include=*.log', '--exclude=*', host + ':' + dest + '/', args.output + '/'])


if __name__ == '__main__':
    main()
