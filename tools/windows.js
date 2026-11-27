// Checks every window in server/patterns.js: no impossible neighbours, fully fillable, and
// simulated difficulty (average empty cells over many games with a sensible bot).
// Usage: node tools/windows.js [games-per-window]
const set=require('../server/patterns').map((p)=>({ ...p, d: p.difficulty })); const R=4,C=5,COL='RYGBP',GAMES=+process.argv[2]||300;
const cell=(p,i)=>{const ch=p.rows[Math.floor(i/C)][i%C];return ch==='.'?null:ch;};
const orth=i=>{const r=Math.floor(i/C),c=i%C;return[[1,0],[-1,0],[0,1],[0,-1]].map(([a,b])=>[r+a,c+b]).filter(([x,y])=>x>=0&&x<R&&y>=0&&y<C).map(([x,y])=>x*C+y);};
const around=i=>{const r=Math.floor(i/C),c=i%C,o=[];for(let a=-1;a<=1;a++)for(let b=-1;b<=1;b++)if((a||b)&&r+a>=0&&r+a<R&&c+b>=0&&c+b<C)o.push((r+a)*C+c+b);return o;};
const edge=i=>{const r=Math.floor(i/C),c=i%C;return r==0||c==0||r==R-1||c==C-1;};
function legal(p,w,d,i){ if(w[i])return false; const e=w.every(x=>!x); if(e?!edge(i):!around(i).some(j=>w[j]))return false;
 const q=cell(p,i); if(q&&q!==d.c&&q!==String(d.v))return false; return orth(i).every(j=>!w[j]||(w[j].c!==d.c&&w[j].v!==d.v));}
function solvable(p){const col=[],val=[];function bt(i){if(i==20)return true;for(const c of COL)for(let v=1;v<=6;v++){const q=cell(p,i);if(q&&q!==c&&q!==String(v))continue;const r=Math.floor(i/C),k=i%C;if(k>0&&(col[i-1]===c||val[i-1]===v))continue;if(r>0&&(col[i-C]===c||val[i-C]===v))continue;col[i]=c;val[i]=v;if(bt(i+1))return true;}col[i]=val[i]=undefined;return false;}return bt(0);}
function score(p,w,d,i){ let s=Math.random()*0.5; const q=cell(p,i); if(q)s+=2; // reward filling restricted cells
 for(const j of orth(i)){ if(w[j])continue; const qj=cell(p,j); if(qj&&(qj===d.c||qj===String(d.v)))s-=3; else s-=0.3; }
 return s;}
const rd=()=>({c:COL[Math.floor(Math.random()*5)],v:1+Math.floor(Math.random()*6)});
function play(p){const w=Array(20).fill(null);for(let r=0;r<10;r++){let pool=[...Array(5)].map(rd);
 for(let pick=0;pick<2;pick++){ // opponent takes a random die before each of our picks
  pool.splice(Math.floor(Math.random()*pool.length),1);
  let best=null;for(const d of pool)for(let i=0;i<20;i++)if(legal(p,w,d,i)){const s=score(p,w,d,i);if(!best||s>best.s)best={s,d,i};}
  if(best){w[best.i]=best.d;pool.splice(pool.indexOf(best.d),1);} }}
 return w.filter(x=>!x).length;}
const out=[];
for(const p of set){
 const n=p.rows.join('').replace(/\./g,'').length, vals=p.rows.join('').replace(/[^1-6]/g,'').length;
 let bad=[];for(let i=0;i<20;i++){const q=cell(p,i);if(!q)continue;for(const j of orth(i))if(j>i&&cell(p,j)===q)bad.push(i+'-'+j);}
 let tot=0;for(let g=0;g<GAMES;g++)tot+=play(p);
 out.push({p,n,vals,ok:solvable(p)&&!bad.length,bad,empty:tot/GAMES});
}
for(const o of out)console.log(`T${o.p.d} ${o.p.name.padEnd(17)} restr=${String(o.n).padStart(2)} vals=${o.vals} ${o.ok?'ok ':'BAD'+o.bad} avgEmpty=${o.empty.toFixed(2)}`);
for(const d of [3,4,5,6]){const xs=out.filter(o=>o.p.d===d).map(o=>o.empty);console.log('tier',d,'mean',(xs.reduce((a,b)=>a+b)/xs.length).toFixed(2),'range',Math.min(...xs).toFixed(2),'-',Math.max(...xs).toFixed(2));}
