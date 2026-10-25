import json,pathlib,subprocess,sys,time
root=pathlib.Path(__file__).resolve().parent
name=sys.argv[1]
if name.startswith('live-host-') and (root/'guest-qualification-pending').exists():
 import os
 parent=subprocess.check_output(['ps','-p',str(os.getppid()),'-o','command='],text=True)
 if 'experiment.py' in parent:
  raw=json.dumps({'idle':False,'guest_qualification_pending':True});(root/(name+'.log')).write_text(raw+'\nSTDERR\n');print(raw);sys.exit(0)
if name.startswith('live-host-'):
 import live_guard
 active=live_guard.active_deployments()
 if active:
  raw=json.dumps({'idle':False,'active':active});(root/(name+'.log')).write_text(raw+'\nSTDERR\n');print(raw);sys.exit(0)
if name.startswith('live-host-') and (root/'fast-guard-ready').exists():
 import urllib.request
 try:
  with urllib.request.urlopen('http://127.0.0.1:17401/',timeout=5) as response:raw=response.read().decode()
  json.loads(raw);(root/(name+'.log')).write_text(raw+'\nSTDERR\n');print(raw);sys.exit(0)
 except Exception:pass
base=['aws','--profile','q9labs','--region','ap-southeast-1','ssm']
mutation='--mutation' in sys.argv
command=(root/(name+'.sh')).read_text()
if mutation:
 import live_guard,safety
 result=live_guard.inspect()
 if not result['idle']:raise RuntimeError('mutation rejected: deployment active')
 command=safety.remote_command(command,time.time()+12)
r=json.loads(subprocess.check_output(base+['send-command','--instance-ids','i-006a30905a8c0e26e','--document-name','AWS-RunShellScript','--parameters',json.dumps({'commands':[command],'executionTimeout':['25']}),'--comment','large10-retry-'+name],timeout=20))
cid=r['Command']['CommandId'];(root/(name+'-command.json')).write_text(json.dumps({'CommandId':cid},indent=2))
def cancel(*args):
 subprocess.run(base+['cancel-command','--command-id',cid,'--instance-ids','i-006a30905a8c0e26e'],capture_output=True,timeout=15)
 if args:raise SystemExit(1)
import signal
signal.signal(signal.SIGTERM,cancel);signal.signal(signal.SIGINT,cancel)
try:
 for _ in range(20):
  time.sleep(1)
  r=json.loads(subprocess.check_output(base+['get-command-invocation','--instance-id','i-006a30905a8c0e26e','--command-id',cid],timeout=15))
  if r['Status'] not in ('Pending','InProgress','Delayed'):break
 else:cancel();raise RuntimeError('remote command cancelled after bounded wait')
except BaseException:
 cancel();raise
(root/(name+'-receipt.json')).write_text(json.dumps(r,indent=2))
(root/(name+'.log')).write_text(r.get('StandardOutputContent','')+'\nSTDERR\n'+r.get('StandardErrorContent',''))
print(r['Status'],r['ResponseCode']);print((root/(name+'.log')).read_text())
if r['Status']!='Success' or r['ResponseCode']!=0:sys.exit(1)
