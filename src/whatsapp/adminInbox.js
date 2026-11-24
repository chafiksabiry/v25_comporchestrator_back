/**
 * Page « Boîte de réception » du support (conversations WhatsApp et chat du site).
 * Page statique sans aucune donnée : la clé d'administration est saisie dans le navigateur (gardée en sessionStorage, jamais dans l'URL)
 * et envoyée en en-tête x-admin-key aux routes /admin/*. Tout le contenu affiché passe par textContent (aucun HTML injecté).
 */
export const ADMIN_INBOX_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>HARX - Boîte de réception support</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--fg:#111827;--card:#fff;--mut:#6b7280;--line:#e5e7eb;--acc:#128c7e}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e5e7eb;--card:#171a21;--mut:#9ca3af;--line:#272b35}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;background:var(--acc);color:#fff}header h1{font-size:16px;margin:0;flex:1}
select,button,input{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}button{cursor:pointer}
main{display:grid;grid-template-columns:minmax(260px,360px) 1fr;gap:12px;padding:12px;height:calc(100vh - 56px)}
@media(max-width:760px){main{grid-template-columns:1fr;height:auto}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:auto;min-height:200px}
.row{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer}.row:hover,.row.sel{background:rgba(18,140,126,.12)}
.row b{display:block}.mut{color:var(--mut);font-size:12px}.tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:99px;background:var(--acc);color:#fff;margin-left:4px}.tag.warn{background:#b45309}
.msg{max-width:80%;margin:8px 12px;padding:8px 10px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line)}
.msg.user{background:rgba(37,211,102,.16)}.msg.human_agent{background:rgba(59,130,246,.16);margin-left:auto}.msg small{display:block;color:var(--mut);margin-bottom:2px}
#login{padding:24px;display:flex;gap:8px;justify-content:center}
</style></head><body>
<header><h1>Boîte de réception support HARX</h1>
<select id="ch"><option value="">Tous les canaux</option><option value="whatsapp">WhatsApp</option><option value="web">Chat du site</option></select>
<button id="refresh" type="button">Actualiser</button><button id="logout" type="button">Changer de clé</button></header>
<div id="login" hidden><input id="key" type="password" placeholder="Clé d'administration" autocomplete="off"><button id="go" type="button">Ouvrir</button></div>
<main id="app" hidden><section id="list" aria-label="Conversations"></section><section id="detail" aria-label="Messages"></section></main>
<script>
(function(){
var K='harx-admin-key',$=function(i){return document.getElementById(i)};
function key(){try{return sessionStorage.getItem(K)||''}catch(e){return ''}}
function api(p){return fetch(p,{headers:{'x-admin-key':key()}}).then(function(r){if(r.status===401||r.status===404){sessionStorage.removeItem(K);show();throw new Error('auth')}if(!r.ok)throw new Error(String(r.status));return r.json()})}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function fmt(d){try{return new Date(d).toLocaleString('fr-FR')}catch(e){return ''}}
function label(c){return c.waId.indexOf('web:')===0?'Visiteur du site':(c.profileName||('+'+c.waId))}
function show(){var k=!!key();$('login').hidden=k;$('app').hidden=!k;if(k)load()}
function load(){api('conversations?channel='+encodeURIComponent($('ch').value)).then(function(d){
 var l=$('list');l.textContent='';if(!d.conversations.length)l.appendChild(el('div','row','Aucune conversation.'));
 d.conversations.forEach(function(c){var r=el('div','row');var b=el('b','',label(c));if(c.handoff)b.appendChild(el('span','tag warn','Humain'));if(c.linked)b.appendChild(el('span','tag','Compte lié'));r.appendChild(b);
  r.appendChild(el('div','mut',fmt(c.updatedAt)+' - '+c.messageCount+' msg'+(c.language?' - '+c.language:'')));r.appendChild(el('div','mut',c.last?c.last.text.slice(0,90):''));
  r.onclick=function(){Array.prototype.forEach.call(l.children,function(x){x.classList.remove('sel')});r.classList.add('sel');open(c)};l.appendChild(r)})}).catch(function(){})}
function open(c){api('conversations/'+encodeURIComponent(c.waId)).then(function(d){var p=$('detail');p.textContent='';
 var h=el('div','row',label(c)+(d.notes.length?' - notes : '+d.notes.map(function(n){return n.key+'='+n.value}).join(', '):''));p.appendChild(h);
 d.messages.forEach(function(m){var x=el('div','msg '+m.role);x.appendChild(el('small','',(m.role==='user'?'Visiteur':m.role==='human_agent'?'Équipe':'Assistant')+' - '+fmt(m.ts)));x.appendChild(document.createTextNode(m.text));p.appendChild(x)});p.scrollTop=p.scrollHeight}).catch(function(){})}
$('go').onclick=function(){var v=$('key').value.trim();if(v){sessionStorage.setItem(K,v);$('key').value='';show()}};
$('key').onkeydown=function(e){if(e.key==='Enter')$('go').click()};
$('refresh').onclick=load;$('ch').onchange=load;$('logout').onclick=function(){sessionStorage.removeItem(K);show()};show();
})();
</script></body></html>`;
