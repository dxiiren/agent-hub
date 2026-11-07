/*agent-hub-rev:10*/(function(){const __go=function(){
// Agent Hub UX layer (patch rev 10): an in-app confirm dialog, a friendly page for addresses that show nothing, and plain-English labels for hub-internal names.
try{
if(typeof document==="undefined")return;
const css=document.createElement("style");
css.textContent=".ah-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}"
+".ah-card{max-width:440px;width:100%;box-sizing:border-box;background:var(--ah-bg,#fff);color:var(--ah-fg,#18181b);border:1px solid var(--ah-bd,#e4e4e7);border-radius:12px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,.3)}"
+".ah-card h2{margin:0 0 8px;font-size:17px;font-weight:600}.ah-card p{margin:0 0 16px;font-size:14px;line-height:1.45;opacity:.85;white-space:pre-wrap;word-break:break-word}"
+".ah-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.ah-btn{font-family:inherit;line-height:1.2;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid var(--ah-bd,#d4d4d8);background:transparent;color:inherit;cursor:pointer}"
+".ah-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}.ah-pri{background:#166534;border-color:#166534;color:#fff}.ah-dng{background:#b91c1c;border-color:#b91c1c;color:#fff}"
+"@media (prefers-color-scheme:dark){.ah-card{--ah-bg:#1c1c1f;--ah-fg:#f4f4f5;--ah-bd:#3f3f46}}";
document.head.appendChild(css);
const dark=()=>{try{for(const e of document.elementsFromPoint(Math.min(innerWidth-5,700),Math.min(innerHeight-5,400))){const c=(getComputedStyle(e).backgroundColor.match(/[\d.]+/g)||[]).map(Number);if(c.length>=3&&(c.length<4||c[3]>.5))return c[0]+c[1]+c[2]<300}}catch(e){}return matchMedia("(prefers-color-scheme: dark)").matches};
function dialog(title,body,buttons){return new Promise(res=>{
  const ov=document.createElement("div");ov.className="ah-ov";ov.setAttribute("role","dialog");ov.setAttribute("aria-modal","true");ov.setAttribute("data-testid","ah-dialog");
  const card=document.createElement("div");card.className="ah-card";if(dark()){card.style.setProperty("--ah-bg","#1c1c1f");card.style.setProperty("--ah-fg","#f4f4f5");card.style.setProperty("--ah-bd","#3f3f46")}
  const h=document.createElement("h2");h.textContent=title;const p=document.createElement("p");p.textContent=body;const row=document.createElement("div");row.className="ah-row";
  const prev=document.activeElement;const done=v=>{document.removeEventListener("keydown",key,true);ov.remove();try{prev&&prev.focus&&prev.focus()}catch(e){}res(v)};
  const key=ev=>{if(ev.key==="Escape"){ev.preventDefault();ev.stopPropagation();done(buttons[0].value)}};
  let first;buttons.forEach((b,i)=>{const el=document.createElement("button");el.type="button";el.className="ah-btn"+(b.cls?" "+b.cls:"");el.textContent=b.label;el.setAttribute("data-testid","ah-dialog-"+(b.id||i));el.onclick=()=>done(b.value);row.appendChild(el);if(b.focus)first=el});
  card.append(h,p,row);ov.appendChild(card);ov.addEventListener("mousedown",ev=>{if(ev.target===ov)done(buttons[0].value)});
  document.addEventListener("keydown",key,true);document.body.appendChild(ov);(first||row.lastChild).focus();
})}
// confirmDialog's web fallback (replaces the browser's own confirm box): o = {title,message,confirmLabel,cancelLabel,destructive}
globalThis.__ahConfirm=o=>dialog(o.title||"Are you sure?",o.message||"",[{id:"cancel",label:o.cancelLabel||"Cancel",value:false,focus:!o.destructive},{id:"confirm",label:o.confirmLabel||"Confirm",value:true,cls:o.destructive?"ah-dng":"ah-pri",focus:!!o.destructive}]);
// plain-English labels for names that only make sense inside the hub
const MAP=[[/\(clean MCP\)/g,"(hub tasks)"],[/\(no user MCP\)/g,"(hub tasks)"],[/^opus\[1m\]$/,"Custom model (from your Claude settings)"],[/^From Claude settings\.json model$/,"Set in your Claude settings"],
 [/^Could not load the model list: Provider .+ is disabled\.?$/,"This provider is switched off. Switch it on in the Providers list first, then add a model."],
 [/^0\.00x Credit$/,"Free (uses no credits)"],[/^([\d.]+)x Credit$/,"$1x credit cost"],
 [/^(.+?) \(([a-z0-9. -]+)\)$/i,(m,a,b)=>a.toLowerCase().includes(b.toLowerCase())&&a.length>b.length?a:m]];
function rewrite(root){
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const v=n.nodeValue;if(!v||v.length>200)continue;let o=v;for(const [re,to] of MAP)o=o.replace(re,to);if(o!==v)n.nodeValue=o}
}
// an address that shows nothing: say so and offer a way back
let lastPath="",timer=0;
const NOTICE="ah-notice";
function hideNotice(){const e=document.getElementById(NOTICE);if(e)e.remove()}
function emptyPane(){
  let chars=0;const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const t=(n.nodeValue||"").trim();if(!t)continue;const r=n.parentElement&&n.parentElement.getBoundingClientRect();if(r&&r.width>0&&r.height>0&&r.left>340)chars+=t.length}
  return chars<3;
}
// pages that say "offline" / "Connect to <host> to see usage" while the host is in fact reachable: retry by reloading (at most 12 times per tab, 5 s apart)
let relAt=0;
function offlineRetry(){
  const t=document.body.innerText||"";
  if(!/Plugin host is offline|Connect to .{1,60} to see (usage|providers)/.test(t))return;
  let c=0;try{c=+sessionStorage.getItem("ah-off-c")||0}catch(e){}
  if(c>=12||Date.now()-relAt<5000)return;relAt=Date.now();
  fetch("/api/health",{cache:"no-store"}).then(r=>{if(r.ok){try{sessionStorage.setItem("ah-off-c",String(c+1))}catch(e){}location.reload()}}).catch(()=>{});
}
let strikes=0;
function check(){
  const p=location.pathname;if(p!==lastPath){lastPath=p;strikes=0;hideNotice()}
  if(!/^\/(settings|h)\//.test(p)){return}
  const empty=emptyPane();
  if(!empty){strikes=0;hideNotice();return}
  if(document.getElementById(NOTICE)||++strikes<3)return; // empty for 3 checks in a row (about 4 s), so a page that is still loading is never mislabelled
  const ov=document.createElement("div");ov.id=NOTICE;ov.setAttribute("data-testid","ah-not-found");
  ov.style.cssText="position:fixed;top:0;bottom:0;right:0;left:320px;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:none";
  const c=document.createElement("div");c.className="ah-card";c.style.pointerEvents="auto";if(dark()){c.style.setProperty("--ah-bg","#1c1c1f");c.style.setProperty("--ah-fg","#f4f4f5");c.style.setProperty("--ah-bd","#3f3f46")}
  const h=document.createElement("h2");h.textContent="This page does not exist";const q=document.createElement("p");q.textContent="The address may be mistyped, or the item was removed. Nothing is wrong with the hub.";
  const row=document.createElement("div");row.className="ah-row";
  const mk=(l,go,cls)=>{const b=document.createElement("button");b.type="button";b.className="ah-btn "+cls;b.textContent=l;b.onclick=go;return b};
  row.append(mk("Go back",()=>{history.length>1?history.back():(location.href="/")},""),mk(/^\/settings/.test(p)?"Open settings":"Go to start page",()=>{location.href=/^\/settings/.test(p)?"/settings/general":"/"},"ah-pri"));
  c.append(h,q,row);ov.appendChild(c);document.body.appendChild(ov);
}
let sched=0;
const tick=()=>{sched=0;try{rewrite(document.body)}catch(e){}};
new MutationObserver(()=>{if(!sched)sched=setTimeout(tick,120)}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
setInterval(()=>{try{check();offlineRetry()}catch(e){}},1200);
// icon-only buttons get a hover tooltip from their accessible name
new MutationObserver(()=>{document.querySelectorAll('[aria-label]:not([title])').forEach(e=>{if(!(e.innerText||'').trim())e.title=e.getAttribute('aria-label')})}).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){try{console.warn("agent-hub ux layer",e)}catch(_){}}
};if(typeof document!=="undefined"){if(document.body)__go();else document.addEventListener("DOMContentLoaded",__go)}})();
process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||"production";
