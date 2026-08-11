"use client";
import{useState,useEffect,useCallback,useRef,Fragment}from"react";
import DB from"./firebase";

const DEF={primaryColor:"#6C9BCF",accentColor:"#E8A87C",appName:"LaundryHub",appEmoji:"🫧",tagline:"Smart laundry control",alertMinutesBefore:5,chatEnabled:true,maintenance:false,reduceMotion:false,defaultUserEmoji:"😊",confirmStop:true,autoLogoutMin:0,time24:true,soundOnFinish:true,gracePoweroffMin:5,defaultWashMinutes:90,spinnerStyle:"drum",textColor:"#e2e6ef",uiScale:1,dashboardOrder:["ready","schedule","cleaning","washes","housemates"],dashboardSectionsEnabled:{},cleaningDoneVisibility:"everyone",cleaningTaskVisibility:"everyone"};

/* ── Theme catalog — one flat design (see GS()), just an accent color palette to pick from ── */
const THEMES=[{n:"Ocean",p:"#6C9BCF",a:"#E8A87C"},{n:"Sunset",p:"#F59E0B",a:"#EF4444"},{n:"Forest",p:"#10B981",a:"#84CC16"},{n:"Midnight",p:"#8B5CF6",a:"#EC4899"},{n:"Rose",p:"#F472B6",a:"#FCD34D"},{n:"Slate",p:"#64748B",a:"#06B6D4"}];
const ADMIN_PW="1234";
const EMO=["😊","😎","🦊","🐱","🐶","🦁","🐸","🦄","🚀","🎨"];
const bg="var(--lh-bg)",ls="var(--lh-border)";
function isOn(e){return e&&e.lastSeen&&(Date.now()-e.lastSeen)<20000}
/* Mobile back button closes overlays (chat/help/profile) instead of navigating away from the app.
   Pushes a history entry on open; popstate fires when user presses back → closes via onClose.
   IMPORTANT: only re-run on `open` change. `onClose` lives in a ref so parent re-renders don't
   reinitialize the effect (which would synthesize a back-navigation and self-close the modal). */
function useBackToClose(open,onClose){
  const onCloseRef=useRef(onClose);
  onCloseRef.current=onClose;
  useEffect(()=>{
    if(!open||typeof window==="undefined")return;
    /* Push a marker state so the mobile back button closes the overlay instead of
       navigating away. Deliberately does NOT pop this state back off on cleanup —
       calling history.back() here raced with React StrictMode's dev-mode
       mount→cleanup→remount cycle: the async popstate from that back() call would
       arrive after the remount's fresh listener attached, firing onClose the
       instant the overlay opened. Leaving one inert history entry behind on a
       normal (non-back-button) close is harmless. */
    try{window.history.pushState({lhOverlay:true},"")}catch{}
    const handler=()=>{if(onCloseRef.current)onCloseRef.current()};
    window.addEventListener("popstate",handler);
    return()=>window.removeEventListener("popstate",handler);
  },[open]);
}
/* RSSI helpers — dBm → % / label / color / bar count */
function rssiPct(r){if(!r||r===0)return 0;if(r>=-50)return 100;if(r<=-100)return 0;return Math.round(2*(r+100));}
function rssiInfo(r){
  if(!r||r===0)return{label:"No signal",color:"var(--lh-text3)",bars:0,tip:"No data from ESP32"};
  if(r>=-50)return{label:"Excellent",color:"#4ade80",bars:4,tip:"Perfect signal, right next to router"};
  if(r>=-60)return{label:"Very good",color:"#4ade80",bars:4,tip:"Strong, reliable"};
  if(r>=-67)return{label:"Good",color:"#84cc16",bars:3,tip:"Fine for everything"};
  if(r>=-75)return{label:"Fair",color:"#fbbf24",bars:2,tip:"Usable but packets may drop on high traffic"};
  if(r>=-82)return{label:"Weak",color:"#fb923c",bars:1,tip:"Disconnects likely — consider a repeater"};
  return{label:"Critical",color:"#f87171",bars:1,tip:"Frequent drops — move router closer or add repeater"};
}
function fmtDT(ms,t24){const d=new Date(ms);return d.toLocaleString(undefined,{hour12:!t24,year:"numeric",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"})}
function fmtT(ms,t24){return new Date(ms).toLocaleTimeString(undefined,{hour12:!t24,hour:"2-digit",minute:"2-digit"})}
/* Canonical default for dashboard section order. Used as the merge target so users
   migrating from an older config don't lose new sections (ready, schedule). */
const SECTION_DEFAULT_ORDER=["ready","schedule","cleaning","washes","housemates"];
function mergeDashOrder(saved){
  const arr=Array.isArray(saved)?[...saved.filter(k=>SECTION_DEFAULT_ORDER.includes(k))]:[];
  SECTION_DEFAULT_ORDER.forEach((k,i)=>{if(!arr.includes(k))arr.splice(Math.min(i,arr.length),0,k)});
  return arr;
}
/* True end-time of a schedule entry, supporting both new-style (endTime) and old-style (minutes). */
function scheduleEndMs(s){
  if(!s)return 0;
  const datePart=(s.dateTime||"").split("T")[0];
  if(!datePart)return 0;
  if(s.endTime){const t=new Date(`${datePart}T${s.endTime}`).getTime();if(t)return t}
  const startMs=new Date(s.dateTime||`${datePart}T${s.startTime||"00:00"}`).getTime()||0;
  return startMs+((s.minutes||45)*60000);
}
function isSchedulePast(s){return scheduleEndMs(s)<=Date.now()}
/* ── Cleaning roster week helpers ── */
function weekMonday(t){const d=new Date(t||Date.now());const dow=d.getDay();const back=(dow+6)%7;d.setHours(0,0,0,0);d.setDate(d.getDate()-back);return d.getTime()}
function weekSundayEnd(t){return weekMonday(t)+7*86400000-1}
function weekIndex(monday,base){if(!base)return 0;return Math.max(0,Math.floor((monday-base)/(7*86400000)))}
/* Compute task assigned to a user this week given their slot index (0-4) and the rotation week. */
function assignedTaskIdx(userSlot,wk,total){return((userSlot+wk)%total+total)%total}
function fmtDateShort(t){return new Date(t).toLocaleDateString(undefined,{month:"short",day:"numeric"})}
function sendPush(title,body){if(typeof window==="undefined"||!("Notification" in window))return;if(Notification.permission==="granted"){try{new Notification(title,{body,icon:"/icon-512.png",tag:"laundryhub",silent:false})}catch{}}}
/* window.confirm()/prompt() don't render at all in iOS standalone PWA mode — the
   click just silently no-ops, which is exactly why Delete etc looked "broken".
   This replaces both everywhere with a real in-app dialog. askConfirm()/askPrompt()
   are called from any component; GlobalConfirm (mounted once at the app root) is
   the only thing that actually renders it, via a tiny pub-sub since there's no
   shared state store. */
let _confirmSub=null;
function askConfirm(msg){return new Promise(resolve=>{if(_confirmSub)_confirmSub({msg,resolve});else resolve(window.confirm?window.confirm(msg):true)})}
function askPrompt(msg,placeholder){return new Promise(resolve=>{if(_confirmSub)_confirmSub({msg,resolve,isPrompt:true,placeholder});else resolve(window.prompt?window.prompt(msg):null)})}
function GlobalConfirm(){
  const[req,setReq]=useState(null);
  const[val,setVal]=useState("");
  useEffect(()=>{_confirmSub=r=>{setVal("");setReq(r)};return()=>{_confirmSub=null}},[]);
  if(!req)return null;
  const done=ok=>{req.resolve(req.isPrompt?(ok?val:null):ok);setReq(null)};
  return<Modal onClose={()=>done(false)} zIndex={9999}>
    <div className="sec" style={{marginBottom:12}}>{req.isPrompt?"Enter text":"Confirm"}</div>
    <div style={{fontSize:13,color:"var(--lh-text2)",marginBottom:req.isPrompt?10:18,lineHeight:1.5,whiteSpace:"pre-line"}}>{req.msg}</div>
    {req.isPrompt&&<input autoFocus value={val} onChange={x=>setVal(x.target.value)} onKeyDown={x=>x.key==="Enter"&&done(true)} placeholder={req.placeholder||""} className="ni" style={{marginBottom:18}}/>}
    <div className="g2"><button onClick={()=>done(false)} className="nb">Cancel</button><button onClick={()=>done(true)} className="nb nb-p" style={{background:req.isPrompt?undefined:"#f87171"}}>{req.isPrompt?"OK":"Confirm"}</button></div>
  </Modal>;
}
/* Hard refresh: unregister service worker, wipe all caches, then reload.
   Use when the PWA gets stuck on old code (after a deploy). Keeps localStorage
   (so your session/preferences survive) — only wipes the offline file cache. */
async function clearCacheAndReload(){
  if(typeof window==="undefined")return;
  try{
    if("serviceWorker" in navigator){
      const regs=await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r=>r.unregister()));
    }
    if(typeof caches!=="undefined"){
      const names=await caches.keys();
      await Promise.all(names.map(n=>caches.delete(n)));
    }
  }catch(e){console.warn("cache clear failed:",e)}
  // Use a cache-busting query string to ensure the very next request bypasses
  // any HTTP cache that might still be around.
  window.location.replace(window.location.pathname+"?_=" +Date.now());
}
function downloadCSV(filename,rows){if(!rows.length)return;const esc=v=>{const s=String(v??"");return/[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s};const csv=[Object.keys(rows[0]).join(","),...rows.map(r=>Object.values(r).map(esc).join(","))].join("\n");const blob=new Blob([csv],{type:"text/csv"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();URL.revokeObjectURL(a.href)}
let _audioCtx=null;
function getAudioCtx(){if(typeof window==="undefined")return null;if(!_audioCtx){try{_audioCtx=new(window.AudioContext||window.webkitAudioContext)()}catch{return null}}if(_audioCtx.state==="suspended")_audioCtx.resume().catch(()=>{});return _audioCtx}
function playBeep(type){const ctx=getAudioCtx();if(!ctx)return;const play=(freq,start,dur,vol=.18)=>{try{const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.type="sine";o.frequency.setValueAtTime(freq,ctx.currentTime+start);g.gain.setValueAtTime(vol,ctx.currentTime+start);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+start+dur);o.start(ctx.currentTime+start);o.stop(ctx.currentTime+start+dur)}catch{}};if(type==="warn"){play(700,0,.25);play(700,.35,.25)}else if(type==="done"){play(880,0,.5);play(1100,.3,.5);play(1320,.6,.7)}else{play(880,0,.5);play(1100,.25,.5)}}
if(typeof window!=="undefined"){const unlock=()=>{getAudioCtx();["click","touchstart","keydown"].forEach(e=>window.removeEventListener(e,unlock))};["click","touchstart","keydown"].forEach(e=>window.addEventListener(e,unlock,{once:true,passive:true}))}

function GS({p,a,rm,textColor,uiScale}){
  /* Single, opinionated design system — flat surfaces, hairline borders, one accent
     color, system font. Replaced the old 7-theme/20-font/3-density/3-radius picker
     matrix, which was the main source of visual clutter and inconsistency.
     One fixed dark theme (no OS light/dark switching — deliberately dropped per
     feedback that auto-switching felt off). Admin can still tweak the text color
     and overall UI size without the old picker sprawl: text color derives its
     secondary/tertiary/quaternary tones automatically via color-mix() so one
     picker adjusts the whole hierarchy consistently, and size uses `zoom` on
     the root so it scales the existing px-based layout without a rem rewrite. */
  const CARD="var(--lh-card)",BORDER="var(--lh-border)",BORDER2="var(--lh-border2)";
  const tc=textColor||"#e2e6ef";
  const ROOT_VARS=`:root{--lh-bg:#1e2233;--lh-card:#242a3d;--lh-nav:#1a1e30;--lh-border:rgba(255,255,255,.08);--lh-border2:rgba(255,255,255,.16);--lh-text:${tc};--lh-text2:color-mix(in srgb,${tc} 68%,#1e2233);--lh-text3:color-mix(in srgb,${tc} 40%,#1e2233);--lh-text4:color-mix(in srgb,${tc} 85%,#1e2233)}`;
  return<style dangerouslySetInnerHTML={{__html:`${ROOT_VARS}@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}@keyframes si{from{transform:translateX(60px);opacity:0}to{transform:translateX(0);opacity:1}}@keyframes fu{from{transform:translateY(14px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes pu{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}@keyframes wv{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1)}}@keyframes rise{0%{transform:translateY(0) scale(1);opacity:.85}70%{opacity:.5}100%{transform:translateY(-130%) scale(.4);opacity:0}}@keyframes rp{0%{box-shadow:0 0 0 0 ${p}33}100%{box-shadow:0 0 0 14px ${p}00}}@keyframes gl{0%,100%{opacity:.7}50%{opacity:1}}@keyframes bk{0%,100%{opacity:1}50%{opacity:0}}@keyframes slideInNext{from{transform:translateX(100%)}to{transform:translateX(0)}}@keyframes slideInPrev{from{transform:translateX(-100%)}to{transform:translateX(0)}}.tab-slide-next{animation:slideInNext .2s cubic-bezier(.2,.8,.2,1)}.tab-slide-prev{animation:slideInPrev .2s cubic-bezier(.2,.8,.2,1)}@keyframes tabFadeNext{from{transform:translateX(14px);opacity:.4}to{transform:translateX(0);opacity:1}}@keyframes tabFadePrev{from{transform:translateX(-14px);opacity:.4}to{transform:translateX(0);opacity:1}}.tab-slide-next-soft{animation:tabFadeNext .16s ease-out}.tab-slide-prev-soft{animation:tabFadePrev .16s ease-out}*{box-sizing:border-box;margin:0;padding:0;transition:background-color .25s ease,border-color .25s ease,color .25s ease}html,body{font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;background:radial-gradient(ellipse 130% 50% at 20% 0%,${p}4d 0%,transparent 60%),radial-gradient(ellipse 110% 45% at 100% 8%,${a||p}38 0%,transparent 55%),${bg};background-color:${bg};background-attachment:fixed;color:var(--lh-text);overflow-x:hidden}.lh-scale{zoom:${uiScale||1}}input:focus,button:focus{outline:none}button,input,select,textarea{font-family:inherit;-webkit-appearance:none}::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:${BORDER2};border-radius:4px}.nm{background:${CARD};border:1px solid ${BORDER};box-shadow:none;border-radius:16px;padding:18px;color:var(--lh-text)}.nm-in{background:${bg};border:1px solid ${BORDER};box-shadow:none;border-radius:12px;padding:14px;color:var(--lh-text)}.nb{background:transparent;border:1px solid ${BORDER2};box-shadow:none;padding:10px 16px;border-radius:12px;cursor:pointer;font-weight:600;font-size:13px;color:var(--lh-text4);transition:background .15s,border-color .15s;-webkit-tap-highlight-color:transparent}.nb:hover{background:${BORDER};border-color:${BORDER2}}.nb:active{background:${BORDER2};transform:none}.nb-p{background:${p};border-color:${p};color:#fff}.nb-p:hover{filter:brightness(1.08)}.nb-p:active{filter:brightness(.92);transform:none}.ni{background:${bg};border:1px solid ${BORDER2};box-shadow:none;padding:11px 14px;border-radius:12px;font-size:14px;width:100%;color:var(--lh-text)}.ni:focus{outline:none;border-color:${p}}.ni::placeholder{color:var(--lh-text3)}.np{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:20px;font-size:10px;font-weight:700;background:${BORDER}}.ns{border-radius:12px;padding:14px;background:${bg};border:1px solid ${BORDER}}.av{border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:${bg};border:1px solid ${BORDER}}.M{font-family:'JetBrains Mono',monospace}.sec{font-size:17px;font-weight:700;color:var(--lh-text);margin-bottom:14px;letter-spacing:-.2px;display:flex;align-items:center;gap:8px}.sec-ico{font-size:19px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}.g4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px}@media(max-width:440px){.g3,.g4{grid-template-columns:1fr 1fr}}.row{display:flex;align-items:center;gap:8px}.sb{display:flex;justify-content:space-between;align-items:center}.wrap{display:flex;flex-wrap:wrap;gap:6px}.tog{width:42px;height:22px;border-radius:11px;cursor:pointer;position:relative;background:${bg};border:1px solid ${BORDER2};transition:background .3s}.tog-k{width:16px;height:16px;border-radius:50%;background:var(--lh-text);position:absolute;top:2px;transition:left .25s}.chat-wrap{display:flex;padding:0 12px 14px}.chat-card{position:relative;width:100%;max-width:820px;height:calc(100vh - 150px);max-height:640px;display:flex;background:${CARD};border:1px solid ${BORDER};border-radius:20px;box-shadow:none;overflow:hidden;animation:fu .2s ease}.chat-sb{width:260px;flex-shrink:0;display:flex;flex-direction:column;background:${CARD};border-right:1px solid ${BORDER};position:relative;z-index:2}.chat-sb-head{display:flex;align-items:center;justify-content:space-between;padding:14px 14px;border-bottom:1px solid ${BORDER}}.chat-contacts{flex:1;overflow-y:auto;padding:8px}.chat-contact{display:flex;gap:10px;align-items:center;width:100%;padding:9px 10px;border:1px solid transparent;background:transparent;cursor:pointer;border-radius:12px;margin-bottom:3px;color:var(--lh-text4);transition:background .15s;text-align:left}.chat-contact:hover{background:${BORDER}}.chat-main{flex:1;display:flex;flex-direction:column;min-width:0}.chat-header{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid ${BORDER};background:${CARD}}.chat-menu{display:none;background:transparent;border:none;color:var(--lh-text4);cursor:pointer;font-size:18px;padding:6px 10px;border-radius:8px}.chat-x{background:transparent;border:none;color:var(--lh-text2);cursor:pointer;font-size:14px;padding:6px 10px;border-radius:8px;font-weight:700}.chat-x:hover{color:var(--lh-text)}.chat-body{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:1px}.chat-daysep{text-align:center;margin:14px 0 8px}.chat-daysep span{display:inline-block;background:${BORDER};color:var(--lh-text2);font-size:10px;font-weight:700;padding:3px 11px;border-radius:10px}.chat-row{display:flex;gap:8px;align-items:flex-end}.chat-row.mine{flex-direction:row-reverse}.chat-row.grp{margin-top:10px}.chat-av{flex-shrink:0}.chat-bubble-wrap{max-width:72%;display:flex;flex-direction:column;position:relative}.chat-actions{display:none;position:absolute;top:-10px;gap:2px;background:${CARD};border:1px solid ${BORDER};padding:2px 4px;border-radius:8px;z-index:1}.chat-row.mine .chat-actions{right:0}.chat-row.other .chat-actions{left:0}.chat-row:hover .chat-actions,.chat-actions.force{display:flex}@media(hover:none){.chat-actions{display:flex!important;position:static;background:transparent;border:none;padding:0;margin-top:2px;opacity:.6}}.chat-action-btn{background:transparent;border:none;color:var(--lh-text4);cursor:pointer;font-size:12px;padding:3px 6px;border-radius:4px;font-weight:700}.chat-action-btn:hover{background:${BORDER};color:var(--lh-text)}.chat-action-btn.del:hover{color:#f87171}.chat-edited{font-size:9px;color:var(--lh-text3);margin-left:6px;font-style:italic}.chat-edit-row{display:flex;gap:6px;align-items:center;margin-top:2px}.chat-edit-input{flex:1;font-size:13px;padding:8px 12px;border-radius:16px}.chat-row.mine .chat-bubble-wrap{align-items:flex-end}.chat-sender{font-size:10px;color:var(--lh-text3);margin-bottom:4px;font-weight:600;padding:0 4px}.chat-b{padding:9px 13px;border-radius:16px;font-size:13px;line-height:1.35;word-wrap:break-word;white-space:pre-wrap;max-width:100%}.chat-row.mine .chat-b{border-bottom-right-radius:4px}.chat-row.other .chat-b{border-bottom-left-radius:4px}.chat-empty{text-align:center;padding:48px 20px;color:var(--lh-text3);margin:auto}.chat-input-row{display:flex;gap:8px;padding:10px 14px;border-top:1px solid ${BORDER};align-items:center}.chat-input{flex:1;border-radius:22px;padding:11px 16px;font-size:13px}.chat-send{width:44px;height:44px;border-radius:22px;padding:0;font-size:16px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:none;cursor:pointer;transition:opacity .15s}.chat-send:disabled{cursor:not-allowed}.chat-x-desktop{display:block}@media(max-width:720px){.chat-wrap{padding:0}.chat-card{max-width:none;max-height:none;border-radius:0}.chat-sb{position:absolute;top:0;bottom:0;left:0;width:280px;transform:translateX(-100%);transition:transform .25s;z-index:10;border-right:1px solid ${BORDER}}.chat-sb.open{transform:translateX(0)}.chat-menu{display:block}.chat-x-desktop{display:none}.chat-bubble-wrap{max-width:80%}}${rm?"*,*::before,*::after{animation:none!important;transition:none!important}":""}`}}/>;}

function Toast({message,type,onClose}){useEffect(()=>{const t=setTimeout(onClose,3500);return()=>clearTimeout(t)},[onClose]);const c={success:"#4ade80",error:"#f87171",warning:"#fbbf24",info:"#60a5fa"}[type]||"#60a5fa";return<div style={{position:"fixed",top:12,right:12,left:12,zIndex:9999,animation:"si .3s ease",maxWidth:360,margin:"0 auto"}}><div className="nm" style={{padding:"12px 16px",borderLeft:`3px solid ${c}`,fontSize:12,fontWeight:600}}>{message}</div></div>;}
/* Spinner styles — admin can pick one in settings. `c` is always the theme primary color. */
function SpinIcon({style,c,paused,sz}){
  const opacity=paused?.45:1;const s=sz*.18;const anim=paused?"none":undefined;
  if(style==="pulse")return<div style={{width:s,height:s,borderRadius:"50%",background:c,animation:anim||"pu 1.6s ease-in-out infinite",opacity,boxShadow:`0 0 16px ${c}88`}}/>;
  if(style==="ring")return<div style={{width:s,height:s,borderRadius:"50%",border:`3px solid ${c}33`,borderTopColor:c,animation:anim||"spin 1s linear infinite",opacity}}/>;
  if(style==="dots")return<div style={{display:"flex",gap:4,opacity}}>{[0,1,2].map(i=><div key={i} style={{width:s*.3,height:s*.3,borderRadius:"50%",background:c,animation:anim||`pu 1.2s ease-in-out ${i*.15}s infinite`}}/>)}</div>;
  if(style==="bubble")return<div style={{fontSize:s,animation:anim||"bob 1.6s ease-in-out infinite",filter:paused?"grayscale(.6)":`drop-shadow(0 0 4px ${c}66)`,opacity}}>🫧</div>;
  if(style==="wave")return<div style={{display:"flex",gap:3,alignItems:"center",opacity}}>{[0,1,2,3].map(i=><div key={i} style={{width:s*.18,height:s*.8,borderRadius:2,background:c,animation:anim||`wv 1s ease-in-out ${i*.12}s infinite`}}/>)}</div>;
  /* === New realistic ones === */
  if(style==="drum"){
    /* Side-view of a washer drum with porthole holes rotating inside it */
    const dr=s*.95;
    return<svg width={dr} height={dr} viewBox="0 0 100 100" style={{opacity,filter:paused?"grayscale(.6)":`drop-shadow(0 0 4px ${c}55)`}}><defs><radialGradient id="dg" cx=".4" cy=".4" r=".7"><stop offset="0" stopColor={c} stopOpacity=".25"/><stop offset="1" stopColor={c} stopOpacity=".05"/></radialGradient></defs><circle cx="50" cy="50" r="46" fill="url(#dg)" stroke={c} strokeWidth="2.5" opacity=".7"/><circle cx="50" cy="50" r="36" fill="none" stroke={c} strokeWidth="1.5" opacity=".4"/><g style={{transformOrigin:"50px 50px",animation:anim||"spin 2.2s linear infinite"}}>{[0,60,120,180,240,300].map(deg=>{const r=28;const x=50+r*Math.cos(deg*Math.PI/180);const y=50+r*Math.sin(deg*Math.PI/180);return<circle key={deg} cx={x} cy={y} r="3.5" fill={c} opacity=".75"/>})}<circle cx="50" cy="50" r="5" fill={c} opacity=".9"/></g></svg>;
  }
  if(style==="bubbles"){
    /* Multiple bubbles rising at staggered speeds — realistic detergent foam */
    return<div style={{width:s*1.2,height:s*1.2,position:"relative",opacity}}>{[
      {l:"20%",d:"0s",sz:.45,dur:"1.6s"},
      {l:"55%",d:".3s",sz:.6,dur:"1.9s"},
      {l:"80%",d:".6s",sz:.35,dur:"1.4s"},
      {l:"35%",d:"1s",sz:.5,dur:"1.8s"},
    ].map((b,i)=><div key={i} style={{position:"absolute",left:b.l,bottom:0,width:s*b.sz,height:s*b.sz,borderRadius:"50%",background:`radial-gradient(circle at 30% 30%, ${c}aa, ${c}33 70%, transparent)`,border:`1px solid ${c}99`,animation:anim||`rise ${b.dur} ease-in ${b.d} infinite`,opacity:.85}}/>)}</div>;
  }
  if(style==="swirl"){
    /* Water-vortex SVG spiral */
    const dr=s*.95;
    return<svg width={dr} height={dr} viewBox="0 0 100 100" style={{opacity,filter:paused?"grayscale(.6)":`drop-shadow(0 0 5px ${c}66)`,animation:anim||"spin 2.4s linear infinite"}}><defs><linearGradient id="sw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={c} stopOpacity="0"/><stop offset="1" stopColor={c} stopOpacity="1"/></linearGradient></defs><path d="M 50 50 m -38 0 a 38 38 0 1 1 76 0 a 30 30 0 1 0 -60 0 a 22 22 0 1 1 44 0 a 14 14 0 1 0 -28 0 a 6 6 0 1 1 12 0" fill="none" stroke="url(#sw)" strokeWidth="3.5" strokeLinecap="round"/></svg>;
  }
  if(style==="droplet"){
    /* Realistic water droplet with shine */
    const dr=s*1.05;
    return<svg width={dr} height={dr} viewBox="0 0 100 100" style={{opacity,animation:anim||"bob 1.6s ease-in-out infinite",filter:paused?"grayscale(.6)":`drop-shadow(0 2px 4px ${c}66)`}}><defs><radialGradient id="dp" cx=".35" cy=".35" r=".7"><stop offset="0" stopColor="#fff" stopOpacity=".8"/><stop offset=".4" stopColor={c} stopOpacity=".9"/><stop offset="1" stopColor={c} stopOpacity="1"/></radialGradient></defs><path d="M50 8 C 30 38, 18 58, 18 70 a 32 32 0 0 0 64 0 C 82 58, 70 38, 50 8 z" fill="url(#dp)" stroke={c} strokeWidth="1.5" strokeOpacity=".4"/><ellipse cx="40" cy="42" rx="6" ry="10" fill="#fff" opacity=".55"/></svg>;
  }
  /* default: drop */
  return<div style={{animation:paused?"none":"spin 2s linear infinite",fontSize:s,opacity,filter:paused?"grayscale(.6)":`drop-shadow(0 0 3px ${c}66)`}}>💧</div>;
}
function Wash({on,prog,c,sz=130,paused,grace,spinnerStyle}){const i=sz-22;const cx=grace?"#fbbf24":(paused?"#f87171":c);const effProg=grace?1:prog;const active=on&&!grace;return<div style={{width:sz,height:sz,borderRadius:"50%",background:`conic-gradient(${cx} ${effProg*360}deg,rgba(255,255,255,.08) ${effProg*360}deg)`,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:(active||grace)?`0 0 24px ${cx}33`:"none",animation:active&&!paused?"rp 2s infinite":"none",transition:"background .3s"}}><div style={{width:i,height:i,borderRadius:"50%",background:bg,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",border:"1px solid rgba(255,255,255,.08)"}}>{grace?<div style={{fontSize:sz*.22,color:"#fbbf24"}}>✓</div>:on?<SpinIcon style={spinnerStyle||"drop"} c={c} paused={paused} sz={sz}/>:<svg width={sz*.16} height={sz*.16} viewBox="0 0 24 24" style={{opacity:.35}}><path d="M12 3v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/><path d="M6.5 6.5a8 8 0 1 0 11 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>}<div className="M" style={{fontSize:grace?12:(paused?12:10),color:grace?"#fbbf24":(paused?"#f87171":"var(--lh-text2)"),marginTop:3,fontWeight:(grace||paused)?800:400,letterSpacing:(grace||paused)?.5:0}}>{grace?"DONE":on?`${Math.round(prog*100)}%`:"IDLE"}</div></div></div>;}
function Tog({on,onChange,color}){return<div className="tog" onClick={onChange} style={{background:on?color||"#6C9BCF":bg}}><div className="tog-k" style={{left:on?23:3}}/></div>;}
/* Settings helpers — MUST be at module scope so React doesn't tear down inputs
   on every parent re-render (the parent re-renders every second due to the
   admin clock interval, which previously caused the on-screen keyboard to
   close as soon as you typed a character). */
function SH({i,t,children}){return<div style={{margin:"6px 0 10px"}}><div style={{fontSize:10,color:"var(--lh-text2)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`}}>{i} {t}</div>{children}</div>;}
function TR({t,d,on,onChange,color}){return<div className="sb" style={{padding:"8px 0"}}><div style={{flex:1}}><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{t}</div><div style={{fontSize:10,color:"var(--lh-text3)",marginTop:1}}>{d}</div></div><Tog on={on} onChange={onChange} color={color}/></div>;}
function Modal({children,onClose,zIndex}){useBackToClose(true,onClose);return<div style={{position:"fixed",inset:0,zIndex:zIndex||9998,background:"#000b",display:"flex",alignItems:"center",justifyContent:"center",padding:12}} onClick={onClose}><div className="nm" style={{width:"100%",maxWidth:400,padding:24,animation:"fu .25s ease",maxHeight:"88vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>{children}</div></div>;}
function UserEspDot({esp}){const on=isOn(esp);return<div className="row" style={{gap:5}}><div style={{width:9,height:9,borderRadius:5,background:on?"#4ade80":"#f87171",animation:on?"gl 2s infinite":"bk 1s infinite"}}/><span style={{fontSize:12,fontWeight:700,color:on?"#4ade80":"#f87171"}}>{on?"On":"Off"}</span></div>;}
function MntBanner(){return<div style={{background:"#f87171",color:"#fff",padding:"9px 14px",margin:"0 12px 10px",borderRadius:12,fontWeight:800,fontSize:12,textAlign:"center",letterSpacing:.3}}>🔧 MAINTENANCE MODE — Washing temporarily unavailable</div>;}
function AdminEspBar({esp}){const on=isOn(esp);const r=esp?.rssi||0;const ri=rssiInfo(r);const pct=rssiPct(r);return<div className="nm-in" style={{padding:"8px 12px",marginBottom:14,display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,flexWrap:"wrap"}}><div className="row" style={{gap:5}}><div style={{width:8,height:8,borderRadius:4,background:on?"#4ade80":"#f87171",animation:on?"gl 2s infinite":"bk 1s infinite"}}/><span style={{fontSize:11,fontWeight:700,color:on?"#4ade80":"#f87171"}}>{on?"ESP32 Connected":"ESP32 Disconnected"}</span></div>{on&&esp&&<div className="row" style={{gap:8}}><div className="row" style={{gap:1}} title={`${ri.label} · ${r}dBm`}>{[1,2,3,4].map(x=><div key={x} style={{width:3,height:4+x*3,borderRadius:1,background:x<=ri.bars?ri.color:"#333a4d"}}/>)}</div><span className="M" style={{fontSize:9,color:ri.color,fontWeight:800}}>{pct}%</span><div style={{width:1,height:12,background:"#333a4d"}}/><span className="M" style={{fontSize:9,color:esp.relay?"#4ade80":"var(--lh-text3)"}}>{esp.relay?"ON":"OFF"}</span></div>}</div>;}

// Check if now conflicts with any schedule
function isScheduleBlocked(sch,userId){
  const now=Date.now();
  return sch.find(s=>{
    if(s.userId===userId)return false;
    const startMs=new Date(s.dateTime).getTime();
    const endMs=startMs+(s.minutes||45)*60000;
    // Blocked from 5min before start until end
    return now>=(startMs-300000)&&now<=endMs;
  });
}

/* Chat — opens with pre-selected recipient */
function ChatMod({user,cfg,users,onClose,initTo}){
  useBackToClose(true,onClose);
  const[msgs,setMsgs]=useState([]);const[txt,setTxt]=useState("");const[to,setTo]=useState(initTo||"all");const[sbOpen,setSbOpen]=useState(false);const[editKey,setEditKey]=useState(null);const[editTxt,setEditTxt]=useState("");const ce=useRef(null);const inputRef=useRef(null);
  const myId=user.id||"admin";
  const isAdmin=myId==="admin";
  const delMsg=async(m)=>{if(!(await askConfirm("Delete this message?")))return;try{await DB.deleteMessage(m._key)}catch{}};
  const startEdit=(m)=>{setEditKey(m._key);setEditTxt(m.text)};
  const saveEdit=async()=>{const t=editTxt.trim();if(!t){setEditKey(null);return}try{await DB.editMessage(editKey,t)}catch{}setEditKey(null);setEditTxt("")};
  const cancelEdit=()=>{setEditKey(null);setEditTxt("")};
  useEffect(()=>{const u=DB.onChatMessages(setMsgs);return()=>u()},[]);
  useEffect(()=>{setTimeout(()=>ce.current?.scrollIntoView({behavior:"smooth"}),10)},[msgs,to]);
  useEffect(()=>{setTimeout(()=>inputRef.current?.focus(),50);const ts=Date.now();if(myId==="admin"){try{localStorage.setItem("lh_admin_last_read",ts.toString())}catch{}}else{DB.updateUser(myId,{lastRead:ts}).catch(()=>{})}},[to,myId]);
  useEffect(()=>{const onKey=(e)=>{if(e.key==="Escape")onClose()};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey)},[onClose]);
  const send=async()=>{if(!txt.trim())return;await DB.sendMessage({from:user.name,fromId:myId,emoji:user.emoji||"🛡️",text:txt.trim(),to,toName:to==="all"?"Everyone":users.find(u=>u.id===to)?.name||"?"});setTxt("");inputRef.current?.focus()};
  const visibleFor=(rid)=>msgs.filter(m=>rid==="all"?m.to==="all":(m.fromId===myId&&m.to===rid)||(m.fromId===rid&&m.to===myId));
  const vis=visibleFor(to);
  const contactList=[{id:"all",name:"Everyone",emoji:"📢"},...users.filter(u=>u.id!==myId&&!u.disabled).map(u=>({id:u.id,name:u.name,emoji:u.emoji||"😊"}))].map(c=>{const cm=visibleFor(c.id);const last=cm[cm.length-1];const unread=cm.filter(m=>m.fromId!==myId&&m.timestamp>(user.lastRead||0)).length;return{...c,last,unread}}).sort((a,b)=>(b.last?.timestamp||0)-(a.last?.timestamp||0));
  const toUser=to==="all"?{name:"Everyone",emoji:"📢",sub:"Public channel"}:(()=>{const u=users.find(x=>x.id===to);return u?{name:u.name,emoji:u.emoji||"😊",sub:"Direct message"}:{name:"?",emoji:"?",sub:""}})();
  const dayLabel=(ms)=>{const d=new Date(ms);d.setHours(0,0,0,0);const t=new Date();t.setHours(0,0,0,0);const diff=(t-d)/86400000;if(diff===0)return "Today";if(diff===1)return "Yesterday";return d.toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"})};
  const t24=cfg.time24!==false;
  return <div className="chat-wrap">
    <div className="chat-card">
      <aside className={`chat-sb${sbOpen?" open":""}`}>
        <div className="chat-sb-head">
          <div><div style={{fontSize:14,fontWeight:800,color:"var(--lh-text)"}}>Messages</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{contactList.length} contact{contactList.length!==1?"s":""}</div></div>
          <button onClick={()=>setSbOpen(false)} className="chat-x" aria-label="Close contacts">✕</button>
        </div>
        <div className="chat-contacts">
          {contactList.map(c=><button key={c.id} onClick={()=>{setTo(c.id);setSbOpen(false)}} className="chat-contact" style={to===c.id?{background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.1)"}:{}}>
            <div className="av" style={{width:38,height:38,fontSize:18,background:bg,flexShrink:0}}>{c.emoji}</div>
            <div style={{flex:1,minWidth:0}}>
              <div className="sb" style={{gap:4}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--lh-text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{c.name}</div>
                {c.last&&<div className="M" style={{fontSize:9,color:"var(--lh-text3)",flexShrink:0}}>{new Date(c.last.timestamp).toLocaleTimeString(undefined,{hour12:!t24,hour:"2-digit",minute:"2-digit"})}</div>}
              </div>
              <div className="sb" style={{marginTop:2,gap:4}}>
                <div style={{fontSize:11,color:"var(--lh-text2)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",flex:1}}>{c.last?`${c.last.fromId===myId?"You: ":""}${c.last.text}`:"—"}</div>
                {c.unread>0&&<span style={{background:"#f87171",color:"#fff",fontSize:9,fontWeight:800,padding:"1px 7px",borderRadius:9,minWidth:18,textAlign:"center"}}>{c.unread>9?"9+":c.unread}</span>}
              </div>
            </div>
          </button>)}
        </div>
      </aside>
      <main className="chat-main" onClick={()=>{if(sbOpen)setSbOpen(false)}}>
        <div className="chat-header">
          <button onClick={()=>setSbOpen(true)} className="chat-menu" aria-label="Contacts">☰</button>
          <div className="av" style={{width:40,height:40,fontSize:20,background:bg,flexShrink:0}}>{toUser.emoji}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:14,fontWeight:800,color:"var(--lh-text)"}}>{toUser.name}</div>
            <div style={{fontSize:10,color:"var(--lh-text3)"}}>{toUser.sub}</div>
          </div>
          <button onClick={onClose} className="chat-x chat-x-desktop" aria-label="Close">✕</button>
        </div>
        <div className="chat-body">
          {vis.length===0?<div className="chat-empty">
            <div style={{marginBottom:12,color:"var(--lh-text3)"}}><NavIcon name="chat" size={40}/></div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--lh-text2)"}}>No messages yet</div>
            <div style={{fontSize:11,color:"var(--lh-text3)",marginTop:6}}>Start the conversation with {toUser.name}</div>
          </div>:vis.map((m,i)=>{
            const prev=vis[i-1];
            const newDay=!prev||new Date(prev.timestamp).toDateString()!==new Date(m.timestamp).toDateString();
            const grpStart=!prev||prev.fromId!==m.fromId||newDay||(m.timestamp-prev.timestamp>300000);
            const mine=m.fromId===myId;
            return<div key={i}>
              {newDay&&<div className="chat-daysep"><span>{dayLabel(m.timestamp)}</span></div>}
              <div className={`chat-row ${mine?"mine":"other"}${grpStart?" grp":""}`}>
                {!mine&&<div className="av chat-av" style={{width:30,height:30,fontSize:15,background:bg,visibility:grpStart?"visible":"hidden"}}>{m.emoji||"?"}</div>}
                <div className="chat-bubble-wrap">
                  {grpStart&&<div className="chat-sender">{mine?"You":m.from} · {new Date(m.timestamp).toLocaleTimeString(undefined,{hour12:!t24,hour:"2-digit",minute:"2-digit"})}{m.edited&&<span className="chat-edited">edited</span>}</div>}
                  {editKey===m._key?<div className="chat-edit-row"><input autoFocus value={editTxt} onChange={e=>setEditTxt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();saveEdit()}else if(e.key==="Escape"){cancelEdit()}}} className="ni chat-edit-input"/><button onClick={saveEdit} className="chat-action-btn" style={{color:"#4ade80",fontSize:14}}>✓</button><button onClick={cancelEdit} className="chat-action-btn" style={{color:"#f87171",fontSize:14}}>✕</button></div>:<>
                    <div className="chat-b" style={{background:mine?cfg.primaryColor:"#2a3045",color:mine?"#fff":"var(--lh-text4)"}}>{m.text}</div>
                    {(mine||isAdmin)&&m._key&&<div className="chat-actions">{mine&&<button onClick={()=>startEdit(m)} className="chat-action-btn" aria-label="Edit">✎</button>}<button onClick={()=>delMsg(m)} className="chat-action-btn del" aria-label="Delete">🗑</button></div>}
                  </>}
                </div>
              </div>
            </div>
          })}
          <div ref={ce}/>
        </div>
        <div className="chat-input-row">
          <input ref={inputRef} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send()}}} placeholder={`Message ${toUser.name}…`} className="ni chat-input"/>
          <button onClick={send} disabled={!txt.trim()} className="chat-send" style={{background:txt.trim()?cfg.primaryColor:"#3a3f54",color:"#fff",opacity:txt.trim()?1:.6}} aria-label="Send">➤</button>
        </div>
      </main>
    </div>
  </div>;
}

/* Header */
function Head({cfg,user,admin,onOut,onProf,onChat,onHelp,unread,esp}){const[menu,setMenu]=useState(false);
/* Non-admin users navigate via the bottom tab bar (Profile tab already has
   profile/help/logout) — so the header stays to just identity + connection
   status. Admin has no tab bar yet, so it keeps its chat/menu entry points. */
return<div style={{padding:"10px 14px",position:"relative"}}><div className="sb">
<div className="row"><div className="av" style={{width:36,height:36,fontSize:18,background:bg}}>{admin?"🛡️":(cfg.appEmoji||"🫧")}</div><div><div style={{fontWeight:900,fontSize:15,color:"var(--lh-text)"}}>{admin?"Admin":cfg.appName}</div><div style={{fontSize:9,color:"var(--lh-text3)"}}>{admin?"Control panel":"Hi, "+user.name}</div></div></div>
{!admin&&<UserEspDot esp={esp}/>}
{admin&&<div className="row" style={{gap:5}}>
{cfg.chatEnabled!==false&&<button onClick={onChat} className="nb" style={{padding:"8px 14px",fontSize:12,fontWeight:700,position:"relative"}}>Chat{unread>0&&<span style={{position:"absolute",top:-5,right:-5,minWidth:18,height:18,padding:"0 5px",borderRadius:9,background:"#f87171",fontSize:9,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800}}>{unread>9?"9+":unread}</span>}</button>}
<button onClick={()=>setMenu(!menu)} className="nb" style={{padding:"8px 13px",fontSize:17,lineHeight:1}}>☰</button>
</div>}
</div>
{admin&&menu&&<div className="nm" style={{position:"absolute",right:14,top:52,zIndex:100,padding:6,minWidth:170,animation:"fu .15s ease"}}>
<button onClick={async()=>{if(!(await askConfirm("Reload the app and clear cached files? Your session stays signed in.")))return;clearCacheAndReload()}} className="nb" style={{width:"100%",textAlign:"left",marginBottom:4,fontSize:12}}>Reload (clear cache)</button>
<button onClick={()=>{onOut();setMenu(false)}} className="nb" style={{width:"100%",textAlign:"left",fontSize:12,color:"#f87171"}}>Sign Out</button>
</div>}
</div>;}

/* Cleaning roster card — shown to the 5 participants on their user dashboard.
   Computes this week's assignment from baseMonday rotation, lets the user
   mark themselves done, and shows everyone's status. */
function CleaningCard({cfg,user,users,roster,completions,toast,compact}){
  const tasks=roster?.tasks||[];const pids=roster?.participantIds||[];
  if(!roster?.enabled||pids.length===0||tasks.length===0)return null;
  /* Bail out if the user isn't one of the 5 chosen participants. */
  if(!pids.includes(user.id))return null;
  const now=Date.now();const mon=weekMonday(now);const sunEnd=weekSundayEnd(now);
  /* isLastDay = today is Sunday (the deadline day), checked by calendar day not
     fractional time remaining — Math.ceil(msLeft/86400000) only reaches 0 in the
     last instant before midnight, so it was never actually true for the rest of
     the day it's meant to flag. */
  const isLastDay=now>=mon+6*86400000;
  const wk=weekIndex(mon,roster.baseMonday||mon);
  const total=Math.min(tasks.length,pids.length);
  const mySlot=pids.indexOf(user.id);
  const myTaskIdx=assignedTaskIdx(mySlot,wk,total);
  const myTask=tasks[myTaskIdx]||`Task ${myTaskIdx+1}`;
  const weekComp=completions?.[mon]||{};
  const myDone=!!weekComp[user.id];
  const msLeft=Math.max(0,sunEnd-now);
  const daysLeft=Math.ceil(msLeft/86400000);
  const c=cfg.primaryColor;
  /* Visibility settings (set by admin) — two independent controls:
     1. cleaningTaskVisibility — who sees task assignments
        - "everyone": full roster visible
        - "self":     roster hidden, only user's own task shown
     2. cleaningDoneVisibility — who sees the ✓ done state
        - "everyone": all see all
        - "self":     each user sees only their own ✓
        - "admin":    users see no ✓ marks; only admin tab shows them */
  const vis=cfg.cleaningDoneVisibility||"everyone";
  const taskVis=cfg.cleaningTaskVisibility||"everyone";
  const showOwnDone=vis!=="admin";
  const showRoster=taskVis==="everyone";
  const togDone=async()=>{try{await DB.markCleaningDone(mon,user.id,!myDone);toast(myDone?"Marked undone":"Marked done — thanks!",myDone?"info":"success")}catch{toast("Could not save","error")}};
  return<div className="nm" style={{padding:18,marginBottom:14}}>
    <div className="sb" style={{marginBottom:12,alignItems:"baseline"}}>
      <div className="sec" style={{marginBottom:0}}>Cleaning week</div>
      <div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:600}}>{fmtDateShort(mon)} → {fmtDateShort(weekSundayEnd(now)-1)}</div>
    </div>
    {/* Hero: your task. In "admin"-visibility mode the done state isn't shown to the user
        but the Mark button still works (admin can see status on their tab). */}
    <div className="nm-in" style={{padding:"14px 16px",marginBottom:12,border:`1px solid ${myDone&&showOwnDone?"#4ade8033":c+"33"}`,background:myDone&&showOwnDone?"#4ade8011":undefined}}>
      <div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1}}>YOUR TASK THIS WEEK</div>
      <div style={{fontSize:22,fontWeight:900,color:myDone&&showOwnDone?"#4ade80":(isLastDay?"#f87171":"var(--lh-text)"),marginTop:4,letterSpacing:-.3,textDecoration:myDone&&showOwnDone?"line-through":"none",textDecorationColor:"#4ade8088",textDecorationThickness:2}}>{myTask}</div>
      <div style={{fontSize:10,color:isLastDay&&!(myDone&&showOwnDone)?"#f87171":"var(--lh-text2)",marginTop:5,fontWeight:isLastDay&&!(myDone&&showOwnDone)?700:400}}>{!showOwnDone?(!isLastDay?`${daysLeft} day${daysLeft===1?"":"s"} left · due Sunday midnight`:"Due TODAY by midnight!"):(myDone?"✓ Done — well played":(!isLastDay?`${daysLeft} day${daysLeft===1?"":"s"} left · due Sunday midnight`:"Due TODAY by midnight!"))}</div>
      <button onClick={togDone} className="nb" style={{marginTop:10,width:"100%",padding:"10px 0",fontSize:12,fontWeight:800,color:myDone&&showOwnDone?"var(--lh-text2)":"#4ade80",border:`1px solid ${myDone&&showOwnDone?"#8890a444":"#4ade8055"}`}}>{showOwnDone?(myDone?"↩ Mark as not done":"✓ Mark as done"):"✓ Mark as done"}</button>
    </div>
    {/* Roster — everyone's task this week. Skipped entirely on the compact (Home tab)
        variant, and hidden when task visibility is "self". */}
    {!compact&&showRoster&&<>
    <div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1,marginBottom:6}}>EVERYONE THIS WEEK</div>
    {pids.slice(0,total).map((pid,slot)=>{const u=users.find(x=>x.id===pid);const tIdx=assignedTaskIdx(slot,wk,total);const t=tasks[tIdx]||`Task ${tIdx+1}`;const done=!!weekComp[pid];const isMe=pid===user.id;
    const showThisDone=vis==="everyone"||(vis==="self"&&isMe);
    return<div key={pid||slot} className="sb" style={{padding:"7px 2px",borderTop:slot>0?`1px solid ${ls}`:"none"}}>
      <div className="row" style={{gap:8,flex:1,minWidth:0}}>
        <span style={{fontSize:14}}>{u?.emoji||"😊"}</span>
        <div style={{minWidth:0}}>
          <div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{u?.name||"(removed user)"}{isMe&&<span style={{color:c,fontSize:9,marginLeft:4}}>you</span>}</div>
          <div style={{fontSize:10,color:done&&showThisDone?"#4ade80":"var(--lh-text2)",textDecoration:done&&showThisDone?"line-through":"none"}}>{t}</div>
        </div>
      </div>
      {showThisDone?<div className="np" style={{fontSize:9,color:done?"#4ade80":"var(--lh-text3)",background:bg}}>{done?"✓":"…"}</div>:<div style={{fontSize:9,color:"var(--lh-text3)",opacity:.4}}>—</div>}
    </div>})}
    </>}
  </div>;
}

/* Help / tutorial modal — short visual guide built into the app */
function HelpModal({cfg,onClose}){
const c=cfg.primaryColor;
const Row=({t,d})=><div style={{paddingBottom:12,marginBottom:12,borderBottom:`1px solid ${ls}`}}><div style={{fontWeight:700,fontSize:13,color:"var(--lh-text)",marginBottom:3}}>{t}</div><div style={{fontSize:12,color:"var(--lh-text2)",lineHeight:1.5}}>{d}</div></div>;
return<div>
<div style={{textAlign:"center",marginBottom:18}}>
  <div className="av" style={{width:54,height:54,fontSize:26,margin:"0 auto 8px",background:bg}}>{cfg.appEmoji||"🫧"}</div>
  <div style={{fontWeight:800,fontSize:17,color:"var(--lh-text)"}}>How it works</div>
</div>

<Row t="Home" d="The circle shows Available, Offline, In use, or Wash done. Start a wash from here when free."/>
<Row t="Schedule" d="Reserve a time slot so no one else can start a wash then."/>
<Row t="Activity" d="Your wash history, water and energy use, and the cleaning roster."/>
<Row t="Chat" d="Message housemates one-to-one or everyone at once."/>
<Row t="Profile" d="Your name, PIN, and Do Not Disturb."/>

<div style={{padding:14,marginBottom:8,borderRadius:12,background:bg,border:"1px solid rgba(255,255,255,.08)"}}>
<div style={{fontSize:11,color:"var(--lh-text2)",lineHeight:1.6}}>
<div style={{marginBottom:8}}><b style={{color:"var(--lh-text4)"}}>Says offline but it's plugged in?</b><br/>Wi-Fi hiccup — recovers within 5 min.</div>
<div style={{marginBottom:8}}><b style={{color:"var(--lh-text4)"}}>Forgot your PIN?</b><br/>Ask your admin to reset it.</div>
<div><b style={{color:"var(--lh-text4)"}}>Install as an app?</b><br/>Browser menu → Add to Home Screen.</div>
</div>
</div>

<button onClick={onClose} className="nb nb-p" style={{width:"100%",marginTop:6,padding:"12px 0",fontSize:14,fontWeight:700,background:c}}>Got it</button>
</div>;}

/* Login */
function Login({onLogin,cfg}){const[m,setM]=useState("user");const[u,setU]=useState("");const[pw,setPw]=useState("");const[err,setErr]=useState("");const[ld,setLd]=useState(false);const go=async()=>{setErr("");setLd(true);try{if(m==="admin"){if(pw===(cfg.adminPassword||ADMIN_PW)){onLogin({role:"admin",name:"Admin",emoji:"🛡️"});return}else setErr("Wrong password")}else{const all=await DB.getUsers();const f=all.find(x=>x.name.toLowerCase()===u.trim().toLowerCase()&&x.pin===pw);if(!f)setErr("Invalid name or PIN");else if(f.disabled)setErr("Account disabled");else{onLogin({role:"user",...f});return}}}catch{setErr("Connection error")}setLd(false)};return<div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:bg,padding:16}}><div style={{width:"100%",maxWidth:350,animation:"fu .5s ease"}}><div style={{textAlign:"center",marginBottom:28}}><div className="av" style={{width:72,height:72,fontSize:32,margin:"0 auto 12px",background:bg}}>{cfg.appEmoji||"🫧"}</div><h1 style={{fontSize:26,fontWeight:900,color:"var(--lh-text)"}}>{cfg.appName}</h1><p style={{color:"var(--lh-text3)",fontSize:12}}>{cfg.tagline||"Smart laundry control"}</p></div><div className="nm" style={{padding:24}}><div className="g2" style={{marginBottom:16}}>{["user","admin"].map(x=><button key={x} onClick={()=>{setM(x);setErr("")}} className={m===x?"nb nb-p":"nb"} style={m===x?{background:cfg.primaryColor}:{}}>{x==="admin"?"Admin":"User"}</button>)}</div>{m==="user"&&<input value={u} onChange={e=>setU(e.target.value)} placeholder="Your name" autoFocus autoCapitalize="words" className="ni" style={{marginBottom:8}}/>}<input value={pw} onChange={e=>setPw(e.target.value)} type="password" inputMode={m==="admin"?"text":"numeric"} autoFocus={m==="admin"} placeholder={m==="admin"?"Admin password":"PIN"} onKeyDown={e=>e.key==="Enter"&&go()} className="ni" style={{marginBottom:6}}/>{err&&<p style={{color:"#f87171",fontSize:11,fontWeight:600,marginTop:4}}>{err}</p>}<button onClick={go} disabled={ld} className="nb nb-p" style={{width:"100%",marginTop:10,padding:"12px 0",fontSize:15,fontWeight:800,background:ld?"var(--lh-text3)":cfg.primaryColor,letterSpacing:.4}}>{ld?"...":"Sign In"}</button>{m==="user"&&<p style={{color:"var(--lh-text3)",fontSize:10,textAlign:"center",marginTop:10}}>Forgot your PIN? Ask your admin to reset it.</p>}</div></div></div>;}

/* ═══ USER ═══ */
/* Bottom tab bar — one persistent destination per real feature, not a profile-only afterthought. */
function NavIcon({name,size=22}){
  const p={fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round",strokeLinejoin:"round"};
  const paths={
    home:<g {...p}><path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9"/></g>,
    calendar:<g {...p}><rect x="4" y="5.5" width="16" height="15" rx="3"/><path d="M4 10h16M8 3.5v3M16 3.5v3"/></g>,
    activity:<g {...p}><path d="M5 7h14M5 12h14M5 17h9"/></g>,
    chat:<path d="M4 5.5h16v11H8.5L4 20.5V5.5z" {...p}/>,
    profile:<g {...p}><circle cx="12" cy="8.3" r="3.3"/><path d="M5 20c1.1-4.2 3.9-6.3 7-6.3s5.9 2.1 7 6.3"/></g>,
  };
  return<svg width={size} height={size} viewBox="0 0 24 24">{paths[name]}</svg>;
}
/* Shared with the swipe-to-change-tab gesture in UserDash so both stay in the same order. */
const TAB_ORDER=["home","schedule","activity","chat","profile"];
const TAB_META={home:{l:"Home",i:"home"},schedule:{l:"Schedule",i:"calendar"},activity:{l:"Activity",i:"activity"},chat:{l:"Chat",i:"chat"},profile:{l:"Profile",i:"profile"}};
function BottomNav({view,setView,unread,c}){
  const tabs=TAB_ORDER.map(k=>({k,...TAB_META[k],badge:k==="chat"?unread:undefined}));
  return<div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:40,background:"var(--lh-nav)",borderTop:`1px solid ${ls}`,display:"flex",paddingBottom:"env(safe-area-inset-bottom)"}}>
    {tabs.map(t=><button key={t.k} onClick={()=>setView(t.k)} style={{flex:1,background:"transparent",border:"none",padding:"9px 0 8px",display:"flex",flexDirection:"column",alignItems:"center",gap:3,cursor:"pointer",color:view===t.k?c:"var(--lh-text3)",position:"relative"}}>
      <NavIcon name={t.i}/>
      {t.badge>0&&<span style={{position:"absolute",top:4,right:"28%",background:"#f87171",color:"#fff",fontSize:9,fontWeight:800,minWidth:15,height:15,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{t.badge>9?"9+":t.badge}</span>}
      <span style={{fontSize:10,fontWeight:600}}>{t.l}</span>
    </button>)}
  </div>;
}
function UserDash({user:init,cfg,onOut,toast}){
const[user,sU]=useState(init);const[mac,sM]=useState({running:false});const[sch,sSch]=useState([]);const[users,sUs]=useState([]);const[esp,sE]=useState(null);const[sd,sSd]=useState("");const[st,sSt]=useState("");const[se,sSe]=useState("");const[now,sN]=useState(Date.now());const[view,sView]=useState("home");const[showHelp,sShowHelp]=useState(false);const[editSch,sES]=useState(null);const[chatTo,sChatTo]=useState("all");const[msgs,sMs]=useState([]);const[hist,sH]=useState([]);const[hs,sHs]=useState(null);const[roster,sRoster]=useState(null);const[completions,sComp]=useState({});const af=useRef(false);const prev=useRef(false);const warned=useRef(false);const touchStart=useRef(null);const dragging=useRef(false);const contentRef=useRef(null);const[slideDir,sSlideDir]=useState(null);
/* Swipe left/right anywhere in the content area to move between tabs, in the same
   order as the bottom nav. The pane tracks the finger live during the drag (direct
   style writes on contentRef, not React state, so it stays smooth at 60fps), then
   either finishes the slide into the next tab or snaps back — a real drag, not an
   instant cut. Ignored while a modal is open or the drag was mostly vertical (a
   scroll, not a swipe). */
const onTouchStart=e=>{const t=e.touches[0];touchStart.current={x:t.clientX,y:t.clientY};dragging.current=false};
const onTouchMove=e=>{
  if(!touchStart.current||showHelp||editSch)return;
  const t=e.touches[0];
  const dx=t.clientX-touchStart.current.x,dy=t.clientY-touchStart.current.y;
  if(!dragging.current){
    if(Math.abs(dx)<10||Math.abs(dx)<Math.abs(dy))return;
    dragging.current=true;
  }
  if(contentRef.current)contentRef.current.style.transform=`translateX(${dx}px)`;
};
const onTouchEnd=e=>{
  const el=contentRef.current;
  const wasDragging=dragging.current;
  if(!touchStart.current||showHelp||editSch||!wasDragging){touchStart.current=null;dragging.current=false;return;}
  const t=e.changedTouches[0];
  const dx=t.clientX-touchStart.current.x,dy=t.clientY-touchStart.current.y;
  touchStart.current=null;dragging.current=false;
  const idx=TAB_ORDER.indexOf(view);
  const goingNext=dx<0;
  const canMove=idx>=0&&(goingNext?idx<TAB_ORDER.length-1:idx>0)&&Math.abs(dx)>=60&&Math.abs(dx)>=Math.abs(dy)*1.3;
  if(!el)return;
  if(!canMove){
    el.style.transition="transform .2s cubic-bezier(.2,.8,.2,1)";el.style.transform="translateX(0)";
    setTimeout(()=>{if(el)el.style.transition=""},200);
    return;
  }
  const w=el.offsetWidth||375;
  el.style.transition="transform .16s cubic-bezier(.2,.8,.2,1)";el.style.transform=`translateX(${goingNext?-w:w}px)`;
  setTimeout(()=>{
    sSlideDir(goingNext?"next":"prev");
    sView(TAB_ORDER[idx+(goingNext?1:-1)]);
  },160);
};
/* Tapping a bottom-nav tab gets the same directional cue as a swipe, just much
   smaller — a slight shift + fade instead of a full-width throw, since a tap
   isn't a drag and shouldn't pretend to be one. */
const goToTab=target=>{
  if(target===view)return;
  const curIdx=TAB_ORDER.indexOf(view),nextIdx=TAB_ORDER.indexOf(target);
  sSlideDir(nextIdx>curIdx?"next-soft":"prev-soft");
  sView(target);
};
useEffect(()=>{try{if(!localStorage.getItem("lh_help_seen")){sShowHelp(true);localStorage.setItem("lh_help_seen","1")}}catch{}},[]);

useEffect(()=>{const a=DB.onMachineChange(sM);const b=DB.onScheduleChange(sSch);const c=DB.onUsersChange(sUs);const d=DB.onEsp32Status(sE);const e=DB.onChatMessages(sMs);const f=DB.onHistoryChange(sH);const g=DB.onHisense(sHs);const h=DB.onCleaning(sRoster);const i=DB.onCleaningCompletions(sComp);const iv=setInterval(()=>sN(Date.now()),1000);return()=>{a();b();c();d();e();f();g();h();i();clearInterval(iv)}},[]);
useEffect(()=>{if(typeof window!=="undefined"&&"Notification" in window&&Notification.permission==="default"){Notification.requestPermission().catch(()=>{})}},[]);
useEffect(()=>{if(prev.current&&!mac?.running&&!user.dnd){toast("Machine is free!","info");if(cfg.soundOnFinish!==false)playBeep("done");sendPush(`${cfg.appName||"LaundryHub"} — Machine free`,"The washing machine just finished.")}prev.current=mac?.running||false},[mac?.running,user.dnd,toast,cfg.soundOnFinish,cfg.appName]);
useEffect(()=>{if(!mac?.running||mac.userId!==user.id){warned.current=false;return}
// SANITY: refuse to auto-stop a wash that just started or has bogus duration.
// Prevents a stale cache / clock-skew / 0-min duration bug from clicking the
// relay off seconds after Turn ON.
const dur=Number(mac.durationMs)||0;const start=Number(mac.startTime)||0;
if(dur<60000||start<=0){return}
const end=start+dur;const age=now-start;
if(now>=end-(cfg.alertMinutesBefore||5)*60000&&now<end&&!af.current){af.current=true;toast(`${cfg.alertMinutesBefore||5}m left!`,"warning");if(cfg.soundOnFinish!==false)playBeep("warn");if(!warned.current){warned.current=true;sendPush(`${cfg.appName||"LaundryHub"} — ${cfg.alertMinutesBefore||5}m left`,"Your wash is almost done.")}}
// Wash has truly ended (and was at least 60s old) — record + stop.
if(now>=end&&age>=60000){console.log("[auto-stop] firing",{age,dur,end,now});DB.setMachine({running:false,lastUser:mac.userName,lastCycle:mac.cycleName,finishedAt:Date.now()});try{DB.addWashRecord({id:Date.now().toString(),userId:mac.userId,userName:mac.userName,cycleName:mac.cycleName,startTime:mac.startTime,finishedAt:Date.now(),durationMs:mac.durationMs})}catch{}toast("Wash complete!","success");sendPush(`${cfg.appName||"LaundryHub"} — Wash complete!`,"Your laundry is ready.");af.current=false}},[now,mac,user.id,cfg,toast]);

const on=isOn(esp);const my=mac?.running&&mac.userId===user.id;const busy=mac?.running&&mac.userId!==user.id;
const hsFresh=hs&&hs.updatedAt&&(Date.now()-hs.updatedAt<45000);const useHs=hsFresh&&(hs.running||hs.paused)&&typeof hs.remainingMin==="number";
const hsSaysDone=hsFresh&&!hs.running&&!hs.paused;
/* Manual override detection — when ConnectLife is stale OR the wash has overrun
   its declared duration by a wide margin. Users get access to a "Mark as free"
   action only when one of these is true, so the button doesn't tempt people to
   force-stop healthy washes. */
const hsAgeSec=hs&&hs.updatedAt?Math.round((Date.now()-hs.updatedAt)/1000):null;
const hsStale=hs===null||(hsAgeSec!==null&&hsAgeSec>120);
const washOverrun=mac?.running&&mac?.startTime&&mac?.durationMs&&(Date.now()-Number(mac.startTime))>(Number(mac.durationMs)*1.5);
const manualOverrideAvailable=mac?.running&&(hsStale||washOverrun);
const graceLeft=hs&&hs.graceUntil?Math.max(0,hs.graceUntil-now):0;const inGrace=graceLeft>0;const graceM=Math.floor(graceLeft/60000);const graceS=Math.floor((graceLeft%60000)/1000);
const effRunning=!hsSaysDone&&(mac?.running||useHs);
const prog=mac?.running?Math.min(1,(now-mac.startTime)/mac.durationMs):0;
const rm=useHs?hs.remainingMin*60000:(mac?.running?Math.max(0,(mac.startTime+mac.durationMs)-now):0);
const rmM=Math.floor(rm/60000);const rmS=useHs?0:Math.floor((rm%60000)/1000);
const bu=users.find(x=>x.id===mac?.userId);
// Simple ON/OFF
const unread=msgs.filter(m=>(m.to==="all"||m.to===user.id)&&m.fromId!==user.id&&m.timestamp>(user.lastRead||0)).length;
const blocked=isScheduleBlocked(sch,user.id);
const go=async(minutes,label)=>{if(mac?.running)return;if(!on)return toast("Machine offline!","error");if(blocked)return toast(`Reserved by ${blocked.userName}`,"error");await DB.setMachine({running:true,userId:user.id,userName:user.name,cycleName:label,startTime:Date.now(),durationMs:minutes*60000});af.current=false;toast(`Machine ON — ${minutes}m`,"success")};
const start=()=>go(cfg.defaultWashMinutes||90,"Wash");
const stop=async()=>{if(!my)return;await DB.setMachine({running:false,lastUser:user.name,lastCycle:mac.cycleName,finishedAt:Date.now()});toast("Stopped","info")};
const ext=async m=>{if(!my)return;await DB.setMachine({...mac,durationMs:mac.durationMs+m*60000});toast(`+${m}m`,"success")};
const addS=async()=>{if(!sd||!st||!se)return toast("Pick date, start & end time","error");const startMs=new Date(`${sd}T${st}`).getTime();const endMs=new Date(`${sd}T${se}`).getTime();if(endMs<=startMs)return toast("End time must be after start","error");const durMin=Math.round((endMs-startMs)/60000);if(durMin<5)return toast("Minimum 5 minutes","error");if(durMin>240)return toast("Maximum 4 hours","error");await DB.addScheduleEntry({id:Date.now().toString(),userId:user.id,userName:user.name,userEmoji:user.emoji||"😊",cycleName:"Scheduled",minutes:durMin,dateTime:`${sd}T${st}`,startTime:st,endTime:se});sSd("");sSt("");sSe("");toast(`Scheduled ${st} → ${se} (${durMin}m)`,"success")};
const fmt=d=>{const x=new Date(d);return x.toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})+" "+x.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"})};
const openChat=(toId)=>{sChatTo(toId||"all");sView("chat");DB.updateUser(user.id,{lastRead:Date.now()})};

return<div className="lh-scale" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} style={{minHeight:"100vh",background:bg,paddingBottom:80}}>
<Head cfg={cfg} user={user} onOut={onOut} onProf={()=>sView("profile")} onHelp={()=>sShowHelp(true)} onChat={()=>openChat("all")} unread={unread} esp={esp}/>
{cfg.maintenance&&<MntBanner/>}

{showHelp&&<Modal onClose={()=>sShowHelp(false)}><HelpModal cfg={cfg} onClose={()=>sShowHelp(false)}/></Modal>}
{editSch&&<Modal onClose={()=>sES(null)}><SchedEdit e={editSch} cfg={cfg} onClose={()=>sES(null)} toast={toast}/></Modal>}

<div ref={contentRef} key={view} className={slideDir?`tab-slide-${slideDir}`:""} onAnimationEnd={()=>sSlideDir(null)}>
{view==="chat"?(cfg.chatEnabled!==false?<ChatMod user={user} cfg={cfg} users={users} onClose={()=>sView("home")} initTo={chatTo}/>:<div className="nm" style={{margin:"0 12px 14px",padding:22,textAlign:"center",color:"var(--lh-text2)"}}>Chat is turned off.</div>):
<div style={{maxWidth:580,margin:"0 auto",padding:"0 12px 14px"}}>
{(()=>{
const sections={};

/* Ready to wash — only renders when machine is idle */
sections.ready=!(mac?.running||useHs)?<div className="nm" style={{marginBottom:16,padding:22,opacity:on&&!blocked?1:.5,transition:"opacity .2s"}}>
<div className="sec">Ready to wash</div>
<button onClick={start} className="nb nb-p" style={{width:"100%",padding:"16px 0",fontSize:16,fontWeight:800,background:on&&!blocked?cfg.primaryColor:"var(--lh-text3)",borderRadius:14,letterSpacing:.3}}>{!on?"Machine offline":blocked?`Reserved by ${blocked.userName}`:(()=>{const m=cfg.defaultWashMinutes||90;const h=Math.floor(m/60);const mm=m%60;return`Start wash — ${h>0?h+"h ":""}${mm>0?mm+"m":""}`.trim()})()}</button>
</div>:null;

/* Schedule = booking form + Reservations list. Kept together as one logical section. */
sections.schedule=(()=>{const visibleSch=sch.filter(s=>!isSchedulePast(s)||s.userId===user.id);const myPastCount=visibleSch.filter(s=>isSchedulePast(s)&&s.userId===user.id).length;return<><div className="nm" style={{marginBottom:16,padding:22}}><div className="sec">Schedule a slot</div>
<div style={{marginBottom:8}}><input type="date" aria-label="Date" value={sd} onChange={e=>sSd(e.target.value)} className="ni" style={{fontSize:15}}/></div>
<div style={{display:"flex",gap:8,marginBottom:10}}><input type="time" aria-label="Start time" value={st} onChange={e=>sSt(e.target.value)} className="ni" style={{fontSize:15,flex:1}}/><input type="time" aria-label="End time" value={se} onChange={e=>sSe(e.target.value)} className="ni" style={{fontSize:15,flex:1}}/></div>
{sd&&st&&se&&(()=>{const startMs=new Date(`${sd}T${st}`).getTime();const endMs=new Date(`${sd}T${se}`).getTime();const dur=endMs>startMs?Math.round((endMs-startMs)/60000):0;return<div className="nm-in" style={{padding:"8px 12px",marginBottom:8}}><div className="sb"><div><div className="M" style={{fontSize:13,color:"var(--lh-text)"}}>{st} → {se}</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{new Date(sd).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</div></div><div style={{textAlign:"right"}}><div style={{fontSize:16,fontWeight:800,color:dur>0?cfg.primaryColor:"#f87171"}}>{dur>0?`${dur}m`:"Invalid"}</div><div style={{fontSize:9,color:"var(--lh-text3)"}}>{dur>0?`${Math.floor(dur/60)}h ${dur%60}m`:"End must be after start"}</div></div></div></div>})()}
<button onClick={addS} className="nb nb-p" style={{width:"100%",background:cfg.accentColor,color:"#1e2233",fontWeight:800}}>Reserve slot</button></div>
{visibleSch.length>0&&<div className="nm" style={{marginBottom:16,padding:22}}><div className="sec">Reservations <span style={{fontSize:11,color:"var(--lh-text2)",fontWeight:700,marginLeft:"auto"}}>{visibleSch.length}</span></div>{visibleSch.map(s=>{const past=isSchedulePast(s);const endT=s.endTime||(()=>{const[h,m]=(s.startTime||s.dateTime?.split("T")[1]||"00:00").split(":").map(Number);const e=new Date(2000,0,1,h,m+(s.minutes||45));return e.toTimeString().slice(0,5)})();return<div key={s.id} className="sb" style={{padding:"10px 0",borderBottom:`1px solid ${ls}`,opacity:past?.55:1}}><div className="row"><span style={{fontSize:13}}>{s.userEmoji||"😊"}</span><div><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{s.userName}{s.userId===user.id&&<span style={{color:cfg.primaryColor,fontSize:9}}> you</span>}{past&&<span style={{color:"var(--lh-text2)",fontSize:9,marginLeft:4,fontWeight:600}}>· past</span>}</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{s.cycleName} · {new Date(s.dateTime).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</div><div className="M" style={{fontSize:11,color:"var(--lh-text2)"}}>{s.startTime||s.dateTime?.split("T")[1]||"?"} → {endT}</div></div></div>{s.userId===user.id&&<button onClick={()=>sES(s)} className="nb" aria-label="Open reservation" style={{fontSize:16,padding:"3px 12px",color:"var(--lh-text2)",lineHeight:1,fontWeight:800}}>⋮</button>}</div>})}</div>}</>})();

sections.cleaning=<CleaningCard cfg={cfg} user={user} users={users} roster={roster} completions={completions} toast={toast}/>;
const cleaningCompact=<CleaningCard cfg={cfg} user={user} users={users} roster={roster} completions={completions} toast={toast} compact/>;

sections.washes=(()=>{const mine=hist.filter(h=>h.userId===user.id);if(!mine.length)return null;const monthStart=new Date();monthStart.setDate(1);monthStart.setHours(0,0,0,0);const thisMonth=mine.filter(h=>h.finishedAt>=monthStart.getTime()).length;const totalMin=mine.reduce((a,h)=>a+Math.round(h.durationMs/60000),0);const totalWater=mine.reduce((a,h)=>a+(h.waterLiters||0),0);const totalEnergy=mine.reduce((a,h)=>a+(h.energyKwh||0),0);return<div className="nm" style={{marginBottom:16,padding:22}}><div className="sec">My washes</div><div className="g3" style={{marginBottom:(totalWater||totalEnergy)?8:12,gap:8}}><div className="nm-in" style={{padding:"13px 8px",textAlign:"center"}}><div style={{fontSize:12,color:"var(--lh-text3)",marginBottom:4,fontWeight:700}}>Total</div><div style={{fontSize:22,fontWeight:900,color:"var(--lh-text)"}}>{mine.length}</div></div><div className="nm-in" style={{padding:"13px 8px",textAlign:"center"}}><div style={{fontSize:12,color:"var(--lh-text3)",marginBottom:4,fontWeight:700}}>Month</div><div style={{fontSize:22,fontWeight:900,color:cfg.primaryColor}}>{thisMonth}</div></div><div className="nm-in" style={{padding:"13px 8px",textAlign:"center"}}><div style={{fontSize:12,color:"var(--lh-text3)",marginBottom:4,fontWeight:700}}>Time</div><div style={{fontSize:22,fontWeight:900,color:"var(--lh-text)"}}>{Math.floor(totalMin/60)}h</div></div></div>{(totalWater||totalEnergy)?<div className="g2" style={{marginBottom:12,gap:8}}><div className="nm-in" style={{padding:"13px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"var(--lh-text3)",marginBottom:4,fontWeight:700}}>Water</div><div style={{fontSize:19,fontWeight:900,color:"#60a5fa"}}>{totalWater.toFixed(0)} <span style={{fontSize:12,color:"var(--lh-text3)",fontWeight:600}}>L</span></div></div><div className="nm-in" style={{padding:"13px 10px",textAlign:"center"}}><div style={{fontSize:12,color:"var(--lh-text3)",marginBottom:4,fontWeight:700}}>Energy</div><div style={{fontSize:19,fontWeight:900,color:"#fbbf24"}}>{totalEnergy.toFixed(2)} <span style={{fontSize:12,color:"var(--lh-text3)",fontWeight:600}}>kWh</span></div></div></div>:null}{mine.slice(0,5).map(h=><div key={h.id} className="sb" style={{padding:"11px 0",borderTop:`1px solid ${ls}`}}><div style={{flex:1,minWidth:0}}><div style={{fontSize:14,fontWeight:700,color:"var(--lh-text)"}}>{h.cycleName}</div><div style={{fontSize:12,color:"var(--lh-text3)",marginTop:3}}>{fmtDT(h.finishedAt,cfg.time24!==false)}{(h.waterLiters||h.energyKwh)&&` · ${h.waterLiters?h.waterLiters.toFixed(1)+"L":""}${h.waterLiters&&h.energyKwh?" · ":""}${h.energyKwh?h.energyKwh.toFixed(2)+"kWh":""}`}</div></div><span className="M" style={{fontSize:13,color:"var(--lh-text2)",whiteSpace:"nowrap",fontWeight:700}}>{Math.round(h.durationMs/60000)}m</span></div>)}</div>})();

sections.housemates=<div className="nm" style={{padding:22,marginBottom:16}}><div className="sec">Housemates</div>
{/* If a wash is running but we can't attribute it to any user (started directly on the
    machine), show a banner so housemates know SOMEONE/something is washing. */}
{(()=>{const realRunning=mac?.running&&!hsSaysDone;const attributable=realRunning&&users.some(x=>!x.disabled&&(mac?.userId===x.id||mac?.userName===x.name||mac?.lastUser===x.name||mac?.lastUserId===x.id));if(realRunning&&!attributable)return<div className="nm-in" style={{padding:"12px 14px",marginBottom:10,border:`1px solid ${cfg.primaryColor}33`}}><div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{width:8,height:8,borderRadius:"50%",background:cfg.primaryColor,display:"inline-block",animation:"pu 1.4s ease-in-out infinite"}}/><div style={{flex:1}}><div style={{fontSize:12,fontWeight:800,color:cfg.primaryColor}}>Machine in use</div><div style={{fontSize:10,color:"var(--lh-text2)"}}>Started directly on the machine{useHs&&typeof hs.remainingMin==="number"?` · ${hs.remainingMin}m left`:""}</div></div></div><button onClick={async()=>{if(!(await askConfirm(`Claim this wash? Your name (${user.name}) will be attached to it.`)))return;try{await DB.setMachine({...mac,userId:user.id,userName:user.name,emoji:user.emoji||"😊",claimedAt:Date.now()});toast("Wash claimed — it's yours now","success")}catch{toast("Failed to claim","error")}}} className="nb nb-p" style={{width:"100%",padding:"10px 0",fontSize:12,fontWeight:800,background:cfg.primaryColor,letterSpacing:.3}}>It's my wash — claim it</button></div>})()}
<div className="g2" style={{gap:8}}>{users.filter(x=>!x.disabled&&x.id!==user.id).map(u=>{
/* A user is "washing" if mac matches their id OR name, even after poller
   mirrored userId to "machine" (common when app's auto-stop+mirror happens).
   If Hisense says wash has ended (hsSaysDone), show "Done" instead of "Washing". */
const macMine=mac?.userId===u.id||mac?.userName===u.name||(mac?.userId==="machine"&&(mac?.lastUser===u.name||mac?.lastUserId===u.id));
const wasMine=mac?.lastUser===u.name;
const washing=mac?.running&&macMine&&!hsSaysDone;
const justDone=hsSaysDone&&(macMine||wasMine)&&inGrace;
const status=washing?"Washing":justDone?"Done":u.dnd?"DND":"Free";
const color=washing?"#4ade80":justDone?"#fbbf24":u.dnd?"#fbbf24":"var(--lh-text3)";
return<button key={u.id} onClick={()=>{if(cfg.chatEnabled!==false)openChat(u.id)}} className="nm-in" style={{display:"flex",alignItems:"center",gap:8,padding:12,cursor:cfg.chatEnabled!==false?"pointer":"default",border:"none",textAlign:"left",transition:"transform .15s"}} onMouseOver={e=>{e.currentTarget.style.transform="translateY(-1px)"}} onMouseOut={e=>{e.currentTarget.style.transform="translateY(0)"}}>
<div className="av" style={{width:28,height:28,fontSize:13,background:washing?`${cfg.primaryColor}33`:bg}}>{u.emoji||"😊"}</div>
<div style={{flex:1}}><div style={{fontSize:11,fontWeight:700,color:"var(--lh-text)"}}>{u.name}</div><div style={{fontSize:9,color}}>{status}</div></div>
</button>})}</div></div>;

const enabled=cfg.dashboardSectionsEnabled||{};
const on2=k=>sections[k]!==undefined&&enabled[k]!==false;

/* Machine status hero — home tab only */
const washHero=<div className="nm" style={{display:"flex",flexDirection:"column",alignItems:"center",padding:28,marginBottom:16,borderRadius:22}}>
<Wash on={!!(effRunning||inGrace)} paused={!!(useHs&&hs.paused)} grace={inGrace} prog={useHs?Math.max(0,1-((hs.totalMin||hs.remainingMin+1)?hs.remainingMin/(hs.totalMin||(hs.remainingMin+1)):0)):prog} c={cfg.primaryColor} spinnerStyle={cfg.spinnerStyle}/>
{inGrace?<div style={{textAlign:"center",marginTop:14,width:"100%"}}><div className="np" style={{color:"#fbbf24",marginBottom:6,letterSpacing:1}}>Wash done</div><div style={{fontSize:14,color:"var(--lh-text2)",marginBottom:2,fontWeight:600}}>Powering off in</div><div className="M" style={{color:"#fbbf24",fontSize:40,marginTop:6,fontWeight:800,letterSpacing:1}}>{graceM}:{String(graceS).padStart(2,"0")}</div></div>:effRunning?<div style={{textAlign:"center",marginTop:14,width:"100%"}}><div className="np" style={{color:busy||(!mac?.running&&useHs)?"#f87171":cfg.primaryColor,marginBottom:6}}>{!mac?.running&&useHs?"In use":(busy?"In use":"Running")}</div>{mac?.running?(()=>{const washer=users.find(x=>x.id===mac.userId||x.name===mac.userName);const isMachineStarted=mac.userId==="machine"||mac.userName==="Machine";return<div><div style={{fontSize:20,fontWeight:700,color:"var(--lh-text)"}}>{mac.cycleName}</div>{isMachineStarted?<div style={{fontSize:11,color:cfg.primaryColor,fontWeight:700,marginTop:3,letterSpacing:.3}}>Started on machine</div>:mac.userName?<div style={{display:"inline-flex",alignItems:"center",gap:6,marginTop:6,padding:"4px 10px",borderRadius:14,background:`${cfg.primaryColor}22`,border:`1px solid ${cfg.primaryColor}55`}}><span style={{fontSize:14}}>{washer?.emoji||"😊"}</span><span style={{fontSize:12,fontWeight:800,color:cfg.primaryColor,letterSpacing:.2}}>{mac.userName}{mac.userId===user.id?" (you)":""}</span></div>:null}</div>})():<div style={{fontSize:15,color:"var(--lh-text2)",marginBottom:2}}>Started on machine</div>}{useHs&&hs.phaseName&&hs.phaseName!=="Idle"&&!hs.paused&&<div style={{fontSize:11,color:cfg.primaryColor,fontWeight:700,marginTop:2,letterSpacing:.5,textTransform:"uppercase"}}>{hs.phaseName}</div>}<div className="M" style={{color:useHs&&hs.paused?"#f87171":"var(--lh-text2)",fontSize:36,marginTop:8,fontWeight:useHs&&hs.paused?700:500,transition:"color .2s"}}>{useHs?`${rmM}m`:`${rmM}:${String(rmS).padStart(2,"0")}`}</div>{!(useHs&&hs.paused)&&rmM>0&&<div style={{fontSize:13,color:"var(--lh-text3)",marginTop:6,fontWeight:600}}>Ends at {fmtT(useHs?(Date.now()+rmM*60000):(mac.startTime+mac.durationMs),cfg.time24!==false)}</div>}{useHs&&hs.paused&&<div style={{marginTop:10}}><span style={{fontSize:16,color:"#fff",background:"#f87171",padding:"6px 18px",borderRadius:14,fontWeight:900,letterSpacing:3,display:"inline-block"}}>Paused</span></div>}</div>:<div style={{textAlign:"center",marginTop:14}}><div className="np" style={{color:on?"#4ade80":"#f87171"}}>{on?"Available":"Offline"}</div>{blocked&&on&&<div style={{fontSize:10,color:"#fbbf24",marginTop:4}}>Reserved by {blocked.userName}</div>}{!on&&<div style={{fontSize:10,color:"#f87171",marginTop:4}}>Machine disconnected</div>}{on&&!blocked&&mac?.lastUser&&<div style={{fontSize:10,color:"var(--lh-text3)",marginTop:4}}>Last: {mac.lastUser}</div>}</div>}
{mac?.running&&!(useHs&&(hs.running||hs.paused))&&(()=>{const age=(Number(mac.startTime)||0)>0?(Date.now()-Number(mac.startTime)):0;const wait=age<10000;return<button disabled={wait} onClick={async()=>{if(!(await askConfirm("Turn off the machine? This cuts power to the wash.")))return;await DB.setMachine({running:false,lastUser:mac?.userName||user.name,lastCycle:mac?.cycleName||"",finishedAt:Date.now()});toast("Powered off","info")}} className="nb" style={{marginTop:14,padding:"12px 0",width:"100%",color:wait?"var(--lh-text3)":"#fbbf24",fontSize:14,fontWeight:800,letterSpacing:.5,border:`1px solid ${wait?"#555b6e44":"#fbbf2444"}`,cursor:wait?"not-allowed":"pointer",opacity:wait?.6:1}}>{wait?`Turn off (${Math.ceil((10000-age)/1000)}s…)`:"Turn off"}</button>})()}
</div>;

/* Manual override banner — only when ConnectLife seems stuck or the wash overran. */
const overrideBanner=manualOverrideAvailable&&<div className="nm" style={{padding:14,marginBottom:14,border:"1px solid #fbbf2433"}}>
  <div style={{fontSize:13,fontWeight:800,color:"#fbbf24"}}>{hsStale?"Cloud sync delayed":"Wash overrun"}</div>
  <div style={{fontSize:11,color:"var(--lh-text2)",marginTop:2,marginBottom:10,lineHeight:1.4}}>{hsStale?`No update from the washer for ${hsAgeSec?Math.floor(hsAgeSec/60)+"m":"a while"}. The machine may actually be free.`:`This wash has been running much longer than expected — it probably finished a while ago.`}</div>
  <button onClick={async()=>{if(!(await askConfirm("Mark machine as free? Check it physically first.\n\nThis opens the power relay and clears the wash.")))return;try{await DB.emergencyReset({reason:"user_manual_override",muteMinutes:10});toast("Machine marked free","success")}catch{toast("Reset failed — try again","error")}}} className="nb" style={{width:"100%",padding:"10px 0",fontSize:12,fontWeight:800,color:"#fbbf24",border:"1px solid #fbbf2444"}}>Check & mark as free</button>
</div>;

/* Profile — inline, no modal */
const profileTab=<><div className="nm" style={{padding:22,marginBottom:16}}>
<ProfileEditor user={user} cfg={cfg} onSave={u2=>{sU(u2);toast("Profile updated","success")}} onClose={()=>sView("home")} toast={toast}/>
</div>
<div className="nm" style={{padding:14,marginBottom:16,display:"grid",gap:8}}>
<button onClick={()=>sShowHelp(true)} className="nb" style={{width:"100%",padding:"11px 0",fontWeight:600}}>Help</button>
<button onClick={async()=>{if(!(await askConfirm("Reload the app and clear cached files? You'll stay signed in.")))return;clearCacheAndReload()}} className="nb" style={{width:"100%",padding:"11px 0",fontWeight:600}}>Reload app</button>
<button onClick={onOut} className="nb" style={{width:"100%",padding:"11px 0",fontWeight:700,color:"#f87171"}}>Log out</button>
</div></>;

if(view==="home")return<>{overrideBanner}{washHero}{on2("ready")&&sections.ready}{on2("cleaning")&&cleaningCompact}</>;
if(view==="schedule")return on2("schedule")?sections.schedule:<div className="nm" style={{padding:22,textAlign:"center",color:"var(--lh-text2)",fontSize:13}}>Scheduling is turned off.</div>;
if(view==="activity")return<>{on2("cleaning")&&sections.cleaning}{on2("washes")&&sections.washes}{!on2("washes")&&!on2("cleaning")&&<div className="nm" style={{padding:22,textAlign:"center",color:"var(--lh-text2)",fontSize:13}}>No activity yet.</div>}</>;
if(view==="profile")return<>{profileTab}{on2("housemates")&&sections.housemates}</>;
return null;
})()}
</div>}
</div>
<BottomNav view={view} setView={goToTab} unread={unread} c={cfg.primaryColor}/>
</div>;}

/* ═══ ADMIN ═══ */
function AdminDash({cfg,setCfg,onOut,toast}){
const[users,sU]=useState([]);const[mac,sM]=useState({running:false});const[sch,sSch]=useState([]);const[esp,sE]=useState(null);const[hist,sH]=useState([]);const[msgs,sMs]=useState([]);const[nn,sNN]=useState("");const[np,sNP]=useState("");const[tab,sT]=useState("dash");
const[cP,sCP]=useState(cfg.primaryColor);const[cA,sCA]=useState(cfg.accentColor);const[tCol,sTCol]=useState(cfg.textColor||"#e2e6ef");const[uiSc,sUiSc]=useState(cfg.uiScale||1);const[aN,sAN]=useState(cfg.appName);const[aM,sAM]=useState(cfg.alertMinutesBefore||5);const[chatEn,sChatEn]=useState(cfg.chatEnabled!==false);const[apEm,sApEm]=useState(cfg.appEmoji||"🫧");const[mntn,sMntn]=useState(!!cfg.maintenance);const[adPw,sAdPw]=useState("");const[tagln,sTagln]=useState(cfg.tagline||"Smart laundry control");const[redMo,sRedMo]=useState(!!cfg.reduceMotion);const[defEm,sDefEm]=useState(cfg.defaultUserEmoji||"😊");const[cStop,sCStop]=useState(cfg.confirmStop!==false);const[aLog,sALog]=useState(cfg.autoLogoutMin||0);const[t24,sT24]=useState(cfg.time24!==false);const[sFin,sSFin]=useState(cfg.soundOnFinish!==false);const[grace,sGrace]=useState(cfg.gracePoweroffMin||5);const[defWash,sDefWash]=useState(cfg.defaultWashMinutes||90);const[dashOrd,sDashOrd]=useState(mergeDashOrder(cfg.dashboardOrder));const[secEn,sSecEn]=useState(cfg.dashboardSectionsEnabled||{});const[clnVis,sClnVis]=useState(cfg.cleaningDoneVisibility||"everyone");const[clnTaskVis,sClnTaskVis]=useState(cfg.cleaningTaskVisibility||"everyone");const[userQ,sUserQ]=useState("");const[histQ,sHistQ]=useState("");const[manMin,sManMin]=useState(5);
const[eu,sEU]=useState(null);const[sfu,sSFU]=useState(false);const[showChat,sC]=useState(false);const[editSch,sES]=useState(null);const[now,sN]=useState(Date.now());const[adLR,sAdLR]=useState(()=>{try{return+(localStorage.getItem("lh_admin_last_read")||0)}catch{return 0}});const[hs,sHs]=useState(null);const[spinStyle,sSpinStyle]=useState(cfg.spinnerStyle||"drop");

const[roster,sRoster]=useState(null);const[completions,sComp]=useState({});
useEffect(()=>{const a=DB.onUsersChange(sU);const b=DB.onMachineChange(sM);const c=DB.onScheduleChange(sSch);const d=DB.onEsp32Status(sE);const e=DB.onHistoryChange(sH);const f=DB.onChatMessages(sMs);const g=DB.onHisense(sHs);const h=DB.onCleaning(sRoster);const i=DB.onCleaningCompletions(sComp);const iv=setInterval(()=>sN(Date.now()),1000);return()=>{a();b();c();d();e();f();g();h();i();clearInterval(iv)}},[]);

const addU=async()=>{if(!nn.trim()||!np.trim())return toast("Required","error");if(np.length<4)return toast("PIN 4+","error");if(users.find(u=>u.name.toLowerCase()===nn.trim().toLowerCase()))return toast("Exists","error");await DB.addUser({id:Date.now().toString(),name:nn.trim(),pin:np.trim(),emoji:cfg.defaultUserEmoji||"😊",dnd:false,disabled:false});sNN("");sNP("");toast(`${nn.trim()} added`,"success")};
const saveCfg=async()=>{const u={...cfg,primaryColor:cP,accentColor:cA,textColor:tCol||"#e2e6ef",uiScale:+uiSc||1,appName:aN,appEmoji:(apEm||"🫧").trim()||"🫧",alertMinutesBefore:+aM||5,chatEnabled:chatEn,maintenance:mntn,tagline:tagln.trim()||"Smart laundry control",reduceMotion:redMo,defaultUserEmoji:(defEm||"😊").trim()||"😊",confirmStop:cStop,autoLogoutMin:Math.max(0,+aLog||0),time24:t24,soundOnFinish:sFin,spinnerStyle:spinStyle||"drum",gracePoweroffMin:Math.max(1,Math.min(30,+grace||5)),defaultWashMinutes:Math.max(15,Math.min(240,+defWash||90)),dashboardOrder:dashOrd&&dashOrd.length?dashOrd:["ready","schedule","cleaning","washes","housemates"],dashboardSectionsEnabled:secEn||{},cleaningDoneVisibility:clnVis||"everyone",cleaningTaskVisibility:clnTaskVis||"everyone"};/* Clean up vestigial config keys from old versions */delete u.washCycles;delete u.maxWashMinutes;delete u.minWashMinutes;delete u.esp32Ip;if(adPw.trim())u.adminPassword=adPw.trim();await DB.setConfig(u);setCfg(u);sAdPw("");toast("Saved","success")};
const applyTheme=(t)=>{sCP(t.p);sCA(t.a);toast(`${t.n} theme — click Save to apply`,"info")};
const forceStop=async(msg="Stopped",type="warning")=>{if(cfg.confirmStop!==false&&!(await askConfirm("Force-stop the running machine?")))return;DB.setMachine({running:false});toast(msg,type)};
const resetUserPin=async(u)=>{const p=await askPrompt(`Set new PIN for ${u.name}:`,"4+ digits");if(!p)return;if(p.length<4)return toast("PIN must be 4+ digits","error");await DB.updateUser(u.id,{pin:p});toast(`PIN reset for ${u.name}`,"success")};
const bulkSetUsers=async(disabled)=>{if(!(await askConfirm(`${disabled?"Disable":"Enable"} all users?`)))return;await Promise.all(users.map(u=>DB.updateUser(u.id,{disabled})));toast(`All users ${disabled?"disabled":"enabled"}`,"info")};
const exportUsers=()=>{if(!users.length)return toast("No users","info");downloadCSV(`laundryhub-users-${new Date().toISOString().slice(0,10)}.csv`,users.map(u=>({name:u.name,pin:u.pin,emoji:u.emoji||"",disabled:!!u.disabled,dnd:!!u.dnd,washes:wc[u.name]||0})));toast("Users exported","success")};
const exportHistory=()=>{if(!hist.length)return toast("No history","info");downloadCSV(`laundryhub-history-${new Date().toISOString().slice(0,10)}.csv`,hist.map(h=>({user:h.userName,cycle:h.cycleName,minutes:Math.round(h.durationMs/60000),waterLiters:h.waterLiters||"",energyKwh:h.energyKwh||"",finishedAt:new Date(h.finishedAt).toISOString(),source:h.source||"app",stoppedBy:h.stoppedBy||""})));toast("History exported","success")};
const rebootEsp=async()=>{if(!(await askConfirm("Send reboot command to ESP32?\n\n(Requires firmware listening at /esp32_command)")))return;try{await DB.sendEspCommand({type:"reboot",ts:Date.now()});toast("Reboot command sent","info")}catch{toast("Failed to send command","error")}};
const broadcast=async()=>{const t=await askPrompt("Broadcast message to all users:","Message");if(!t||!t.trim())return;await DB.sendMessage({from:"Admin",fromId:"admin",emoji:"🛡️",to:"all",toName:"Everyone",text:t.trim()});toast("Broadcast sent","success")};
const manualOn=async()=>{if(mac?.running)return toast("Machine already running","error");const m=Math.max(1,+manMin||5);await DB.setMachine({running:true,userId:"admin",userName:"Admin",cycleName:"Manual",startTime:Date.now(),durationMs:m*60000});toast(`ON ${m}m`,"success")};
const exportCfg=()=>{const blob=new Blob([JSON.stringify(cfg,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`laundryhub-config-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href);toast("Config downloaded","success")};
const clearAllHistory=async()=>{if(!(await askConfirm(`Delete all ${hist.length} wash history records? This cannot be undone.`)))return;await DB.clearHistory();toast("History cleared","info")};
const resetDefaults=async()=>{if(!(await askConfirm("Reset all settings to defaults? Users, schedule, and history are kept.")))return;await DB.setConfig(DEF);setCfg(DEF);toast("Reset to defaults","info")};
const on=isOn(esp);
/* Prefer real Hisense data over the app's pre-set timer so admin time matches user view */
const hsFresh=hs&&hs.updatedAt&&(Date.now()-hs.updatedAt<45000);const useHs=hsFresh&&(hs.running||hs.paused)&&typeof hs.remainingMin==="number";
const hsSaysDone=hsFresh&&!hs.running&&!hs.paused;
const rmM=useHs?hs.remainingMin:(mac?.running?Math.ceil(Math.max(0,(mac.startTime+mac.durationMs)-now)/60000):0);
const prog=useHs&&hs.totalMin?Math.max(0,1-(hs.remainingMin/hs.totalMin)):(mac?.running?Math.min(1,(now-mac.startTime)/mac.durationMs):0);
const graceLeft=hs&&hs.graceUntil?Math.max(0,hs.graceUntil-now):0;const inGrace=graceLeft>0;const graceM=Math.floor(graceLeft/60000);const graceS=Math.floor((graceLeft%60000)/1000);
const wc={};hist.forEach(h=>{wc[h.userName]=(wc[h.userName]||0)+1});
const tabs=[{id:"dash",l:"Dashboard"},{id:"users",l:"Users"},{id:"ctrl",l:"Control"},{id:"clean",l:"Cleaning"},{id:"esp",l:"ESP32"},{id:"api",l:"API"},{id:"log",l:"History"},{id:"cfg",l:"Settings"}];

return<div className="lh-scale" style={{minHeight:"100vh",background:bg}}>
<Head cfg={cfg} user={{name:"Admin",emoji:"🛡️"}} admin onOut={onOut} onChat={()=>{const ts=Date.now();try{localStorage.setItem("lh_admin_last_read",ts.toString())}catch{}sAdLR(ts);sC(true)}} unread={msgs.filter(m=>(m.to==="admin"||(m.to==="all"&&m.fromId!=="admin"))&&m.timestamp>adLR).length} esp={esp}/>
{cfg.maintenance&&<MntBanner/>}
{eu&&<Modal onClose={()=>sEU(null)}><EditUser u={eu} cfg={cfg} onClose={()=>sEU(null)} toast={toast}/></Modal>}
{sfu&&<Modal onClose={()=>sSFU(false)}><StartFor users={users} cfg={cfg} mac={mac} onClose={()=>sSFU(false)} toast={toast}/></Modal>}
{showChat&&<ChatMod user={{name:"Admin",id:"admin",emoji:"🛡️"}} cfg={cfg} users={users} onClose={()=>sC(false)} initTo="all"/>}
{editSch&&<Modal onClose={()=>sES(null)}><SchedEdit e={editSch} cfg={cfg} onClose={()=>sES(null)} toast={toast}/></Modal>}
<div style={{maxWidth:660,margin:"0 auto",padding:"0 12px 14px"}}>
<AdminEspBar esp={esp}/>
<div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto",paddingBottom:4,borderBottom:`1px solid ${ls}`}}>{tabs.map(t=><button key={t.id} onClick={()=>sT(t.id)} style={{background:"transparent",border:"none",borderBottom:tab===t.id?`2px solid ${cfg.primaryColor}`:"2px solid transparent",fontSize:13,padding:"10px 14px",fontWeight:600,whiteSpace:"nowrap",cursor:"pointer",color:tab===t.id?cfg.primaryColor:"var(--lh-text2)"}}>{t.l}</button>)}</div>

{tab==="dash"&&(()=>{const today=new Date();today.setHours(0,0,0,0);const weekly=Array.from({length:7},(_,i)=>{const d0=today.getTime()-(6-i)*86400000;const d1=d0+86400000;const cnt=hist.filter(h=>h.finishedAt>=d0&&h.finishedAt<d1).length;return{lbl:new Date(d0).toLocaleDateString(undefined,{weekday:"short"}).slice(0,2),cnt,today:i===6}});const maxWk=Math.max(1,...weekly.map(d=>d.cnt));const nextSch=sch.filter(s=>new Date(s.dateTime).getTime()>=Date.now()).slice(0,3);return<><div className="g4" style={{marginBottom:14}}>{[{l:"Users",v:users.filter(x=>!x.disabled).length,s:`/${users.length}`},{l:"Scheduled",v:sch.length},{l:"Washes",v:hist.length},{l:"ESP32",v:on?"ON":"OFF",c:on?"#4ade80":"#f87171"}].map((s,i)=><div key={i} className="ns"><div style={{fontSize:9,color:"var(--lh-text3)",fontWeight:600}}>{s.l}</div><div style={{fontSize:20,fontWeight:800,color:s.c||"var(--lh-text)"}}>{s.v}<span style={{fontSize:11,color:"var(--lh-text3)"}}>{s.s||""}</span></div></div>)}</div>
<div className="nm" style={{marginBottom:14}}><div className="sb" style={{marginBottom:12}}><div className="sec" style={{marginBottom:0}}>Last 7 days · {weekly.reduce((a,b)=>a+b.cnt,0)} washes</div>{cfg.chatEnabled!==false&&<button onClick={broadcast} className="nb" style={{fontSize:10,padding:"6px 12px",color:cfg.primaryColor,fontWeight:700}}>📣 Broadcast</button>}</div><div style={{display:"flex",alignItems:"end",gap:6,height:70,padding:"0 2px"}}>{weekly.map((d,i)=><div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}><div className="M" style={{fontSize:9,color:"var(--lh-text2)"}}>{d.cnt||""}</div><div style={{width:"100%",height:Math.max(3,(d.cnt/maxWk)*50),background:d.today?cfg.primaryColor:cfg.accentColor,borderRadius:4,opacity:d.cnt?1:.3,transition:"height .3s"}}/><div style={{fontSize:9,color:d.today?cfg.primaryColor:"var(--lh-text3)",fontWeight:d.today?800:600}}>{d.lbl}</div></div>)}</div></div>
<div className="nm" style={{marginBottom:14,display:"flex",alignItems:"center",gap:14}}><Wash on={mac?.running||inGrace} prog={inGrace?1:prog} grace={inGrace} c={cfg.primaryColor} sz={95} spinnerStyle={cfg.spinnerStyle}/><div style={{flex:1}}>{inGrace?<><div className="np" style={{color:"#fbbf24",marginBottom:4}}>✓ WASH DONE</div><div style={{fontSize:12,color:"var(--lh-text2)",fontWeight:600}}>Powering off in</div><div className="M" style={{fontSize:22,fontWeight:800,color:"#fbbf24",letterSpacing:1,marginTop:2}}>{graceM}:{String(graceS).padStart(2,"0")}</div>{mac?.userName&&<div style={{fontSize:10,color:"var(--lh-text3)",marginTop:4}}>{mac.userName} · {mac.cycleName}</div>}</>:mac?.running?<><div className="np" style={{color:cfg.primaryColor,marginBottom:4}}>RUNNING</div><div style={{fontSize:14,fontWeight:800,color:"var(--lh-text)"}}>{mac.userName}</div><div style={{fontSize:12,color:"var(--lh-text2)"}}>{mac.cycleName} · {rmM}m left{useHs?" (real)":""}</div><button onClick={()=>forceStop("Stopped","warning")} className="nb" style={{marginTop:8,fontSize:10,padding:"5px 14px",color:"#f87171"}}>Force Stop</button></>:<><div className="np" style={{color:on?"#4ade80":"#f87171"}}>{on?"IDLE":"OFFLINE"}</div>{mac?.lastUser&&<div style={{fontSize:11,color:"var(--lh-text3)",marginTop:3}}>Last: {mac.lastUser}</div>}<button onClick={()=>sSFU(true)} className="nb" style={{marginTop:8,fontSize:10,padding:"5px 14px",color:cfg.primaryColor}}>Start for user...</button></>}</div></div>
{nextSch.length>0&&<div className="nm" style={{marginBottom:14}}><div className="sec"><span className="sec-ico">🗓️</span>Upcoming <span style={{fontSize:11,color:"var(--lh-text2)",fontWeight:700,marginLeft:"auto"}}>{nextSch.length}{sch.length>nextSch.length?`/${sch.length}`:""}</span></div>{nextSch.map(s=><div key={s.id} className="sb" style={{padding:"6px 0"}}><div className="row"><span style={{fontSize:14}}>{s.userEmoji||"😊"}</span><div><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{s.userName}</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{s.cycleName}</div></div></div><div className="M" style={{fontSize:11,color:"var(--lh-text2)"}}>{new Date(s.dateTime).toLocaleDateString(undefined,{weekday:"short",day:"numeric",month:"short"})} {s.startTime||s.dateTime?.split("T")[1]||""}</div></div>)}</div>}
{/* Per-user wash chart — horizontal bars, sorted, with this-month vs total split */}
{(()=>{const monthStart=new Date();monthStart.setDate(1);monthStart.setHours(0,0,0,0);const stats=users.filter(u=>!u.disabled).map(u=>{const userHist=hist.filter(h=>h.userName===u.name);const tot=userHist.length;const month=userHist.filter(h=>(h.finishedAt||0)>=monthStart.getTime()).length;const tMin=userHist.reduce((a,h)=>a+Math.round((h.durationMs||0)/60000),0);const water=userHist.reduce((a,h)=>a+(h.waterLiters||0),0);return{u,tot,month,tMin,water}}).sort((a,b)=>b.tot-a.tot);const maxTot=Math.max(1,...stats.map(s=>s.tot));return<div className="nm"><div className="sb" style={{marginBottom:10}}><div className="sec" style={{marginBottom:0}}><span className="sec-ico">📊</span>Wash stats per user</div><div style={{fontSize:9,color:"var(--lh-text3)"}}>This month / all-time</div></div>
{stats.length===0?<div style={{fontSize:11,color:"var(--lh-text3)",textAlign:"center",padding:14}}>No washes recorded yet</div>:stats.map(s=>{const totPct=(s.tot/maxTot)*100;const monthPct=(s.month/maxTot)*100;return<div key={s.u.id} style={{marginBottom:12}}>
  <div className="sb" style={{marginBottom:5,alignItems:"baseline"}}>
    <div className="row" style={{gap:6}}><span style={{fontSize:14}}>{s.u.emoji||"😊"}</span><span style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{s.u.name}</span></div>
    <div className="row" style={{gap:8}}>
      <span className="M" style={{fontSize:11,color:cfg.primaryColor,fontWeight:800}}>{s.month}</span>
      <span style={{fontSize:9,color:"var(--lh-text3)"}}>/</span>
      <span className="M" style={{fontSize:11,color:"var(--lh-text)",fontWeight:800}}>{s.tot}</span>
    </div>
  </div>
  <div style={{position:"relative",height:10,borderRadius:5,background:"#1e2233",overflow:"hidden",border:"1px solid rgba(255,255,255,.06)"}}>
    <div style={{width:`${totPct}%`,height:"100%",background:`linear-gradient(90deg,${cfg.primaryColor}55,${cfg.primaryColor}88)`,transition:"width .4s ease"}}/>
    <div style={{position:"absolute",top:0,left:0,width:`${monthPct}%`,height:"100%",background:`linear-gradient(90deg,${cfg.primaryColor},${cfg.primaryColor}dd)`,boxShadow:`0 0 6px ${cfg.primaryColor}66`,transition:"width .4s ease"}}/>
  </div>
  <div style={{display:"flex",gap:10,marginTop:4,fontSize:9,color:"var(--lh-text3)",flexWrap:"wrap"}}><span>⏱ {Math.floor(s.tMin/60)}h</span>{s.water>0&&<span>💧 {s.water.toFixed(0)} L</span>}</div>
</div>})}
<div style={{display:"flex",gap:10,marginTop:8,paddingTop:8,borderTop:`1px solid ${ls}`,fontSize:9,color:"var(--lh-text3)"}}><div className="row" style={{gap:4}}><div style={{width:12,height:6,borderRadius:3,background:cfg.primaryColor,boxShadow:`0 0 4px ${cfg.primaryColor}66`}}/>this month</div><div className="row" style={{gap:4}}><div style={{width:12,height:6,borderRadius:3,background:`${cfg.primaryColor}55`}}/>all-time</div></div>
</div>})()}</>})()}

{tab==="users"&&(()=>{const q=userQ.trim().toLowerCase();const filt=q?users.filter(u=>u.name.toLowerCase().includes(q)):users;const nEn=users.filter(u=>!u.disabled).length;return<div className="nm"><div className="sb" style={{marginBottom:12}}><div className="sec" style={{marginBottom:0}}>Users ({nEn}/{users.length})</div><div className="row" style={{gap:4}}><button onClick={()=>bulkSetUsers(false)} className="nb" style={{fontSize:9,padding:"5px 9px",color:"#4ade80"}}>Enable all</button><button onClick={()=>bulkSetUsers(true)} className="nb" style={{fontSize:9,padding:"5px 9px",color:"#f87171"}}>Disable all</button><button onClick={exportUsers} className="nb" style={{fontSize:9,padding:"5px 9px",color:cfg.primaryColor}}>⬇ CSV</button></div></div>
<div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}><input value={nn} onChange={e=>sNN(e.target.value)} placeholder="Name" className="ni" style={{flex:2,minWidth:90}}/><input value={np} onChange={e=>sNP(e.target.value)} placeholder="PIN" maxLength={6} className="ni" style={{flex:1,minWidth:60}}/><button onClick={addU} className="nb nb-p" style={{background:cfg.primaryColor}}>Add</button></div>
<input value={userQ} onChange={e=>sUserQ(e.target.value)} placeholder="🔍 Search users..." className="ni" style={{marginBottom:10,fontSize:12}}/>
{filt.length===0?<div style={{color:"var(--lh-text3)",fontSize:12,textAlign:"center",padding:"12px 0"}}>No users match</div>:filt.map(u=><div key={u.id} className="sb" style={{padding:"10px 0",borderBottom:`1px solid ${ls}`}}><div className="row"><div className="av" style={{width:32,height:32,fontSize:15,background:bg}}>{u.emoji||"😊"}</div><div><div style={{fontWeight:700,fontSize:13,color:u.disabled?"var(--lh-text3)":"var(--lh-text)"}}>{u.name}{u.disabled&&<span style={{color:"#f87171",fontSize:9,marginLeft:4}}>disabled</span>}</div><div className="M" style={{fontSize:10,color:"var(--lh-text3)"}}>{u.pin} · {wc[u.name]||0} washes</div></div></div><div className="row" style={{gap:4}}><button onClick={()=>resetUserPin(u)} className="nb" style={{fontSize:9,padding:"4px 8px",color:"#fbbf24"}}>PIN</button><button onClick={()=>DB.updateUser(u.id,{disabled:!u.disabled})} className="nb" style={{fontSize:9,padding:"4px 8px",color:u.disabled?"#4ade80":"#fbbf24"}}>{u.disabled?"On":"Off"}</button><button onClick={()=>sEU(u)} className="nb" style={{fontSize:9,padding:"4px 8px",color:cfg.primaryColor}}>Edit</button><button onClick={async()=>{if(!(await askConfirm(`Delete ${u.name}?`)))return;DB.removeUser(u.id);toast("Removed","info")}} className="nb" style={{fontSize:9,padding:"4px 8px",color:"#f87171"}}>Del</button></div></div>)}</div>})()}

{tab==="ctrl"&&<div className="nm"><div className="sec">Control</div><div className="nm-in" style={{marginBottom:14}}>
{inGrace?<div><div style={{fontSize:13,fontWeight:800,color:"#fbbf24"}}>✓ Wash done — {mac?.userName||"machine"} ({mac?.cycleName||"—"})</div><div style={{fontSize:11,color:"var(--lh-text2)",marginTop:4,fontWeight:600}}>Powering off in <span className="M" style={{color:"#fbbf24",fontWeight:800,fontSize:14}}>{graceM}:{String(graceS).padStart(2,"0")}</span></div></div>:mac?.running?<div style={{fontSize:13,fontWeight:700,color:"#f87171"}}>Running — {mac.userName} ({mac.cycleName}) — {rmM}m{useHs?" (Hisense)":""}</div>:<div style={{fontSize:13,fontWeight:700,color:"#4ade80"}}>Idle</div>}
{mac?.running&&!inGrace&&<button onClick={()=>forceStop("Stopped","warning")} className="nb" style={{marginTop:8,color:"#f87171",fontSize:11}}>Force Stop</button>}
{inGrace&&<button onClick={async()=>{if(!(await askConfirm("Cut power immediately (skip the 5-min grace)?")))return;await DB.setMachine({running:false,lastUser:mac?.userName||"",lastCycle:mac?.cycleName||"",finishedAt:Date.now()});await DB.sendEspCommand({type:"off",ts:Date.now()});toast("Power cut early","info")}} className="nb" style={{marginTop:8,color:"#fbbf24",fontSize:11}}>🔌 Cut power now</button>}
</div><button onClick={()=>sSFU(true)} className="nb nb-p" style={{width:"100%",background:cfg.primaryColor,marginBottom:14}}>Start for user...</button>{mac?.running&&<button onClick={async()=>{if(!(await askConfirm("EMERGENCY STOP — cut power immediately?")))return;DB.setMachine({running:false});toast("Emergency stop","error")}} className="nb" style={{width:"100%",marginBottom:14,padding:"14px 0",background:"#f87171",color:"#fff",fontWeight:900,fontSize:15,letterSpacing:1}}>🚨 EMERGENCY STOP</button>}
<div style={{fontSize:13,fontWeight:700,color:"var(--lh-text)",marginBottom:8}}>Manual relay</div><div style={{display:"flex",gap:6,marginBottom:14,alignItems:"stretch"}}><input type="number" value={manMin} onChange={e=>sManMin(e.target.value)} min="1" max="240" className="ni" style={{width:70,textAlign:"center",fontSize:13,fontWeight:700}}/><button onClick={manualOn} className="nb" style={{flex:1,color:"#4ade80",fontWeight:700}}>ON for {Math.max(1,+manMin||5)}m</button><button onClick={()=>forceStop("OFF","info")} className="nb" style={{flex:1,color:"#f87171",fontWeight:700}}>OFF</button></div><div style={{fontSize:13,fontWeight:700,color:"var(--lh-text)",marginBottom:8}}>Per-user</div>{users.filter(x=>!x.disabled).map(u=><div key={u.id} className="sb" style={{padding:"8px 0",borderBottom:`1px solid ${ls}`}}><div className="row"><span style={{fontSize:13}}>{u.emoji||"😊"}</span><span style={{fontSize:12,fontWeight:600,color:"var(--lh-text)"}}>{u.name}</span></div>{(!mac?.running||mac.userId!==u.id)?<button onClick={()=>{if(mac?.running)return toast("Busy","error");DB.setMachine({running:true,userId:u.id,userName:u.name,cycleName:"Admin",startTime:Date.now(),durationMs:45*60000});toast(`ON for ${u.name}`,"success")}} className="nb" style={{fontSize:9,padding:"3px 10px",color:"#4ade80"}}>Start</button>:<button onClick={()=>forceStop("Stopped","info")} className="nb" style={{fontSize:9,padding:"3px 10px",color:"#f87171"}}>Stop</button>}</div>)}
{/* ── EMERGENCY RESET — use when Hisense Connect Life is stuck reporting "running" but machine is actually OFF ── */}
<div className="nm-in" style={{padding:"12px 14px",marginTop:14,marginBottom:14,border:"1px solid #fbbf2433"}}>
  <div className="sb" style={{marginBottom:8}}>
    <div><div style={{fontSize:11,color:"#fbbf24",fontWeight:800,letterSpacing:.5}}>⚠ HISENSE STUCK?</div><div style={{fontSize:10,color:"var(--lh-text2)",marginTop:2}}>Use if Connect Life shows "running" but the machine is actually OFF</div></div>
  </div>
  {(()=>{const muted=hs?.muteUntil&&hs.muteUntil>Date.now();const muteLeft=muted?Math.ceil((hs.muteUntil-Date.now())/60000):0;return<>
  {muted&&<div style={{fontSize:10,color:"#fbbf24",marginBottom:8,padding:"6px 10px",background:"#fbbf2411",borderRadius:6,fontWeight:700}}>🔇 Hisense mirroring paused — {muteLeft}m left <button onClick={async()=>{await DB.clearHisenseMute();toast("Unmuted","info")}} style={{marginLeft:8,background:"transparent",border:"none",color:cfg.primaryColor,fontSize:10,fontWeight:700,cursor:"pointer",textDecoration:"underline"}}>Resume now</button></div>}
  <button onClick={async()=>{if(!(await askConfirm("Emergency reset: clear machine state, pause Hisense mirroring for 10 min, and open the relay?\n\nUse this ONLY if Hisense is stuck reporting a wash that isn't actually happening.")))return;try{await DB.emergencyReset({reason:"admin_hisense_stuck",muteMinutes:10});toast("Reset done — Hisense muted for 10 min","success")}catch(e){toast("Reset failed","error")}}} className="nb" style={{width:"100%",padding:"10px 0",fontSize:12,fontWeight:800,color:"#fbbf24",border:"1px solid #fbbf2444"}}>🔄 Emergency reset (clear stuck state)</button>
  </>})()}
</div>
{sch.length>0&&<><div style={{fontSize:13,fontWeight:700,color:"var(--lh-text)",marginTop:14,marginBottom:8}}>Reservations ({sch.length})</div>{sch.map(s=>{const endT=s.endTime||(()=>{const[h,m]=(s.startTime||s.dateTime?.split("T")[1]||"00:00").split(":").map(Number);const en=new Date(2000,0,1,h,m+(s.minutes||45));return en.toTimeString().slice(0,5)})();return<div key={s.id} className="sb" style={{padding:"8px 0",borderBottom:`1px solid ${ls}`}}><div className="row"><span style={{fontSize:13}}>{s.userEmoji||"😊"}</span><div><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{s.userName}</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{s.cycleName} · {new Date(s.dateTime).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short"})}</div><div className="M" style={{fontSize:11,color:"var(--lh-text2)"}}>{s.startTime||s.dateTime?.split("T")[1]||"?"} → {endT}</div></div></div><div className="row" style={{gap:3}}><button onClick={()=>sES(s)} className="nb" style={{fontSize:9,padding:"3px 8px",color:cfg.primaryColor}}>Edit</button><button onClick={async()=>{await DB.removeScheduleEntry(s.id);toast(`Cancelled ${s.userName}'s reservation`,"info")}} className="nb" style={{fontSize:9,padding:"3px 8px",color:"#f87171"}}>Cancel</button></div></div>})}<button onClick={async()=>{await DB.clearSchedule();toast("All reservations cleared","info")}} className="nb" style={{marginTop:8,width:"100%",color:"#f87171",fontSize:11}}>Clear all reservations</button></>}
</div>}

{tab==="clean"&&(()=>{
const enabled=!!roster?.enabled;
const pids=roster?.participantIds||["","","","",""];
const tasks=roster?.tasks||["","","","",""];
const baseMon=roster?.baseMonday||weekMonday(Date.now());
const mon=weekMonday(Date.now());const wk=weekIndex(mon,baseMon);
const total=Math.min(5,tasks.filter(t=>t).length,pids.filter(p=>p).length);
const enabledUsers=users.filter(u=>!u.disabled);
const save=async(patch)=>{const next={enabled,participantIds:pids.slice(0,5),tasks:tasks.slice(0,5),baseMonday:baseMon,...patch};while(next.participantIds.length<5)next.participantIds.push("");while(next.tasks.length<5)next.tasks.push("");try{await DB.setCleaning(next);toast("Saved","success")}catch(e){console.error("[cleaning] save failed:",e);toast(`Save failed: ${e?.code||e?.message||"unknown"}`,"error")}};
const setSlot=(slot,uid)=>{const p=[...pids];while(p.length<5)p.push("");p[slot]=uid;save({participantIds:p})};
const setTask=(slot,name)=>{const t=[...tasks];while(t.length<5)t.push("");t[slot]=name;save({tasks:t})};
const resetRotation=async()=>{if(!(await askConfirm("Reset rotation so this Monday becomes the new starting point?\n\nEveryone's task numbers will shift back to their slot order.")))return;await save({baseMonday:weekMonday(Date.now())})};
return<div className="nm"><div className="sb" style={{marginBottom:12}}><div className="sec" style={{marginBottom:0}}>Cleaning roster</div><div className="row" style={{gap:5}}><span style={{fontSize:10,color:enabled?"#4ade80":"var(--lh-text3)",fontWeight:800}}>{enabled?"ON":"OFF"}</span><Tog on={enabled} onChange={()=>save({enabled:!enabled})} color={cfg.primaryColor}/></div></div>
<div style={{fontSize:11,color:"var(--lh-text2)",marginBottom:14,lineHeight:1.5}}>5 users, 5 tasks. Rotation shifts every Monday at 00:00 — each person does a different task each week. Cycle completes every 5 weeks.</div>

<div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`}}>📝 TASKS</div>
{[0,1,2,3,4].map(i=><div key={i} className="row" style={{gap:8,marginBottom:7}}><span className="M" style={{fontSize:11,color:"var(--lh-text3)",width:18,textAlign:"right"}}>{i+1}</span><input value={tasks[i]||""} onChange={e=>setTask(i,e.target.value)} placeholder={`Task ${i+1} (e.g. "Kitchen")`} className="ni" style={{fontSize:12}}/></div>)}

<div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`,marginTop:18}}>👥 PARTICIPANTS</div>
<div style={{fontSize:10,color:"var(--lh-text2)",marginBottom:8}}>Pick 5 users. The ORDER matters — it determines the rotation offset.</div>
{[0,1,2,3,4].map(i=><div key={i} className="row" style={{gap:8,marginBottom:7}}><span className="M" style={{fontSize:11,color:"var(--lh-text3)",width:18,textAlign:"right"}}>{i+1}</span><select value={pids[i]||""} onChange={e=>setSlot(i,e.target.value)} className="ni" style={{fontSize:12}}><option value="">— choose user —</option>{enabledUsers.map(u=><option key={u.id} value={u.id} disabled={pids.includes(u.id)&&pids[i]!==u.id}>{u.emoji||"😊"} {u.name}</option>)}</select></div>)}

<div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`,marginTop:18}}>📅 ROTATION</div>
<div className="nm-in" style={{padding:"10px 12px",marginBottom:8}}><div className="sb"><div><div style={{fontSize:10,color:"var(--lh-text3)"}}>Base week</div><div style={{fontSize:13,fontWeight:700,color:"var(--lh-text)"}}>{fmtDateShort(baseMon)}</div></div><div style={{textAlign:"right"}}><div style={{fontSize:10,color:"var(--lh-text3)"}}>Week #</div><div className="M" style={{fontSize:13,fontWeight:700,color:cfg.primaryColor}}>{wk}</div></div></div></div>
<button onClick={resetRotation} className="nb" style={{fontSize:10,padding:"6px 12px",color:"#fbbf24",width:"100%"}}>↻ Reset rotation (start fresh this Monday)</button>

{total>0&&<><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`,marginTop:18}}>👁 PREVIEW — THIS WEEK ({fmtDateShort(mon)} → {fmtDateShort(weekSundayEnd(Date.now())-1)})</div>
{pids.slice(0,total).map((pid,slot)=>{const u=users.find(x=>x.id===pid);if(!u)return null;const tIdx=assignedTaskIdx(slot,wk,total);const t=tasks[tIdx]||`Task ${tIdx+1}`;const done=!!(completions?.[mon]||{})[pid];return<div key={pid} className="sb" style={{padding:"6px 0",borderBottom:`1px solid ${ls}`}}><div className="row" style={{gap:8}}><span style={{fontSize:13}}>{u.emoji||"😊"}</span><span style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{u.name}</span></div><div className="row" style={{gap:6}}><span style={{fontSize:11,color:done?"#4ade80":"var(--lh-text2)",fontWeight:600,textDecoration:done?"line-through":"none"}}>{t}</span><span className="np" style={{fontSize:9,color:done?"#4ade80":"var(--lh-text3)",background:bg}}>{done?"✓":"…"}</span></div></div>})}

<div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1.5,marginBottom:8,paddingBottom:6,borderBottom:`1px solid ${ls}`,marginTop:18}}>📊 NEXT 5 WEEKS</div>
<div style={{overflowX:"auto"}}><table style={{width:"100%",fontSize:10,borderCollapse:"collapse"}}><thead><tr><th style={{textAlign:"left",padding:"4px 6px",color:"var(--lh-text3)",fontWeight:700}}>User</th>{[0,1,2,3,4].map(o=>{const m=weekMonday(Date.now()+o*7*86400000);return<th key={o} style={{textAlign:"left",padding:"4px 6px",color:o===0?cfg.primaryColor:"var(--lh-text3)",fontWeight:700}}>{fmtDateShort(m)}{o===0&&" ←"}</th>})}</tr></thead><tbody>{pids.slice(0,total).map((pid,slot)=>{const u=users.find(x=>x.id===pid);if(!u)return null;return<tr key={pid}><td style={{padding:"6px",color:"var(--lh-text)",fontWeight:700,whiteSpace:"nowrap"}}>{u.emoji||"😊"} {u.name}</td>{[0,1,2,3,4].map(o=>{const fwk=wk+o;const tIdx=assignedTaskIdx(slot,fwk,total);return<td key={o} style={{padding:"6px",color:o===0?"var(--lh-text)":"var(--lh-text2)",fontWeight:o===0?700:500}}>{tasks[tIdx]||`T${tIdx+1}`}</td>})}</tr>})}</tbody></table></div>
</>}
</div>})()}

{tab==="esp"&&<div className="nm"><div className="sb" style={{marginBottom:12}}><div className="sec" style={{marginBottom:0}}>ESP32 Monitor</div><div className="row" style={{gap:4}}><button onClick={rebootEsp} disabled={!on} className="nb" style={{fontSize:10,padding:"6px 10px",color:on?"#fbbf24":"var(--lh-text3)",fontWeight:700,opacity:on?1:.5,cursor:on?"pointer":"not-allowed"}}>↻ Reboot</button><button onClick={async()=>{if(!(await askConfirm("Toggle relay manually?")))return;DB.sendEspCommand({type:"toggle_relay",ts:Date.now()});toast("Toggle sent","info")}} disabled={!on} className="nb" style={{fontSize:10,padding:"6px 10px",color:on?cfg.primaryColor:"var(--lh-text3)",fontWeight:700,opacity:on?1:.5,cursor:on?"pointer":"not-allowed"}}>⚡ Toggle</button></div></div>{esp?<>
{/* WiFi signal — dedicated wide card with bar + % + label + tip */}
{(()=>{const ri=rssiInfo(esp.rssi);const pct=rssiPct(esp.rssi);return<div className="nm-in" style={{padding:"12px 14px",marginBottom:12}}>
  <div className="sb" style={{marginBottom:8,alignItems:"center"}}>
    <div className="row" style={{gap:8}}>
      <span style={{fontSize:15}}>📶</span>
      <div><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:700,letterSpacing:.5}}>WIFI SIGNAL</div><div className="M" style={{fontSize:15,fontWeight:800,color:ri.color}}>{ri.label}</div></div>
    </div>
    <div style={{textAlign:"right"}}><div className="M" style={{fontSize:20,fontWeight:900,color:ri.color}}>{pct}%</div><div style={{fontSize:9,color:"var(--lh-text3)"}}>{esp.rssi||0} dBm</div></div>
  </div>
  <div style={{height:8,borderRadius:4,background:"#1e2233",overflow:"hidden",border:"1px solid rgba(255,255,255,.06)",marginBottom:6}}>
    <div style={{width:`${pct}%`,height:"100%",background:`linear-gradient(90deg,${ri.color}99,${ri.color})`,transition:"width .4s ease, background .4s ease",boxShadow:`0 0 8px ${ri.color}66`}}/>
  </div>
  <div style={{fontSize:10,color:"var(--lh-text2)",fontStyle:"italic"}}>{ri.tip}</div>
</div>})()}
<div className="g2" style={{marginBottom:14}}>{[{l:"Status",v:on?"Connected":"Disconnected",c:on?"#4ade80":"#f87171"},{l:"IP",v:esp.ip||"—"},{l:"Relay",v:esp.relay?"ON":"OFF",c:esp.relay?"#4ade80":"var(--lh-text3)"},{l:"Heap",v:esp.freeHeap?`${Math.round(esp.freeHeap/1024)} KB`:"—"},{l:"Uptime",v:esp.uptime?`${Math.floor(esp.uptime/3600)}h ${Math.floor(esp.uptime%3600/60)}m ${esp.uptime%60}s`:"—"},{l:"Last seen",v:esp.lastSeen?`${Math.round((Date.now()-esp.lastSeen)/1000)}s ago`:"—"}].map((s,i)=><div key={i} className="nm-in" style={{padding:10}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>{s.l}</div><div className="M" style={{fontSize:12,color:s.c||"var(--lh-text)"}}>{s.v}</div></div>)}</div><div className="nm-in" style={{padding:10,fontFamily:"'JetBrains Mono',monospace",fontSize:10,lineHeight:1.8,color:"#4ade80",background:"#0a0e18"}}><div style={{color:"var(--lh-text3)"}}># Live feed</div><div>[WIFI] {esp.ip} | RSSI: {esp.rssi}dBm ({rssiPct(esp.rssi)}%)</div><div>[RELAY] {esp.relay?"=== ON ===":"--- OFF ---"}</div><div>[UP] {esp.uptime?`${Math.floor(esp.uptime/3600)}h${Math.floor(esp.uptime%3600/60)}m${esp.uptime%60}s`:"—"}</div><div style={{color:on?"#4ade80":"#f87171"}}>[{on?"ONLINE":"OFFLINE"}]</div></div></>:<div className="nm-in" style={{padding:20,textAlign:"center"}}><div style={{fontSize:24,marginBottom:8}}>📡</div><div style={{color:"var(--lh-text3)"}}>No ESP32 data</div></div>}</div>}

{tab==="api"&&(()=>{
const hsAge=hs&&hs.updatedAt?Math.round((Date.now()-hs.updatedAt)/1000):null;
const hsOk=hsAge!==null&&hsAge<30;
const activePoller=(cfg.activePoller||"fly").toLowerCase();
const lastSource=hs?.pollerSource||"?";
const setPoller=async(which)=>{if(!(await askConfirm(`Switch active poller to "${which.toUpperCase()}"?\n\nThe other poller will go to standby. Make sure the one you're switching to is actually running.`)))return;try{await DB.setActivePoller(which);toast(`Active poller → ${which.toUpperCase()}`,"success")}catch(e){toast(`Save failed: ${e?.code||e?.message||"unknown"}`,"error")}};
const hsState=hs&&hs.running?"Running":hs&&hs.paused?"Paused":hs&&hs.ended?"Ended":hs?"Idle":"—";
const hsColor=hsOk?"#4ade80":(hsAge!==null&&hsAge<120)?"#fbbf24":"#f87171";
const fmtAgo=s=>s==null?"—":s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ${s%60}s ago`:`${Math.floor(s/3600)}h ago`;
return<div className="nm"><div className="sec">API & data pipeline</div>

{/* Active poller switch — use PC instance when Fly.io is down. Both instances must be running;
    only the one matching cfg.activePoller actually writes to Firebase. */}
<div className="nm-in" style={{padding:"14px 16px",marginBottom:14,border:`1px solid ${cfg.primaryColor}33`}}>
  <div className="sb" style={{marginBottom:10,alignItems:"baseline"}}>
    <div><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:800,letterSpacing:1}}>🎛 ACTIVE POLLER</div><div className="M" style={{fontSize:15,fontWeight:800,color:cfg.primaryColor,marginTop:2}}>{activePoller==="pc"?"💻 PC (local)":"☁ Fly.io"}</div></div>
    <div style={{textAlign:"right",fontSize:9,color:"var(--lh-text3)"}}>Last write by:<br/><span className="M" style={{color:lastSource===activePoller?"#4ade80":"#fbbf24",fontWeight:800,fontSize:11}}>{lastSource}</span></div>
  </div>
  <div className="g2" style={{gap:6}}>
    <button onClick={()=>setPoller("fly")} disabled={activePoller==="fly"} className="nb" style={{padding:"10px 0",fontSize:12,fontWeight:800,color:activePoller==="fly"?"#4ade80":"var(--lh-text4)",border:activePoller==="fly"?"1px solid #4ade8055":undefined,cursor:activePoller==="fly"?"default":"pointer"}}>{activePoller==="fly"?"✓ ":""}☁ Fly.io</button>
    <button onClick={()=>setPoller("pc")} disabled={activePoller==="pc"} className="nb" style={{padding:"10px 0",fontSize:12,fontWeight:800,color:activePoller==="pc"?"#4ade80":"var(--lh-text4)",border:activePoller==="pc"?"1px solid #4ade8055":undefined,cursor:activePoller==="pc"?"default":"pointer"}}>{activePoller==="pc"?"✓ ":""}💻 PC (local)</button>
  </div>
  <div style={{fontSize:10,color:"var(--lh-text3)",fontStyle:"italic",marginTop:10,lineHeight:1.5}}>{activePoller==="pc"?"⚠ PC poller must be running on your machine — double-click hisense-poller/start-pc-poller.bat":"☁ Fly.io poller handles things automatically. Switch to PC if Fly is down."}</div>
</div>

<div className="nm-in" style={{padding:"12px 14px",marginBottom:12}}>
  <div className="sb" style={{alignItems:"center",marginBottom:10}}>
    <div className="row" style={{gap:8}}><span style={{fontSize:15}}>🌀</span><div><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:700,letterSpacing:.5}}>HISENSE CONNECT LIFE (POLLER)</div><div className="M" style={{fontSize:14,fontWeight:800,color:hsColor}}>{hsOk?"Connected":hsAge!==null?"Stale":"No data"}</div></div></div>
    <div className="row" style={{gap:5}}><div style={{width:8,height:8,borderRadius:4,background:hsColor,animation:hsOk?"gl 2s infinite":"bk 1s infinite"}}/></div>
  </div>
  <div className="g2" style={{gap:6}}>
    {[{l:"Last poll",v:fmtAgo(hsAge),c:hsColor},{l:"State",v:hsState},{l:"Remaining",v:hs&&typeof hs.remainingMin==="number"?`${hs.remainingMin} min`:"—"},{l:"Phase",v:hs?.phaseName||"—"},{l:"Door",v:hs?.doorLocked===true?"Locked":hs?.doorLocked===false?"Unlocked":"—"},{l:"Program",v:hs?.programId!==undefined&&hs?.programId!==null?`#${hs.programId}`:"—"},{l:"Water",v:hs?.waterLiters?`${hs.waterLiters.toFixed(1)} L`:"—"},{l:"Energy",v:hs?.energyKwh?`${hs.energyKwh.toFixed(2)} kWh`:"—"},{l:"Grace",v:hs?.graceUntil&&hs.graceUntil>Date.now()?`${Math.round((hs.graceUntil-Date.now())/1000)}s left`:"—"},{l:"Device",v:hs?.nickname||hs?.deviceId?.slice(-6)||"—"}].map((s,i)=><div key={i} className="nm-in" style={{padding:"8px 10px"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>{s.l}</div><div className="M" style={{fontSize:11,color:s.c||"var(--lh-text)",fontWeight:700}}>{s.v}</div></div>)}
  </div>
</div>
{/* Washing machine WiFi card — derived from Hisense data (hs.online + hs.updatedAt).
    Tells you whether the Hisense cloud can talk to the machine over WiFi right now.
    Note: Hisense doesn't expose RSSI/signal strength, so this is a binary health check. */}
{(()=>{const washerOnline=hs&&hs.online===true&&hsAge!==null&&hsAge<60;const washerStale=hs&&hsAge!==null&&hsAge>=60&&hsAge<300;const washerOffline=!hs||hs.online===false||hsAge===null||hsAge>=300;const wColor=washerOnline?"#4ade80":washerStale?"#fbbf24":"#f87171";const wLabel=washerOnline?"Connected to WiFi":washerStale?"Stale / weak signal":(hs?.online===false?"Reported offline by Hisense":"No contact");return<div className="nm-in" style={{padding:"12px 14px",marginBottom:12}}>
  <div className="sb" style={{alignItems:"center",marginBottom:10}}>
    <div className="row" style={{gap:8}}><span style={{fontSize:15}}>🫧</span><div><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:700,letterSpacing:.5}}>WASHING MACHINE — WiFi</div><div className="M" style={{fontSize:14,fontWeight:800,color:wColor}}>{wLabel}</div></div></div>
    <div className="row" style={{gap:5}}><div style={{width:8,height:8,borderRadius:4,background:wColor,animation:washerOnline?"gl 2s infinite":"bk 1s infinite"}}/></div>
  </div>
  <div className="g2" style={{gap:6}}>
    {[{l:"Hisense reports",v:hs?.online===true?"Online":hs?.online===false?"Offline":"Unknown",c:wColor},{l:"Last seen by cloud",v:fmtAgo(hsAge),c:wColor},{l:"Nickname",v:hs?.nickname||"—"},{l:"Device ID",v:hs?.deviceId?hs.deviceId.slice(-12):"—"}].map((s,i)=><div key={i} className="nm-in" style={{padding:"8px 10px"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>{s.l}</div><div className="M" style={{fontSize:11,color:s.c||"var(--lh-text)",fontWeight:700}}>{s.v}</div></div>)}
  </div>
  <div style={{fontSize:9,color:"var(--lh-text3)",fontStyle:"italic",marginTop:8,lineHeight:1.4}}>{washerOnline?"✓ Hisense cloud is receiving fresh data — the washer's WiFi is healthy.":washerStale?"⚠ Hisense data is older than 1 minute. Could be a brief WiFi blip or slow Hisense cloud — usually self-recovers.":hs?.online===false?"✗ Hisense knows the machine but reports it's offline. The washer probably lost WiFi — check power and signal at the machine.":"✗ No data from Hisense cloud at all. Either the poller is down (check ESP32 card below or Fly.io) or the machine has been offline a long time."}</div>
  <div style={{fontSize:9,color:"var(--lh-text3)",marginTop:6}}>⚠ Hisense doesn't expose WiFi signal strength (RSSI). Health is inferred from data freshness.</div>
</div>})()}
<div className="nm-in" style={{padding:"12px 14px",marginBottom:12}}>
  <div className="sb" style={{alignItems:"center",marginBottom:10}}>
    <div className="row" style={{gap:8}}><span style={{fontSize:15}}>🧱</span><div><div style={{fontSize:10,color:"var(--lh-text3)",fontWeight:700,letterSpacing:.5}}>ESP32 RELAY CONTROLLER</div><div className="M" style={{fontSize:14,fontWeight:800,color:on?"#4ade80":"#f87171"}}>{on?"Online":"Offline"}</div></div></div>
    <div className="row" style={{gap:5}}><div style={{width:8,height:8,borderRadius:4,background:on?"#4ade80":"#f87171",animation:on?"gl 2s infinite":"bk 1s infinite"}}/></div>
  </div>
  {esp?<div className="g2" style={{gap:6}}>
    {[{l:"Last heartbeat",v:esp.lastSeen?fmtAgo(Math.round((Date.now()-esp.lastSeen)/1000)):"—",c:on?"#4ade80":"#f87171"},{l:"Uptime",v:esp.uptime?`${Math.floor(esp.uptime/3600)}h${Math.floor(esp.uptime%3600/60)}m`:"—"},{l:"Relay",v:esp.relay?"CLOSED (ON)":"OPEN (OFF)",c:esp.relay?"#4ade80":"var(--lh-text3)"},{l:"WiFi",v:`${rssiPct(esp.rssi)}% · ${esp.rssi}dBm`,c:rssiInfo(esp.rssi).color},{l:"IP",v:esp.ip||"—"},{l:"Free heap",v:esp.freeHeap?`${Math.round(esp.freeHeap/1024)} KB`:"—"}].map((s,i)=><div key={i} className="nm-in" style={{padding:"8px 10px"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>{s.l}</div><div className="M" style={{fontSize:11,color:s.c||"var(--lh-text)",fontWeight:700}}>{s.v}</div></div>)}
  </div>:<div style={{fontSize:11,color:"var(--lh-text3)",textAlign:"center",padding:14}}>No ESP32 heartbeat received</div>}
</div>
<div className="nm-in" style={{padding:"12px 14px",marginBottom:12}}>
  <div className="sec" style={{fontSize:13,marginBottom:10}}>📦 Data flow</div>
  <div style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,lineHeight:1.8,color:"var(--lh-text2)",background:"#0a0e18",padding:12,borderRadius:8}}>
    <div style={{color:hsOk?"#4ade80":"#f87171"}}>[1] Hisense Cloud → Fly.io Poller  {hsOk?"✓":"✗"} ({fmtAgo(hsAge)})</div>
    <div style={{color:hsOk?"#4ade80":"var(--lh-text3)"}}>[2] Fly.io Poller → Firebase /hisense  {hsOk?"✓":"—"}</div>
    <div style={{color:"#4ade80"}}>[3] Firebase /machine ⇄ app  ✓</div>
    <div style={{color:on?"#4ade80":"#f87171"}}>[4] ESP32 polls /machine/running  {on?"✓":"✗"} (1s)</div>
    <div style={{color:on?"#4ade80":"#f87171"}}>[5] ESP32 heartbeat → /esp32_status  {on?"✓":"✗"} (15s)</div>
  </div>
</div>
<div className="nm-in" style={{padding:"12px 14px"}}>
  <div className="sec" style={{fontSize:13,marginBottom:10}}>🔍 Raw Hisense payload</div>
  <pre style={{fontFamily:"'JetBrains Mono',monospace",fontSize:9,lineHeight:1.5,color:"var(--lh-text2)",background:"#0a0e18",padding:12,borderRadius:8,maxHeight:200,overflow:"auto",margin:0}}>{hs?JSON.stringify({running:hs.running,paused:hs.paused,ended:hs.ended,phaseName:hs.phaseName,remainingMin:hs.remainingMin,totalMin:hs.totalMin,waterLiters:hs.waterLiters,energyKwh:hs.energyKwh,doorLocked:hs.doorLocked,power:hs.power,programId:hs.programId,online:hs.online,nickname:hs.nickname,deviceId:hs.deviceId},null,2):"(no data received yet — Fly.io poller may be down)"}</pre>
</div>
</div>})()}

{tab==="log"&&(()=>{const hq=histQ.trim().toLowerCase();const histF=hq?hist.filter(h=>(h.userName||"").toLowerCase().includes(hq)||(h.cycleName||"").toLowerCase().includes(hq)):hist;const totMin=histF.reduce((a,h)=>a+Math.round(h.durationMs/60000),0);return<div className="nm"><div className="sb" style={{marginBottom:10}}><div className="sec" style={{marginBottom:0}}>History ({histF.length}{hq?`/${hist.length}`:""})</div><div className="row" style={{gap:4}}><button onClick={exportHistory} className="nb" style={{fontSize:10,padding:"6px 10px",color:cfg.primaryColor,fontWeight:700}}>⬇ CSV</button><button onClick={clearAllHistory} disabled={!hist.length} className="nb" style={{fontSize:10,padding:"6px 10px",color:hist.length?"#f87171":"var(--lh-text3)",fontWeight:700,opacity:hist.length?1:.5,cursor:hist.length?"pointer":"not-allowed"}}>🗑 Clear all</button></div></div>
<input value={histQ} onChange={e=>sHistQ(e.target.value)} placeholder="🔍 Search by user or cycle..." className="ni" style={{marginBottom:10,fontSize:12}}/>
{histF.length>0&&<div className="g3" style={{marginBottom:12,gap:6}}><div className="nm-in" style={{padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>Total runs</div><div style={{fontSize:15,fontWeight:800,color:"var(--lh-text)"}}>{histF.length}</div></div><div className="nm-in" style={{padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>Total time</div><div style={{fontSize:15,fontWeight:800,color:"var(--lh-text)"}}>{Math.floor(totMin/60)}h {totMin%60}m</div></div><div className="nm-in" style={{padding:"8px 10px",textAlign:"center"}}><div style={{fontSize:9,color:"var(--lh-text3)"}}>Avg</div><div style={{fontSize:15,fontWeight:800,color:"var(--lh-text)"}}>{histF.length?Math.round(totMin/histF.length):0}m</div></div></div>}
{histF.length===0?<div style={{color:"var(--lh-text3)",fontSize:12,textAlign:"center",padding:"12px 0"}}>{hq?"No matches":"No washes yet"}</div>:histF.slice(0,50).map(h=><div key={h.id} className="sb" style={{padding:"7px 0",borderBottom:`1px solid ${ls}`,gap:8}}><div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>{h.userName} — {h.cycleName}{h.stoppedBy&&<span style={{fontSize:9,color:h.stoppedBy==="esp32_safety"?"#fbbf24":"#60a5fa",marginLeft:4}}>({h.stoppedBy})</span>}{h.source==="hisense"&&<span style={{fontSize:9,color:"#4ade80",marginLeft:4}}>🟢</span>}</div><div style={{fontSize:10,color:"var(--lh-text3)"}}>{fmtDT(h.finishedAt,cfg.time24!==false)}{(h.waterLiters||h.energyKwh)&&` · ${h.waterLiters?h.waterLiters.toFixed(1)+"L":""}${h.waterLiters&&h.energyKwh?" · ":""}${h.energyKwh?h.energyKwh.toFixed(2)+"kWh":""}`}</div></div><span className="M" style={{fontSize:11,color:"var(--lh-text2)",whiteSpace:"nowrap"}}>{Math.round(h.durationMs/60000)}m</span></div>)}
{histF.length>50&&<div style={{fontSize:10,color:"var(--lh-text3)",textAlign:"center",marginTop:10}}>Showing 50 of {histF.length} — export CSV for full</div>}
</div>})()}

{/* Settings — admin full control. Reorganized into clear sections. */}
{tab==="cfg"&&<div className="nm"><div className="sec">Settings</div><div style={{display:"grid",gap:6}}>

<SH i="🏷" t="BRANDING">
<div className="g2" style={{gridTemplateColumns:"3fr 1fr",marginBottom:8}}><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>App name</label><input value={aN} onChange={e=>sAN(e.target.value)} className="ni"/></div><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Emoji</label><input value={apEm} onChange={e=>sApEm(e.target.value)} maxLength={4} className="ni" style={{textAlign:"center",fontSize:16}}/></div></div>
<div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Welcome tagline <span style={{color:"var(--lh-text2)"}}>(shown on login)</span></label><input value={tagln} onChange={e=>sTagln(e.target.value)} maxLength={60} placeholder="Smart laundry control" className="ni"/></div>
</SH>

<SH i="🎨" t="APPEARANCE">
<div style={{marginBottom:10}}><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:6,display:"block"}}>Color palette</label><div className="wrap">{THEMES.map(t=><button key={t.n} onClick={()=>applyTheme(t)} className="nb" style={{fontSize:10,padding:"6px 12px",display:"flex",alignItems:"center",gap:6,fontWeight:700}}><span style={{display:"inline-block",width:12,height:12,borderRadius:6,background:`linear-gradient(135deg,${t.p} 0 50%,${t.a} 50% 100%)`}}/>{t.n}</button>)}</div></div>
<div className="g2" style={{marginBottom:10}}><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Primary color</label><div className="row"><input type="color" value={cP} onChange={e=>sCP(e.target.value)} style={{width:34,height:30,border:"none",borderRadius:8,cursor:"pointer"}}/><input value={cP} onChange={e=>sCP(e.target.value)} className="ni" style={{fontSize:11}}/></div></div><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Accent color</label><div className="row"><input type="color" value={cA} onChange={e=>sCA(e.target.value)} style={{width:34,height:30,border:"none",borderRadius:8,cursor:"pointer"}}/><input value={cA} onChange={e=>sCA(e.target.value)} className="ni" style={{fontSize:11}}/></div></div></div>
<div className="g2" style={{marginBottom:10}}><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Text color</label><div className="row"><input type="color" value={tCol} onChange={e=>sTCol(e.target.value)} style={{width:34,height:30,border:"none",borderRadius:8,cursor:"pointer"}}/><input value={tCol} onChange={e=>sTCol(e.target.value)} className="ni" style={{fontSize:11}}/></div></div><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>UI size</label><div className="wrap">{[{k:.9,l:"Small"},{k:1,l:"Medium"},{k:1.12,l:"Large"}].map(o=><button key={o.l} onClick={()=>sUiSc(o.k)} className="nb" style={{fontSize:11,padding:"7px 12px",color:uiSc===o.k?cfg.primaryColor:"var(--lh-text4)",fontWeight:uiSc===o.k?800:600,flex:1}}>{o.l}</button>)}</div></div></div>
<div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:6,display:"block"}}>Wash spinner</label><div className="wrap">{[{k:"drum",l:"🌀 Drum",new:true},{k:"swirl",l:"💫 Swirl",new:true},{k:"bubbles",l:"🫧 Foam",new:true},{k:"droplet",l:"💧 Drop",new:true},{k:"drop",l:"💧 Classic"},{k:"pulse",l:"● Pulse"},{k:"ring",l:"◜ Ring"},{k:"dots",l:"••• Dots"},{k:"wave",l:"▊ Wave"}].map(s=><button key={s.k} onClick={()=>sSpinStyle(s.k)} className="nb" style={{fontSize:11,padding:"6px 11px",color:spinStyle===s.k?cfg.primaryColor:"var(--lh-text4)",fontWeight:spinStyle===s.k?800:600,position:"relative"}}>{s.l}{s.new&&<sup style={{color:"#fbbf24",fontSize:8,marginLeft:3,fontWeight:800}}>NEW</sup>}</button>)}</div><div style={{marginTop:8,display:"flex",justifyContent:"center",padding:"10px 0"}}><Wash on={true} prog={.65} c={cP} paused={false} grace={false} spinnerStyle={spinStyle} sz={80}/></div></div>
<TR t="Reduce motion" d="Disable animations for accessibility" on={redMo} onChange={()=>sRedMo(!redMo)} color={cfg.primaryColor}/>
</SH>

<SH i="🌀" t="WASH BEHAVIOUR">
<div className="g2" style={{marginBottom:8}}><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Default wash (min) <span style={{color:"var(--lh-text2)"}}>Turn ON button</span></label><input type="number" value={defWash} onChange={e=>sDefWash(e.target.value)} className="ni" min="15" max="240"/></div><div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Powering-off (min) <span style={{color:"var(--lh-text2)"}}>after wash ends</span></label><input type="number" value={grace} onChange={e=>sGrace(e.target.value)} className="ni" min="1" max="30"/></div></div>
<div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Reminder (min before end) <span style={{color:"var(--lh-text2)"}}>push notification</span></label><input type="number" value={aM} onChange={e=>sAM(e.target.value)} className="ni" min="1" max="15"/></div>
<TR t="Confirm before force-stop" d="Ask before stopping a running wash" on={cStop} onChange={()=>sCStop(!cStop)} color={cfg.primaryColor}/>
<TR t="Beep when wash finishes" d="Play a tone when machine frees" on={sFin} onChange={()=>sSFin(!sFin)} color={cfg.primaryColor}/>
</SH>

<SH i="🗂" t="USER DASHBOARD LAYOUT">
{(()=>{
const LABELS={ready:{i:"💦",l:"Ready to wash"},schedule:{i:"📅",l:"Schedule & reservations"},cleaning:{i:"🧹",l:"Cleaning week"},washes:{i:"✨",l:"My washes"},housemates:{i:"🏠",l:"Housemates"}};
const move=(idx,dir)=>{const o=[...dashOrd];const ni=idx+dir;if(ni<0||ni>=o.length)return;[o[idx],o[ni]]=[o[ni],o[idx]];sDashOrd(o)};
const isOn=(k)=>secEn[k]!==false;
const toggle=(k)=>sSecEn({...secEn,[k]:!isOn(k)});
return<><div style={{fontSize:11,color:"var(--lh-text2)",marginBottom:8,lineHeight:1.5}}>Use the toggle to enable/disable a section, arrows to reorder. Applies to every user's dashboard. Don't forget to save.</div>
{dashOrd.map((k,i)=>{const L=LABELS[k]||{i:"❔",l:k};const on=isOn(k);return<div key={k} className="nm-in" style={{padding:"10px 12px",marginBottom:6,display:"flex",alignItems:"center",gap:10,opacity:on?1:.55}}>
  <span className="M" style={{fontSize:10,color:"var(--lh-text3)",width:14,textAlign:"right"}}>{i+1}</span>
  <span style={{fontSize:16,filter:on?"none":"grayscale(.7)"}}>{L.i}</span>
  <div style={{flex:1,fontSize:12,fontWeight:700,color:on?"var(--lh-text)":"var(--lh-text3)",textDecoration:on?"none":"line-through"}}>{L.l}</div>
  <Tog on={on} onChange={()=>toggle(k)} color={cfg.primaryColor}/>
  <button onClick={()=>move(i,-1)} disabled={i===0} className="nb" style={{padding:"4px 10px",fontSize:11,opacity:i===0?.3:1,cursor:i===0?"not-allowed":"pointer"}}>↑</button>
  <button onClick={()=>move(i,1)} disabled={i===dashOrd.length-1} className="nb" style={{padding:"4px 10px",fontSize:11,opacity:i===dashOrd.length-1?.3:1,cursor:i===dashOrd.length-1?"not-allowed":"pointer"}}>↓</button>
</div>})}
<div style={{fontSize:10,color:"var(--lh-text3)",marginTop:8,fontStyle:"italic"}}>Tip: Cleaning week only shows for the 5 chosen participants — others see only the enabled non-cleaning sections.</div>
</>})()}

<div style={{marginTop:14,paddingTop:12,borderTop:`1px solid ${ls}`}}><div style={{fontSize:10,color:"var(--lh-text2)",fontWeight:800,letterSpacing:1,marginBottom:6}}>🧹 CLEANING PRIVACY</div>

<div style={{marginBottom:10}}><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:6,display:"block"}}>Task assignments visible to <span style={{color:"var(--lh-text2)"}}>(what task each person has)</span></label>
<div className="wrap">{[{k:"everyone",l:"👥 Everyone"},{k:"self",l:"🙋 Yourself only"}].map(o=><button key={o.k} onClick={()=>sClnTaskVis(o.k)} className="nb" style={{fontSize:11,padding:"7px 12px",color:clnTaskVis===o.k?cfg.primaryColor:"var(--lh-text4)",fontWeight:clnTaskVis===o.k?800:600,flex:1}}>{o.l}</button>)}</div>
<div style={{fontSize:10,color:"var(--lh-text3)",marginTop:6,fontStyle:"italic"}}>{clnTaskVis==="everyone"?"Everyone sees the full roster — who's assigned to what.":"Each user only sees their own task; the roster list is hidden."}</div>
</div>

<div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:6,display:"block"}}>Done status (✓) visible to <span style={{color:"var(--lh-text2)"}}>(who has finished their task)</span></label>
<div className="wrap">{[{k:"everyone",l:"👥 Everyone"},{k:"self",l:"🙋 Yourself only"},{k:"admin",l:"🛡 Admin only"}].map(o=><button key={o.k} onClick={()=>sClnVis(o.k)} className="nb" style={{fontSize:11,padding:"7px 12px",color:clnVis===o.k?cfg.primaryColor:"var(--lh-text4)",fontWeight:clnVis===o.k?800:600,flex:1}}>{o.l}</button>)}</div>
<div style={{fontSize:10,color:"var(--lh-text3)",marginTop:6,fontStyle:"italic",lineHeight:1.5}}>{clnVis==="everyone"?"All 5 participants see who has marked their task done.":clnVis==="self"?"Each user only sees their own ✓; nobody can see if others have done their task.":"Users see no ✓ marks at all. Only you (admin) can track completion via the Cleaning tab."}</div>
</div>
<div style={{fontSize:10,color:"#fbbf24",marginTop:10,padding:"6px 10px",background:"#fbbf2411",borderRadius:6,fontWeight:600}}>⚠ Click <b>Save all settings</b> at the bottom for changes to apply to users.</div>
</div>
</SH>

<SH i="💬" t="FEATURES">
<TR t="Enable chat" d="Users can message each other" on={chatEn} onChange={()=>sChatEn(!chatEn)} color={cfg.primaryColor}/>
<TR t="24-hour time" d="Use 14:30 instead of 2:30 PM" on={t24} onChange={()=>sT24(!t24)} color={cfg.primaryColor}/>
<div style={{marginTop:8}}><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Default emoji for new users</label><input value={defEm} onChange={e=>sDefEm(e.target.value)} maxLength={4} className="ni" style={{textAlign:"center",fontSize:16}}/></div>
</SH>

<SH i="🛡" t="SECURITY">
<div style={{marginBottom:8}}><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Admin password <span style={{color:"var(--lh-text2)"}}>blank = keep current</span></label><input type="password" value={adPw} onChange={e=>sAdPw(e.target.value)} placeholder="New password" className="ni" autoComplete="new-password"/></div>
<div><label style={{fontSize:11,color:"var(--lh-text3)",marginBottom:4,display:"block"}}>Auto-logout after idle (min) <span style={{color:"var(--lh-text2)"}}>0 = never</span></label><input type="number" value={aLog} onChange={e=>sALog(e.target.value)} className="ni" min="0" max="120"/></div>
</SH>

<SH i="🔧" t="SYSTEM">
<TR t="Maintenance mode" d="Show red banner when servicing the machine" on={mntn} onChange={()=>sMntn(!mntn)} color="#f87171"/>
</SH>

<button onClick={saveCfg} className="nb nb-p" style={{width:"100%",padding:"13px 0",fontSize:14,fontWeight:800,background:cfg.primaryColor,marginTop:6}}>💾 Save all settings</button>
<div style={{marginTop:14,paddingTop:14,borderTop:`1px solid ${ls}`}}>
<div style={{fontSize:10,color:"#f87171",fontWeight:800,letterSpacing:1.2,marginBottom:8}}>⚠ DANGER ZONE</div>
<div className="g2" style={{gap:6,marginBottom:6}}>
<button onClick={exportCfg} className="nb" style={{fontSize:10,padding:"10px 0",color:cfg.primaryColor,fontWeight:700}}>⬇ Export config</button>
<button onClick={async()=>{if(!(await askConfirm("Clear browser cache & service worker, then reload the app? Useful after a deploy or if the UI seems stuck on old code.")))return;clearCacheAndReload()}} className="nb" style={{fontSize:10,padding:"10px 0",color:"#fbbf24",fontWeight:700}}>🔄 Clear cache & reload</button>
</div>
<div className="g2" style={{gap:6}}>
<button onClick={clearAllHistory} className="nb" style={{fontSize:10,padding:"10px 0",color:"#f87171",fontWeight:700}}>🗑 Clear history</button>
<button onClick={resetDefaults} className="nb" style={{fontSize:10,padding:"10px 0",color:"#f87171",fontWeight:700}}>↺ Reset defaults</button>
</div>
</div>
</div></div>}
</div></div>;}

/* ═══ SUB COMPONENTS ═══ */
function ProfileEditor({user,cfg,onSave,onClose,toast}){
  const[name,sN]=useState(user.name);const[pin,sP]=useState("");const[pin2,sP2]=useState("");const[emo,sE]=useState(user.emoji||"😊");const[dnd,sD]=useState(user.dnd||false);
  const save=async()=>{const u={...user,name:name.trim()||user.name,emoji:emo,dnd};if(pin){if(pin.length<4)return toast("PIN must be 4+","error");if(pin!==pin2)return toast("PINs don't match","error");u.pin=pin}await DB.addUser(u);toast("Profile updated!","success");onSave(u)};
  return<><div className="sec">Profile & Settings</div>
  <div style={{textAlign:"center",marginBottom:16}}><div className="av" style={{width:64,height:64,fontSize:30,margin:"0 auto",background:bg}}>{emo}</div></div>
  <div className="wrap" style={{marginBottom:14}}>{EMO.map(e=><button key={e} onClick={()=>sE(e)} style={{width:32,height:32,borderRadius:8,fontSize:15,cursor:"pointer",background:emo===e?`${cfg.primaryColor}33`:bg,display:"flex",alignItems:"center",justifyContent:"center",border:emo===e?`2px solid ${cfg.primaryColor}`:"1px solid rgba(255,255,255,.1)"}}>{e}</button>)}</div>
  <input value={name} onChange={e=>sN(e.target.value)} placeholder="Display name" className="ni" style={{marginBottom:8}}/>
  <input value={pin} onChange={e=>sP(e.target.value)} type="password" placeholder="New PIN (leave blank to keep current)" maxLength={6} className="ni" style={{marginBottom:6}}/>
  <input value={pin2} onChange={e=>sP2(e.target.value)} type="password" placeholder="Confirm new PIN" maxLength={6} className="ni" style={{marginBottom:10}}/>
  <div className="sb" style={{marginBottom:14}}><span style={{fontSize:12,fontWeight:700,color:"var(--lh-text)"}}>Do Not Disturb</span><Tog on={dnd} onChange={()=>sD(!dnd)} color={cfg.primaryColor}/></div>
  <div className="g2"><button onClick={onClose} className="nb">Cancel</button><button onClick={save} className="nb nb-p" style={{background:cfg.primaryColor}}>Save</button></div></>;}

function SchedEdit({e,cfg,onClose,toast}){const past=isSchedulePast(e);const[d,sD]=useState(e.dateTime?.split("T")[0]||"");const[t,sT]=useState(e.startTime||e.dateTime?.split("T")[1]||"");const[te,sTE]=useState(e.endTime||"");return<><div className="sec" style={{marginBottom:12}}>{past?"Reservation":"Edit reservation"}</div><input type="date" aria-label="Date" disabled={past} value={d} onChange={x=>sD(x.target.value)} className="ni" style={{marginBottom:6,opacity:past?.5:1}}/><div style={{display:"flex",gap:6,marginBottom:6}}><input type="time" aria-label="Start time" disabled={past} value={t} onChange={x=>sT(x.target.value)} className="ni" style={{flex:1,opacity:past?.5:1}}/><input type="time" aria-label="End time" disabled={past} value={te} onChange={x=>sTE(x.target.value)} className="ni" style={{flex:1,opacity:past?.5:1}}/></div>{!past&&t&&te&&(()=>{const s=new Date(`2000-01-01T${t}`).getTime();const en=new Date(`2000-01-01T${te}`).getTime();const dur=en>s?Math.round((en-s)/60000):0;return dur>0?<div className="nm-in" style={{padding:"8px 12px",marginBottom:10}}><div className="sb"><span className="M" style={{fontSize:12,color:"var(--lh-text)"}}>{t} → {te}</span><span style={{fontSize:11,fontWeight:700,color:cfg.primaryColor}}>{dur}m</span></div></div>:null})()}<div style={{display:"flex",gap:8}}><button onClick={async()=>{onClose();if(!(await askConfirm("Delete this reservation?")))return;await DB.removeScheduleEntry(e.id);toast("Deleted","info")}} className="nb" style={{color:"#f87171"}}>Delete</button><div style={{flex:1}}/><button onClick={onClose} className="nb">Cancel</button>{!past&&<button onClick={async()=>{if(!d||!t||!te)return toast("Fill all fields","error");const s=new Date(`${d}T${t}`).getTime();const en=new Date(`${d}T${te}`).getTime();if(en<=s)return toast("End must be after start","error");const dur=Math.round((en-s)/60000);await DB.updateScheduleEntry({...e,dateTime:`${d}T${t}`,startTime:t,endTime:te,minutes:dur});toast("Saved!","success");onClose()}} className="nb nb-p" style={{background:cfg.primaryColor}}>Save</button>}</div></>;}
function EditUser({u,cfg,onClose,toast}){const[name,sN]=useState(u.name);const[pin,sP]=useState(u.pin);const[emo,sE]=useState(u.emoji||"😊");const[dnd,sD]=useState(u.dnd||false);const[dis,sDis]=useState(u.disabled||false);return<><div className="sec">Edit user</div><div style={{textAlign:"center",marginBottom:12}}><div className="av" style={{width:52,height:52,fontSize:26,margin:"0 auto",background:bg}}>{emo}</div></div><div className="wrap" style={{marginBottom:12}}>{EMO.map(e=><button key={e} onClick={()=>sE(e)} style={{width:28,height:28,borderRadius:6,fontSize:13,cursor:"pointer",background:emo===e?`${cfg.primaryColor}33`:bg,display:"flex",alignItems:"center",justifyContent:"center",border:emo===e?`2px solid ${cfg.primaryColor}`:"1px solid rgba(255,255,255,.1)"}}>{e}</button>)}</div><input value={name} onChange={e=>sN(e.target.value)} placeholder="Name" className="ni" style={{marginBottom:6}}/><input value={pin} onChange={e=>sP(e.target.value)} placeholder="PIN" className="ni" style={{marginBottom:10}}/><div className="sb" style={{marginBottom:8}}><span style={{fontSize:12,fontWeight:600}}>DND</span><Tog on={dnd} onChange={()=>sD(!dnd)} color={cfg.primaryColor}/></div><div className="sb" style={{marginBottom:14}}><span style={{fontSize:12,fontWeight:600,color:dis?"#f87171":"#4ade80"}}>{dis?"Disabled":"Active"}</span><Tog on={!dis} onChange={()=>sDis(!dis)} color="#4ade80"/></div><div className="g2"><button onClick={onClose} className="nb">Cancel</button><button onClick={async()=>{if(!name.trim()||!pin.trim())return toast("Required","error");await DB.addUser({...u,name:name.trim(),pin:pin.trim(),emoji:emo,dnd,disabled:dis});toast("Updated","success");onClose()}} className="nb nb-p" style={{background:cfg.primaryColor}}>Save</button></div></>;}
function StartFor({users,cfg,mac,onClose,toast}){const[sel,sS]=useState(null);const[m,sM]=useState(90);return<><div className="sec">Start for user</div><div style={{marginBottom:14}}>{users.filter(x=>!x.disabled).map(u=><button key={u.id} onClick={()=>sS(u)} className="nb" style={{display:"flex",alignItems:"center",gap:8,width:"100%",marginBottom:6,borderColor:sel?.id===u.id?cfg.primaryColor:undefined,background:sel?.id===u.id?`${cfg.primaryColor}1a`:undefined}}><span style={{fontSize:16}}>{u.emoji||"😊"}</span><span style={{fontWeight:700}}>{u.name}</span></button>)}</div><div style={{fontSize:12,fontWeight:700,color:"var(--lh-text)",marginBottom:8}}>Duration</div><div className="wrap" style={{marginBottom:14}}>{[30,60,90,120,150,180].map(x=><button key={x} onClick={()=>sM(x)} className="nb" style={{fontSize:11,padding:"6px 12px",color:m===x?cfg.primaryColor:"var(--lh-text4)"}}>{x>=60?`${x/60}h`:`${x}m`}</button>)}</div><div className="g2"><button onClick={onClose} className="nb">Cancel</button><button onClick={async()=>{if(!sel)return toast("Pick user","error");if(mac?.running)return toast("Busy","error");await DB.setMachine({running:true,userId:sel.id,userName:sel.name,cycleName:"Wash",startTime:Date.now(),durationMs:m*60000});toast(`ON for ${sel.name} — ${m}m`,"success");onClose()}} className="nb nb-p" style={{background:cfg.primaryColor}}>Turn ON</button></div></>;}

/* Main */
export default function Home(){const[s,sS]=useState(null);const[cfg,sCfg]=useState(DEF);const[td,sTD]=useState(null);const[rdy,sRdy]=useState(false);const toast=useCallback((m,t)=>sTD({message:m,type:t,key:Date.now()}),[]);useEffect(()=>{try{const v=localStorage.getItem("lh_session");if(v)sS(JSON.parse(v))}catch{}},[]);const login=u=>{sS(u);try{localStorage.setItem("lh_session",JSON.stringify(u))}catch{}};const logout=useCallback(()=>{sS(null);try{localStorage.removeItem("lh_session")}catch{}},[]);useEffect(()=>{const u=DB.onConfigChange(c=>{if(c)sCfg(p=>({...DEF,...c}));sRdy(true)});return()=>u()},[]);
const seenTs=useRef(0);useEffect(()=>{try{seenTs.current=+(localStorage.getItem("lh_notif_seen")||Date.now())}catch{seenTs.current=Date.now()}const u=DB.onNotifications(list=>{const fresh=list.filter(n=>(n.ts||0)>seenTs.current);if(fresh.length){fresh.forEach(n=>{sTD({message:n.text||n.type,type:n.type==="idle_timeout"?"warning":"info",key:n.ts});sendPush(`${cfg.appName||"LaundryHub"}`,n.text||n.type)});const last=fresh[fresh.length-1].ts||Date.now();seenTs.current=last;try{localStorage.setItem("lh_notif_seen",last.toString())}catch{}}});return()=>u()},[cfg.appName]);
useEffect(()=>{if(!s||!cfg.autoLogoutMin||cfg.autoLogoutMin<=0)return;let t;const reset=()=>{clearTimeout(t);t=setTimeout(()=>{logout();sTD({message:"Auto-logged out (idle)",type:"info",key:Date.now()})},cfg.autoLogoutMin*60000)};const evs=["mousedown","keydown","touchstart","scroll"];evs.forEach(e=>window.addEventListener(e,reset,{passive:true}));reset();return()=>{clearTimeout(t);evs.forEach(e=>window.removeEventListener(e,reset))}},[s,cfg.autoLogoutMin,logout]);if(!rdy)return<div style={{minHeight:"100vh",background:bg,display:"flex",alignItems:"center",justifyContent:"center"}}><GS p={DEF.primaryColor} a={DEF.accentColor}/><div style={{textAlign:"center",animation:"pu 1.5s infinite"}}><div className="av" style={{width:60,height:60,fontSize:28,margin:"0 auto",background:bg}}>🫧</div><div style={{color:"var(--lh-text3)",marginTop:8,fontSize:12}}>Connecting...</div></div></div>;return<><GS p={cfg.primaryColor} a={cfg.accentColor} rm={cfg.reduceMotion} textColor={cfg.textColor} uiScale={cfg.uiScale}/><GlobalConfirm/>{td&&<Toast key={td.key} message={td.message} type={td.type} onClose={()=>sTD(null)}/>}{!s?<Login cfg={cfg} onLogin={login}/>:s.role==="admin"?<AdminDash cfg={cfg} setCfg={sCfg} onOut={logout} toast={toast}/>:<UserDash user={s} cfg={cfg} onOut={logout} toast={toast}/>}</>;
}
