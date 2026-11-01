import {test,expect,type Page} from '@playwright/test';

test.beforeEach(async({request,page})=>{
  await request.post('/api/strategy/stop',{data:{}});
  await request.post('/api/connection',{data:{mode:'simulation'}});
  await request.post('/api/reset',{data:{}});
  await page.goto('/');
  await expect(page.getByRole('button',{name:'Strategie starten'})).toBeEnabled();
});
async function setThreshold(page:Page,value:string){
  await page.locator('[data-id="compare-1"] .node-heading').click();
  await page.getByLabel('Schwellenwert · USD').fill(value);
  await page.getByRole('button',{name:'Konfiguration schließen'}).click();
}

test('editor loads locally, drag/drop adds a configurable node, no external requests',async({page})=>{
  const errors:string[]=[];const external:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!/^http:\/\/(127\.0\.0\.1|localhost)/.test(r.url()))external.push(r.url());});
  await page.reload();
  await expect(page.locator('.trade-node')).toHaveCount(3);
  await expect(page.locator('.market-chart')).toBeVisible();
  const canvas=page.locator('.canvas');
  await page.getByRole('button',{name:'Zeitintervall Signal in regelmäßigen Abständen'}).dragTo(canvas,{targetPosition:{x:350,y:340}});
  await expect(page.locator('.trade-node')).toHaveCount(4);
  await expect(page.getByLabel('Intervall · Sekunden')).toBeVisible();
  await page.getByLabel('Intervall · Sekunden').fill('15');
  await expect(page.locator('.trade-node.blue')).toContainText('15s');
  await page.getByRole('button',{name:'Speichern',exact:true}).click();
  await page.reload();
  await expect(page.locator('.trade-node')).toHaveCount(4);
  await page.locator('.trade-node.blue .node-heading').click();
  await page.getByRole('button',{name:'Node entfernen'}).click();
  await expect(page.locator('.trade-node')).toHaveCount(3);
  expect(errors).toEqual([]);expect(external).toEqual([]);
});

test('a true graph fills one simulated order, updates positions and does not repeat every tick',async({page,request})=>{
  await setThreshold(page,'0.01');
  await page.getByRole('button',{name:'Speichern',exact:true}).click();
  await page.reload();
  await expect(page.locator('[data-id="compare-1"]')).toContainText('$0.01');
  await page.getByRole('button',{name:'Strategie starten'}).click();
  await expect(page.getByRole('button',{name:'Stoppen',exact:true})).toBeVisible();
  await page.locator('.panel-tabs').getByRole('button',{name:/^Orders/}).click();
  await expect(page.locator('tbody')).toContainText('Filled');
  await page.waitForTimeout(2100);
  const state=await (await request.get('/api/state')).json();
  expect(state.orders).toHaveLength(1);expect(state.positions[0].quantity).toBe(1);expect(state.balance).toBeLessThan(100000);
  await page.locator('.panel-tabs').getByRole('button',{name:/^Positionen/}).click();
  await expect(page.locator('tbody')).toContainText('AAPL');
  await page.getByRole('button',{name:'Stoppen',exact:true}).click();
  await expect(page.getByRole('button',{name:'Strategie starten'})).toBeVisible();
});

test('limit orders remain pending and can be cancelled after strategy stop',async({page,request})=>{
  await setThreshold(page,'0.01');
  await page.locator('[data-id="order-1"] .node-heading').click();
  await page.getByLabel('Ordertyp').selectOption('LMT');
  await page.getByLabel('Limitpreis · USD').fill('1');
  await page.getByLabel('Anzahl Aktien').fill('2');
  await page.getByRole('button',{name:'Konfiguration schließen'}).click();
  await page.getByRole('button',{name:'Strategie starten'}).click();
  await page.locator('.panel-tabs').getByRole('button',{name:/^Orders/}).click();
  await expect(page.locator('tbody')).toContainText('Submitted');
  await page.getByRole('button',{name:'Stoppen',exact:true}).click();
  await page.getByRole('button',{name:/Order .* stornieren/}).click();
  await expect(page.locator('tbody')).toContainText('Cancelled');
  expect((await (await request.get('/api/state')).json()).positions).toHaveLength(0);
});

test('strategy export/import roundtrips the actual graph',async({page})=>{
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Strategie exportieren',exact:true}).click();
  const download=await downloadPromise;
  const stream=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  const strategy=JSON.parse(Buffer.concat(chunks).toString());
  expect(strategy.nodes).toHaveLength(3);expect(strategy.edges).toHaveLength(2);
  strategy.name='Importierte Strategie';
  await page.locator('input[type="file"]').setInputFiles({name:'strategy.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(strategy))});
  await expect(page.getByLabel('Strategiename')).toHaveValue('Importierte Strategie');
  await page.locator('[data-id="market-1"] .node-heading').click();
  await page.getByLabel('Symbol',{exact:true}).fill('GOOG');
  await expect(page.locator('[data-id="market-1"]')).toContainText('GOOG');
});

test('broken graphs cannot run and paper live ports are rejected by API',async({page,request})=>{
  await page.locator('[data-id="market-1"] .node-heading').click();
  await page.getByRole('button',{name:'Node entfernen'}).click();
  await page.getByRole('button',{name:'Strategie starten'}).click();
  await expect(page.locator('.toast.error')).toBeVisible();
  const response=await request.post('/api/connection',{data:{mode:'paper',host:'127.0.0.1',port:7496,clientId:27}});
  expect(response.status()).toBe(400);
  const state=await (await request.get('/api/state')).json();expect(state.orders).toHaveLength(0);expect(state.run.running).toBe(false);
});
