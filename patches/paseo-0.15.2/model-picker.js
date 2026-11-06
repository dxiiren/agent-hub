/*agent-hub-rev:2*/function __AhPick(p){
  // Add custom model (Settings > Providers > provider > Add model): a picker instead of a free-text box.
  // Source of the list: the agent-hub-providers plugin RPC "provider-models" (endpoint kinds: the endpoint's /v1/models, fetched by the daemon so keys stay server-side);
  // anything else: the daemon's own model list for that provider (the same catalog behind "N models"). Free text only through the last entry.
  const [st,setSt]=(0,d.useState)({s:"load"}),[pick,setPick]=(0,d.useState)(""),[tick,setTick]=(0,d.useState)(0),cl=(0,C.useHostRuntimeClient)(p.__s);
  (0,d.useEffect)(()=>{
    if(!p.__v)return;
    let live=!0;setSt({s:"load"});setPick("");
    (async()=>{
      let list=null,err=null,r=null;
      if(cl){try{r=await cl.invokePluginRpc("agent-hub-providers","agent-hub-providers.call",{verb:"provider-models",args:{provider:p.__p}})}catch(e){r=null}}
      if(r&&Array.isArray(r.models))list=r.models;else if(r&&r.error)err=String(r.error);
      if(!list&&!err){
        if(!cl)err="Not connected to the daemon.";
        else try{const q=await cl.listProviderModels(p.__p);if(q&&q.error)err=String(q.error);else list=(q&&q.models)||[]}catch(e){err=String(e&&e.message||e)}
      }
      if(!live)return;
      if(err)setSt({s:"err",err});
      else{const have=new Set((p.__e||[]).map(x=>x.id));setSt({s:"ok",list:list.filter(m=>m&&m.id&&!have.has(m.id))})}
    })();
    return()=>{live=!1};
  },[p.__v,p.__p,cl,tick]);
  const c=p.__c,box={width:"100%",boxSizing:"border-box",padding:"10px 12px",borderRadius:8,border:"1px solid "+c.border,background:c.surface2,color:c.foreground,fontSize:14},
    note={fontSize:13,color:c.foregroundMuted},bad={fontSize:13,color:c.destructive};
  if(st.s==="load")return(0,z.jsx)("div",{style:note,"data-testid":"model-picker-loading",children:"Loading models..."});
  if(st.s==="err")return(0,z.jsxs)("div",{style:{display:"grid",gap:8},children:[
    (0,z.jsx)("div",{style:bad,"data-testid":"model-picker-error",children:"Could not load the model list: "+st.err}),
    (0,z.jsx)("button",{type:"button",style:{...box,width:"auto",cursor:"pointer"},onClick:()=>setTick(x=>x+1),children:"Retry"}),
    p.__f]});
  const custom=pick==="__custom__";
  return(0,z.jsxs)("div",{style:{display:"grid",gap:8},children:[
    (0,z.jsxs)("select",{"data-testid":"model-picker",style:box,value:pick,onChange:ev=>{const v=ev.target.value;setPick(v);p.__t(v==="__custom__"?"":v)},children:[
      (0,z.jsx)("option",{value:"",children:st.list.length?"Choose a model ("+st.list.length+")":"No other models offered"}),
      ...st.list.map(m=>(0,z.jsx)("option",{value:m.id,children:m.label&&m.label!==m.id?m.label+" ("+m.id+")":m.id},m.id)),
      (0,z.jsx)("option",{value:"__custom__",children:"Custom model id..."})]}),
    custom?p.__f:null]});
}
function B(s){const n=(0,o.c)(65),{provider:l,serverId:f,visible:m,onClose:h,refresh:v}=s