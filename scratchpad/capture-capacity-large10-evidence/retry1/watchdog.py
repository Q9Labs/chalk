import os,sys,time,pathlib,json,subprocess,signal
R=pathlib.Path(__file__).resolve().parent
owner=int(sys.argv[1]);proof=pathlib.Path(sys.argv[3]) if len(sys.argv)>3 and sys.argv[2] in ('--proof','--deadline-proof') else None
proof_deadline=time.time()+.15 if len(sys.argv)>2 and sys.argv[2]=='--deadline-proof' else float('inf')
while True:
 try:s=json.loads((R/'state.json').read_text())
 except FileNotFoundError:s={}
 if not proof and s.get('cleanup_finished'):sys.exit()
 try:os.kill(owner,0);alive=True
 except ProcessLookupError:alive=False
 if not alive or time.time()>=(proof_deadline if proof else s.get('finish_by',float('inf'))):break
 time.sleep(.05 if proof else 2)
if proof:
 if alive:os.kill(owner,signal.SIGTERM)
 proof.write_text('cleanup branch reached');sys.exit()
if alive:
 os.kill(owner,signal.SIGTERM)
 for _ in range(30):
  time.sleep(2)
  try:os.kill(owner,0)
  except ProcessLookupError:break
 else:os.kill(owner,signal.SIGKILL)
q=subprocess.run([sys.executable,str(R/'experiment.py'),'cleanup'],timeout=1800)
(R/'guardian-result.json').write_text(json.dumps({'triggered_at':time.time(),'cleanup_exit':q.returncode},indent=2))
s=json.loads((R/'state.json').read_text())
for name in s['boxes']:subprocess.run(['instabox','rm',name],capture_output=True,timeout=120)
if q.returncode:sys.exit(q.returncode)
