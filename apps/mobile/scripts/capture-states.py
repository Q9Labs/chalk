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

SSH = ['ssh', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']
SCP = ['scp', *SSH[1:]]

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
    serial = f'emulator-{args.emulator_port}'
    avd_created = False
    slot = args.slot or args.platform + "-1"
    lock = open("/tmp/chalk-mobile-slot-" + slot + ".lock", "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as cause:
        raise RuntimeError(f'Device slot {slot} is leased by another check; choose another slot') from cause
    driver_port = 22180 + int(slot.rsplit('-', 1)[1]) if args.platform == 'ios' else 22184
    recorder = None
    manager = None
    avd = None
    receiver = None
    owner_state = Path('/tmp/chalk-mobile-owner-' + uuid.uuid4().hex + '.json')
    def remember():
        temporary = owner_state.with_suffix('.pending')
        temporary.write_text(json.dumps({'groups': [proc.pid for proc in processes if proc.poll() is None], 'device': device, 'avd': avd if avd_created else None, 'manager': str(manager) if manager else None, 'retain_device': bool(args.client_cache)}))
        temporary.replace(owner_state)
    remember()
    with (path / 'owner-cleanup.log').open('w') as cleanup_log:
        watcher = subprocess.Popen([sys.executable, str(Path(__file__).with_name('capture-owner-watch.py')), str(owner_state)], stdin=subprocess.PIPE, stdout=cleanup_log, stderr=subprocess.STDOUT, start_new_session=True, pass_fds=(lock.fileno(),))
    def run(command, **kwargs):
        data = kwargs.pop('input', None)
        timeout = kwargs.pop('timeout', None)
        if data is not None:
            kwargs['stdin'] = subprocess.PIPE
        proc = subprocess.Popen(command, start_new_session=True, **kwargs)
        processes.append(proc)
        remember()
        try:
            proc.communicate(data, timeout=timeout)
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
        out = path / 'captures'
        import shutil
        if out.exists():
            shutil.rmtree(out)
        out.mkdir()
        run(['df', '-h', '/'])
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', args.port))
        # Always reconcile the lockfile. pnpm reuses unchanged dependencies cheaply.
        run(['pnpm', 'install', '--frozen-lockfile'])
        if not os.environ.get('JAVA_HOME'):
            existing_java = Path('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
            if (existing_java / 'bin/java').exists():
                os.environ['JAVA_HOME'] = str(existing_java)
                os.environ['PATH'] = str(existing_java / 'bin') + ':' + os.environ['PATH']
        os.environ['MAESTRO_DRIVER_STARTUP_TIMEOUT'] = '240000'
        os.environ['MAESTRO_CLI_NO_ANALYTICS'] = 'true'
        os.environ['MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED'] = 'true'
        os.environ['MAESTRO_DISABLE_UPDATE_CHECK'] = 'true'
        # Expo's localhost otherwise binds only ::1 on this host; adb reverse uses IPv4.
        os.environ['NODE_OPTIONS'] = (os.environ.get('NODE_OPTIONS', '') + ' --dns-result-order=ipv4first').strip()
        app = path / 'apps/mobile'
        # Package exports resolve dist: rebuilding it is required even when native binaries are cached.
        run(['pnpm', '--dir', str(app), 'run', 'prepare:native-dependencies'])
        native_inputs = json.loads((path / 'native-inputs.json').read_text())
        digest = hashlib.sha256()
        for relative in native_inputs:
            content = (path / relative).read_bytes()
            if relative.endswith('/package.json'):
                package = json.loads(content)
                package.pop('scripts', None)
                content = json.dumps(package, sort_keys=True, separators=(',', ':')).encode()
            digest.update(relative.encode() + b'\0' + content + b'\0')
        signature = digest.hexdigest()
        stamp = path / ('native-' + args.platform + '.stamp')
        prepared = stamp.exists() and stamp.read_text() == signature
        cache = Path(args.client_cache) if args.client_cache else path
        if args.client_cache and (cache / 'shared-inputs.sha256').read_text().strip() != signature:
            raise RuntimeError('Shared client fingerprint differs: native dependencies/config/assets changed; rebuild once before capture')
        bundle = 'ai.q9labs.chalk.mobile'
        if args.platform == 'ios':
            runtimes = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'runtimes', '-j']))['runtimes']
            runtime = next(r['identifier'] for r in runtimes if r['isAvailable'] and r['name'].startswith('iOS'))
            pool_name = 'chalk-mobile-slot-' + slot if args.client_cache else path.name + args.device_label
            inventory = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', '-j']))
            existing = next((entry for entries in inventory['devices'].values() for entry in entries if entry['name'] == pool_name), None)
            device = existing['udid'] if existing else None
            if not device:
                device = subprocess.check_output(['xcrun', 'simctl', 'create', pool_name, args.device_type, runtime], text=True).strip()
            remember()
            if not existing or existing['state'] == 'Shutdown':
                run(['xcrun', 'simctl', 'boot', device])
            run(['xcrun', 'simctl', 'bootstatus', device, '-b'])
            if args.clean_status_bar:
                run(['xcrun', 'simctl', 'status_bar', device, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100'])
            built = cache / 'native-build/Build/Products/Debug-iphonesimulator/Chalk.app'
            if args.client_cache and not built.exists():
                raise RuntimeError('Shared iOS client missing')
            if not args.client_cache and (not prepared or not built.exists()):
                if not (app / 'ios/Chalk.xcodeproj').exists():
                    run(['pnpm', '--dir', str(app), 'exec', 'expo', 'prebuild', '--platform', 'ios', '--no-install'])
                if args.ios_proof_overlay:
                    run(['python3', args.ios_proof_overlay, str(app)])
                    (path / 'native-proof.json').write_text(json.dumps({'ios_overlay_sha256': hashlib.sha256(Path(args.ios_proof_overlay).read_bytes()).hexdigest(), 'kind': 'M4-only; excluded from release source'}))
                run(['pod', 'install'], cwd=app / 'ios')
                workspaces = list((app / 'ios').glob('*.xcworkspace'))
                if len(workspaces) != 1:
                    raise RuntimeError('Expected exactly one generated Xcode workspace')
                run(['xcodebuild', '-workspace', str(workspaces[0]), '-scheme', 'Chalk', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', f'id={device}', '-derivedDataPath', str(path / 'native-build'), 'IPHONEOS_DEPLOYMENT_TARGET=15.1', 'build'], stdout=open(path / 'xcodebuild.log', 'w'), stderr=subprocess.STDOUT)
                stamp.write_text(signature)
            run(['xcrun', 'simctl', 'install', device, str(built)])
            app_data = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', device, bundle, 'data'], text=True).strip())
            preferences = app_data / 'Library/Preferences'
            preferences.mkdir(parents=True, exist_ok=True)
            run(['defaults', 'write', str(preferences / bundle), 'RCT_jsLocation', '-string', f'127.0.0.1:{args.port}'])
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
            if serial in subprocess.check_output([adb, 'devices'], text=True):
                raise RuntimeError('Selected emulator port already in use; refusing to touch another owner')
            images = list((sdk / 'system-images').glob('*/google_apis/arm64-v8a'))
            if not images:
                raise RuntimeError('No Android ARM64 Google APIs system image is installed')
            image = sorted(images)[-1]
            avd = 'chalk-mobile-slot-' + slot if args.client_cache else path.name
            manager = next((sdk / 'cmdline-tools').glob('*/bin/avdmanager'))
            if not (Path.home() / '.android/avd' / (avd + '.ini')).exists():
                run([str(manager), 'create', 'avd', '-n', avd, '-k', ';'.join(image.relative_to(sdk).parts)], input='no\n', text=True)
            config = Path.home() / '.android/avd' / (avd + '.avd/config.ini')
            display = {'hw.lcd.width': '1236', 'hw.lcd.height': '2745', 'hw.lcd.density': '480', 'hw.cpu.ncore': '2', 'hw.ramSize': '1536', 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': args.android_gpu, 'skin.dynamic': 'yes', 'skin.name': '1236x2745'}
            values = dict(line.split('=', 1) for line in config.read_text().splitlines() if '=' in line)
            values.update(display)
            config.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
            avd_created = True
            remember()
            emulator = start([str(sdk / 'emulator/emulator'), '-avd', avd, '-no-snapshot', '-no-window', '-no-boot-anim', '-skin', '1236x2745', '-cores', '2', '-memory', '1536', '-gpu', args.android_gpu, '-port', str(args.emulator_port)], 'emulator.log')
            run([adb, '-s', serial, 'wait-for-device'])
            deadline = time.monotonic() + 180
            while subprocess.check_output([adb, '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], text=True).strip() != '1':
                if emulator.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError('Emulator failed to boot')
                time.sleep(1)
            run([adb, '-s', serial, 'shell', 'wm', 'size', args.android_size])
            run([adb, '-s', serial, 'shell', 'wm', 'density', str(args.android_density)])
            if args.clean_status_bar:
                # SystemUI demo mode: fixed clock, full battery, full signal, no notifications.
                demo = [['enter'], ['clock', '-e', 'hhmm', '0941'], ['battery', '-e', 'level', '100', '-e', 'plugged', 'false'], ['network', '-e', 'wifi', 'show', '-e', 'level', '4'], ['network', '-e', 'mobile', 'show', '-e', 'datatype', 'none', '-e', 'level', '4'], ['notifications', '-e', 'visible', 'false']]
                run([adb, '-s', serial, 'shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1'])
                for command in demo:
                    run([adb, '-s', serial, 'shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', *command])
            start([adb, '-s', serial, 'logcat', '-v', 'threadtime', 'ReactNativeJS:V', 'AndroidRuntime:V', '*:S'], 'app-console.log')
            apk = cache / 'apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk'
            if args.client_cache and not apk.exists():
                raise RuntimeError('Shared Android client missing')
            if not args.client_cache and (not prepared or not apk.exists()):
                if not (app / 'android/gradlew').exists():
                    run(['pnpm', '--dir', str(app), 'exec', 'expo', 'prebuild', '--platform', 'android', '--no-install'])
                debug_key = app / 'android/app/debug.keystore'
                if not debug_key.exists():
                    # Public Android debug signing credentials, never a release key.
                    run(['keytool', '-genkeypair', '-keystore', str(debug_key), '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
                run(['./gradlew', 'assembleDebug', '-PreactNativeArchitectures=arm64-v8a'], cwd=app / 'android')
                stamp.write_text(signature)
            with (path / 'android-install.log').open('w') as install_log:
                try:
                    run([adb, '-s', serial, 'install', '-r', str(apk)], stdout=install_log, stderr=subprocess.STDOUT)
                except subprocess.CalledProcessError:
                    if not args.client_cache or 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' not in (path / 'android-install.log').read_text():
                        raise
                    print('Replacing differently signed debug app on the leased capture pool', flush=True)
                    run([adb, '-s', serial, 'uninstall', bundle])
                    run([adb, '-s', serial, 'install', '-r', str(apk)])
        if args.platform == 'android':
            preferences = '<?xml version="1.0" encoding="utf-8"?><map><string name="debug_http_host">127.0.0.1:' + str(args.port) + '</string></map>'
            run([adb, '-s', serial, 'shell', 'run-as', bundle, 'mkdir', '-p', 'shared_prefs'])
            run([adb, '-s', serial, 'shell', 'run-as', bundle, 'sh', '-c', shlex.quote('cat > shared_prefs/' + bundle + '_preferences.xml')], input=preferences, text=True)
        metro = start(['pnpm', '--dir', str(app), 'exec', 'expo', 'start', '--clear', '--localhost', '--port', str(args.port)], 'metro.log')
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
        from http.server import BaseHTTPRequestHandler, HTTPServer
        received = {}
        class Measurements(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                    if self.path != '/dump' or not 0 < size <= 1000000:
                        raise ValueError('Invalid measurement upload')
                    payload = json.loads(self.rfile.read(size))
                    received[payload['codes']] = payload
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'ok')
                except (ValueError, KeyError) as cause:
                    self.send_error(400, str(cause))
            def log_message(self, *_):
                pass
        receiver = HTTPServer(('127.0.0.1', 0), Measurements)
        receiver.timeout = 1
        measurement_port = receiver.server_address[1]
        if args.platform == 'android':
            run([adb, '-s', serial, 'reverse', f'tcp:{measurement_port}', f'tcp:{measurement_port}'])
        else:
            start(['xcrun', 'simctl', 'spawn', device, 'log', 'stream', '--style', 'compact', '--predicate', 'process == "Chalk"'], 'app-console.log')
        orientation = 'portrait'
        dismiss = out / 'dismiss-open.yaml'
        dismiss.write_text('appId: ' + bundle + '\n---\n- tapOn:\n    text: "Open"\n    optional: true\n')

        def open_url(url):
            # iOS asks "Open in Chalk?" before simctl openurl reaches the app, and every URL queues its own prompt.
            run(['xcrun', 'simctl', 'openurl', device, url])
            run([args.maestro, '--device', device, 'test', '--driver-host-port', str(driver_port), str(dismiss)], timeout=240)
        failures = []
        payload = {}
        actual = None
        for index, state in enumerate(args.states):
            try:
                from urllib.parse import parse_qsl, urlencode
                codes, _, options = state.partition('?')
                query = {'codes': codes}
                query.update(parse_qsl(options, strict_parsing=True))
                if args.sheet:
                    query['sheet'] = args.sheet
                if args.menu:
                    query['menu'] = args.menu
                requested_ids = list(dict.fromkeys(['frame.screen', *filter(None, args.ids.split(','))]))
                query.update(dump=f'http://127.0.0.1:{measurement_port}/dump', ids=','.join(requested_ids), capture=state)
                received.pop(state, None)
                url = 'chalk://dev/states?' + urlencode(query)
                light = 'V2' in codes.split(',')
                if args.platform == 'ios':
                    run(['xcrun', 'simctl', 'ui', device, 'appearance', 'light' if light else 'dark'])
                    if index == 0:
                        subprocess.run(['xcrun', 'simctl', 'terminate', device, bundle], capture_output=True)
                        run(['xcrun', 'simctl', 'launch', device, bundle, '-RCT_jsLocation', f'127.0.0.1:{args.port}'])
                    next_orientation = 'landscape' if 'O2' in codes.split(',') else 'portrait'
                    if next_orientation != orientation:
                        flow = out / 'orientation.yaml'
                        flow.write_text('appId: ' + bundle + '\n---\n- setOrientation: ' + ('LANDSCAPE_LEFT' if next_orientation == 'landscape' else 'PORTRAIT') + '\n')
                        run([args.maestro, '--device', device, 'test', '--driver-host-port', str(driver_port), str(flow)], timeout=300)
                        orientation = next_orientation
                    open_url(url)
                else:
                    run([adb, '-s', serial, 'reverse', f'tcp:{args.port}', f'tcp:{args.port}'])
                    run([adb, '-s', serial, 'shell', 'cmd', 'uimode', 'night', 'no' if light else 'yes'])
                    run([adb, '-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'])
                    run([adb, '-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', '1' if 'O2' in codes.split(',') else '0'])
                    run([adb, '-s', serial, 'shell', shlex.join(['am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, bundle])])
                deadline = time.monotonic() + 180
                warm_deliveries = [time.monotonic() + delay for delay in range(10, 180, 10)] if index == 0 and args.platform == 'ios' else []
                while state not in received:
                    if metro.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError(f'No native SDK measurement upload for {state}; inspect app-console.log/metro.log')
                    receiver.handle_request()
                    if state not in received and warm_deliveries and time.monotonic() >= warm_deliveries[0]:
                        # A cold native launch may deliver the URL before JS installs its Linking listener.
                        open_url(url)
                        warm_deliveries.pop(0)
                payload = received.pop(state)
                (out / f'{index}-measurements.json').write_text(json.dumps(payload, indent=2))
                if payload.get('platform') != args.platform or not payload.get('root', {}).get('frame') or not payload.get('measurements', {}).get('frame.screen', {}).get('frame'):
                    raise RuntimeError(f'Native {payload.get("surface", "sdk")} root is not mounted for {state}: {payload}; inspect unsupported-state errors and native startup logs')
                if args.platform == 'ios':
                    expected, expected_scale = [int(value) for value in args.expect_size.split('x')], args.expect_scale
                else:
                    expected, expected_scale = [412, 915], 3
                if 'O2' in codes.split(','):
                    expected.reverse()
                actual = [payload.get('screen', {}).get('width'), payload.get('screen', {}).get('height')]
                if not args.skip_size_check and (actual != expected or payload.get('scale') != expected_scale):
                    raise RuntimeError(f'Wrong native device: expected {expected} at {expected_scale}x, received {actual} at {payload.get("scale")}x')
                print(f'Native SDK ready: {state}', flush=True)
                if args.dump:
                    request = urllib.request.Request(args.dump, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
                    with urllib.request.urlopen(request, timeout=10) as response:
                        response.read()
                time.sleep(args.settle)
                if args.platform == 'android':
                    run([adb, '-s', serial, 'shell', 'uiautomator', 'dump', '/sdcard/chalk-capture-ui.xml'])
                    hierarchy = subprocess.check_output([adb, '-s', serial, 'exec-out', 'cat', '/sdcard/chalk-capture-ui.xml'], text=True)
                    if "isn't responding" in hierarchy or 'isn\u2019t responding' in hierarchy:
                        raise RuntimeError('Android ANR dialog covers the app; capture rejected')
                if args.flow:
                    import shutil
                    if not shutil.which(args.maestro):
                        raise RuntimeError('Scripted tap/drag capture needs Maestro on the M4')
                    if args.platform == 'ios':
                        recorder = start(['xcrun', 'simctl', 'io', device, 'recordVideo', str(out / f'{index}.mp4')], 'recording.log')
                    else:
                        recorder = start([adb, '-s', serial, 'shell', 'screenrecord', '--time-limit', '120', '/sdcard/chalk-feel.mp4'], 'recording.log')
                    try:
                        run([args.maestro, '--device', device if args.platform == 'ios' else serial, 'test', '--driver-host-port', str(driver_port), '--debug-output', str(out / f'maestro-{index}'), '--test-output-dir', str(out / f'journey-{index}'), '--format', 'junit', '--output', str(out / f'journey-{index}.xml'), args.flow])
                    finally:
                        if recorder.poll() is None:
                            if args.platform == 'android':
                                run([adb, '-s', serial, 'shell', 'pkill', '-2', 'screenrecord'])
                            else:
                                os.killpg(recorder.pid, signal.SIGINT)
                            recorder.wait(timeout=15)
                    if args.platform == 'android':
                        run([adb, '-s', serial, 'pull', '/sdcard/chalk-feel.mp4', str(out / f'{index}.mp4')])
                target = out / f'{index}-{codes.replace(",", "-")}.png'
                if args.platform == 'ios':
                    run(['xcrun', 'simctl', 'io', device, 'screenshot', str(target)])
                else:
                    with target.open('wb') as output:
                        run([adb, '-s', serial, 'exec-out', 'screencap', '-p'], stdout=output)
            except Exception as cause:
                diagnostic = out / f'{index}-failure.png'
                if args.platform == 'ios':
                    subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', str(diagnostic)])
                else:
                    with diagnostic.open('wb') as output:
                        subprocess.run([adb, '-s', serial, 'exec-out', 'screencap', '-p'], stdout=output)
                failures.append({'state': state, 'error': str(cause)})
                (out / 'failures.json').write_text(json.dumps(failures, indent=2))
                print(f'CAPTURE FAILED {state}: {cause}', flush=True)
                if not args.keep_going:
                    raise
        (out / 'manifest.json').write_text(json.dumps({'platform': args.platform, 'states': args.states, 'screen': actual, 'scale': payload.get('scale'), 'slot': slot, 'device': device if args.platform == 'ios' else serial, 'metro_port': args.port}, indent=2))
        if failures:
            raise RuntimeError(f'{len(failures)} states failed; see captures/failures.json')
    finally:
        if receiver:
            receiver.server_close()
        for proc in reversed(processes):
            terminate(proc)
        remember()
        watcher.stdin.close()
        if watcher.wait(timeout=180):
            raise RuntimeError('Capture owner cleanup failed')
        lock.close()


def owned_copy(args, dest, host):
    # Hold a per-copy lease BEFORE rsync, including cleanup. EOF releases it after owner loss.
    lease_code = "import fcntl,signal,sys; signal.alarm(2400); f=open(sys.argv[1],'a+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('READY',flush=True); sys.stdin.read()"
    lease = subprocess.Popen([*SSH, host, shlex.join(['python3', '-c', lease_code, dest + '.lease'])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    try:
        if lease.stdout.readline().strip() != 'READY':
            status = lease.wait(timeout=15)
            raise RuntimeError('M4 SSH connection failed before the copy lease' if status == 255 else 'Prepared copy is in use; choose a unique --name')
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
    p.add_argument('--emulator-port', type=int, default=5582)
    p.add_argument('--android-gpu', choices=['auto', 'host', 'software'], default='auto')
    p.add_argument('--sheet', choices=['more', 'people', 'chat', 'details', 'route'])
    p.add_argument('--menu', choices=['leave', 'route'])
    p.add_argument('--slot', choices=['ios-1', 'ios-2', 'ios-3', 'android-1'])
    p.add_argument('--client-cache', help='M4 prepared copy containing the shared native build and fingerprint')
    p.add_argument('--ios-proof-overlay', help='Local proof-only Python overlay applied to the M4 iOS copy, never the checkout')
    p.add_argument('--settle', type=float, default=4)
    p.add_argument('--device-type', default='com.apple.CoreSimulator.SimDeviceType.iPhone-16', help='CoreSimulator device type for a new iOS simulator')
    p.add_argument('--device-label', default='', help='Suffix for the simulator or emulator name, e.g. -ipad')
    p.add_argument('--expect-size', default='393x852', help='Expected iOS screen size in points, WxH portrait')
    p.add_argument('--expect-scale', type=int, default=3, help='Expected iOS pixel ratio')
    p.add_argument('--clean-status-bar', action='store_true', help='Fixed 9:41 status bar on the leased simulator or emulator')
    p.add_argument('--skip-size-check', action='store_true', help='Accept any native screen size, for store shots on other devices')
    p.add_argument('--android-size', default='1236x2745', help='Android wm size, WxH pixels')
    p.add_argument('--android-density', type=int, default=480, help='Android wm density in dpi')
    p.add_argument('--dump')
    p.add_argument('--ids', default='')
    p.add_argument('--maestro', default='maestro', help='Maestro executable path on the M4')
    p.add_argument('--flow', help='Maestro YAML: tapOn accessibility text, swipe and waitForAnimationToEnd')
    p.add_argument('--keep-going', action='store_true', help='Record per-state failures and continue the remaining captures')
    p.add_argument('--cleanup', action='store_true')
    p.add_argument('--remote', help=argparse.SUPPRESS)
    args = p.parse_args()
    if args.emulator_port % 2 or not 5554 <= args.emulator_port <= 5682:
        p.error('--emulator-port must be an even port from 5554..5682')
    if not 1024 <= args.port <= 65535:
        p.error('--port must be 1024..65535')
    if args.slot and not args.slot.startswith(args.platform):
        p.error('--slot must match --platform')
    if args.slot and not args.client_cache and not args.cleanup:
        p.error('--slot requires --client-cache /path/on/M4; parallel slots never start native builds')
    from urllib.parse import parse_qsl, urlsplit
    if args.dump:
        endpoint = urlsplit(args.dump)
        if endpoint.scheme != 'http' or endpoint.hostname not in ['localhost', '127.0.0.1']:
            p.error('--dump must be an M4-local HTTP endpoint (use an SSH reverse tunnel when collecting on the Air)')
    for state in args.states:
        _, _, options = state.partition('?')
        for key, value in parse_qsl(options, strict_parsing=True):
            if (key == 'sheet' and value in ['more', 'people', 'chat', 'details', 'route']) or (key == 'menu' and value in ['leave', 'route']) or (key == 'app' and value == 'ready') or (key == 'video' and value == 'off') or (key == 'pinned' and value.startswith('person-') and value[7:].isdigit()):
                continue
            p.error('Unsupported capture state query option')
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
    if args.cleanup:
        cleanup = "import pathlib,shutil,sys; p=pathlib.Path(sys.argv[1]); assert p.parent==pathlib.Path('/tmp') and p.name.startswith('chalk-mobile-') and not p.is_symlink(); shutil.rmtree(p) if p.exists() else None"
        run([*SSH, host, shlex.join(['python3', '-c', cleanup, dest])])
        return
    if not args.cleanup:
        run(['rsync', '-az', '-e', shlex.join(SSH), '--delete', '--exclude=/native-build', '--exclude=/native-*.stamp', '--exclude=/captures', '--exclude=*.log', '--exclude=.expo', '--exclude=node_modules', '--exclude=.git', '--exclude=.worktrees', '--exclude=.env*', '--exclude=scratchpad', '--exclude=Pods', '--exclude=.gradle', '--exclude=.cxx', '--exclude=/apps/mobile/ios/build', '--exclude=/apps/mobile/android/build', '--exclude=/apps/mobile/android/app/build', '--exclude=artifacts', '--exclude=dist', str(Path(args.worktree).resolve()) + '/', host + ':' + dest + '/'])
        inputs = subprocess.check_output(['git', '-C', args.worktree, 'ls-files', '-z', '--', 'pnpm-lock.yaml', 'apps/mobile/package.json', 'apps/mobile/app.config.ts', 'apps/mobile/assets', 'apps/mobile/plugins', 'apps/mobile/ios', 'apps/mobile/android', 'sdks/typescript/react-native/package.json', 'sdks/typescript/react-native/Q9ChalkReactNative.podspec', 'sdks/typescript/react-native/ios', 'sdks/typescript/react-native/android']).decode().strip('\0').split('\0')
        run([*SSH, host, shlex.join(['python3', '-c', 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(sys.stdin.buffer.read())', dest + '/native-inputs.json'])], input=json.dumps(sorted(inputs)).encode())
    if not args.cleanup:
        run([*SCP, str(Path(__file__)), str(Path(__file__).with_name('capture-owner-watch.py')), host + ':' + dest + '/apps/mobile/scripts/'])
        if not (Path(args.worktree) / 'apps/mobile/src/dev-states').is_dir():
            print('Installing dev-only capture route in the remote copy; product source remains unchanged', flush=True)
            source = Path(__file__).resolve().parents[1] / 'src/dev-states'
            run(['rsync', '-az', '-e', shlex.join(SSH), str(source), host + ':' + dest + '/apps/mobile/src/'])
            run([*SSH, host, shlex.join(['cp', dest + '/apps/mobile/App.tsx', dest + '/apps/mobile/App.product.tsx'])])
            run([*SCP, str(Path(__file__).with_name('capture-entry.tsx.template')), host + ':' + dest + '/apps/mobile/App.tsx'])
        # One authoritative harness, including fixes made after a lane branched.
        source = Path(__file__).resolve().parents[1] / 'src/dev-states'
        run(['rsync', '-az', '-e', shlex.join(SSH), str(source) + '/', host + ':' + dest + '/apps/mobile/src/dev-states/'])
        run([*SCP, str(Path(__file__).with_name('install-app-fixtures.py')), str(Path(__file__).with_name('app-states.tsx.template')), host + ':' + dest + '/apps/mobile/scripts/'])
        run([*SSH, host, shlex.join(['python3', dest + '/apps/mobile/scripts/install-app-fixtures.py', dest + '/apps/mobile'])])
    command = ['python3', dest + '/apps/mobile/scripts/capture-states.py', '--remote', dest, '--platform', args.platform, '--port', str(args.port), '--settle', str(args.settle), '--maestro', args.maestro, '--states', *args.states]
    command += ['--emulator-port', str(args.emulator_port)]
    command += ['--android-gpu', args.android_gpu]
    command += ['--device-type', args.device_type, '--device-label', args.device_label, '--expect-size', args.expect_size, '--expect-scale', str(args.expect_scale)]
    if args.clean_status_bar:
        command.append('--clean-status-bar')
    command += ['--android-size', args.android_size, '--android-density', str(args.android_density)]
    if args.skip_size_check:
        command.append('--skip-size-check')
    if args.ios_proof_overlay:
        overlay = dest + '/apps/mobile/scripts/proof-ios-overlay.py'
        run([*SCP, args.ios_proof_overlay, host + ':' + overlay])
        command += ['--ios-proof-overlay', overlay]
    if args.keep_going:
        command.append('--keep-going')
    if args.sheet:
        command += ['--sheet', args.sheet]
    if args.menu:
        command += ['--menu', args.menu]
    if args.slot:
        command += ['--slot', args.slot]
    if args.client_cache:
        command += ['--client-cache', args.client_cache]
    if args.cleanup:
        command.append('--cleanup')
    if args.dump:
        command += ['--dump', args.dump]
    if args.ids:
        command += ['--ids', args.ids]
    if args.flow:
        run([*SCP, args.flow, host + ':' + dest + '/capture-flow.yaml'])
        command += ['--flow', dest + '/capture-flow.yaml']
    try:
        run([*SSH, host, shlex.join(command)])
    finally:
        if not args.cleanup:
            failed = sys.exc_info()[0] is not None
            Path(args.output).mkdir(parents=True, exist_ok=True)
            subprocess.run(['rsync', '-az', '-e', shlex.join(SSH), '--delete', host + ':' + dest + '/captures/', args.output + '/'], check=not failed)
            subprocess.run(['rsync', '-az', '-e', shlex.join(SSH), '--include=*.log', '--exclude=*', host + ':' + dest + '/', args.output + '/'], check=not failed)


if __name__ == '__main__':
    main()
