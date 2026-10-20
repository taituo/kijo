#!/usr/bin/env node
// Kijo Native Terminal Host — no DOM, Canvas, or browser dependencies.
// The real 6x6 layout, focus mapping, ownership, and scene graph live in WASM.
// This host interprets the scene graph for ANSI/SSH; a GPU host can consume it too.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, uptime, freemem, totalmem, loadavg, platform, arch } from 'node:os';
import { spawn } from 'node:child_process';
import process from 'node:process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = resolve(root, 'core/scene.wasm');
export const KIND = {EMPTY:0, REAL:1, GHOST:2};
export const STATUS = ['idle','working','blocked','error','complete'];
export const VIEWS = ['focus','overview','back','timeline'];
const TILE_SIZE = 7, NODE_SIZE = 13;
const rawFile = process.env.KIJO_STATE_FILE || resolve(process.env.XDG_STATE_HOME || resolve(homedir(), '.local/state'), 'kijo/state.json');

export async function loadCore() {
  // Binary locally or portable base64 artifact committed to GitHub.
  const bytes = existsSync(wasmPath) ? readFileSync(wasmPath) : Buffer.from(readFileSync(wasmPath+'.b64','utf8').trim(),'base64');
  const { instance } = await WebAssembly.instantiate(bytes);
  const api = instance.exports;
  api.kijo_reset();
  if(api.kijo_version() !== 1) throw new Error('Unsupported Kijo scene ABI');
  return api;
}
function ints(api, pointer, count) { return Array.from(new Int32Array(api.memory.buffer, pointer, count)); }
export function getTiles(api) {
  const raw = ints(api, api.kijo_tile_ptr(), api.kijo_tile_count()*TILE_SIZE);
  const fields = ['id','kind','status','owner','group','tx','flags'];
  return Array.from({length:36}, (_,i)=> Object.fromEntries(fields.map((key,j)=>[key,raw[i*TILE_SIZE+j]])));
}
export function getScene(api, view) {
  const mode = typeof view==='string'?VIEWS.indexOf(view):view;
  if(mode<0||mode>3) throw new Error('Unknown view: '+view);
  api.kijo_build_scene(mode);
  const raw = ints(api,api.kijo_node_ptr(),api.kijo_node_count()*NODE_SIZE);
  const fields=['kind','id','x','y','w','h','status','owner','group','flags','material','shader','meta'];
  return Array.from({length:api.kijo_node_count()}, (_,i)=> Object.fromEntries(fields.map((key,j)=>[key,raw[i*NODE_SIZE+j]])));
}
export function persist(api, notes={}, stateFile=rawFile) {
  mkdirSync(dirname(stateFile), {recursive:true});
  writeFileSync(stateFile,JSON.stringify({version:1,tiles:getTiles(api),focus:[api.kijo_focus_x(),api.kijo_focus_y()],notes},null,2));
}
export function restore(api, stateFile=rawFile) {
  if(!existsSync(stateFile)) return {};
  try {
    const state=JSON.parse(readFileSync(stateFile,'utf8'));
    if(state.version!==1 || !Array.isArray(state.tiles) || state.tiles.length!==36) throw new Error('Wrong schema');
    state.tiles.forEach((t,i)=>api.kijo_restore_tile(i,t.id,t.kind,t.status,t.owner,t.group,t.tx,t.flags));
    api.kijo_focus_set(...state.focus);
    return state.notes||{};
  } catch (err) { console.error('Ignoring invalid saved state:',err.message);return {}; }
}
function label(t,notes) {
  if(t.id===1) return 'LOCAL SHELL';
  if(t.id===2) return 'AGENT / demo';
  if(t.id===3) return 'HOST METRICS';
  if(t.id===4) return 'REMOTE / unset';
  return String(notes[t.id]||`NOTE ${t.id}`).slice(0,24);
}
const clean=s=>String(s).replace(/[\x00-\x1f\x7f-\x9f]/g,' ').replace(/[^\x20-\x7e]/g,'?');
class Surface {
  constructor(w,h){this.w=w;this.h=h;this.rows=Array.from({length:h},()=>Array(w).fill(' '));}
  put(x,y,s){if(y<0||y>=this.h)return; [...clean(s)].forEach((c,j)=>{if(x+j>=0&&x+j<this.w)this.rows[y][x+j]=c;});}
  box(x,y,w,h,selected=false,ghost=false){
    const ch=ghost?'.':'-'; const side=selected?'#':'|';
    if(w<3||h<2)return;
    this.put(x,y,'+'+ch.repeat(w-2)+'+');
    this.put(x,y+h-1,'+'+ch.repeat(w-2)+'+');
    for(let row=y+1;row<y+h-1;row++){this.put(x,row,side);this.put(x+w-1,row,side);}
  }
  line(y){return (this.rows[y]||[]).join('').trimEnd();}
  toString(){return this.rows.map(r=>r.join('').trimEnd()).join('\n');}
}
export function render(api,{view='focus',cols=106,rows=35,selected={x:2,y:2},ghosts=true,notes={},events=[],connected=false}={}) {
  cols=Math.max(52,Math.min(240,cols)); rows=Math.max(18,Math.min(80,rows));
  const surf=new Surface(cols,rows);
  const scene=getScene(api,view);
  const tiles=getTiles(api);
  const now=new Date().toLocaleTimeString('en-GB',{hour12:false});
  surf.put(1,0,`KIJO    / ${view.toUpperCase()}    / WASM ABI 1`);
  surf.put(Math.max(1,cols-28),0,`${connected?'REMOTE':'LOCAL'}  ${now}`);
  surf.put(1,1,'='.repeat(cols-2));
  const x0=2,y0=3, maxW=cols-4,maxH=rows-9;
  const metrics=`${hostname()}  ${platform()}/${arch()}  uptime ${Math.floor(uptime()/60)}m  RAM ${Math.round((1-freemem()/totalmem())*100)}%  load ${loadavg()[0].toFixed(2)}`;
  if(view==='focus') {
    const gap=2,cw=Math.floor((maxW-gap)/2),ch=Math.floor((maxH-gap)/2);
    for(const n of scene) {
      const cx=Math.floor(n.x/500),cy=Math.floor(n.y/500);
      const x=x0+cx*(cw+gap),y=y0+cy*(ch+gap);
      const tx=n.meta%6,ty=Math.floor(n.meta/6),sel=selected.x===tx&&selected.y===ty;
      surf.box(x,y,cw,ch,sel,n.kind===3&&ghosts);
      if(n.kind===3 && ghosts) {
        surf.put(x+2,y+1,`GHOST   / reserved by #${n.owner}`);
        surf.put(x+2,y+3,`group ${n.group} / no visual payload`);
        surf.put(x+2,y+5,'[N] promote to independent note');
      } else if(n.kind===2) {
        const t=tiles[n.meta];
        surf.put(x+2,y+1,`${sel?'* ':''}${label(t,notes)}`);
        surf.put(x+2,y+3,`state / ${STATUS[t.status]}`);
        if(t.id===1){ surf.put(x+2,y+5,'Native shell adapter'); surf.put(x+2,y+6,'[P] open actual local shell'); }
        else if(t.id===2){surf.put(x+2,y+5,'SIMULATED agent / not running');surf.put(x+2,y+6,'[T] change test state');}
        else if(t.id===3){surf.put(x+2,y+5,`Host CPU load: ${loadavg()[0].toFixed(2)}`);surf.put(x+2,y+6,`System memory: ${Math.round((1-freemem()/totalmem())*100)}%`);}
        else if(t.id===4){surf.put(x+2,y+5,'SSH target not configured');surf.put(x+2,y+6,'KIJO_SSH_HOST=host  [O] attach');}
        else {surf.put(x+2,y+5,`User note / saved to ${clean('state file')}`);}
      } else if(n.kind===1 && ghosts) {surf.put(x+2,y+1,'EMPTY SLOT');}
    }
    surf.put(2,rows-6,`viewport (${api.kijo_focus_x()},${api.kijo_focus_y()}) / 2x2 selected (${selected.x},${selected.y})`);
  } else if(view==='overview') {
    const gap=1,cw=Math.floor((maxW-5*gap)/6),ch=Math.max(3,Math.floor((maxH-5*gap)/6));
    for(const n of scene) {
      const tx=n.meta%6,ty=Math.floor(n.meta/6);
      const x=x0+tx*(cw+gap),y=y0+ty*(ch+gap);
      const sel=selected.x===tx&&selected.y===ty;
      surf.box(x,y,cw,ch,sel,n.kind===3&&ghosts);
      const t=tiles[n.meta];
      if(n.kind===2) {
        const tag=t.id===1?'SHELL':t.id===2?'AGENT':t.id===3?'HOST':t.id===4?'SSH':'NOTE';
        surf.put(x+1,y+1,`${tag} ${t.id}`.slice(0,cw-2));
        if(ch>3)surf.put(x+1,y+2,STATUS[t.status].slice(0,cw-2));
      } else if(n.kind===3 && ghosts) surf.put(x+1,y+1,`g:${n.owner}`);
    }
    surf.put(2,rows-6,`6x6 / real ${tiles.filter(t=>t.kind===1).length}  ghost ${tiles.filter(t=>t.kind===2).length}  select ${selected.x},${selected.y}  [ENTER] focus`);
  } else if(view==='back') {
    surf.put(3,4,'RENDER TREE / actual WebAssembly scene nodes');
    surf.put(3,6,'SOURCE                    CONNECTION                  SINK');
    surf.put(3,7,'-----------------------------------------------------------------');
    const reals=scene.filter(n=>n.kind===2);
    let offset=8;
    for(const n of reals){
      const name=label(tiles[n.meta],notes);
      surf.put(3,offset++,`${name.padEnd(25)}  -->  ${`group ${n.group}`.padEnd(22)}${STATUS[n.status]}`);
    }
    offset+=2;
    for(const n of scene.filter(n=>n.kind===4).slice(0,8))surf.put(3,offset++,`GHOST SLOT ${String(n.meta).padStart(2)}             --owner--> TILE #${n.owner} / group ${n.group}`);
    surf.put(3,rows-6,'Connector graph: structured/inspectable. Actual backend integration not connected.');
  } else if(view==='timeline') {
    surf.put(3,4,'EVENT LOG / local model updates and host events');
    surf.put(3,5,'-------------------------------------------------------');
    const base=scene.map(n=>`Tile #${n.id}   state ${STATUS[n.status]}  tx-group ${n.group}`);
    [...events.slice(-Math.max(0,rows-13)),...base].slice(-Math.max(1,rows-14)).forEach((e,i)=>surf.put(3,7+i,e));
  }
  surf.put(1,rows-4,'-'.repeat(cols-2));
  surf.put(2,rows-3,metrics.slice(0,cols-4));
  surf.put(2,rows-2,'[1] focus  [2] map  [3] back  [4] time  [arrows] move  [n] note  [x] close  [g] ghosts  [r] reset  [q] quit'.slice(0,cols-4));
  return surf.toString();
}
async function shellTakeover(command,args,api,context) {
  if(!process.stdin.isTTY) return;
  process.stdin.setRawMode(false);process.stdin.pause();
  process.stdout.write('\x1b[?1049l\x1b[0m');
  await new Promise(done=>{
    const child=spawn(command,args,{stdio:'inherit',env:process.env});
    child.on('error',e=>{console.error(e.message);done();});child.on('exit',done);
  });
  process.stdin.setRawMode(true);process.stdin.resume();
  process.stdout.write('\x1b[?1049h');
  context.events.push(`${new Date().toISOString()} Returned from ${command}`);
}
export async function main(argv=process.argv.slice(2)) {
  const api=await loadCore();
  const opts={view:'focus',selected:{x:2,y:2},ghosts:true,notes:{},events:[]};
  if(!argv.includes('--fresh'))opts.notes=restore(api);
  const viewArg=argv.indexOf('--view');if(viewArg>=0&&VIEWS.includes(argv[viewArg+1]))opts.view=argv[viewArg+1];
  if(argv.includes('--once')||!process.stdin.isTTY){console.log(render(api,{...opts,cols:process.stdout.columns||106,rows:process.stdout.rows||35}));return;}
  let redraw=()=>process.stdout.write('\x1b[H\x1b[2J'+render(api,{...opts,cols:process.stdout.columns,rows:process.stdout.rows}));
  process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  redraw();
  const quit=()=>{persist(api,opts.notes);process.stdin.setRawMode(false);process.stdout.write('\x1b[?25h\x1b[?1049l');process.exit(0);};
  process.on('SIGTERM',quit);
  process.stdin.on('data',async key=>{
    if(key==='\u0003'||key==='q'){quit();return;}
    if(['1','2','3','4'].includes(key))opts.view=VIEWS[Number(key)-1];
    else if(key==='\x1b[A')opts.selected.y=Math.max(0,opts.selected.y-1);
    else if(key==='\x1b[B')opts.selected.y=Math.min(5,opts.selected.y+1);
    else if(key==='\x1b[C')opts.selected.x=Math.min(5,opts.selected.x+1);
    else if(key==='\x1b[D')opts.selected.x=Math.max(0,opts.selected.x-1);
    else if(key==='\r' && opts.view==='overview'){opts.view='focus';}
    else if(key==='g')opts.ghosts=!opts.ghosts;
    else if(key==='r'){api.kijo_reset();opts.notes={};opts.selected={x:2,y:2};opts.events.push('Reset');}
    else if(key==='n'){
      const id=api.kijo_promote_ghost(opts.selected.x,opts.selected.y);
      if(id){opts.notes[id]=`Note ${id}`;opts.events.push(`Promoted ghost at ${opts.selected.x},${opts.selected.y} into note #${id}`);}
    } else if(key==='x'){
      const t=getTiles(api)[opts.selected.y*6+opts.selected.x];
      if(t.kind===1&&api.kijo_close(t.id)){opts.events.push(`Closed tile #${t.id}; owned ghosts cleaned`);delete opts.notes[t.id];}
    } else if(key==='t'){
      const t=getTiles(api)[opts.selected.y*6+opts.selected.x];
      if(t.kind===1){api.kijo_status(t.id,(t.status+1)%5);opts.events.push(`Demo status change for tile #${t.id}`);}
    } else if(key==='p' && getTiles(api)[opts.selected.y*6+opts.selected.x]?.id===1){await shellTakeover(process.env.SHELL||'/bin/sh',[],api,opts);}
    else if(key==='o' && getTiles(api)[opts.selected.y*6+opts.selected.x]?.id===4 && process.env.KIJO_SSH_HOST){
      await shellTakeover('ssh',['-t',process.env.KIJO_SSH_HOST],api,opts);
    }
    if(opts.view==='focus')api.kijo_focus_set(Math.max(0,Math.min(4,opts.selected.x-1)),Math.max(0,Math.min(4,opts.selected.y-1)));
    persist(api,opts.notes);redraw();
  });
  process.stdout.on('resize',redraw);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1});
