export function inspectorHtml(nonce: string, codebaseMemoryUrl: string): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Boron Content Inspector</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; --bg:#09100e; --panel:#111a17; --panel2:#16211d; --line:#2b3833; --text:#f4f7f5; --muted:#b8c1bd; --subtle:#89948f; --acid:#a8ff4f; --cyan:#6bc7d9; --warn:#ffc764; --danger:#ff7d75; }
    * { box-sizing:border-box; }
    html,body { margin:0; width:100%; height:100%; overflow:hidden; background:var(--bg); color:var(--text); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input,select,textarea { font:inherit; }
    button { color:inherit; }
    .shell { height:100%; display:grid; grid-template-rows:64px 1fr; }
    header { display:flex; align-items:center; gap:26px; padding:0 22px; border-bottom:1px solid var(--line); background:#0c1411; }
    .brand { display:flex; align-items:center; gap:12px; min-width:230px; }
    .mark { width:34px; height:34px; display:grid; place-items:center; border-radius:10px; background:var(--acid); color:#08100c; font-weight:900; }
    .brand strong { font-size:15px; letter-spacing:.12em; }
    .brand small { display:block; color:var(--muted); margin-top:1px; }
    nav { display:flex; gap:5px; height:100%; align-items:center; }
    nav button { border:0; background:transparent; color:var(--muted); padding:10px 13px; border-radius:9px; cursor:pointer; }
    nav button:hover,nav button.active { background:var(--panel2); color:var(--text); }
    nav button.active { box-shadow:inset 0 -2px var(--acid); }
    .spatial-link { margin-left:auto; border:1px solid #58705f; border-radius:9px; background:#17241e; color:var(--acid); padding:8px 11px; text-decoration:none; font-size:12px; font-weight:800; white-space:nowrap; }
    .spatial-link:hover { border-color:var(--acid); }
    .status { color:var(--muted); font-size:12px; }
    .status.ok::before { content:""; display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--acid); margin-right:7px; }
    main { min-height:0; }
    .view { display:none; width:100%; height:100%; }
    .view.active { display:grid; }
    #ontology { grid-template-columns:230px minmax(500px,1fr) 330px; }
    #codebase { grid-template-columns:minmax(620px,1fr) 340px; }
    #wiki { grid-template-columns:260px minmax(480px,1fr) 330px; background:#edf0ec; color:#18201c; }
    #review { grid-template-columns:340px minmax(500px,1fr); }
    #telemetry { grid-template-columns:1fr; overflow:auto; padding:28px; }
    .rail,.detail { min-width:0; overflow:auto; background:var(--panel); border-right:1px solid var(--line); padding:18px; }
    .detail { border-right:0; border-left:1px solid var(--line); }
    .eyebrow { color:var(--subtle); font-size:10px; font-weight:800; letter-spacing:.15em; text-transform:uppercase; margin-bottom:8px; }
    h1,h2,h3,p { margin-top:0; }
    h2 { font-size:17px; margin-bottom:7px; }
    .muted { color:var(--muted); }
    .field { display:grid; gap:6px; margin:13px 0; }
    .field label { color:var(--muted); font-size:12px; font-weight:650; }
    input,select,textarea { width:100%; border:1px solid #3a4842; background:#0b1310; color:var(--text); border-radius:8px; padding:9px 10px; outline:none; }
    input:focus,select:focus,textarea:focus { border-color:var(--acid); box-shadow:0 0 0 2px #a8ff4f22; }
    textarea { min-height:110px; resize:vertical; }
    .button { border:1px solid #4c5b55; background:#18231f; border-radius:9px; padding:9px 12px; cursor:pointer; font-weight:700; }
    .button:hover { border-color:#718179; background:#1d2a25; }
    .button.primary { color:#0a120e; border-color:var(--acid); background:var(--acid); }
    .button.wide { width:100%; }
    .button:disabled { opacity:.45; cursor:not-allowed; }
    .project-list,.result-list,.page-list,.correction-list { display:grid; gap:7px; }
    .list-item { text-align:left; border:1px solid transparent; background:#121d19; border-radius:9px; padding:10px; cursor:pointer; color:var(--text); }
    .list-item:hover,.list-item.active { background:#1b2923; border-color:#405149; }
    .list-item strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .list-item small { display:block; color:var(--muted); margin-top:3px; overflow:hidden; text-overflow:ellipsis; }
    .stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:16px 0; }
    .stat { background:#0d1612; border:1px solid var(--line); border-radius:9px; padding:10px; }
    .stat strong { display:block; font-size:18px; color:var(--acid); }
    .graph-wrap { position:relative; overflow:hidden; background:radial-gradient(circle at 52% 45%,#17231f 0,#0a110f 58%,#070c0a 100%); }
    #ontologyGraph { width:100%; height:100%; min-height:500px; }
    .graph-toolbar { position:absolute; top:15px; left:15px; right:15px; z-index:2; display:flex; gap:8px; align-items:center; pointer-events:none; }
    .graph-toolbar > * { pointer-events:auto; }
    .graph-legend { margin-left:auto; background:#0d1612e8; border:1px solid var(--line); border-radius:9px; padding:7px 10px; color:var(--muted); font-size:11px; }
    .edge { stroke:#557067; stroke-opacity:.50; stroke-width:1.3; marker-end:url(#arrow); }
    .edge.candidate { stroke:var(--warn); stroke-dasharray:5 5; }
    .edge-label { fill:#c3cdc8; font-size:10px; font-weight:650; cursor:pointer; paint-order:stroke; stroke:#09100e; stroke-width:4px; }
    .node circle { stroke:#0b120f; stroke-width:3; cursor:pointer; }
    .node text { fill:#f4f8f6; font-size:12px; font-weight:750; pointer-events:none; paint-order:stroke; stroke:#09100e; stroke-width:5px; }
    .node.selected circle { stroke:var(--acid); stroke-width:5; }
    .badge { display:inline-flex; border:1px solid #52625b; color:var(--muted); border-radius:999px; padding:3px 7px; font-size:10px; }
    .badge.pending { color:var(--warn); border-color:#7d673a; }
    .empty { padding:20px; border:1px dashed #45534d; border-radius:10px; color:var(--muted); }
    .code-frame { min-width:0; height:100%; background:#050807; }
    .code-frame iframe { width:100%; height:100%; border:0; }
    .code-side { overflow:auto; background:var(--panel); border-left:1px solid var(--line); padding:18px; }
    .wiki-rail { overflow:auto; background:#f7f8f6; border-right:1px solid #d8ddd8; padding:20px 16px; }
    .wiki-rail .eyebrow,.wiki-rail .muted { color:#69736d; }
    .wiki-rail .list-item { background:transparent; color:#26302a; border-radius:7px; }
    .wiki-rail .list-item:hover,.wiki-rail .list-item.active { background:#e2e9e1; border-color:#cbd5cb; }
    .wiki-rail .list-item small { color:#717c75; }
    .wiki-doc { overflow:auto; background:#fff; padding:44px clamp(28px,6vw,82px); }
    .wiki-doc article { max-width:850px; margin:0 auto; color:#202823; font-size:15px; line-height:1.72; }
    .wiki-doc h1 { font-size:34px; line-height:1.18; margin:0 0 24px; letter-spacing:-.025em; }
    .wiki-doc h2 { font-size:23px; margin:34px 0 12px; padding-top:8px; border-top:1px solid #edf0ed; }
    .wiki-doc h3 { font-size:18px; margin:25px 0 8px; }
    .wiki-doc code { background:#eef2ee; padding:2px 5px; border-radius:4px; }
    .wiki-doc pre { background:#17201b; color:#eff7f1; padding:16px; border-radius:8px; overflow:auto; }
    .wiki-doc a { color:#2b6f4a; }
    .wiki-detail { overflow:auto; background:#f7f8f6; border-left:1px solid #d8ddd8; padding:20px; color:#202823; }
    .wiki-detail input,.wiki-detail textarea { background:#fff; color:#202823; border-color:#c7d0c8; }
    .wiki-detail label { color:#59645d; }
    .review-detail { overflow:auto; padding:28px; }
    .kv { display:grid; grid-template-columns:130px 1fr; gap:8px 18px; padding:9px 0; border-bottom:1px solid var(--line); }
    .kv span:first-child { color:var(--muted); }
    .telemetry-grid { display:grid; grid-template-columns:repeat(2,minmax(320px,1fr)); gap:16px; }
    .telemetry-card { border:1px solid var(--line); border-radius:12px; background:var(--panel); padding:18px; }
    .telemetry-card h2 { margin-bottom:14px; }
    .telemetry-card .stats { grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); }
    .reason-list { display:grid; gap:5px; margin-top:14px; }
    .reason-list div { display:flex; justify-content:space-between; gap:18px; border-top:1px solid var(--line); padding-top:6px; color:var(--muted); }
    .reason-list + .eyebrow { margin-top:20px; }
    .toast { position:fixed; right:20px; bottom:20px; max-width:440px; padding:12px 15px; border-radius:9px; background:#203028; border:1px solid #526a5e; color:var(--text); transform:translateY(100px); opacity:0; transition:.2s; z-index:30; }
    .toast.show { transform:none; opacity:1; }
    .toast.error { border-color:#93524d; background:#38201d; }
    @media (max-width:1100px) { #ontology { grid-template-columns:190px minmax(430px,1fr) 290px; } #wiki { grid-template-columns:210px minmax(420px,1fr) 290px; } }
  </style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand"><div class="mark">B</div><div><strong>BORON CONTENT</strong><small>Human review, zero owned LLM</small></div></div>
    <nav>
      <button data-view="ontology" class="active">Ontology</button>
      <button data-view="codebase">Codebase Graph</button>
      <button data-view="wiki">OpenWiki</button>
      <button data-view="review">Review Queue</button>
      <button data-view="telemetry">Telemetry</button>
    </nav>
    <a class="spatial-link" href="/inspector/spatial">Spatial MR</a>
    <div id="status" class="status">Authenticating…</div>
  </header>
  <main>
    <section id="ontology" class="view active">
      <aside class="rail">
        <div class="eyebrow">PostgreSQL ontology</div><h2>Knowledge graph</h2>
        <p class="muted">Entities and current relations. Dashed links are candidates.</p>
        <div id="ontologyStats" class="stats"></div>
        <div class="eyebrow">Projects</div><div id="projectList" class="project-list"></div>
      </aside>
      <div class="graph-wrap">
        <div class="graph-toolbar"><button id="reloadGraph" class="button">Refresh</button><div class="graph-legend">● confirmed &nbsp; ◌ candidate &nbsp; click nodes or relation labels</div></div>
        <svg id="ontologyGraph" viewBox="0 0 1000 700" role="img" aria-label="Ontology relationship graph"></svg>
      </div>
      <aside class="detail">
        <div class="eyebrow">Selected entity or relation</div><h2 id="ontologySelection">Nothing selected</h2>
        <p class="muted">Edits become pending human corrections. Source data is not overwritten.</p>
        <form id="ontologyForm">
          <div class="field"><label for="ontologyKind">Kind / relation type</label><input id="ontologyKind" disabled></div>
          <div class="field"><label for="ontologyName">Display name</label><input id="ontologyName" disabled></div>
          <div class="field"><label for="ontologyUri">Canonical URI</label><input id="ontologyUri" disabled></div>
          <div class="field"><label for="ontologyNote">Correction or relationship instruction</label><textarea id="ontologyNote" disabled placeholder="Explain what is wrong and how the next agent should reconcile it."></textarea></div>
          <button id="saveOntology" class="button primary wide" disabled>Save pending correction</button>
        </form>
        <div id="subjectCorrections"></div>
      </aside>
    </section>

    <section id="codebase" class="view">
      <div class="code-frame"><iframe title="Codebase Memory graph" src="${codebaseMemoryUrl}/"></iframe></div>
      <aside class="code-side">
        <div class="eyebrow">Codebase Memory</div><h2>Graph + correction</h2>
        <p class="muted">The maintained 3D graph remains the code-structure owner. Search a graph entity here, then attach a human correction without changing its index.</p>
        <div class="field"><label for="codeProject">Indexed project</label><select id="codeProject"></select></div>
        <div class="field"><label for="codeSearch">Search Boron graph</label><input id="codeSearch" placeholder="function, route, class…"></div>
        <button id="runCodeSearch" class="button wide">Search graph entities</button>
        <div id="codeResults" class="result-list"></div>
        <form id="codeForm">
          <div class="field"><label for="codeSubject">Selected qualified name / URI</label><input id="codeSubject" placeholder="Select a result or enter a stable URI"></div>
          <div class="field"><label for="codeNote">Correction instruction</label><textarea id="codeNote" placeholder="Describe the incorrect ownership, dependency, symbol identity, or relation."></textarea></div>
          <button class="button primary wide">Save codebase correction</button>
        </form>
      </aside>
    </section>

    <section id="wiki" class="view">
      <aside class="wiki-rail"><div class="eyebrow">OpenWiki</div><h2>Project knowledge</h2><p id="wikiRoot" class="muted"></p><div id="pageList" class="page-list"></div></aside>
      <div class="wiki-doc"><article id="wikiArticle"><h1>OpenWiki</h1><p>Select a page from the left.</p></article></div>
      <aside class="wiki-detail">
        <div class="eyebrow">Selected page</div><h2 id="wikiSelection">Nothing selected</h2>
        <p>Suggestions are recorded for the next Boron-enabled agent; generated Markdown is not silently overwritten.</p>
        <form id="wikiForm">
          <div class="field"><label for="wikiTitle">Proposed title</label><input id="wikiTitle" disabled></div>
          <div class="field"><label for="wikiPath">Page path</label><input id="wikiPath" disabled></div>
          <div class="field"><label for="wikiNote">Correction / rewrite instruction</label><textarea id="wikiNote" disabled></textarea></div>
          <button id="saveWiki" class="button primary wide" disabled>Save wiki correction</button>
        </form>
      </aside>
    </section>

    <section id="review" class="view">
      <aside class="rail"><div class="eyebrow">Pending manual corrections</div><h2>Review queue</h2><p class="muted">A later agent resolves these after applying or rejecting the requested semantic repair.</p><div id="correctionList" class="correction-list"></div></aside>
      <div id="correctionDetail" class="review-detail"><div class="empty">Select a pending correction.</div></div>
    </section>

    <section id="telemetry" class="view">
      <div><div class="eyebrow">Eligibility contract v2</div><h1>Adoption + writeback telemetry</h1><p class="muted">Eligible denominators, exclusions, and the unobservable boundary are reported separately. Legacy mixed coverage remains visible only for compatibility.</p><button id="reloadTelemetry" class="button">Refresh</button><div id="telemetryGrid" class="telemetry-grid"></div></div>
    </section>
  </main>
</div>
<div id="toast" class="toast"></div>
<script nonce="${nonce}">
  var csrfToken = '';
  var currentProject = 'Boron Context';
  var ontologyData = null;
  var selectedOntology = null;
  var selectedWiki = null;
  var wikiData = null;
  var codeSelection = null;
  var codebaseMemoryUrl = ${JSON.stringify(codebaseMemoryUrl)};
  var codebaseProjects = [];
  var codebaseProject = '';

  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch];}); }
  function compactLocalPath(value) { var text=String(value||''); try { if(text.indexOf('file://')===0) text=decodeURIComponent(new URL(text).pathname); } catch(error) {} return text.replace(/^\/Users\/[^/]+/,'~').replace(/^\/home\/[^/]+/,'~'); }
  function compactProjectName(value) { return String(value||'').replace(/^Users-[^-]+-/,''); }
  function toast(message,error) { var el=document.getElementById('toast'); el.textContent=message; el.className='toast show'+(error?' error':''); setTimeout(function(){el.className='toast';},3500); }
  async function api(path,body,mutation) {
    var headers={'content-type':'application/json'}; if(mutation) headers['x-boron-csrf']=csrfToken;
    var response=await fetch(path,{method:'POST',headers:headers,credentials:'same-origin',body:JSON.stringify(body||{})});
    var data=await response.json(); if(!response.ok) throw new Error(data.error||('HTTP '+response.status)); return data;
  }
  async function authenticate() {
    var ticket=new URLSearchParams(location.hash.slice(1)).get('ticket'); history.replaceState(null,'',location.pathname);
    if(ticket){ var result=await api('/v1/inspector/session',{ticket:ticket},false); csrfToken=result.csrfToken; }
    var graph=await api('/v1/inspector/ontology',{projectHint:currentProject},false); csrfToken=csrfToken||graph.csrfToken||'';
    document.getElementById('status').textContent='Daemon + PostgreSQL online'; document.getElementById('status').className='status ok';
    renderOntology(graph); await Promise.all([loadWiki(),loadCorrections(),loadCodebaseProjects(),loadTelemetry()]);
  }

  document.querySelectorAll('nav button').forEach(function(button){ button.addEventListener('click',function(){
    document.querySelectorAll('nav button').forEach(function(item){item.classList.toggle('active',item===button);});
    document.querySelectorAll('.view').forEach(function(view){view.classList.toggle('active',view.id===button.dataset.view);});
  });});

  async function loadOntology(projectHint) { try { renderOntology(await api('/v1/inspector/ontology',projectHint?{projectHint:projectHint}:{},false)); } catch(error){toast(error.message,true);} }
  function renderOntology(data) {
    ontologyData=data; var resolvedProject=data.project&&data.projects.find(function(project){return project.id===data.project.id;}); currentProject=resolvedProject?resolvedProject.sourceUri:currentProject;
    document.getElementById('ontologyStats').innerHTML='<div class="stat"><strong>'+data.nodes.length+'</strong>entities</div><div class="stat"><strong>'+data.edges.length+'</strong>relations</div><div class="stat"><strong>'+data.pendingCorrections.length+'</strong>pending</div><div class="stat"><strong>'+data.nodes.filter(function(n){return n.confirmationState==='candidate';}).length+'</strong>candidate</div>';
    var projects=document.getElementById('projectList'); projects.innerHTML=''; data.projects.forEach(function(project){ var button=document.createElement('button'); button.className='list-item'+(data.project&&data.project.id===project.id?' active':''); button.innerHTML='<strong>'+escapeHtml(project.name)+'</strong><small>'+escapeHtml(project.status)+' · '+escapeHtml(compactLocalPath(project.sourceUri))+'</small>'; button.addEventListener('click',function(){currentProject=project.sourceUri;loadOntology(project.sourceUri);}); projects.appendChild(button); });
    drawGraph(data.nodes,data.edges); selectOntology(null); chooseCodebaseProject();
  }
  function nodeColor(kind,state) { if(state==='candidate') return '#ffc764'; var value=kind.toLowerCase(); if(value.indexOf('project')>=0)return '#a8ff4f'; if(value.indexOf('capability')>=0)return '#6bc7d9'; if(value.indexOf('artifact')>=0)return '#bf8cff'; return '#dce8e2'; }
  function drawGraph(nodes,edges) {
    var svg=document.getElementById('ontologyGraph'); var width=1000,height=700,cx=500,cy=350; var positions={};
    nodes.forEach(function(node,index){ var ring=1+Math.floor(index/18); var angle=(index*2.399963)+(ring*.31); var radius=nodes.length<=18?220:Math.min(290,95+ring*72); positions[node.id]={x:cx+Math.cos(angle)*radius,y:cy+Math.sin(angle)*radius}; });
    var markup='<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#557067"></path></marker></defs>';
    edges.forEach(function(edge){var a=positions[edge.source],b=positions[edge.target];if(!a||!b)return;var mx=(a.x+b.x)/2,my=(a.y+b.y)/2;markup+='<line class="edge '+escapeHtml(edge.confirmationState)+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"></line><text class="edge-label" data-edge="'+escapeHtml(edge.id)+'" x="'+mx+'" y="'+my+'">'+escapeHtml(edge.relationType)+'</text>';});
    nodes.forEach(function(node){var p=positions[node.id];markup+='<g class="node" data-node="'+escapeHtml(node.id)+'" transform="translate('+p.x+' '+p.y+')"><circle r="'+(node.confirmationState==='candidate'?12:14)+'" fill="'+nodeColor(node.kind,node.confirmationState)+'"></circle><text x="19" y="4">'+escapeHtml(node.name.length>28?node.name.slice(0,27)+'…':node.name)+'</text></g>';});
    svg.innerHTML=markup;
    svg.querySelectorAll('[data-node]').forEach(function(el){el.addEventListener('click',function(){selectOntology(nodes.find(function(node){return node.id===el.dataset.node;}));});});
    svg.querySelectorAll('[data-edge]').forEach(function(el){el.addEventListener('click',function(){selectOntology(edges.find(function(edge){return edge.id===el.dataset.edge;}));});});
  }
  function selectOntology(item) {
    selectedOntology=item; document.querySelectorAll('.node').forEach(function(node){node.classList.toggle('selected',item&&node.dataset.node===item.id);});
    var disabled=!item; ['ontologyKind','ontologyName','ontologyUri','ontologyNote','saveOntology'].forEach(function(id){document.getElementById(id).disabled=disabled;});
    if(!item){document.getElementById('ontologySelection').textContent='Nothing selected';document.getElementById('ontologyKind').value='';document.getElementById('ontologyName').value='';document.getElementById('ontologyUri').value='';document.getElementById('ontologyNote').value='';return;}
    var isEdge=Object.prototype.hasOwnProperty.call(item,'relationType'); document.getElementById('ontologySelection').textContent=isEdge?item.relationType:item.name; document.getElementById('ontologyKind').value=isEdge?item.relationType:item.kind; document.getElementById('ontologyName').value=isEdge?item.confirmationState:item.name; document.getElementById('ontologyUri').value=isEdge?'boron://relation/'+item.id:item.canonicalUri; document.getElementById('ontologyNote').value='';
  }
  document.getElementById('reloadGraph').addEventListener('click',function(){loadOntology(currentProject);});
  document.getElementById('ontologyForm').addEventListener('submit',async function(event){event.preventDefault();if(!selectedOntology)return;var isEdge=Object.prototype.hasOwnProperty.call(selectedOntology,'relationType');var fields={};var kind=document.getElementById('ontologyKind').value.trim(),name=document.getElementById('ontologyName').value.trim(),uri=document.getElementById('ontologyUri').value.trim();if(isEdge){if(kind!==selectedOntology.relationType)fields.relationType=kind;if(name!==selectedOntology.confirmationState)fields.confirmationState=name;}else{if(kind!==selectedOntology.kind)fields.kind=kind;if(name!==selectedOntology.name)fields.name=name;if(uri!==selectedOntology.canonicalUri)fields.canonicalUri=uri;}try{await saveCorrection({projectHint:currentProject,layer:'ontology',subjectKind:isEdge?'relation':'entity',subjectId:selectedOntology.id,subjectUri:isEdge?'boron://relation/'+selectedOntology.id:selectedOntology.canonicalUri,fields:fields,note:document.getElementById('ontologyNote').value});document.getElementById('ontologyNote').value='';await loadOntology(currentProject);await loadCorrections();}catch(error){toast(error.message,true);}});

  async function saveCorrection(body) { var result=await api('/v1/inspector/corrections/create',body,true); toast('Saved pending correction r'+result.revision,false); return result; }

  async function codebaseRpc(name,args){var response=await fetch(codebaseMemoryUrl+'/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:Date.now(),method:'tools/call',params:{name:name,arguments:args||{}}})});var rpc=await response.json();if(!response.ok||rpc.error)throw new Error((rpc.error&&rpc.error.message)||('HTTP '+response.status));return JSON.parse(rpc.result.content[0].text);}
  async function loadCodebaseProjects(){try{var payload=await codebaseRpc('list_projects',{});codebaseProjects=payload.projects||[];var select=document.getElementById('codeProject');select.innerHTML='';codebaseProjects.forEach(function(project){var option=document.createElement('option');option.value=project.name;option.textContent=compactProjectName(project.name)+' · '+project.nodes+' nodes';select.appendChild(option);});chooseCodebaseProject();}catch(error){document.getElementById('codeProject').innerHTML='<option>Codebase Memory unavailable</option>';}}
  function chooseCodebaseProject(){if(!codebaseProjects.length)return;var project=ontologyData&&ontologyData.project;var source=project&&ontologyData.projects.find(function(item){return item.id===project.id;});var sourcePath=source&&source.sourceUri||'';try{if(sourcePath.indexOf('file://')===0)sourcePath=decodeURIComponent(new URL(sourcePath).pathname);}catch(error){}var match=codebaseProjects.find(function(item){return sourcePath&&item.root_path===sourcePath;})||codebaseProjects.find(function(item){return project&&item.name.toLowerCase().indexOf(project.name.toLowerCase().replace(/\s+/g,'-'))>=0;})||codebaseProjects[0];codebaseProject=match.name;document.getElementById('codeProject').value=codebaseProject;}
  document.getElementById('codeProject').addEventListener('change',function(event){codebaseProject=event.target.value;codeSelection=null;document.getElementById('codeSubject').value='';document.getElementById('codeResults').innerHTML='';});
  document.getElementById('runCodeSearch').addEventListener('click',runCodeSearch); document.getElementById('codeSearch').addEventListener('keydown',function(event){if(event.key==='Enter'){event.preventDefault();runCodeSearch();}});
  async function runCodeSearch(){var query=document.getElementById('codeSearch').value.trim();if(!query||!codebaseProject)return;var box=document.getElementById('codeResults');box.innerHTML='<p class="muted">Searching…</p>';try{var payload=await codebaseRpc('search_graph',{project:codebaseProject,query:query,limit:16});box.innerHTML='';(payload.results||[]).forEach(function(item){var button=document.createElement('button');button.className='list-item';button.innerHTML='<strong>'+escapeHtml(item.name)+'</strong><small>'+escapeHtml(item.label)+' · '+escapeHtml(item.file_path||'')+'</small>';button.addEventListener('click',function(){codeSelection=item;document.getElementById('codeSubject').value=item.qualified_name;});box.appendChild(button);});if(!(payload.results||[]).length)box.innerHTML='<div class="empty">No graph entities found.</div>';}catch(error){box.innerHTML='<div class="empty">Graph search unavailable. The embedded Codebase Memory viewer remains usable.</div>';}}
  document.getElementById('codeForm').addEventListener('submit',async function(event){event.preventDefault();var subject=document.getElementById('codeSubject').value.trim(),note=document.getElementById('codeNote').value.trim();if(!subject) return toast('Select or enter a code entity.',true);try{await saveCorrection({projectHint:currentProject,layer:'codebase',subjectKind:codeSelection?codeSelection.label:'code_entity',subjectId:codeSelection?codeSelection.qualified_name:subject,subjectUri:subject.indexOf('://')>=0?subject:'codebase-memory://'+subject,fields:codeSelection?{name:codeSelection.name,filePath:codeSelection.file_path||''}:{},note:note});document.getElementById('codeNote').value='';await loadCorrections();}catch(error){toast(error.message,true);}});

  async function loadWiki(){try{wikiData=await api('/v1/inspector/wiki',{},false);document.getElementById('wikiRoot').textContent=compactLocalPath(wikiData.root);var list=document.getElementById('pageList');list.innerHTML='';wikiData.pages.forEach(function(page){var button=document.createElement('button');button.className='list-item';button.innerHTML='<strong>'+escapeHtml(page.title)+'</strong><small>'+escapeHtml(page.path)+'</small>';button.addEventListener('click',function(){selectWiki(page,button);});list.appendChild(button);});if(wikiData.pages[0])selectWiki(wikiData.pages[0],list.querySelector('button'));}catch(error){toast(error.message,true);}}
  function selectWiki(page,button){selectedWiki=page;document.querySelectorAll('#pageList .list-item').forEach(function(item){item.classList.toggle('active',item===button);});document.getElementById('wikiArticle').innerHTML=renderMarkdown(page.content);document.getElementById('wikiSelection').textContent=page.title;document.getElementById('wikiTitle').value=page.title;document.getElementById('wikiPath').value=page.path;document.getElementById('wikiNote').value='';['wikiTitle','wikiPath','wikiNote','saveWiki'].forEach(function(id){document.getElementById(id).disabled=false;});}
  function inlineMarkdown(text){return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\x60([^\x60]+)\x60/g,'<code>$1</code>').replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');}
  function renderMarkdown(markdown){var lines=markdown.split(/\r?\n/),html='',inCode=false,list=false;lines.forEach(function(line){if(line.length>=3&&line.charCodeAt(0)===96&&line.charCodeAt(1)===96&&line.charCodeAt(2)===96){if(list){html+='</ul>';list=false;}html+=inCode?'</code></pre>':'<pre><code>';inCode=!inCode;return;}if(inCode){html+=escapeHtml(line)+'\n';return;}var heading=line.match(/^(#{1,3})\s+(.+)$/);if(heading){if(list){html+='</ul>';list=false;}var level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';return;}var item=line.match(/^[-*]\s+(.+)$/);if(item){if(!list){html+='<ul>';list=true;}html+='<li>'+inlineMarkdown(item[1])+'</li>';return;}if(list){html+='</ul>';list=false;}if(line.trim())html+='<p>'+inlineMarkdown(line)+'</p>';});if(list)html+='</ul>';if(inCode)html+='</code></pre>';return html;}
  document.getElementById('wikiForm').addEventListener('submit',async function(event){event.preventDefault();if(!selectedWiki)return;var fields={};var title=document.getElementById('wikiTitle').value.trim(),path=document.getElementById('wikiPath').value.trim();if(title!==selectedWiki.title)fields.title=title;if(path!==selectedWiki.path)fields.path=path;try{await saveCorrection({projectHint:currentProject,layer:'wiki',subjectKind:'wiki_page',subjectId:selectedWiki.path,subjectUri:selectedWiki.uri,fields:fields,note:document.getElementById('wikiNote').value});document.getElementById('wikiNote').value='';await loadCorrections();}catch(error){toast(error.message,true);}});

  async function loadCorrections(){try{var items=await api('/v1/inspector/corrections/list',{status:'pending',limit:200},false);var list=document.getElementById('correctionList');list.innerHTML='';items.forEach(function(item){var button=document.createElement('button');button.className='list-item';button.innerHTML='<strong>'+escapeHtml(item.subjectUri)+'</strong><small><span class="badge pending">'+escapeHtml(item.layer)+'</span> · revision '+item.revision+'</small>';button.addEventListener('click',function(){showCorrection(item,button);});list.appendChild(button);});if(!items.length)list.innerHTML='<div class="empty">No pending corrections.</div>';}catch(error){toast(error.message,true);}}
  function showCorrection(item,button){document.querySelectorAll('#correctionList .list-item').forEach(function(el){el.classList.toggle('active',el===button);});var fields=Object.keys(item.fields).map(function(key){return '<div class="kv"><span>'+escapeHtml(key)+'</span><strong>'+escapeHtml(item.fields[key])+'</strong></div>';}).join('');document.getElementById('correctionDetail').innerHTML='<div class="eyebrow">'+escapeHtml(item.layer)+' · pending · revision '+item.revision+'</div><h1>'+escapeHtml(item.subjectUri)+'</h1><p class="muted">This is explicit human input. A Boron-enabled agent should reconcile it against current sources and relations, then resolve the correction through the MCP tool.</p><div class="kv"><span>Project</span><strong>'+escapeHtml(item.projectName||'Unscoped')+'</strong></div><div class="kv"><span>Subject kind</span><strong>'+escapeHtml(item.subjectKind)+'</strong></div>'+fields+'<div class="kv"><span>Instruction</span><strong>'+escapeHtml(item.note||'—')+'</strong></div><div class="kv"><span>Created</span><strong>'+escapeHtml(item.createdAt)+'</strong></div>';}

  function reasonRows(group,label){var entries=Object.entries(group||{});if(!entries.length)return '';return '<div class="eyebrow">'+escapeHtml(label)+'</div><div class="reason-list">'+entries.map(function(entry){return '<div><span>'+escapeHtml(entry[0])+'</span><strong>'+entry[1]+'</strong></div>';}).join('')+'</div>';}
  function ratio(value){return (Number(value||0)*100).toFixed(1)+'%';}
  function telemetryCard(data,windowDays,kind){var metric=data[kind];var title=kind==='adoption'?'Adoption':'Writeback';var extra=kind==='adoption'?'<div class="stat"><strong>'+metric.unobservable+'</strong>unobservable</div>':'';return '<article class="telemetry-card"><div class="eyebrow">'+windowDays+' day · '+kind+'</div><h2>'+title+' '+ratio(metric.ratio)+'</h2><div class="stats"><div class="stat"><strong>'+metric.numerator+'/'+metric.eligibleDenominator+'</strong>eligible</div><div class="stat"><strong>'+metric.ineligible+'</strong>ineligible</div>'+extra+'</div>'+reasonRows(metric.reasons.eligible,'Eligible reasons')+reasonRows(metric.reasons.ineligible,'Ineligible reasons')+(kind==='adoption'?reasonRows(metric.reasons.unobservable,'Unobservable reasons'):'')+'</article>';}
  async function loadTelemetry(){var grid=document.getElementById('telemetryGrid');grid.innerHTML='<p class="muted">Loading telemetry…</p>';try{var results=await Promise.all([api('/v1/metrics/adoption',{windowDays:7},false),api('/v1/metrics/adoption',{windowDays:30},false)]);grid.innerHTML=telemetryCard(results[0],7,'adoption')+telemetryCard(results[0],7,'writeback')+telemetryCard(results[1],30,'adoption')+telemetryCard(results[1],30,'writeback');}catch(error){grid.innerHTML='<div class="empty">Telemetry unavailable: '+escapeHtml(error.message)+'</div>';}}
  document.getElementById('reloadTelemetry').addEventListener('click',loadTelemetry);

  authenticate().catch(function(error){document.getElementById('status').textContent='Open from the Boron menu bar to authenticate';document.getElementById('status').className='status';toast(error.message,true);});
</script>
</body>
</html>`
}
