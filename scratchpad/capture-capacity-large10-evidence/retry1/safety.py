"""Pure safety policy, with injectable clock/I/O for failure proofs."""
import time
RATE=.02679+.25
CAP=.25
RESERVE=.06
MINIMUMS=.02

def deadlines(start,cap=CAP,rate=RATE,reserve=RESERVE,minimums=MINIMUMS):
 if cap<=reserve+minimums or rate<=0:raise ValueError('insufficient bounded budget')
 cleanup=start+(cap-reserve-minimums)*3600/rate
 return {'finish_by':cleanup,'stop_new_load_by':cleanup-20*60,'worst_rate':rate,'cleanup_reserve':reserve}

def ledger_cost(entries,now):
 return sum(max(.01,(x.get('absent_at',now)-x['created'])/3600*x['rate']) for x in entries.values())

def remember_intent(state,name,rate,now):
 state.setdefault('intents',{})[name]={'created':now,'rate':rate,'mutation_deadline':now+180}
 state.setdefault('seen',{})['intent:'+name]={'created':now,'rate':rate,'active':True,'name':name}

def reconcile(state,discover):
 for name,intent in state.get('intents',{}).items():
  for node in discover(name):
   ident=str(node['id'])
   if not any(w['id']==ident for w in state['workers']):state['workers'].append({'id':ident,'size':node['size_slug'],'registered':False})
   item=state['seen'].pop('intent:'+name,{'created':intent['created'],'rate':intent['rate'],'active':True,'name':name})
   state['seen'].setdefault(ident,item)
 return state['workers']

def cleanup_all(actions):
 errors=[]
 for label,action in actions:
  try:action()
  except Exception as error:errors.append({'action':label,'error':str(error)})
 return errors

def remote_command(command,expires):
 # No queued flock. Expiry and controller state are checked while holding the lock.
 return """set -eu
[ "$(date +%%s)" -lt %d ] || exit 76
exec 9>/var/lib/chalk/deployment-controller/deployment.lock
flock -n -x 9 || exit 75
[ "$(date +%%s)" -lt %d ] || exit 76
python3 - <<'CONTROLLER_IDLE'
import subprocess,shlex,pathlib,sys
for line in subprocess.check_output(['ps','-eo','args='],text=True).splitlines():
 try:argv=shlex.split(line)
 except ValueError:continue
 if argv and pathlib.Path(argv[0]).name=='chalk-deployment-controller':sys.exit(75)
CONTROLLER_IDLE
curl -fsS --max-time 2 http://127.0.0.1:18080/readyz >/dev/null
[ "$(date +%%s)" -lt %d ] || exit 76
%s
""" % (int(expires),int(expires),int(expires),command)

def coverage_complete(row,window_ms):
 return row['bundles']>0 and row['v2_bundles']==row['bundles'] and row['other_bundles']==0 and row['max_sequence']-row['min_sequence']+1==row['bundles'] and row['last_ms']-row['first_ms']>=window_ms
