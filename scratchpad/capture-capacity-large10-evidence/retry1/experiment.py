import safety,fcntl
import pathlib,json,subprocess,sys,os,time,datetime,threading,runpy,hashlib,urllib.request,signal,tarfile,shlex
R=pathlib.Path(__file__).resolve().parent;P=R
O=runpy.run_path(str(P/'do-ops.py'));D=O['DO']();lock=threading.RLock();stop=threading.Event();failure=[]
S={'started':time.time(),'cap_usd':.25,'prior_usd':1.52812,'workers':[],'owned':[],'seen':{},'runs':[],'flag':False,'controller_stopped':False,'intents':{},'phase':'setup','finish_by':time.time()+600,'boxes':json.loads((R/'boxes.json').read_text())}

if (R/'state.json').exists() and not (len(sys.argv)>1 and sys.argv[1]=='cleanup'):
 previous=json.loads((R/'state.json').read_text());assert previous.get('cleanup_finished'),'previous owner not clean'
 S.update(started=previous['started'],seen=previous['seen'],runs=previous['runs'])
progress_path=R/'progress.json'
progress=json.loads(progress_path.read_text()) if progress_path.exists() else {'phase':'small','small_index':0,'largest':2,'large_next':None,'large_pass':None}
def progress_save():progress_path.write_text(json.dumps(progress,indent=2))
class PauseCut(Exception):pass
class NeedBox(Exception):pass

def save():
 with lock:
  temporary=R/'state.json.tmp';temporary.write_text(json.dumps(S,indent=2));temporary.replace(R/'state.json')
def event(msg): print(datetime.datetime.now(datetime.timezone.utc).isoformat(),msg,flush=True);save()
def freeze():
 import live_guard
 result=live_guard.inspect()
 if not result['idle']:raise PauseCut('Release/Cut/controller active; void this window')
 return result
def host(name,code,mutation=False):
 with lock:
  if mutation:freeze()
  name=name+'-'+str(time.time_ns());(R/(name+'.sh')).write_text("set -eu\npython3 - <<'HOST'\n"+code+"\nHOST\n")
  q=subprocess.run([sys.executable,str(R/'ssm.py'),name]+(['--mutation'] if mutation else []),capture_output=True,text=True,timeout=90)
  if q.returncode:raise RuntimeError('SSM failed '+name)
  return (R/(name+'.log')).read_text().split('\nSTDERR')[0]
def fleet(method,path,body=None):
 code=(P/'host-control.py').read_text()+f"\nprint(json.dumps(request({method!r},{path!r},{body!r})))"
 v=json.loads(host('fleet',code,method!='GET'));assert v['status'] in (200,204),v;return v.get('body')
def budget(reserve=0):
 with lock:return budget_locked(reserve)
def budget_locked(reserve=0):
 now=time.time()
 reconcile_intents()
 for n in D.request('GET','/droplets?per_page=200&tag_name=chalk-nightly-recorder-owner')['droplets']:
  born=datetime.datetime.fromisoformat(n['created_at'].replace('Z','+00:00')).timestamp()
  if born<S['started']-2 and 'chalk-recorder-render' not in n['tags']:continue
  ident=str(n['id'])
  S['seen'].setdefault(ident,{'created':max(born,S['started']),'rate':n['size']['price_hourly'],'size':n['size_slug'],'tags':n['tags'],'active':True})
 for ident,n in S['seen'].items():
  if n.get('active') and not ident.startswith('intent:') and D.request('GET','/droplets/'+ident).get('status')==404:n.update(active=False,absent_at=now)
 total=safety.ledger_cost(S['seen'],now);S['spent_upper_usd']=total;S['checked_budget_at']=now;save()
 if reserve and (total+reserve>S['cap_usd'] or now>=S['finish_by']):raise RuntimeError(f'BLOCKED: bounded DO budget; spent upper {total:.5f}; reserve {reserve:.5f}')
 return total
def ssh(w,command,data=None,timeout=90):
 q=subprocess.run(['ssh','-i',str(R/'ssh-key'),'-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+str(R/'known_hosts'),'-o','ConnectTimeout=10','root@'+w['ip'],command],input=data,capture_output=True,timeout=timeout)
 if q.returncode: (R/'last-ssh-error.log').write_bytes(q.stderr);raise RuntimeError('worker SSH failed; see last-ssh-error.log')
 return q.stdout
def flag(on):
 S['flag']=True;save();freeze()
 code=(P/('flag-on-runtime.sh' if on else 'flag-off-runtime.sh')).read_text()
 code+='\n'+(P/'flag-on-restart.sh').read_text()
 name='flag-atomic-'+str(on)+'-'+str(time.time_ns());(R/(name+'.sh')).write_text(code)
 q=subprocess.run([sys.executable,str(R/'ssm.py'),name,'--mutation'],capture_output=True,text=True,timeout=80)
 if q.returncode:raise RuntimeError('runtime flag mutation failed; cleanup intent retained')
 assert loaded()==on
 S['flag']=on;save();event('runtime-only flag '+str(on))

def loaded():
 code="""import subprocess,json,pathlib
c=json.loads(subprocess.check_output(['sudo','-u','#1000','env','XDG_RUNTIME_DIR=/run/user/1000','podman','inspect','chalk-api'],text=True))[0]
e=dict(l.split('=',1) for l in c['Config']['Env'] if '=' in l)
print(json.dumps({'loaded':e.get('CHALK_RECORDING_BUNDLE_V2_ENABLED'),'runtime':[l for l in pathlib.Path('/run/chalk/env/api.env').read_text().splitlines() if l.startswith('CHALK_RECORDING_BUNDLE_V2_ENABLED=')]}))
"""
 v=json.loads(host('loaded',code));return v['loaded']=='true' and v['runtime']==['CHALK_RECORDING_BUNDLE_V2_ENABLED=true']
def provision(size):
 budget(.15);freeze();name='chalk-recorder-diagnostic-capacity-large10-'+str(int(time.time()));tag=D.request('POST','/tags',{'name':name});S['owned'].append(['/tags/',name]);save()
 live=S['live_env'];fw=D.request('GET','/firewalls/'+live['FIREWALL_ID'])['firewall'];ip=urllib.request.urlopen('https://api.ipify.org',timeout=10).read().decode().strip()
 rules={k:fw[k] for k in ('inbound_rules','outbound_rules')};rules['inbound_rules'].append({'protocol':'tcp','ports':'22','sources':{'addresses':[ip+'/32']}})
 freeze();f=D.request('POST','/firewalls',{'name':name,**rules})['firewall'];S['owned'].append(['/firewalls/',f['id']]);save();gen=int(time.time())
 tags=sorted([live['OWNER_TAG'],'chalk-environment-nightly','chalk-recorder-capture','chalk-release-'+hashlib.sha256(live['RELEASE_ID'].encode()).hexdigest()[:16],'chalk-image-'+live['IMAGE_DIGEST'][7:],'chalk-boot-'+str(gen),'chalk-recorder-diagnostic',name]);S['owned'].append(['/tags/','chalk-boot-'+str(gen)]);save()
 request={'key':{'environment':'nightly','role':'capture'},'name':name,'owner_tag':live['OWNER_TAG'],'boot_generation':gen,'required_tags':tags,'release':{'release_id':live['RELEASE_ID'],'image_id':int(live['IMAGE_ID']),'image_digest':live['IMAGE_DIGEST'],'region':live['REGION'],'size':size,'firewall_id':f['id'],'bootstrap_endpoint':live['BOOTSTRAP_ENDPOINT'],'gpu':False,'bootstrap_ca_base64':live['BOOTSTRAP_CA_BASE64'],'archive':{'bucket':live['ARCHIVE_BUCKET'],'key':live['ARCHIVE_KEY'],'sha256':live['ARCHIVE_SHA256'],'region':live['ARCHIVE_REGION']}}}
 if not S.get('paid_started'):
  S['paid_started']=time.time();S.update(safety.deadlines(S['paid_started']));save()
 safety.remember_intent(S,name,.02679,time.time());save()
 body={'operation':'create','environment':'nightly','role':'capture','owner_tag':live['OWNER_TAG'],'project_id':live['DIGITALOCEAN_PROJECT_ID'],'vpc_uuid':live['DIGITALOCEAN_VPC_UUID'],'ssh_key_ids':[],'diagnostic_ssh_key_id':S['key_id'],'mutation_deadline':datetime.datetime.fromtimestamp(time.time()+180,datetime.timezone.utc).isoformat(),'evidence_path':str(R/(name+'-provider.jsonl')),'request':request}
 w=None
 for create_attempt in range(3):
  body['mutation_deadline']=datetime.datetime.fromtimestamp(time.time()+180,datetime.timezone.utc).isoformat()
  (R/(size+'-intent.json')).write_text(json.dumps(body));freeze()
  try:
   q=subprocess.run([str(P/'boot-probe-held')],input=json.dumps(body),text=True,capture_output=True,timeout=180,env={**os.environ,'DIGITALOCEAN_TOKEN':D.token,'AWS_PROFILE':'q9labs','AWS_REGION':'ap-southeast-1'})
  finally:
   reconcile_intents();save()
  (R/(size+'-create-'+str(create_attempt)+'.json')).write_text(q.stdout);(R/(size+'-create-'+str(create_attempt)+'.stderr')).write_text(q.stderr)
  candidates=[n for n in D.request('GET','/droplets?per_page=200&tag_name='+name)['droplets'] if n['name']==name]
  if candidates and w is None:
   assert len(candidates)==1
   w=next(x for x in S['workers'] if x['id']==str(candidates[0]['id']));save()
  if q.returncode==0:break
  evidence=[json.loads(line) for line in pathlib.Path(body['evidence_path']).read_text().splitlines()]
  service_down=any(resource.get('status')=='service_down' for resource in evidence[-1].get('response',{}).get('resources',[]))
  if not service_down or create_attempt==2:raise RuntimeError('worker create failed; see saved provider response: '+q.stderr)
  event('DO project service_down; retry same worker, not a new droplet');time.sleep(20)
 assert w is not None
 for attempt in range(3):
  node=D.request('GET','/droplets/'+w['id'])['droplet']
  if node['status']=='active' and any(n['type']=='public' for n in node['networks']['v4']):break
  if attempt==2:raise RuntimeError('worker did not become active')
  time.sleep(20)
 body.update(operation='inspect',provider_id=w['id']);q=subprocess.run([str(P/'boot-probe-held')],input=json.dumps(body),text=True,capture_output=True,timeout=60,env={**os.environ,'DIGITALOCEAN_TOKEN':D.token,'AWS_PROFILE':'q9labs','AWS_REGION':'ap-southeast-1'});assert q.returncode==0;qv=json.loads(q.stdout);w.update(ip=qv['public_ip'],bootstrap=qv['bootstrap']);save()
 code=(P/'host-lib.py').read_text()+(P/'host-control.py').read_text()
 code+="\n_,issuer,issuer_root=runtime('chalk-recorder-issuer',1000)\nbody="+repr(w['bootstrap'])+"\nresult=request('POST','nodes/'+body['provider_id']+'/bootstrap',{**body,'schema_version':'recorder_fleet_bootstrap.v1'})\nevidence=registration(issuer,issuer_root,body['provider_id'])\nprint(json.dumps({'controller_response':result,**evidence}))"
 w['registered']=True;save()
 for attempt in range(3):
  v=json.loads(host('register-'+str(attempt),code,True));(R/(size+'-register-'+str(attempt)+'.json')).write_text(json.dumps(v))
  if v.get('record',{}).get('certificates') and v.get('controller_response',{}).get('status')==200:break
  if attempt==2:raise RuntimeError('registration incomplete after three checked attempts; see register evidence')
  assert v['controller_response']['status'] in (202,409),'registration rejected'
  time.sleep(10)
 w['identity']=v['record']['identity'];w['worker_id']=w['identity']['worker_id'];save()
 for attempt in range(3):
  try:ssh(w,'true');break
  except Exception:
   if attempt==2:raise
   time.sleep(10)
 with tarfile.open(R/'worker.tar.gz') as t:binary=t.extractfile('recorder-capture').read()
 freeze();ssh(w,'mkdir -p /opt/capacity; cat > /opt/capacity/recorder-capture; chmod 755 /opt/capacity/recorder-capture',binary)
 unit=f'''[Unit]\nDescription=Task-owned Capture capacity worker\nAfter=network-online.target\n[Service]\nUser=chalk-recorder\nGroup=chalk-recorder\nEnvironmentFile=/etc/chalk-recorder/worker.env\nEnvironmentFile=/etc/chalk-recorder/capture.env\nExecStart=/opt/capacity/recorder-capture --run --slots=10\nRuntimeMaxSec={max(1,int(S['finish_by']-time.time()))}\nTimeoutStopSec=30\n'''
 freeze();ssh(w,'systemctl stop chalk-recorder-capture.service; cat > /etc/systemd/system/chalk-capacity-large10.service',unit.encode());freeze();ssh(w,'systemctl daemon-reload; systemctl start chalk-capacity-large10.service; uptime; nproc; systemctl show chalk-capacity-large10.service -p MainPID -p ActiveState')
 (R/(size+'-worker-runtime.log')).write_bytes(ssh(w,'systemctl show chalk-capacity-large10.service -p MainPID -p ActiveState -p CPUQuotaPerSecUSec -p MemoryMax -p NRestarts; cat /sys/fs/cgroup/system.slice/chalk-capacity-large10.service/cpu.max; uptime; nproc; cat /proc/meminfo'))
 event('worker ready '+size+' '+w['id']);return w

def remove_worker(w):
 # Shared-host operations may defer during a Cut; isolated paid resource deletion never does.
 errors=[]
 try:
  found=next((x for x in fleet('GET','nodes?role=capture')['nodes'] if x['identity']['provider_id']==w['id']),None)
  if found:fleet('POST','nodes/'+w['id']+'/identity/revoke',{'schema_version':'recorder_fleet_command.v1','environment':'nightly','identity':found['identity']})
 except Exception as error:errors.append(str(error))
 D.request('DELETE','/droplets/'+w['id'])
 for attempt in range(30):
  if D.request('GET','/droplets/'+w['id']).get('status')==404:
   w['deleted']=True
   if w['id'] in S['seen']:S['seen'][w['id']].update(active=False,absent_at=time.time())
   save();break
  time.sleep(2)
 else:raise RuntimeError('task worker deletion did not converge')
 if errors:S.setdefault('deferred_fleet_revoke',[]).append(w['id']);S.setdefault('cleanup_notes',[]).extend(errors);save()

pool_ready=threading.Event()
def pool_loop():
 try:
  stale=0
  while not stop.is_set():
   code=(P/'host-control.py').read_text()+"\nd=request('GET','demand?role=capture');assert d['status']==200\nr=request('PUT','pool',{'schema_version':'recorder_fleet_pool.v1','key':{'environment':'nightly','role':'capture'},'demand_revision':d['body']['revision'],'admission_open':True,'ready_capacity':10,'reason':'ready','observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()})\nprint(json.dumps(r))"
   response=json.loads(host('publish-pool',code,True))
   if response['status']==409:
    stale+=1
    if stale>=3:raise RuntimeError('pool demand changed across three publication attempts')
    continue
   assert response['status']==204,response
   stale=0;pool_ready.set();budget(.15);stop.wait(8)
 except Exception as e:failure.append(str(e));stop.set()

def db(label,ids):
 sql="begin read only; select json_build_object('id',j.id,'recording_id',j.recording_id,'kind',j.kind,'state',j.state,'attempt_count',j.attempt_count,'error_code',j.error_code,'lease_owner',a.lease_owner,'schema',convert_from(a.envelope_bytes,'UTF8')::jsonb->>'bundle_schema_version') from recording_jobs j left join recording_job_attempt_authorities a on a.job_id=j.id where j.recording_id in ("+','.join("'"+x+"'" for x in ids)+"); commit;"
 worker_id=next(w['worker_id'] for w in reversed(S['workers']) if not w.get('deleted'))
 sql=sql.replace('; commit;',"; select json_build_object('kind','measurement_guard','other_leases',count(*)) from recording_jobs where kind='capture' and state='leased' and lease_owner='"+worker_id+"' and recording_id not in ("+','.join("'"+x+"'" for x in ids)+"); commit;")
 (P/(label+'.sql')).write_text(sql);q=subprocess.run([sys.executable,str(P/'db-read.py'),label+'.sql'],capture_output=True,text=True,timeout=90);assert q.returncode==0;rows=[json.loads(l) for l in (P/(label+'.sql.log')).read_text().splitlines() if l.startswith('{')];(R/(label+'.json')).write_text(json.dumps(rows,indent=2));assert all(x['other_leases']==0 for x in rows if x['kind']=='measurement_guard'),'unrelated Capture jobs loaded the measured worker';return rows

def scheduled_cut_guard(count):
 freeze()

def run_count(w,count,guests=2,profile=False):
 scheduled_cut_guard(count)
 if time.time()>=S['stop_new_load_by']:raise RuntimeError('budget-derived new-load deadline reached')
 if failure:raise RuntimeError(failure[0])
 # Live Render max_nodes=1: reserve $0.10 for bounded run completion and all cleanup.
 budget(.15)
 if not loaded():flag(True)
 per_box=2
 needed=2 if guests==10 else (count+per_box-1)//per_box
 if needed>len(S['boxes']):raise RuntimeError('BLOCKED: need '+str(needed)+' free generator boxes; only '+str(len(S['boxes']))+' prepared')
 identity_before=freeze(); S['count_identity']=identity_before; save()
 label=w['size']+'-'+str(count)+'x'+str(guests)+('-profile' if profile else '')+'-'+str(int(time.time()));jobs=[];readies=[]
 S['current_label']=label;save();(R/(label+'-loaded-before.json')).write_text(json.dumps(identity_before,indent=2))
 for i in range(needed):
  if failure or stop.is_set():raise RuntimeError('setup cancelled before launching another guest')
  freeze()
  subprocess.run(['instabox','ssh',S['boxes'][i],'--','rm -f /opt/capacity/stop'],check=True,timeout=30)
  n=1 if guests==10 else min(per_box,count-i*per_box);name=S['boxes'][i];spec={'label':label,'count':n,'guests':5 if guests==10 else guests,'seconds':1200,'preflight':False,'loadDeadlineMs':int(S['stop_new_load_by']*1000)}
  if guests==10:
   spec.update(totalGuests=10,guestOffset=i*5)
   if i:spec['shared']=shared
  cmd="umask 077; python3 -c "+shlex.quote("import pathlib;pathlib.Path('/opt/capacity/run-request.json').write_text("+repr(json.dumps(spec))+")")
  subprocess.run(['instabox','ssh',name,'--',cmd],check=True,timeout=40)
  f=open(R/(label+'-generator-'+str(i)+'.log'),'wb');cmd="bash -lc 'cd /opt/capacity/source && timeout --kill-after=30s -s TERM 1800 node generator.mjs'";p=subprocess.Popen(['instabox','ssh',name,'--',cmd],stdout=f,stderr=f);jobs.append((name,p,f,i));S['generator_pids']=[job[1].pid for job in jobs];save()
  if guests==10 and i==0:
   deadline=time.time()+120
   while True:
    q=subprocess.run(['instabox','ssh',name,'--','cat /opt/capacity/results/'+label+'/created.json'],capture_output=True,timeout=25)
    if q.returncode==0:shared=json.loads(q.stdout);break
    assert time.time()<deadline,'ten-camera Episode was not created';time.sleep(2)
 S['generator_pids']=[p.pid for _,p,_,_ in jobs];save();deadline=time.time()+300
 while len(readies)<needed:
  if failure:raise RuntimeError(failure[0])
  readies=[]
  for name,p,f,i in jobs:
   q=subprocess.run(['instabox','ssh',name,'--','cat /opt/capacity/results/'+label+'/ready.json'],capture_output=True,timeout=25)
   if q.returncode==0:readies.append(json.loads(q.stdout))
   elif p.poll() is not None:raise RuntimeError('generator failed before readiness '+label)
  if time.time()>deadline:raise RuntimeError('generators not ready in 300s')
  if len(readies)<needed:time.sleep(3)
 ids=[x['recording_id'] for v in readies for x in v['recordings'] if x['recording_id']!='preflight'];(R/(label+'-ids.json')).write_text(json.dumps(ids));S['current_ids']=ids;save()
 rows=db(label+'-before',ids);caps=[x for x in rows if x['kind']=='capture'];assert len(caps)==count and all(x['schema']=='recording_bundle.v2' and x['lease_owner']==w['worker_id'] for x in caps),'DB v2/direct-worker proof failed'
 if not loaded():raise PauseCut('count void: flag dropped at window start')
 event('count ready '+label)
 logger=(R/'sample.py').read_bytes();ssh(w,'cat > /opt/capacity/sample.py',logger)
 raw=ssh(w,('CAP_SFU_COUNT=1 ' if guests==10 else '')+'python3 /opt/capacity/sample.py',timeout=150);(R/(label+'-samples.json')).write_bytes(raw);v=json.loads(raw);assert v['packet_socket_drops']==0,'SFU transport counter lost packets'
 if profile:ssh(w,'curl --fail --silent http://127.0.0.1:6060/debug/pprof/profile?seconds=30 > /opt/capacity/profile.pprof',timeout=45);(R/(label+'.pprof')).write_bytes(ssh(w,'cat /opt/capacity/profile.pprof'))
 identity_after=freeze();(R/(label+'-loaded-after.json')).write_text(json.dumps(identity_after,indent=2))
 if not loaded() or identity_after['api_started']!=identity_before['api_started']:raise PauseCut('count void: API restarted or runtime flag dropped; retry after cleanup')
 journal=ssh(w,'journalctl -u chalk-capacity-large10.service --no-pager -o json');(R/(label+'-worker-journal.jsonl')).write_bytes(journal)
 after=db(label+'-after',ids);assert all(x['schema']=='recording_bundle.v2' and x['state']=='leased' for x in after if x['kind']=='capture'),'Capture lost v2 or active lease during run'
 S['phase']='finalizing';save()
 # Each box ends its Recordings sequentially. Unchanged Render MAX_NODES=1 bounds billed Render nodes.
 for name,p,f,i in jobs:subprocess.run(['instabox','ssh',name,'--','touch /opt/capacity/stop'],check=True,timeout=30)
 final_deadline=S['finish_by']-180
 for name,p,f,i in jobs:
  p.wait(timeout=max(1,final_deadline-time.time()));f.close();assert p.returncode==0,'generator or sequential cleanup failed'
  q=subprocess.run(['instabox','ssh',name,'--','tar -czf - -C /opt/capacity/results '+label],capture_output=True,timeout=90);assert q.returncode==0;(R/(label+'-generator-'+str(i)+'.tar.gz')).write_bytes(q.stdout)
  subprocess.run(['instabox','ssh',name,'--','rm -f /opt/capacity/stop'],check=True,timeout=30)
  dest=R/(label+'-generator-'+str(i));dest.mkdir(exist_ok=True)
  with tarfile.open(fileobj=__import__('io').BytesIO(q.stdout)) as t:t.extractall(dest,filter='data')
 camera=[];streams={}
 for i in range(needed):
  dest=R/(label+'-generator-'+str(i))/label
  for path in sorted(dest.glob('stats-*.json'),key=lambda path:int(path.stem.split('-')[-1])):
   snapshot=json.loads(path.read_text())
   for ri,run in enumerate(snapshot['data']):
    for gi,guest in enumerate(run['guests']):
     for item in guest:
      if item.get('type')!='outbound-rtp' or not item.get('camera') or not item.get('rid'):continue
      camera.append(item)
      if v['first']['at']*1000<=snapshot['at']<=v['last']['at']*1000:streams.setdefault((i,ri,gi,item['id']),[]).append((snapshot['at'],item))
 assert camera and not any(x.get('qualityLimitationReason')=='cpu' or x.get('qualityLimitationDurations',{}).get('cpu',0)>0 for x in camera),'generator CPU limitation; run excluded'
 assert len(streams)==count*guests*3,'missing outbound camera layer during measurement'
 assert all(rows[-1][1]['bytesSent']>rows[0][1]['bytesSent'] and rows[-1][1]['framesEncoded']>rows[0][1]['framesEncoded'] for rows in streams.values()),'camera layer stalled during measurement'
 full=[rows for rows in streams.values() if rows[0][1]['rid']=='f']
 assert len(full)==count*guests and all(x.get('frameWidth')==1280 and x.get('frameHeight')==720 for rows in full for at,x in rows),'full camera layer changed resolution'
 full_fps=[(rows[-1][1]['framesEncoded']-rows[0][1]['framesEncoded'])/((rows[-1][0]-rows[0][0])/1000) for rows in full]
 if profile:
  box=S['boxes'][0]
  with tarfile.open(R/'worker.tar.gz') as archive:binary=archive.extractfile('recorder-capture').read()
  for filename,data in [('capture-profile-binary',binary),('capture-profile.pprof',(R/(label+'.pprof')).read_bytes())]:
   q=subprocess.run(['instabox','ssh',box,'--','cat > /tmp/'+filename],input=data,capture_output=True,timeout=60);assert q.returncode==0
  for kind,options in [('flat',[]),('cumulative',['-cum'])]:
   command='GOTOOLCHAIN=local go tool pprof -top -lines -nodecount=100 '+(' '.join(options))+' /tmp/capture-profile-binary /tmp/capture-profile.pprof'
   q=subprocess.run(['instabox','ssh',box,'--',command],capture_output=True,timeout=90);(R/(label+'-pprof-'+kind+'.txt')).write_bytes(q.stdout+q.stderr);assert q.returncode==0,'profile analysis failed'
 identity_final=freeze();(R/(label+'-loaded-final.json')).write_text(json.dumps(identity_final,indent=2))
 if not loaded() or identity_final['api_started']!=identity_before['api_started']:raise PauseCut('count void: API restarted or flag dropped before final proof')
 final=db(label+'-final',ids);assert all(x['schema']=='recording_bundle.v2' and x['state']=='succeeded' and not x['error_code'] for x in final if x['kind']=='capture'),'Capture/Render final v2 proof failed';assert loaded(),'runtime flag reverted by final proof';assert all(x['state']=='succeeded' and not x['error_code'] for x in final if x['kind']=='capture'),'Capture finalization failed'
 coverage_sql="begin read only; with ordered as (select b.*, lag(monotonic_end_millis) over(partition by recording_id order by sequence_number) as previous_end from recording_bundles b where recording_id in ("+','.join("'"+x+"'" for x in ids)+")) select json_build_object('recording_id',recording_id,'bundles',count(*),'v2_bundles',count(*) filter(where content_type='application/vnd.chalk.recording-bundle'),'other_bundles',count(*) filter(where content_type<>'application/vnd.chalk.recording-bundle'),'bytes',sum(byte_size),'gap_only_bundles',count(*) filter(where codec='gap'),'coverage_holes',count(*) filter(where monotonic_start_millis>previous_end),'coverage_hole_ms',coalesce(sum(greatest(0,monotonic_start_millis-previous_end)),0),'min_sequence',min(sequence_number),'max_sequence',max(sequence_number),'first_ms',min(monotonic_start_millis),'last_ms',max(monotonic_end_millis)) from ordered group by recording_id; commit;"
 coverage_name=label+'-coverage.sql';(P/coverage_name).write_text(coverage_sql)
 q=subprocess.run([sys.executable,str(P/'db-read.py'),coverage_name],capture_output=True,timeout=90);assert q.returncode==0
 coverage=[json.loads(line) for line in (P/(coverage_name+'.log')).read_text().splitlines() if line.startswith('{')];assert len(coverage)==count and all(safety.coverage_complete(row,120000) for row in coverage),'missing committed v2 bundle proof'
 (R/(label+'-bundle-coverage.json')).write_text(json.dumps(coverage,indent=2))
 result={'label':label,'size':w['size'],'count':count,'guests':guests,'profile':profile,'peak_cpu_percent':max(x['cpu_percent'] for x in v['samples']),'average_cpu_percent':sum(x['cpu_percent'] for x in v['samples'])/len(v['samples']),'samples':len(v['samples']),'rss_peak_mib':max(x['rss_mib'] for x in v['samples']),'ingress_MB_per_hour':sum(x['network_rx_bytes'] for x in v['samples'])/sum(x['seconds'] for x in v['samples'])*3600/1e6,'sfu_transport_MB_per_hour':sum(x['sfu_udp_bytes'] for x in v['samples'])/sum(x['seconds'] for x in v['samples'])*3600/1e6,'packet_socket_drops':v['packet_socket_drops'],'sampler_cpu_core_peak_percent':max(x['sampler_cpu_core_percent'] for x in v['samples']),'host_steal_peak_percent':max(x['host_steal_percent'] for x in v['samples']),'network_rx_drops':sum(x['network_rx_dropped'] for x in v['samples']),'network_rx_errors':sum(x['network_rx_errors'] for x in v['samples']),'generator_full_layer_mean_fps_range':[min(full_fps),max(full_fps)],'generator_active_camera_layers':len(streams),'bundle_coverage_holes':sum(row['coverage_holes'] for row in coverage),'bundle_coverage_hole_ms':sum(row['coverage_hole_ms'] for row in coverage),'gap_only_bundles':sum(row['gap_only_bundles'] for row in coverage),'generator_camera_samples':len(camera),'v2_proved':True,'bundle_sequence_complete':True,'measured_span_sufficient':True,'gap_free':all(row['coverage_holes']==0 and row['gap_only_bundles']==0 for row in coverage),'recordings':ids}
 S['runs'].append(result);S['current_ids']=[];S['generator_pids']=[];save();budget();event('count complete '+json.dumps(result));return result

def pid_exists(pid):
 try:
  try:
   reaped,_=os.waitpid(pid,os.WNOHANG)
   if reaped:return False
  except ChildProcessError:pass
  os.kill(pid,0);return True
 except ProcessLookupError:return False

def cleanup():
 cleanup_lock=open(R/'cleanup.lock','a')
 fcntl.flock(cleanup_lock,fcntl.LOCK_EX)
 try:
  stop.set();S['phase']='cleanup';save()
  if 'thread' in globals() and thread.is_alive():thread.join(timeout=30)
  errors=safety.cleanup_all([('stop '+name,lambda name=name:subprocess.run(['instabox','ssh',name,'--','touch /opt/capacity/stop'],capture_output=True,timeout=30,check=True)) for name in S['boxes']])
  # Preserve finalization, but never beyond the budget-derived paid lifetime.
  until=S['finish_by']-180
  while time.time()<until and any(pid_exists(pid) for pid in S.get('generator_pids',[])):time.sleep(2)
  try:reconcile_intents()
  except Exception as error:errors.append({'action':'reconcile','error':str(error)})
  errors+=safety.cleanup_all([('delete '+w['id'],lambda w=w:remove_worker(w)) for w in S['workers'] if not w.get('deleted')])
  # A timed-out create remains discoverable/charged until its mutation interval expires.
  if any(k.startswith('intent:') for k in S['seen']):
   until=max(x['mutation_deadline'] for x in S['intents'].values())+30
   while time.time()<until:
    reconcile_intents()
    for w in S['workers']:
     if not w.get('deleted'):errors+=safety.cleanup_all([('delete reconciled '+w['id'],lambda w=w:remove_worker(w))])
    time.sleep(5)
   for key,item in S['seen'].items():
    if key.startswith('intent:'):item.update(active=False,absent_at=time.time())
  if S['controller_stopped']:
   errors+=safety.cleanup_all([('restore controller',lambda:host('restore-controller',"import subprocess\nsubprocess.run(['sudo','-u','#1000','env','XDG_RUNTIME_DIR=/run/user/1000','systemctl','--user','start','chalk-recorder-capture.service'],check=True)",True))])
  if S['flag']:
   errors+=safety.cleanup_all([('remove flag',lambda:flag(False))])
  errors+=safety.cleanup_all([(path+ident,lambda path=path,ident=ident:D.request('DELETE',path+ident)) for path,ident in reversed(S['owned'])])
  errors+=safety.cleanup_all([('remove mTLS copies',lambda:host('remove-owned',"import shutil\nshutil.rmtree('/run/chalk-capacity-large10') if __import__('pathlib').Path('/run/chalk-capacity-large10').exists() else None",True))])
  for pid in S.get('guard_pids',[]):
   try:os.kill(pid,signal.SIGTERM)
   except ProcessLookupError:pass
  if S.get('deferred_fleet_revoke'):
   errors.append({'action':'deferred fleet revocation','error':'Release/Cut or host check prevented revocation; explicit reconciliation required','workers':S['deferred_fleet_revoke']})
  S['cleanup_errors']=errors
  try:budget()
  except Exception as error:errors.append({'action':'final ledger','error':str(error)})
  if not errors:S['cleanup_finished']=time.time()
  save()
  if errors:raise RuntimeError('cleanup errors; see state.json')
 finally:fcntl.flock(cleanup_lock,fcntl.LOCK_UN);cleanup_lock.close()




def reconcile_intents():
 safety.reconcile(S,lambda name:D.request('GET','/droplets?per_page=200&tag_name='+name)['droplets']);save()

if __name__=='__main__' and len(sys.argv)>1 and sys.argv[1]=='cleanup':
 S=json.loads((R/'state.json').read_text());cleanup();sys.exit()
