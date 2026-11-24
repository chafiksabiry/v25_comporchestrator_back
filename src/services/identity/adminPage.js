/**
 * Page « Revue des pièces » (admin HARX), sur le modèle de la boîte de réception support : page statique SANS aucune donnée.
 * Le jeton admin du tableau de bord (JWT, typeUser 'admin') est saisi dans le navigateur, gardé en sessionStorage (jamais dans
 * l'URL) et envoyé en en-tête Authorization. Ouverte depuis l'Inbox admin, la page reçoit le jeton de la session admin dans le
 * fragment (#t=…, jamais envoyé au serveur), le range en sessionStorage puis l'efface aussitôt de l'adresse : pas de saisie à la main. Tout le contenu passe par textContent (aucun HTML injecté : le texte lu sur un document
 * est affiché tel quel, jamais interprété). Images déchiffrées à la volée, dessinées dans un canvas avec un filigrane
 * « HARX — revue — date — admin » ; clic droit et glisser désactivés.
 */
export const ADMIN_IDENTITY_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>HARX - Revue des pièces</title>
<style>
:root{color-scheme:dark;--bg:#050914;--card:#0b1126;--fg:#f8fafc;--mut:#98a3cf;--line:rgba(130,148,255,.18);--acc:#ec4899;--ok:#6ee7b7;--warn:#fcd34d;--err:#fca5a5}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;background:linear-gradient(100deg,#e0245e,#d21e9c);color:#fff}header h1{font-size:16px;margin:0;flex:1}
button,select,input,textarea{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:#161e42;color:var(--fg)}button{cursor:pointer}
.primary{background:linear-gradient(90deg,#f7941e,#e6188d);border:0;color:#fff;font-weight:700}.danger{color:var(--err);border-color:rgba(239,68,68,.45)}
main{display:grid;grid-template-columns:300px 1fr;gap:12px;padding:12px}@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:auto}
.row{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer}.row.sel{background:rgba(236,72,153,.12);box-shadow:inset 3px 0 0 var(--acc)}
.mut{color:var(--mut);font-size:12px}.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);margin:4px 4px 0 0}
.detail{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;padding:12px}@media(max-width:1100px){.detail{grid-template-columns:1fr}}
canvas{width:100%;border-radius:10px;border:1px solid var(--line);background:#000;user-select:none}
ul.checks{list-style:none;padding:0;margin:0}ul.checks li{display:flex;gap:8px;padding:4px 0}.ok{color:var(--ok)}.review{color:var(--warn)}.fail{color:var(--err)}.info{color:var(--mut)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:start;vertical-align:top}th{color:var(--mut);font-size:12px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px;border-bottom:1px solid var(--line)}
#login{padding:24px;display:flex;gap:8px;justify-content:center}
</style></head><body>
<header><h1>Revue des pièces · admin HARX</h1><select id="st"><option value="review">À revoir</option><option value="pending">Validées, un pays à revoir</option><option value="rejected">Refusées</option><option value="approved">Validées</option></select><button id="refresh" type="button">Actualiser</button><button id="logout" type="button">Changer de jeton</button></header>
<div id="login" hidden><input id="tok" type="password" placeholder="Jeton admin du tableau de bord" autocomplete="off"><button id="go" type="button">Ouvrir</button></div>
<main id="app" hidden><section id="list" aria-label="Vérifications"></section><section id="detail" aria-label="Détail"></section></main>
<script>
(function(){
var K='harx-identity-admin',$=function(i){return document.getElementById(i)},who='';
(function(){var m=/^#t=([^&]+)/.exec(location.hash||'');if(!m)return;try{sessionStorage.setItem(K,decodeURIComponent(m[1]))}catch(e){}try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}})();
function tok(){try{return sessionStorage.getItem(K)||''}catch(e){return ''}}
function hdr(){return {Authorization:'Bearer '+tok()}}
function api(p,o){o=o||{};o.headers=Object.assign(hdr(),o.headers||{});return fetch(p,o).then(function(r){if(r.status===401||r.status===404){try{sessionStorage.removeItem(K)}catch(e){}show();throw new Error('auth')}return r})}
function json(p,o){return api(p,o).then(function(r){return r.json().then(function(b){if(!r.ok)throw new Error(b.code||String(r.status));return b})})}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=String(x);return e}
function fmt(d){try{return new Date(d).toLocaleString('fr-FR')}catch(e){return ''}}
function show(){var k=!!tok();$('login').hidden=k;$('app').hidden=!k;if(k){try{who=JSON.parse(atob(tok().split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).email||'admin'}catch(e){who='admin'}load()}}
function load(){json('/admin/identity/verifications?status='+encodeURIComponent($('st').value)).then(function(d){var l=$('list');l.textContent='';
 l.appendChild(el('div','row mut',d.verifications.length+' vérification(s), plus anciennes d’abord'));
 d.verifications.forEach(function(v){var r=el('div','row');r.appendChild(el('b','',v.name||'(sans nom)'));r.appendChild(el('div','mut','il y a '+v.ageHours+' h · '+v.docType+(v.reviewRequested?' · revue demandée':'')+(v.pendingCountries&&v.pendingCountries.length?' · à revoir : '+v.pendingCountries.join(', '):'')+(v.overdue?' · plus de 72 h':'')));
  v.reasons.forEach(function(x){r.appendChild(el('span','badge',x))});r.onclick=function(){Array.prototype.forEach.call(l.children,function(x){x.classList.remove('sel')});r.classList.add('sel');open(v.id)};l.appendChild(r)})}).catch(function(){})}
function drawFile(id,f,box,pg){var n=f.meta&&f.meta.pageBytes&&f.meta.pageBytes.length||0;if(pg==null&&n>1){for(var i=0;i<n;i++)drawFile(id,f,box,i);return}var q=pg==null?'':'?page='+pg;var c=el('canvas');c.oncontextmenu=function(e){e.preventDefault()};c.ondragstart=function(e){e.preventDefault()};box.appendChild(c);
 if(f.mime==='application/pdf'){var p=el('p','mut','PDF ('+(f.meta&&f.meta.pages||1)+' page(s)) : ');var b=el('button','', 'Ouvrir le PDF (journalisé)');b.onclick=function(){api('/admin/identity/verifications/'+id+'/files/'+f.fileId).then(function(r){return r.blob()}).then(function(bl){window.open(URL.createObjectURL(bl),'_blank','noopener')})};p.appendChild(b);box.replaceChild(p,c);return}
 api('/admin/identity/verifications/'+id+'/files/'+f.fileId+q).then(function(r){return r.blob()}).then(function(bl){var u=URL.createObjectURL(bl);var img=new Image();img.onload=function(){c.width=img.naturalWidth;c.height=img.naturalHeight;var g=c.getContext('2d');g.drawImage(img,0,0);URL.revokeObjectURL(u);
  var s='HARX — revue — '+new Date().toLocaleDateString('fr-FR')+' — '+who;g.save();g.globalAlpha=.35;g.fillStyle='#ffd666';g.font='bold '+Math.round(c.width/28)+'px sans-serif';g.translate(c.width/2,c.height/2);g.rotate(-0.28);for(var y=-c.height;y<c.height;y+=c.height/4){g.fillText(s,-c.width/2,y)}g.restore()};img.src=u})}
function open(id){json('/admin/identity/verifications/'+id).then(function(d){var p=$('detail');p.textContent='';
 var a=el('div','actions');a.appendChild(el('b','',(d.declared&&d.declared.fullName)||''));a.appendChild(el('span','mut','n° '+d.attempt+' · '+fmt(d.createdAt)+' · '+d.status));
 var pend=(d.status==='approved'&&d.pendingCountries)||[];
 if(pend.length){var vc=d.verifiedCountries||{};a.appendChild(el('span','ok','Déjà validé : '+[vc.residence?'résidence '+vc.residence:'',vc.nationality?'nationalité '+vc.nationality:''].filter(Boolean).join(', ')+'. À revoir : '+pend.join(', ')+' (le pays déjà validé reste ouvert).'))}
 if(d.status==='review'||pend.length){
  var res=el('label','',' ');var cr=el('input');cr.type='checkbox';cr.checked=pend.length?pend.indexOf('residence')>=0:true;if(pend.length&&pend.indexOf('residence')<0){cr.disabled=true}res.appendChild(cr);res.appendChild(document.createTextNode(' Résidence '+((d.declared&&d.declared.residence)||'?')));
  var nat=el('label','',' ');var cn=el('input');cn.type='checkbox';cn.checked=pend.length?pend.indexOf('nationality')>=0:d.docType!=='residence_permit';if(pend.length&&pend.indexOf('nationality')<0){cn.disabled=true}nat.appendChild(cn);nat.appendChild(document.createTextNode(' Nationalité '+((d.declared&&d.declared.nationality)||'?')));
  var ok=el('button','primary',pend.length?'Valider ce pays aussi':'Valider');ok.onclick=function(){decide(id,{outcome:'approved',residence:cr.checked?d.declared.residence:null,nationality:cn.checked?d.declared.nationality:null})};
  var sel=el('select');['NAME_MISMATCH','COUNTRY_MISMATCH_NATIONALITY','COUNTRY_MISMATCH_RESIDENCE','PROOF_TOO_OLD','ID_EXPIRED','UNREADABLE','DOCUMENT_TYPE_NOT_ACCEPTED','UNDERAGE','PROOF_HOLDER_OTHER','DOCUMENT_SUSPECTED'].forEach(function(x){var o=el('option','',x);o.value=x;sel.appendChild(o)});
  var note=el('input');note.placeholder='Note (facultatif)';note.maxLength=500;
  var ko=el('button','danger',pend.length?'Ne pas ouvrir ce pays':'Refuser');ko.onclick=function(){decide(id,{outcome:'rejected',reasonCode:sel.value,note:note.value})};
  var rs=el('button','','Demander un autre document');rs.onclick=function(){decide(id,{outcome:'resubmit',note:note.value})};
  [res,nat,ok,sel,note,ko,rs].forEach(function(x){a.appendChild(x)})}
 p.appendChild(a);
 var g=el('div','detail');var left=el('div');var right=el('div');g.appendChild(left);g.appendChild(right);p.appendChild(g);
 if(!d.files.length)left.appendChild(el('p','mut','Images supprimées (décision prise ou délai écoulé).'));
 d.files.forEach(function(f){left.appendChild(el('h3','',f.kind));(f.signals||[]).forEach(function(s){left.appendChild(el('div','review',s.detail||s.code))});var box=el('div');left.appendChild(box);drawFile(id,f,box)});
 right.appendChild(el('h3','','Contrôles calculés par le code'));var ul=el('ul','checks');var ic={pass:'✓',review:'!',fail:'✕',info:'·'};
 d.checks.forEach(function(c){var li=el('li',c.result==='pass'?'ok':c.result);li.appendChild(el('span','',ic[c.result]||'·'));li.appendChild(el('span','',c.code+' — '+(c.detail||'')+(c.reason?' ['+c.reason+']':'')));ul.appendChild(li)});right.appendChild(ul);
 right.appendChild(el('h3','','Déclaré / lu'));var t=el('table');var x=d.extracted||{},i=x.id||{},pr=x.proof||{},de=d.declared||{};
 [['','Déclaré','Pièce','Justificatif'],['Nom',de.fullName,[i.lastName,i.givenNames].filter(Boolean).join(' '),pr.holderName],['Nom (écriture d’origine)','—',[i.lastNameNative,i.givenNamesNative].filter(Boolean).join(' '),pr.holderNameNative],['Pays','Nat. '+(de.nationality||'?')+' · Rés. '+(de.residence||'?'),i.nationalityIso3||i.issuingCountryIso3,(pr.countryPrinted||'')+(pr.countryInferred?' (déduit '+pr.countryInferred+', '+pr.inferenceBasis+')':'')],['Date','—',i.expiryDate?'exp. '+i.expiryDate:'',pr.issueDate],['Type',d.docType,i.documentType,pr.documentType]].forEach(function(r,k){var tr=el('tr');r.forEach(function(v){var c=el(k?'td':'th','',v==null?'':v);if(/[\\u0600-\\u06FF]/.test(String(v||'')))c.dir='rtl';tr.appendChild(c)});t.appendChild(tr)});right.appendChild(t);
 right.appendChild(el('p','mut','Le texte lu est affiché tel quel (jamais interprété). Les images sont supprimées dès votre décision.'));
 right.appendChild(el('h3','','Journal'));(d.accessLog||[]).forEach(function(l){right.appendChild(el('div','mut',fmt(l.at)+' · '+l.adminId+' · '+l.action+(l.fileId?' · '+l.fileId:'')))});
 }).catch(function(e){$('detail').textContent=String(e.message||e)})}
function decide(id,body){json('/admin/identity/verifications/'+id+'/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(){load();$('detail').textContent='Décision enregistrée.'}).catch(function(e){alert(e.message)})}
$('go').onclick=function(){var v=$('tok').value.trim();if(v){try{sessionStorage.setItem(K,v)}catch(e){}$('tok').value='';show()}};
$('tok').onkeydown=function(e){if(e.key==='Enter')$('go').click()};
$('refresh').onclick=load;$('st').onchange=load;$('logout').onclick=function(){try{sessionStorage.removeItem(K)}catch(e){}show()};show();
})();
</script></body></html>`;
