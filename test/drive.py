"""Automated balance/regression driver. Plays optimally: best-BST draft,
phys/spec-aware move scoring, matchup-aware switching, all reward types."""
import json, re, subprocess, sys

src = open('game.js').read()
chart_src = re.search(r'const TYPE_CHART = \{(.*?)\n\};', src, re.S).group(1)
chart = {}
for m in re.finditer(r'(\w+):\{([^}]*)\}', chart_src):
    chart[m.group(1)] = {k: float(v) for k, v in re.findall(r'(\w+):(\.?\d+\.?\d*)', m.group(2))}

def eff(t, dts):
    r = 1
    for dt in dts: r *= chart.get(t, {}).get(dt, 1)
    return r

def run(*a): return subprocess.run(['node','game.js',*a], capture_output=True, text=True).stdout
def state(): return json.load(open('.gauntlet/state.json'))

def score(me, foe, m):
    A = me['stats']['spa'] if m['cls']=='special' else me['stats']['atk']
    D = foe['stats']['spd'] if m['cls']=='special' else foe['stats']['def']
    stab = 1.5 if m['type'] in me['types'] else 1
    return m['power']*A/D*eff(m['type'], foe['types'])*stab*(m['accuracy']/100)

MAX_ROUNDS = 40

def play_one(verbose=True):
    run('start'); s = state()
    totals = [sum(d['base'].values()) for d in s['draft']]
    p = totals.index(max(totals))
    if verbose: print("draft:", [d['name'] for d in s['draft']], "->", s['draft'][p]['name'])
    run('pick', str(p+1))
    tested = set()
    for step in range(800):
        s = state(); scr = s['screen']
        if scr == 'over':
            if verbose: print(f"WIPED — cleared {s['finalScore']}")
            return s['finalScore']
        if scr == 'reward':
            team = s['run']['team']; rec = s.get('recruit'); rnd = s['run']['round']-1
            if rnd >= MAX_ROUNDS:
                if verbose: print(f"reached round {rnd} — capped")
                return rnd
            offers = s.get('offers', [])
            hurt = sum(m['stats']['maxhp']-m['hp'] for m in team) / sum(m['stats']['maxhp'] for m in team)
            if 'recruit' in offers and rec and len(team) < 3:
                run('reward','recruit')
                if verbose: print(f"r{rnd}: recruit {rec['name']}")
            elif 'restore' in offers and hurt > 0.35:
                run('reward','restore')
                if verbose: print(f"r{rnd}: restore")
            elif 'train' in offers:
                run('reward','train','1')
                if verbose: print(f"r{rnd}: train slot 1")
            elif 'restore' in offers:
                run('reward','restore')
                if verbose: print(f"r{rnd}: restore")
            else:
                bsts = [sum(m['base'].values()) for m in team]
                slot = bsts.index(min(bsts))+1
                run('reward','recruit',str(slot))
                if verbose: print(f"r{rnd}: replace slot {slot} with {rec['name']}")
            continue
        r = s['run']
        if r.get('mustSwitch'):
            foe = r['enemy']
            alive = [(i,m) for i,m in enumerate(r['team']) if m['hp']>0 and i!=r['activeIdx']]
            best = max(alive, key=lambda x: max(score(x[1],foe,m) for m in x[1]['moves']))
            run('switch', str(best[0]+1))
            if verbose: print(f"r{r['round']}: forced switch -> {best[1]['name']}")
            continue
        me = r['team'][r['activeIdx']]; foe = r['enemy']
        sc = [score(me,foe,m) for m in me['moves']]
        run('move', str(sc.index(max(sc))+1))
    return state().get('run',{}).get('round', -1)

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    scores = [play_one(verbose=(n==1)) for _ in range(n)]
    print("scores:", scores, "| best on file:", state()['best'])
