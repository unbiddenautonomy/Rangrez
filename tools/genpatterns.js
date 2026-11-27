// Generates an original set of window patterns. Run once; output is frozen into server/patterns.js
const R=4,C=5, COLORS='RYGBP'.split(''), VALS='123456'.split('');
let seed=20261127; const rnd=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
const pick=a=>a[Math.floor(rnd()*a.length)];
function solvable(g){ // full fill exists respecting cells + orthogonal rule
  const col=Array(20),val=Array(20);
  function ok(i,c,v){const r=Math.floor(i/C),k=i%C;
    for(const [dr,dk] of [[-1,0],[0,-1]]){const rr=r+dr,kk=k+dk; if(rr<0||kk<0)continue; const j=rr*C+kk; if(col[j]===c||val[j]===v)return false;}
    const s=g[i]; if(s&&s!==c&&s!==v)return false; return true;}
  function bt(i){ if(i===20)return true; for(const c of COLORS)for(const v of VALS){ if(ok(i,c,v)){col[i]=c;val[i]=v; if(bt(i+1))return true;}} col[i]=val[i]=undefined; return false;}
  return bt(0);
}
function gen(n,sym){
  for(;;){ const g=Array(20).fill(null); let placed=0, tries=0;
    while(placed<n && tries++<500){ const i=Math.floor(rnd()*20); if(g[i])continue; const r=Math.floor(i/C),k=i%C;
      const s = rnd()<0.5?pick(COLORS):pick(VALS);
      const cells=[i]; if(sym){ const m=r*C+(C-1-k); if(m!==i) cells.push(m);} 
      if(cells.some(x=>g[x])) continue; if(placed+cells.length>n+1) continue;
      cells.forEach(x=>g[x]=s);
      const bad=cells.some(x=>{const rr=Math.floor(x/C),kk=x%C; return [[1,0],[-1,0],[0,1],[0,-1]].some(([a,b])=>{const y=rr+a,z=kk+b; return y>=0&&y<R&&z>=0&&z<C&&!cells.includes(y*C+z)&&g[y*C+z]===s;})|| cells.length===2&&Math.abs(cells[0]-cells[1])===1; });
      if(bad){cells.forEach(x=>g[x]=null);continue;} placed+=cells.length; }
    if(placed>=n && solvable(g)) return g; }
}
const counts={3:[6,7],4:[8,9],5:[10,11],6:[12,13]};
const out=[]; for(const d of [3,4,5,6]) for(let i=0;i<5;i++){ const [a,b]=counts[d]; out.push({difficulty:d, cells:gen(rnd()<.5?a:b, i%2===0)}); }
for(const p of out){ const rows=[]; for(let r=0;r<R;r++) rows.push(p.cells.slice(r*C,r*C+C).map(x=>x||'.').join('')); p.rows=rows; delete p.cells; }
console.log(JSON.stringify(out));
