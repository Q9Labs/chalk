import ast,unittest,pathlib,tempfile,types,subprocess,json,time,datetime,hashlib,io,safety
SOURCE=pathlib.Path(__file__).with_name('experiment.py').read_text()
def load(names,env):
 tree=ast.parse(SOURCE);functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names];exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-experiment-functions','exec'),env);return env
class IntegrationProof(unittest.TestCase):
 def test_actual_provision_reconciles_after_create_timeout(self):
  with tempfile.TemporaryDirectory() as folder:
   state={'started':1000,'workers':[],'owned':[],'seen':{},'intents':{},'key_id':1,'live_env':{k:'x' for k in ['FIREWALL_ID','OWNER_TAG','RELEASE_ID','IMAGE_DIGEST','REGION','BOOTSTRAP_ENDPOINT','BOOTSTRAP_CA_BASE64','ARCHIVE_BUCKET','ARCHIVE_KEY','ARCHIVE_SHA256','ARCHIVE_REGION','DIGITALOCEAN_PROJECT_ID','DIGITALOCEAN_VPC_UUID']}}
   state['live_env']['IMAGE_ID']='1';state['live_env']['IMAGE_DIGEST']='sha256:'+'a'*64
   def request(method,path,body=None):
    if path.startswith('/droplets?'):return {'droplets':[{'id':42,'size_slug':'s-2vcpu-2gb'}]}
    if path.startswith('/firewalls/') or path=='/firewalls':return {'firewall':{'id':'fw','inbound_rules':[],'outbound_rules':[]}}
    return {}
   def timeout(*args,**kwargs):
    self.assertTrue(state['intents']);self.assertTrue(state['seen']);raise subprocess.TimeoutExpired('injected provider create',1)
   env={'S':state,'R':pathlib.Path(folder),'P':pathlib.Path(folder),'time':time,'datetime':datetime.datetime,'hashlib':hashlib,'json':json,'safety':safety,'D':types.SimpleNamespace(request=request,token='test'),'subprocess':types.SimpleNamespace(run=timeout),'os':types.SimpleNamespace(environ={}), 'urllib':types.SimpleNamespace(request=types.SimpleNamespace(urlopen=lambda *a,**k:io.BytesIO(b'127.0.0.1'))),'budget':lambda *a:0,'freeze':lambda:None,'save':lambda:None}
   # The source uses datetime.datetime, not the shorthand above.
   env['datetime']=datetime
   load(['provision','reconcile_intents'],env)
   with self.assertRaises(subprocess.TimeoutExpired):env['provision']('s-2vcpu-2gb')
   self.assertEqual(state['workers'][0]['id'],'42');self.assertIn('42',state['seen']);self.assertGreaterEqual(safety.ledger_cost(state['seen'],time.time()),.01)
 def test_actual_worker_delete_is_not_skipped_when_revoke_fails(self):
  calls=[];state={'seen':{'42':{'active':True}},'workers':[]}
  def request(method,path,body=None):calls.append(method);return {'status':404}
  def broken(*args):raise TimeoutError('injected host/Cut revocation failure')
  env={'S':state,'D':types.SimpleNamespace(request=request),'fleet':broken,'time':time,'save':lambda:None}
  load(['remove_worker'],env);worker={'id':'42'};env['remove_worker'](worker)
  self.assertIn('DELETE',calls);self.assertTrue(worker['deleted']);self.assertEqual(state['deferred_fleet_revoke'],['42'])
 def test_actual_main_finalizer_calls_cleanup_after_stop_timeout(self):
  tree=ast.parse(pathlib.Path(__file__).with_name('run.py').read_text());main=next(x for x in tree.body if isinstance(x,ast.Try));calls=[];state={}
  def failed_stop():raise TimeoutError('injected SSH stop timeout')
  env={'E':types.SimpleNamespace(S=state,safety=safety,save=lambda:None,cleanup=lambda:calls.append('cleanup')), 'stop_load':failed_stop,'pumps':[]}
  exec(compile(ast.Module(body=main.finalbody,type_ignores=[]),'actual-main-finalizer','exec'),env)
  self.assertEqual(calls,['cleanup']);self.assertEqual(len(state['stop_load_errors']),1)
if __name__=='__main__':unittest.main()
