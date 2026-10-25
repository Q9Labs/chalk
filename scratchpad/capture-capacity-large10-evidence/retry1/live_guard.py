import json,pathlib,subprocess,time,threading,sys
R=pathlib.Path(__file__).resolve().parent
ACTIVE=('queued','in_progress','waiting','pending','requested')
mutex=threading.RLock()
def active_deployments():
 from concurrent.futures import ThreadPoolExecutor
 def query(pair):
  workflow,status=pair
  endpoint='repos/Q9Labs/chalk/actions/workflows/'+workflow+'/runs?status='+status+'&per_page=100'
  payload=json.loads(subprocess.check_output(['gh','api',endpoint]))
  return [{'databaseId':x['id'],'name':x['name'],'status':x['status'],'url':x['html_url']} for x in payload['workflow_runs']]
 with ThreadPoolExecutor(max_workers=4) as pool:
  groups=list(pool.map(query,[(w,s) for w in ('ci.yml','nightly.yml','promote.yml') for s in ('queued','in_progress')]))
 rows=[x for group in groups for x in group];(R/('deployment-workflows-'+str(time.time_ns())+'.json')).write_text(json.dumps(rows));return rows
def inspect():
 if (R/"release-hold").exists():return {"idle":False,"release_lead_hold":True}
 with mutex:
  stamp=str(time.time_ns()); rows=json.loads(subprocess.check_output(['gh','run','list','--repo','Q9Labs/chalk','--limit','10','--json','databaseId,name,status,conclusion,url']))
  (R/('live-workflows-'+stamp+'.json')).write_text(json.dumps(rows))
  active=[x for x in rows if x['status'] in ACTIVE and ('cut nightly' in x['name'].lower() or x['name'].lower().startswith('release') and x['name']!='Release contracts')]
  if active:return {'idle':False,'active':active}
  name='live-host-'+stamp
  (R/(name+'.sh')).write_text('''set -eu
flock -n /var/lib/chalk/deployment-controller/deployment.lock -c 'true' || exit 75
python3 - <<'HOST'
import subprocess,json,urllib.request
cmd=['sudo','-u','#1000','env','XDG_RUNTIME_DIR=/run/user/1000']
c=json.loads(subprocess.check_output(cmd+['podman','inspect','chalk-api']))[0]
e=dict(x.split('=',1) for x in c['Config']['Env'] if '=' in x)
with urllib.request.urlopen('http://127.0.0.1:18080/readyz',timeout=5) as response:ready=response.status
ps=subprocess.check_output(['ps','-eo','args'],text=True)
active=[x for x in ps.splitlines() if 'chalk-deployment-controller' in x and 'python' not in x and 'ssm' not in x]
print(json.dumps({'idle':not active and ready==200,'deployment_jobs':active,'readyz':ready,'api_started':c['State']['StartedAt'],'api_image':c['ImageName'],'flag':e.get('CHALK_RECORDING_BUNDLE_V2_ENABLED')}))
HOST
''')
  q=subprocess.run([sys.executable,str(R/'ssm.py'),name],capture_output=True,timeout=80)
  if q.returncode:return {'idle':False,'host_check_failed':name}
  return json.loads((R/(name+'.log')).read_text().split('\nSTDERR')[0])
def wait():
 while True:
  result=inspect()
  if result['idle']:return result
  print('deployment guard waiting: '+json.dumps(result),flush=True);time.sleep(1 if 'Resource temporarily unavailable' in result.get('error','') else 15)
if __name__=='__main__':print(json.dumps(wait()))
