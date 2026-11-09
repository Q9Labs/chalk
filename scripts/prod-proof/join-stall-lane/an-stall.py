import json,sys
tag=sys.argv[1]; thr=float(sys.argv[2]) if len(sys.argv)>2 else 3
G=[json.load(open(f'/tmp/w/{tag}/g{i}.json')) for i in (1,2,3)]
T0=min(a['t'] for g in G for a in g['actions'] if a['what']=='join click')
rel=lambda t:round((t-T0)/1000,1)
def at(H,t):
    return min(H,key=lambda h:abs(h['t']-t))
def outframes(g,t0,t1):
    a,b=at(g['history'],t0),at(g['history'],t1)
    v=lambda h:[o['f'] for o in h['out'] if o['k']=='video']
    return [y-x for x,y in zip(v(a),v(b))] if len(v(a))==len(v(b)) else ('n/a',v(a),v(b))
for gi,g in enumerate(G,1):
    H=g['history']; ser={}
    for h in H:
        for i in h['in']:
            if i['k']=='video': ser.setdefault(i.get('tid') or i['id'],[]).append((h['t'],i))
    for tid,s in ser.items():
        ld=None
        for t,i in s:
            if i['f']>0 and (ld is None or i['f']>ld[1]):
                if ld and (t-ld[0])/1000>=thr:
                    t0,i0=ld[0],ld[2]
                    print(f"rx G{gi} {tid[-4:]} stall {rel(t0)}..{rel(t)} ({(t-t0)/1000:.1f}s): pk+{i['pk']-i0['pk']} kf+{(i.get('kf') or 0)-(i0.get('kf') or 0)} pli+{(i.get('pli') or 0)-(i0.get('pli') or 0)} nack+{(i.get('nack') or 0)-(i0.get('nack') or 0)} bytes+{i['b']-i0['b']} | senders' video frames over window G1..G3: {[outframes(x,t0,t) for x in G]}")
                ld=(t,i['f'],i)
