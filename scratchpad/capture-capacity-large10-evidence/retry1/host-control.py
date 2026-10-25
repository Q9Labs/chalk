import json,pathlib,ssl,http.client,socket,sys,subprocess,shutil,datetime,time,signal,os
R=pathlib.Path('/run/chalk-capacity-large10')
def init():
 assert not R.exists()
 cmd=['sudo','-u','#1000','env','XDG_RUNTIME_DIR=/run/user/1000','podman']
 c=json.loads(subprocess.check_output(cmd+['inspect','chalk-recorder-capture'],text=True))[0];e=dict(l.split('=',1) for l in c['Config']['Env'] if '=' in l);cr='/proc/'+str(c['State']['Pid'])+'/root'
 R.mkdir(mode=0o700)
 for short,name in [('cert','CONTROLLER_CERT'),('key','CONTROLLER_KEY'),('ca','SERVER_CA')]:
  p=R/short;shutil.copyfile(cr+e['CHALK_RECORDER_FLEET_'+name],p);p.chmod(0o600)
 cfg={'url':e['CHALK_RECORDER_FLEET_CONTROL_PLANE_URL'],'server':e['CHALK_RECORDER_FLEET_SERVER_NAME']};(R/'config.json').write_text(json.dumps(cfg));print(json.dumps({'initialized':True}))
def request(method,path,body=None):
 from urllib.parse import urlsplit
 cfg=json.loads((R/'config.json').read_text());base=urlsplit(cfg['url']);port=base.port or 443
 ctx=ssl.create_default_context(cafile=R/'ca');ctx.load_cert_chain(R/'cert',R/'key')
 c=http.client.HTTPSConnection(cfg['server'],port,context=ctx,timeout=45);c._create_connection=lambda address,timeout,source:socket.create_connection((base.hostname,port),timeout,source)
 try:
  c.request(method,'/internal/v1/recorder/fleet/'+path,json.dumps(body) if body is not None else None,{'Content-Type':'application/json'});r=c.getresponse();raw=r.read();value=json.loads(raw) if raw else None
  return {'status':r.status,'body':value}
 finally:c.close()
def main(task):
 if task['action']=='init':return init()
 if task['action']=='request':print(json.dumps(request(task['method'],task['path'],task.get('body'))));return
 if task['action']=='publish':
  stop=False
  def halt(*args):
   nonlocal stop
   stop=True
  signal.signal(signal.SIGTERM,halt);signal.signal(signal.SIGINT,halt)
  deadline=time.monotonic()+1200
  while not stop and time.monotonic()<deadline:
   d=request('GET','demand?role=capture');assert d['status']==200
   b={'schema_version':'recorder_fleet_pool.v1','key':{'environment':'nightly','role':'capture'},'demand_revision':d['body']['revision'],'admission_open':True,'ready_capacity':task['slots'],'reason':'ready','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
   r=request('PUT','pool',b);assert r['status']==204
   time.sleep(2)
  print(json.dumps({'publisher_stopped':True}));return
