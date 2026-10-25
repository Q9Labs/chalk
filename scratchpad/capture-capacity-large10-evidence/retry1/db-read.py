import json,os,pathlib,subprocess,urllib.parse,sys,socket,time,re
root=pathlib.Path(__file__).parent
raw=subprocess.check_output(['aws','--profile','q9labs','--region','ap-southeast-1','ssm','get-parameter','--name','/chalk/nightly/managed-episode/api.env','--with-decryption','--output','json'])
cfg=dict(l.split('=',1) for l in json.loads(raw)['Parameter']['Value'].splitlines() if '=' in l and not l.startswith('#'))
u=urllib.parse.urlparse(cfg['CHALK_DATABASE_URL'].strip().strip(chr(34)).strip(chr(39)))
e={**os.environ,'PGHOST':u.hostname,'PGPORT':str(u.port or 5432),'PGUSER':urllib.parse.unquote(u.username),'PGPASSWORD':urllib.parse.unquote(u.password or ''),'PGDATABASE':u.path.lstrip('/'),'PGSSLMODE':'require','PGCONNECT_TIMEOUT':'10','PGAPPNAME':'nightly-capture-drift-readonly','PGOPTIONS':''}
log=open(root/'db-tunnel.log','w+')
tunnel=subprocess.Popen(['aws','--profile','q9labs','--region','ap-southeast-1','ssm','start-session','--target','i-006a30905a8c0e26e','--document-name','AWS-StartPortForwardingSessionToRemoteHost','--parameters',json.dumps({'host':[u.hostname],'portNumber':[str(u.port or 5432)],'localPortNumber':['15439']})],stdout=log,stderr=log,start_new_session=True)
try:
 for _ in range(50):
  try:
   with socket.create_connection(('127.0.0.1',15439),timeout=.2): break
  except OSError:
   if tunnel.poll() is not None: raise RuntimeError('SSM tunnel failed; see db-tunnel.log')
   time.sleep(.2)
 else: raise RuntimeError('SSM tunnel did not open in 10 seconds')
 e.update(PGHOSTADDR='127.0.0.1',PGPORT='15439')
 q=subprocess.run(['/opt/homebrew/bin/psql','-X','-qAt','--set=ON_ERROR_STOP=1'],input=(root/sys.argv[1]).read_text(),env=e,capture_output=True,text=True,timeout=30)
 out=q.stdout if q.returncode==0 else q.stderr.replace(urllib.parse.unquote(u.password or ''),'[REDACTED]')
 (root/(sys.argv[1]+'.log')).write_text(out)
 print('db_exit',q.returncode);print(out)
finally:
 import signal
 os.killpg(tunnel.pid,signal.SIGTERM)
 tunnel.wait(timeout=10)
 log.seek(0); txt=log.read();log.close()
 ids=re.findall(r'SessionId: (\S+)',txt)
 for sid in ids:
  subprocess.run(['aws','--profile','q9labs','--region','ap-southeast-1','ssm','terminate-session','--session-id',sid],stdout=subprocess.DEVNULL,check=True)
