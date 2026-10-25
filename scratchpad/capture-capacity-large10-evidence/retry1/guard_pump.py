import pathlib,subprocess,sys,json,shlex,signal
import live_guard
name=sys.argv[1]
remote='''import pathlib,time,json,sys
r=pathlib.Path('/opt/capacity/guard');r.mkdir(exist_ok=True)
while True:
 for p in r.glob('*.request'):
  print(p.stem,flush=True)
  line=sys.stdin.readline()
  if not line:sys.exit()
  temporary=r/(p.stem+'.tmp');temporary.write_text(line);temporary.replace(r/(p.stem+'.response'));p.unlink(missing_ok=True)
 time.sleep(.2)
'''
p=subprocess.Popen(['instabox','ssh',name,'--','python3 -u -c '+shlex.quote(remote)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
def stop(*_):p.terminate();raise SystemExit()
signal.signal(signal.SIGTERM,stop)
try:
 for line in p.stdout:
  ident=line.strip();assert ident and all(c in '0123456789abcdef-' for c in ident),ident
  result=live_guard.inspect();p.stdin.write(json.dumps(result)+'\n');p.stdin.flush()
 raise RuntimeError('guard SSH stream ended')
finally:
 if p.poll() is None:p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
