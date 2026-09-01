import { chromium } from '@playwright/test';
const URL='http://127.0.0.1:8861';
const b=await chromium.launch();
const c=await b.newContext({viewport:{width:1512,height:950}}); const p=await c.newPage();
const errs=[]; p.on('pageerror',e=>errs.push('pageerror: '+e.message));
await p.goto(URL,{waitUntil:'domcontentloaded'}); await p.request.post(URL+'/api/v1/auth/demo');
// find a deal
const j=await (await p.request.get(URL+'/api/v1/records/deal?limit=1')).json();
const id=j.data[0].id, nm=j.data[0].display_name;
await p.goto(URL+'/deals/'+id,{waitUntil:'networkidle'}); await p.waitForTimeout(900);
await p.getByRole('button',{name:'Move stage'}).click(); await p.waitForTimeout(500);
await p.getByRole('menuitem',{name:/Archive this deal/}).click().catch(async()=>{await p.getByText('Archive this deal').click()});
await p.waitForTimeout(900);
await p.screenshot({path:'/tmp/crit-drive/41-archive.png',fullPage:true});
const t=await p.locator('body').innerText();
console.log('ARCHIVE CONFIRM?',(t.match(/Archive[\s\S]{0,400}/)||[''])[0].replace(/\n/g,' | ').slice(0,400));
const dlg=p.locator('[role=dialog]');
if(await dlg.count()){ await dlg.getByRole('button',{name:/Archive/}).click(); await p.waitForTimeout(1500);}
const after=await (await p.request.get(URL+'/api/v1/records/deal/'+id)).json();
console.log('archived server-side?',after.archived,'|',nm);
console.log('page now:',(await p.locator('main').innerText()).slice(0,300).replace(/\n/g,' | '));

// conversation archive?
await p.goto(URL+'/copilot',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
const btns=[]; for(const el of await p.locator('main button').all()){const x=((await el.innerText()).trim()||await el.getAttribute('aria-label')||'').replace(/\n/g,'/'); if(x&&/archiv|delete|rename|menu|more/i.test(x))btns.push(x.slice(0,50));}
console.log('\nconversation-level action buttons found:',JSON.stringify(btns));
console.log('ERRS',errs);
await b.close();
