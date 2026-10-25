import socket,struct,os,json,subprocess,urllib.request,datetime,time
out={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':'stun.cloudflare.com','port':3478}
def parse(data,tx):
 typ,size,cookie,tid=struct.unpack('!HHI12s',data[:20]);result={'response_type':hex(typ),'transaction_matches':tid==tx,'cookie_matches':cookie==0x2112a442,'mapped':[]};i=20
 while i+4<=len(data):
  tag,n=struct.unpack('!HH',data[i:i+4]);v=data[i+4:i+4+n];i+=4+((n+3)//4)*4
  if tag in (1,0x20) and len(v)>=8:
   family=v[1];port=struct.unpack('!H',v[2:4])[0];addr=v[4:8] if family==1 else v[4:20]
   if tag==0x20:
    port^=0x2112;mask=struct.pack('!I',cookie)+tx;addr=bytes(x^y for x,y in zip(addr,mask))
   result['mapped'].append({'attribute':hex(tag),'address':socket.inet_ntop(socket.AF_INET if family==1 else socket.AF_INET6,addr),'port':port})
 return result
try:out['egress_ip']=urllib.request.urlopen('https://api.ipify.org',timeout=8).read().decode()
except Exception as e:out['egress_error']=str(e)
ips=list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(out['host'],3478,socket.AF_INET,socket.SOCK_DGRAM)));out['resolved_ipv4']=ips;out['probes']=[]
for proto in ['UDP','TCP']:
 for ip in ips[:2]:
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if proto=='UDP' else socket.SOCK_STREAM);s.settimeout(4);tx=os.urandom(12);msg=struct.pack('!HHI12s',1,0,0x2112a442,tx);p={'protocol':proto,'remote':ip};start=time.monotonic()
  try:
   s.connect((ip,3478));p['local']=s.getsockname();s.sendall(msg);data=s.recv(2048)
   if proto=='TCP' and len(data)>=20:
    needed=20+struct.unpack('!H',data[2:4])[0]
    while len(data)<needed:data+=s.recv(needed-len(data))
   p.update(parse(data,tx))
  except Exception as e:p['error']=type(e).__name__+': '+str(e)
  finally:s.close();p['elapsed_s']=round(time.monotonic()-start,3);out['probes'].append(p)
for key,cmd in [('routes',['ip','route']),('interfaces',['ip','-br','address']),('resolv',['cat','/etc/resolv.conf']),('kernel',['uname','-a'])]:
 try:out[key]=subprocess.check_output(cmd,text=True,timeout=5)
 except Exception as e:out[key]=str(e)
print(json.dumps(out,indent=2))
