import json,subprocess,pathlib,urllib.request,urllib.error
R=pathlib.Path(__file__).resolve().parent
def freeze():
 import live_guard
 state=live_guard.inspect()
 if not state['idle']:raise RuntimeError('nightly mutation refused: deployment/lead hold')
class DO:
 def __init__(self):self.token=subprocess.check_output(['doctl','--context','collabez','auth','token'],text=True).strip()
 def request(self,method,path,body=None):
  if method not in ('GET','DELETE'):freeze()
  request=urllib.request.Request('https://api.digitalocean.com/v2'+path,method=method,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'},data=json.dumps(body).encode() if body is not None else None)
  try:
   with urllib.request.urlopen(request,timeout=30) as response:
    data=response.read();return json.loads(data) if data else {'status':response.status}
  except urllib.error.HTTPError as error:
   if error.code==404:return {'status':404}
   (R/'do-last-error.json').write_bytes(error.read());raise RuntimeError('DO request failed; see private do-last-error.json') from None
