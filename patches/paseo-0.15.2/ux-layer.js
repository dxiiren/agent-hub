/*agent-hub-rev:22*/(function(){const __go=function(){
// Agent Hub UX layer (patch rev 10): an in-app confirm dialog, a friendly page for addresses that show nothing, and plain-English labels for hub-internal names.
try{
if(typeof document==="undefined")return;
// App diagnostic text (Settings > Diagnostics > Run): the machine PATH list, user names in folder paths and long raw log lines are not needed to get help, so they are shortened before the text is shown or copied
globalThis.__ahDiag=q=>String(q).split("\n").map(l=>/^\s*PATH:\s/.test(l)?"  PATH: (hidden, "+l.split(";").length+" folders)":l).map(l=>l.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g,"$1<user>").replace(/(\/(?:Users|home)\/)[^\/\s"']+/g,"$1<user>")).map(l=>/^\s*\{"level":/.test(l)&&l.length>240?l.slice(0,240)+" ...":l).join("\n");
// First start of the New workspace composer: with no earlier choice it says "Select model". Preselect Claude's newest model ("Latest release" in the daemon's own list, cached by the app from an earlier visit); a choice the user already made is never touched.
const pre=()=>{try{if(!localStorage.getItem("@paseo:create-agent-preferences")){for(const k of Object.keys(localStorage)){if(k.indexOf("@paseo/provider-snapshot/v2:")!==0)continue;const es=(JSON.parse(localStorage.getItem(k)).compactSnapshot||{}).entries||[],e=es.find(x=>x.provider==="claude"&&x.enabled!==false),m=e&&(e.models||[]).find(m=>/latest release/i.test(m.description||"")&&m.isSelectable!==false);if(m){localStorage.setItem("@paseo:create-agent-preferences",JSON.stringify({provider:"claude",providerPreferences:{claude:{model:m.id}},isolation:"local",launchTarget:{kind:"chat"}}));return true}}}}catch(e){}return false};
// a brand-new browser has no cached model list when the page first loads: it arrives a few seconds later, so the choice is made then, and the page reloads once (only while the composer is empty and still says "Select model") so the composer picks it up
pre();
const preTick=()=>{try{if(!pre())return;if(sessionStorage.getItem("ah-pre"))return;const t=document.body.innerText||"";if(!/Select model/.test(t))return;if([...document.querySelectorAll("textarea,input")].some(e=>(e.value||"").length>0))return;sessionStorage.setItem("ah-pre","1");location.reload()}catch(e){}};
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
// Search (Cmd/Ctrl+K): the settings pages are searchable too, "Settings: Providers", "Settings: Usage", ... (shown once something is typed; Enter opens the page)
globalThis.__ahSettingsActions=(push,Icon)=>{
  const host=()=>{const m=location.pathname.match(/\/(?:settings\/hosts|h)\/([^/]+)/);if(m)return m[1];try{const r=JSON.parse(localStorage.getItem("@paseo:daemon-registry")||"[]");return r[0]&&r[0].serverId}catch(e){return null}};
  const APP=[["General","general","language startup updates"],["Appearance","appearance","theme dark light font size colors"],["Sidebar","sidebar","badge navigation items footer"],["Chat","chat","messages detail level collapse send behaviour"],["Terminal","terminal","shell scrollback"],["Editor","editor","code editor"],["Files","files","file panels"],["Diagnostics","diagnostics","logs help support run"],["About","about","version"]];
  const HOST=[["Overview","host","restart host name remove"],["Projects","projects","folders repositories delete remove"],["Connections","connections","address password pair"],["Pair device","pair-device","phone qr code"],["Agents","agents","profiles"],["Metadata","metadata","labels"],["Voice","voice","dictation speech"],["Workspaces","workspaces","worktrees"],["Providers","providers","models claude codex qwen add provider catalog endpoint"],["Usage","usage","limits plan credits tokens cost"],["Terminals","terminals","terminal profiles shell"],["Plugins","plugins","plugin gate install extensions"]];
  const mk=(label,rank,kw,path)=>({id:"settings-"+label.toLowerCase().replace(/\W+/g,"-"),group:"actions",groupRank:0,rank,keywords:["settings","setting",...label.toLowerCase().split(" "),...kw.split(" ")],visibility:"query",run:()=>{const p=path();if(p)push(p)},presentation:{kind:"action",title:"Settings: "+label,sectionTitle:"Actions",icon:Icon}});
  return [...APP.map((a,i)=>mk(a[0],20+i,a[2],()=>"/settings/"+a[1])),...HOST.map((a,i)=>mk(a[0],40+i,a[2],()=>{const h=host();return h?"/settings/hosts/"+h+"/"+a[1]:null}))];
};
// plain-English labels for names that only make sense inside the hub
const MAP=[[/\(clean MCP\)/g,"(hub tasks)"],[/\(no user MCP\)/g,"(hub tasks)"],[/^opus\[1m\]$/,"Custom model (from your Claude settings)"],[/^From Claude settings\.json model$/,"Set in your Claude settings"],
 [/^Could not load the model list: Provider .+ is disabled\.?$/,"This provider is switched off. Switch it on in the Providers list first, then add a model."],
 [/^0\.00x Credit$/,"Free (uses no credits)"],[/^([\d.]+)x Credit$/,"$1x credit cost"],
 [/^agent-hub-[a-z]+ · (.+)$/,"$1"],
 [/^This plugin settings screen is unavailable\.?$/,"This plugin is switched off or not loaded, so its page is not available. Switch it on under Plugins, then open this page again."],
 [/^Connect to this host to open plugin settings\.?$/,"The host is not connected right now. This page reconnects by itself; anything you typed here is not saved yet."],
 [/^(.+?) not found on PATH$/,"$1 is not installed on this computer (not found on PATH). Install it, or switch this provider off."],
 [/^Provider (.+) is not installed\.?$/,"$1 is not installed on this computer."],
 [/^(.+?) \(([a-z0-9. -]+)\)$/i,(m,a,b)=>a.toLowerCase().includes(b.toLowerCase())&&a.length>b.length?a:m]];
const LONG=[[/^Request failed: Plugin manifest is missing:.*$/s,"That is not a plugin folder: it has no paseo-plugin.json file. Choose the plugin's own folder, a Git URL or an npm package that is a Paseo plugin."],
 [/^.*Plugin ID "([^"]+)" is already configured.*$/s,"A plugin with the ID $1 is already installed. Remove it first, or install a different plugin."],
 [/^Request failed: .*code=handler_error.*$/s,"The plugin could not be installed. Check the folder, URL or package name and try again."],
 [/^npm error.*$/s,"The package could not be downloaded from npm. Check the name and your internet connection."]];
function rewrite(root){
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const v=n.nodeValue;if(!v||v.length>4000)continue;let o=v;for(const [re,to] of LONG)o=o.replace(re,to);if(o!==v){n.nodeValue=o;continue}if(v.length>200)continue;for(const [re,to] of MAP)o=o.replace(re,to);if(o!==v){try{if(/mono|courier/i.test(getComputedStyle(n.parentElement).fontFamily))continue}catch(e){}n.nodeValue=o}}
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
// while the hub does not answer at all, say so (instead of "Connect to <host> to see usage"), and that the page recovers by itself
const DOWN="The hub is not answering right now. This page loads by itself as soon as it is back.";
let hubDown=false,downAt=0;
function downCheck(){
  const t=document.body.innerText||"";
  if(!/Plugin host is offline|Connect to .{1,60} to see (usage|providers)|Connecting(\s+to)?\s+\S+|^No active schedules$/m.test(t)&&!hubDown)return;
  if(Date.now()-downAt<2500)return;downAt=Date.now();
  fetch("/api/health",{cache:"no-store"}).then(r=>{hubDown=!r.ok}).catch(()=>{hubDown=true});
}
const downOrig=new Map(); // a replaced text goes back once the hub answers again (React would not redraw an unchanged node)
function downText(){
  if(!hubDown){downOrig.forEach((v,n)=>{n.nodeValue=v});downOrig.clear();return}
  const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
  while((n=w.nextNode())){const v=(n.nodeValue||"").trim();if(/^Connect to .{1,60} to see (usage|providers)\.?$/.test(v)||/^The host is still connecting, or its plugin service is restarting/.test(v)||/^Reconnect to this host to manage its plugins/.test(v)||/^No active schedules$/.test(v)){if(!downOrig.has(n))downOrig.set(n,n.nodeValue);n.nodeValue=DOWN}}
}
let strikes=0;
// a short note while the page greys out (plugin Reload takes a moment and disables the whole list)
function toast(msg,ms){const e=document.createElement("div");e.setAttribute("data-testid","ah-toast");e.setAttribute("role","status");e.style.cssText="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147482000;background:#18181b;color:#fff;border-radius:10px;padding:10px 16px;font:14px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)";e.textContent=msg;document.body.appendChild(e);setTimeout(()=>e.remove(),ms||3500)}
// Paseo reports "failed" for a moment while a reloading plugin restarts (it showed for up to 4 s, then "running"): for 25 s after Reload that word reads "starting..." (a plugin that is still failed after that shows the real "failed")
const reloading={};let lastPlug="";
document.addEventListener("click",ev=>{try{const E=ev.target&&ev.target.closest?ev.target:null;if(!E||!/\/plugins$/.test(location.pathname))return;const a=E.closest('[aria-label^="Actions for "]');if(a)lastPlug=a.getAttribute("aria-label").slice(12);const sw=E.closest('[role="switch"][aria-label]');if(sw){const l=sw.getAttribute("aria-label");if(/ plugins$/.test(l))document.querySelectorAll('[data-testid^="plugin-row-"]').forEach(r=>{reloading[r.getAttribute("data-testid").slice(11)]=Date.now()});else reloading[l.split(":")[0]]=Date.now()}const t=E.closest('[role="menuitem"]');if(t&&(t.textContent||"").trim()==="Reload"){reloading[lastPlug]=Date.now();toast("Reloading the plugin: the list is greyed out for a few seconds.")}const c=E.closest('[data-testid="ah-dialog-confirm"]');if(c){const h=c.closest(".ah-card");if(h&&/^Remove /.test((h.querySelector("h2")||{}).textContent||""))toast("Removing the plugin...")}}catch(e){}},true);
let connAt=0;
function connectingHint(){
  const t=document.body.innerText||"",busy=/^\s*Connecting(\s+to)?\s+\S+/m.test(t)&&t.length<400;
  const id="ah-conn";let e=document.getElementById(id);
  if(!busy){connAt=0;if(e)e.remove();return}
  if(!connAt)connAt=Date.now();
  if(Date.now()-connAt>15000&&!e){e=document.createElement("div");e.id=id;e.setAttribute("data-testid","ah-connecting-hint");e.style.cssText="position:fixed;left:"+(innerWidth>=768?320:0)+"px;right:0;bottom:24px;text-align:center;font:14px system-ui,sans-serif;opacity:.75;padding:0 16px";e.textContent="Still connecting. The host may be busy or starting up; this page keeps trying by itself.";document.body.appendChild(e)}
}
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
const tick=()=>{sched=0;try{rewrite(document.body)}catch(e){}try{downText()}catch(e){}try{polish()}catch(e){}};
new MutationObserver(()=>{if(!sched)sched=setTimeout(tick,120)}).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:["aria-checked"]});
setInterval(()=>{try{check();downCheck();offlineRetry();connectingHint();preTick()}catch(e){}},1200);
// polish applied to elements as they appear
function polish(){
  const path=location.pathname;
  if(/\/plugins$/.test(path))document.querySelectorAll('[data-testid^="plugin-row-"]').forEach(row=>{const at=reloading[row.getAttribute("data-testid").slice(11)];if(!at||Date.now()-at>25000)return;const w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode()))if((n.nodeValue||"").trim()==="failed")n.nodeValue="starting..."});
  // model dialog: a model whose label is its id would print the id twice side by side; the grey id after the name is dropped then
  document.querySelectorAll('[role="dialog"] div,[role="dialog"] span').forEach(e=>{if(e.children.length||e.style.display==="none")return;const t=(e.textContent||"").trim(),p=e.previousElementSibling;if(t&&p&&!p.children.length&&(p.textContent||"").trim()===t&&/mono|courier|consolas/i.test(getComputedStyle(e).fontFamily))e.style.display="none"});
  // an endpoint provider whose server does not answer: its launcher exits with code 75 after a live check, and Paseo only says "exited before initialization". Say what happened, with the time of the check, and name the button "Check again".
  if(/\/providers$/.test(path)){
    const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;
    const idOf=el=>{for(let e=el;e&&e!==document.body;e=e.parentElement){const a=e.querySelectorAll('[data-testid^="provider-actions-"]');if(a.length===1)return a[0].getAttribute("data-testid").slice(17);if(a.length>1)break}return null};
    const stamp=id=>{let best=0;try{for(const k of Object.keys(localStorage)){if(k.indexOf("@paseo/provider-snapshot/v2:")!==0)continue;const f=(JSON.parse(localStorage.getItem(k)).fetchedAt||{})[id];if(f&&Date.parse(f)>best)best=Date.parse(f)}}catch(e){}const d=new Date(best||Date.now());return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")};
    while((n=w.nextNode())){const v=n.nodeValue||"";
      if(/^ACP agent process exited before initialization completed \(exit code 75\)/.test(v)){const id=idOf(n.parentElement);n.nodeValue="Not answering (checked "+stamp(id)+"): nothing replied from this endpoint. Start it or check its Base URL, then press Check again."}
      else if(v.trim()==="Retry"&&idOf(n.parentElement))n.nodeValue="Check again"}
  }
  // a provider that is switched off cannot load models, so the useless Retry button next to that message is hidden
  document.querySelectorAll('[data-testid="model-picker-error"]').forEach(e=>{if(/switched off/.test(e.textContent||"")){const b=e.parentElement&&e.parentElement.querySelector("button");if(b&&b.style.display!=="none")b.style.display="none"}});
  // Providers page: a status that is only a word gets an explanation on hover, and a jump link to the "Add provider" list (it sits far down)
  if(/\/providers$/.test(path)){
    document.querySelectorAll("div").forEach(e=>{if(e.children.length)return;const t=(e.textContent||"").trim();if(t==="Agent Hub")e.title="Set up through the hub's own short form: adds another model, endpoint or account.";else if(t==="Agent CLI")e.title="A command-line coding agent. Its program must be installed on this computer first.";else if(t==="Disabled")e.title="Switched off. Turn the switch on to use this provider.";else if(t==="Not installed")e.title="The program for this provider is not on this computer."});
    if(!document.getElementById("ah-jump")){
      const h=[...document.querySelectorAll("div")].find(e=>!e.children.length&&(e.textContent||"").trim()==="Add provider"&&e.getBoundingClientRect().height>0&&e.getBoundingClientRect().top>200);
      const title=[...document.querySelectorAll("div")].find(e=>!e.children.length&&(e.textContent||"").trim()==="Providers"&&parseFloat(getComputedStyle(e).fontSize)>=24);
      if(h&&title&&title.parentElement){const b=document.createElement("button");b.id="ah-jump";b.type="button";b.className="ah-btn";b.style.cssText="margin:6px 0 0;align-self:flex-start";b.textContent="Add a provider ↓";b.onclick=()=>{const t=[...document.querySelectorAll("div")].find(e=>!e.children.length&&(e.textContent||"").trim()==="Add provider"&&e.getBoundingClientRect().height>0&&e.id!=="ah-jump");if(t)t.scrollIntoView({behavior:"smooth",block:"start"})};title.parentElement.insertBefore(b,title.nextSibling)}
    }
  }else{const j=document.getElementById("ah-jump");if(j)j.remove()}
  // catalog: Paseo already hides a CLI entry once it is installed; a hub entry can be added many times, so its tile says how many of that kind are already in "Installed providers" ("2 added", button "Add another")
  if(/\/providers$/.test(path)){const BUILTIN=new Set(["claude","codex","copilot","opencode","pi","omp","antigravity","muse"]);const ids=[...document.querySelectorAll('[data-testid^="provider-actions-"]')].map(e=>e.getAttribute("data-testid").slice(17));
    document.querySelectorAll('[data-testid^="provider-catalog-tile-agent-hub-"]').forEach(tile=>{const kind=tile.getAttribute("data-testid").slice(32),b=tile.querySelector('[data-testid^="install-provider-"]');if(!b)return;
      const n=ids.filter(i=>!BUILTIN.has(i)&&(i===kind||i.startsWith(kind+"-"))).length;let tag=tile.querySelector("[data-ah-added]");
      if(n>0){if(!tag){tag=document.createElement("div");tag.setAttribute("data-ah-added","1");tag.style.cssText="font-size:12px;opacity:.75";const nm=[...tile.querySelectorAll("div")].find(e=>!e.children.length&&(e.textContent||"").trim()&&e.getBoundingClientRect().height>0);if(nm&&nm.parentElement)nm.parentElement.appendChild(tag)}
        if(tag)tag.textContent="Already added: "+n;const w2=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let x;while((x=w2.nextNode()))if(/^Add$/.test(x.nodeValue.trim()))x.nodeValue="Add another"}
      else if(tag){tag.remove();const w2=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let x;while((x=w2.nextNode()))if(x.nodeValue.trim()==="Add another")x.nodeValue="Add"}})}
  // account e-mails on the Usage cards are masked (a shared screen or a screenshot must not show them); hover shows the full address
  if(/\/usage$/.test(location.pathname)){const w0=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n0;while((n0=w0.nextNode())){const m=(n0.nodeValue||'').match(/^(\d{2,3})% used$/);if(m&&+m[1]>=90)n0.nodeValue=m[1]+'% used - '+(+m[1]>=100?'full':'almost full')+', tasks on this plan may be refused until it resets'}}
  if(/\/usage$/.test(location.pathname)){const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){const m=(n.nodeValue||"").match(/^\s*([\w.+-]{2,})@([\w-]+(?:\.[\w-]+)+)\s*$/);if(m&&n.parentElement){n.parentElement.title=m[1]+"@"+m[2];n.nodeValue=m[1][0]+"***@"+m[2]}}}
  document.querySelectorAll('[role="switch"][aria-label]').forEach(e=>{const l=e.getAttribute("aria-label"),on=e.getAttribute("aria-checked")==="true",m=l.match(/^(?:Enable|Disable) (.+)$/);if(m){const w=(on?"Disable ":"Enable ")+m[1];if(w!==l)e.setAttribute("aria-label",w)}});
  document.querySelectorAll('div,span').forEach(e=>{if(e.children.length===0&&/^Updated /.test(e.textContent||"")&&e.style.whiteSpace!=="normal"){e.style.whiteSpace="normal";e.style.textOverflow="clip";e.style.overflow="visible"}});
  if(/\/settings\/hosts\/[^/]+\/host$/.test(location.pathname))document.querySelectorAll("input[type=text],input:not([type])").forEach(e=>{if(!e.maxLength||e.maxLength<0)e.maxLength=60});
}
// icon-only buttons get a hover tooltip from their accessible name
new MutationObserver(()=>{document.querySelectorAll('[aria-label]:not([title])').forEach(e=>{if(!(e.innerText||'').trim())e.title=e.getAttribute('aria-label')})}).observe(document.documentElement,{childList:true,subtree:true});
}catch(e){try{console.warn("agent-hub ux layer",e)}catch(_){}}
};if(typeof document!=="undefined"){if(document.body)__go();else document.addEventListener("DOMContentLoaded",__go)}})();
process.env=process.env||{};process.env.NODE_ENV=process.env.NODE_ENV||"production";
