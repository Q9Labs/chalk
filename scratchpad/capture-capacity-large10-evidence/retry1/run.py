SETUP='freeze();host(\'init\',(P/\'host-control.py\').read_text()+"\\ninit()",True)\nsafe_fields=[\'ENVIRONMENT\',\'ROLE\',\'OWNER_TAG\',\'DIGITALOCEAN_PROJECT_ID\',\'DIGITALOCEAN_VPC_UUID\',\'BOOTSTRAP_CA_BASE64\',\'REGION\',\'FIREWALL_ID\',\'BOOTSTRAP_ENDPOINT\',\'IMAGE_ID\',\'IMAGE_DIGEST\',\'RELEASE_ID\',\'ARCHIVE_BUCKET\',\'ARCHIVE_KEY\',\'ARCHIVE_SHA256\',\'ARCHIVE_REGION\']\nlive_code="import subprocess,json\\nc=json.loads(subprocess.check_output([\'sudo\',\'-u\',\'#1000\',\'env\',\'XDG_RUNTIME_DIR=/run/user/1000\',\'podman\',\'inspect\',\'chalk-recorder-capture\'],text=True))[0]\\ne=dict(l.split(\'=\',1) for l in c[\'Config\'][\'Env\'] if \'=\' in l)\\nprint(json.dumps({k:e.get(\'CHALK_RECORDER_FLEET_\'+k) for k in "+repr(safe_fields)+"}))"\nS[\'live_env\']=json.loads(host(\'live-fleet\',live_code));assert all(S[\'live_env\'].values()),\'live fleet bootstrap field absent\';save()\nrender_code="import subprocess,json\\nc=json.loads(subprocess.check_output([\'sudo\',\'-u\',\'#1000\',\'env\',\'XDG_RUNTIME_DIR=/run/user/1000\',\'podman\',\'inspect\',\'chalk-recorder-render\'],text=True))[0]\\ne=dict(l.split(\'=\',1) for l in c[\'Config\'][\'Env\'] if \'=\' in l)\\nprint(json.dumps({\'size\':e.get(\'CHALK_RECORDER_FLEET_SIZE\'),\'max_nodes\':e.get(\'CHALK_RECORDER_FLEET_MAX_NODES\')}))"\nS[\'render_bound\']=json.loads(host(\'render-bound\',render_code));assert S[\'render_bound\']=={\'size\':\'c-8\',\'max_nodes\':\'1\'},\'Render billing bound changed\';save()\n\nfor keyfile in (\'ssh-key\',\'ssh-key.pub\'):\n if (R/keyfile).exists():(R/keyfile).rename(R/(keyfile+\'.\'+str(time.time_ns())))\nsubprocess.run([\'ssh-keygen\',\'-q\',\'-t\',\'ed25519\',\'-N\',\'\',\'-f\',str(R/\'ssh-key\')],check=True);freeze();key=D.request(\'POST\',\'/account/keys\',{\'name\':\'chalk-capacity-large10\',\'public_key\':(R/\'ssh-key.pub\').read_text()})[\'ssh_key\'];S[\'key_id\']=key[\'id\'];S[\'owned\'].append([\'/account/keys/\',str(key[\'id\'])]);save()\nflag(True)\n# The regular controller stays configured as-is, but pauses while the direct worker supplies the pool.\nnodes=fleet(\'GET\',\'nodes?role=capture\')[\'nodes\'];assert not any(x[\'active_leases\'] for x in nodes),\'nightly Capture not idle\'\nS[\'controller_stopped\']=True;save()\nhost(\'stop-controller\',"import subprocess\\nsubprocess.run([\'sudo\',\'-u\',\'#1000\',\'env\',\'XDG_RUNTIME_DIR=/run/user/1000\',\'systemctl\',\'--user\',\'stop\',\'chalk-recorder-capture.service\'],check=True)\\nprint(\'stopped\')",True);S[\'controller_stopped\']=True;save()\n'
import experiment as E, pathlib,json,subprocess,time,threading,signal,sys,os
from concurrent.futures import ThreadPoolExecutor
R=pathlib.Path(__file__).resolve().parent
assert (R/'preflight-passed.json').exists(),'free guest preflight not passed'
pumps=[]
def stop_load():
 with ThreadPoolExecutor(max_workers=4) as pool:
  list(pool.map(lambda name:subprocess.run(['instabox','ssh',name,'--','touch /opt/capacity/stop'],capture_output=True,timeout=35),E.S['boxes']))
def guard_watch():
 import live_guard
 while not E.stop.wait(10):
  try:
   rows=live_guard.active_deployments()
   if rows:
    E.S['window_void']=True;E.failure.append('Release/Cut started mid-window');E.save();stop_load();return
   E.budget(.15)
  except Exception as error:
   E.failure.append(str(error));E.S['window_void']=True;E.save();stop_load();return
try:
 E.freeze()
 E.save()
 guardlog=(R/'owner-guardian.log').open('ab')
 guardian=subprocess.Popen(['python3',str(R/'watchdog.py'),str(os.getpid())],stdout=guardlog,stderr=guardlog,start_new_session=True)
 E.S['watchdog_pid']=guardian.pid;E.save()
 signal.signal(signal.SIGTERM,lambda *_:(_ for _ in ()).throw(RuntimeError('owner cancelled')))
 # Previous harness helper setup, executed in its module namespace.
 exec(SETUP,E.__dict__)
 E.thread=threading.Thread(target=E.pool_loop)
 for i,name in enumerate(E.S['boxes']):
  f=(R/f'run-guard-{i}.log').open('ab');p=subprocess.Popen(['python3',str(R/'guard_pump.py'),name],stdout=f,stderr=f);pumps.append((p,f));E.S['guard_pids']=[x[0].pid for x in pumps];E.save()
 worker=E.provision('s-2vcpu-2gb')
 E.thread.start();assert E.pool_ready.wait(60),'pool not ready'
 watcher=threading.Thread(target=guard_watch,daemon=True);watcher.start()
 result=E.run_count(worker,10,2,False)
 assert not E.failure and not E.S.get('window_void'),E.failure
 E.S['status']='DONE';E.save()
except Exception as error:
 E.S['status']='BLOCKED';E.S['reason']=str(error);E.save();print('BLOCKED',str(error),flush=True)
finally:
 E.S['stop_load_errors']=E.safety.cleanup_all([('stop load',stop_load)]);E.save()
 try:E.cleanup()
 except Exception as error:E.S['cleanup_error']=str(error);E.save();print('CLEANUP ERROR',str(error),flush=True)
 for p,f in pumps:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  f.close()

if E.S.get('status')!='DONE' or E.S.get('cleanup_error') or E.S.get('cleanup_errors'):sys.exit(1)
