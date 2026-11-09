import json,sys
def analyze(path, label=''):
    d=json.load(open(path)); out=[]
    joins={j['guest']:j for j in d['joins']}
    for g in d['guests']:
        gi=g['guest']; base=joins[gi]['startedAt']; S=g['samples']; rel=lambda t:(t-base)/1000
        meta={}
        for s in S:
            for r in s['remotes']: meta.setdefault(r['id'],{'p':r['participantId'][-4:],'src':r['source'],'seen':s['t']})
        series={}
        for s in S:
            for i in s['inbound']:
                series.setdefault(i['id'],[]).append((s['t'],i))
        for tid,m in meta.items():
            if m['src']!='camera' or tid not in series: 
                if m['src']=='camera': out.append(dict(run=label,rx=gi,track=m['p'],seen=round(rel(m['seen']),1),first_pkt=None,first_key=None,first_dec=None,stalls=[]))
                continue
            ser=series[tid]
            fp=next((t for t,i in ser if i['packets']>0),None); fk=next((t for t,i in ser if i['keyframes']>0),None); fd=next((t for t,i in ser if i['decoded']>0),None)
            stalls=[];last=None;lastdec=None
            for t,i in ser:
                if i['decoded']>0:
                    if lastdec is None or i['decoded']>lastdec[1]:
                        if lastdec and t-lastdec[0]>2000: stalls.append((round(rel(lastdec[0]),1),round((t-lastdec[0])/1000,1)))
                        lastdec=(t,i['decoded'])
            last=ser[-1][1]
            out.append(dict(run=label,rx=gi,track=m['p'],seen=round(rel(m['seen']),1),first_pkt=fp and round(rel(fp),1),first_key=fk and round(rel(fk),1),first_dec=fd and round(rel(fd),1),stalls=stalls,pli=last['pli'],nack=last['nack'],lost=last['lost'],freezes=last['freezes']))
    return out
if __name__=='__main__':
    for p in sys.argv[1:]:
        for r in analyze(p,p.split('/')[-2] if '/' in p else p): print(r)
