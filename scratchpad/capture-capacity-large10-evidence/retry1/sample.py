import json,pathlib,subprocess,time,os,socket,struct,threading,collections
pid=int(subprocess.check_output(['systemctl','show','chalk-capacity-large10.service','-p','MainPID','--value']));cores=os.cpu_count();hz=os.sysconf('SC_CLK_TCK');page=os.sysconf('SC_PAGE_SIZE')
iface=subprocess.check_output(['sh','-c',"ip route show default | awk '{print $5;exit}'"],text=True).strip()
# Count inbound UDP payload on sockets owned by the measured worker. No media is saved.
wire={'bytes':0,'packets':0,'peers':collections.Counter()};ports=set();count_sfu=os.environ.get('CAP_SFU_COUNT')=='1'
if count_sfu:
 inodes={x.readlink().name[8:-1] for x in pathlib.Path('/proc/'+str(pid)+'/fd').iterdir() if x.is_symlink() and str(x.readlink()).startswith('socket:[')}
 ports=set()
 for table in ('udp','udp6'):
  for line in pathlib.Path('/proc/net/'+table).read_text().splitlines()[1:]:
   fields=line.split()
   if fields[9] in inodes:ports.add(int(fields[1].split(':')[1],16))
 assert ports,'worker has no bound UDP socket'
 wire={'bytes':0,'packets':0,'peers':collections.Counter()};done=threading.Event()
 sock=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3));sock.bind((iface,0));sock.settimeout(.2);sock.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,4*1024*1024)
 def receive():
  while not done.is_set():
   try:data,address=sock.recvfrom(65535)
   except socket.timeout:continue
   if address[2]==socket.PACKET_OUTGOING or len(data)<42:continue
   proto=struct.unpack('!H',data[12:14])[0]
   if proto==0x0800 and data[23]==17:
    offset=14+(data[14]&15)*4;peer=socket.inet_ntoa(data[26:30])
   elif proto==0x86dd and len(data)>=62 and data[20]==17:
    offset=54;peer=socket.inet_ntop(socket.AF_INET6,data[22:38])
   else:continue
   if len(data)<offset+8:continue
   source,dst,length,_=struct.unpack('!HHHH',data[offset:offset+8])
   if dst not in ports or source in (53,123):continue
   wire['bytes']+=max(0,length-8);wire['packets']+=1;wire['peers'][peer]+=max(0,length-8)
 thread=threading.Thread(target=receive);thread.start()
def read():
 s=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().split();p=pathlib.Path('/proc/'+str(pid)+'/statm').read_text().split();base=pathlib.Path('/sys/class/net')/iface/'statistics'
 return {'at':time.time(),'ticks':int(s[13])+int(s[14]),'start_ticks':s[21],'rss_mib':int(p[1])*page/1048576,'rx':int((base/'rx_bytes').read_text()),'dropped':int((base/'rx_dropped').read_text()),'errors':int((base/'rx_errors').read_text()),'sfu_udp_bytes':wire['bytes'],'sfu_udp_packets':wire['packets'],'sampler_ticks':sum(int(x) for x in pathlib.Path('/proc/self/stat').read_text().split()[13:15]),'host_cpu':[int(x) for x in pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:]]}
def children():
 return sorted({int(x) for p in pathlib.Path('/proc/'+str(pid)+'/task').glob('*/children') for x in p.read_text().split()})
initial_children=children()
a=read();initial=a;rows=[]
for _ in range(120):
 time.sleep(1);b=read();assert b['start_ticks']==initial['start_ticks'];elapsed=b['at']-a['at'];core=(b['ticks']-a['ticks'])/hz/elapsed*100
 rows.append({'at':b['at'],'seconds':elapsed,'cpu_percent':core/cores,'cpu_core_percent':core,'sampler_cpu_core_percent':(b['sampler_ticks']-a['sampler_ticks'])/hz/elapsed*100,'rss_mib':b['rss_mib'],'network_rx_bytes':b['rx']-a['rx'],'network_rx_dropped':b['dropped']-a['dropped'],'network_rx_errors':b['errors']-a['errors'],'sfu_udp_bytes':b['sfu_udp_bytes']-a['sfu_udp_bytes'],'sfu_udp_packets':b['sfu_udp_packets']-a['sfu_udp_packets'],'host_steal_percent':(b['host_cpu'][7]-a['host_cpu'][7])/max(1,sum(b['host_cpu'][:8])-sum(a['host_cpu'][:8]))*100});a=b
socket_drops=0
if count_sfu:
 done.set();thread.join(timeout=2);socket_packets,socket_drops=struct.unpack('II',sock.getsockopt(263,6,8));sock.close()
print(json.dumps({'initial_child_pids':initial_children,'final_child_pids':children(),'udp_ports':sorted(ports),'sfu_udp_peers_bytes':dict(wire['peers']),'packet_socket_drops':socket_drops,'pid':pid,'cores':cores,'interface':iface,'first':initial,'last':a,'samples':rows}))
