import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT muss zwischen 1024 und 65535 liegen.');
const {app,service}=createApp();
if(process.env.NODE_ENV==='production' || process.argv.includes('--production')) {
  app.use(express.static(path.join(root,'dist')));
  app.get('/{*path}',(_req,res)=>res.sendFile(path.join(root,'dist','index.html')));
} else {
  const {createServer}=await import('vite');
  const vite=await createServer({root,server:{middlewareMode:true,hmr:{host:'127.0.0.1',port:port+1}},appType:'spa'});
  app.use(vite.middlewares);
}
const server=app.listen(port,'127.0.0.1',()=>console.log(`NodeDesk läuft lokal: http://127.0.0.1:${port} · ausschließlich Simulation / IBKR Paper`));
const shutdown=()=>{service.close();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
