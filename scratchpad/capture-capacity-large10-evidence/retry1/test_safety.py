import shutil
import unittest,tempfile,pathlib,subprocess,time,os,signal
from safety import *
class SafetyProof(unittest.TestCase):
 def test_deadline_is_budget_derived_and_leaves_finalization_and_cleanup(self):
  d=deadlines(1000);self.assertLess((d['finish_by']-1000)*RATE/3600+MINIMUMS,CAP-RESERVE+.00001);self.assertEqual(d['finish_by']-d['stop_new_load_by'],1200)
  self.assertLess(deadlines(1000,cap=.2)['finish_by'],d['finish_by'])
 def test_create_timeout_still_reconciles_and_charges_deleted_worker(self):
  s={'workers':[]};remember_intent(s,'owned',.02679,1000)
  try:raise subprocess.TimeoutExpired('create',1)
  except subprocess.TimeoutExpired:reconcile(s,lambda name:[{'id':7,'size_slug':'s-2vcpu-2gb'}])
  self.assertEqual(s['workers'][0]['id'],'7');s['seen']['7'].update(active=False,absent_at=1100)
  self.assertGreaterEqual(ledger_cost(s['seen'],1200),.01)
 def test_unknown_create_intent_is_not_free(self):
  s={};remember_intent(s,'unknown',.02679,1000);self.assertGreaterEqual(ledger_cost(s['seen'],1100),.01)
 def test_all_cleanup_actions_run_even_if_stop_ssh_and_revoke_fail(self):
  called=[]
  def fail():raise TimeoutError('injected')
  errors=cleanup_all([('stop',fail),('revoke',fail),('delete',lambda:called.append('deleted')),('flag',lambda:called.append('flag'))])
  self.assertEqual(called,['deleted','flag']);self.assertEqual(len(errors),2)
 def test_expired_remote_command_cannot_mutate_and_lock_is_nonblocking(self):
  with tempfile.TemporaryDirectory() as folder:
   marker=pathlib.Path(folder)/'mutated';code=remote_command('touch '+str(marker),time.time()-1).replace('/var/lib/chalk/deployment-controller/deployment.lock',folder+'/lock')
   result=subprocess.run(['bash','-c',code]);self.assertEqual(result.returncode,76);self.assertFalse(marker.exists());self.assertIn('flock -n -x',code)
 def test_missing_sequence_or_measured_span_is_not_complete(self):
  row={'bundles':3,'v2_bundles':3,'other_bundles':0,'min_sequence':0,'max_sequence':2,'first_ms':0,'last_ms':125000}
  self.assertTrue(coverage_complete(row,120000));row['max_sequence']=3;self.assertFalse(coverage_complete(row,120000));row['max_sequence']=2;row['last_ms']=100000;self.assertFalse(coverage_complete(row,120000))
 def test_owner_loss_cleanup_process_is_independent(self):
  with tempfile.TemporaryDirectory() as folder:
   marker=pathlib.Path(folder)/'cleaned'
   owner=subprocess.Popen(['sleep','10'])
   guard=subprocess.Popen(['python3',str(pathlib.Path(__file__).with_name('watchdog.py')),str(owner.pid),'--proof',str(marker)])
   owner.kill();owner.wait();guard.wait(timeout=5);self.assertTrue(marker.exists())
 def test_actual_guardian_enforces_its_deadline(self):
  with tempfile.TemporaryDirectory() as folder:
   marker=pathlib.Path(folder)/'deadline-cleanup'
   owner=subprocess.Popen(['sleep','10'])
   guard=subprocess.Popen(['python3',str(pathlib.Path(__file__).with_name('watchdog.py')),str(owner.pid),'--deadline-proof',str(marker)])
   guard.wait(timeout=5);owner.wait(timeout=5);self.assertTrue(marker.exists());self.assertNotEqual(owner.returncode,0)
 @unittest.skipUnless(shutil.which('flock'),'Linux flock proof runs on free Instabox')
 def test_busy_deployment_lock_never_queues_a_mutation(self):
  with tempfile.TemporaryDirectory() as folder:
   ready=pathlib.Path(folder)/'ready';lock=folder+'/lock';marker=pathlib.Path(folder)/'mutated'
   holder=subprocess.Popen(['flock','-x',lock,'sh','-c','touch '+str(ready)+'; sleep 5'])
   try:
    until=time.time()+3
    while not ready.exists() and time.time()<until:time.sleep(.01)
    self.assertTrue(ready.exists())
    command=remote_command('touch '+str(marker),time.time()+30).replace('/var/lib/chalk/deployment-controller/deployment.lock',lock)
    q=subprocess.run(['bash','-c',command],timeout=1);self.assertEqual(q.returncode,75);self.assertFalse(marker.exists())
   finally:holder.terminate();holder.wait(timeout=5)
if __name__=='__main__':unittest.main()
