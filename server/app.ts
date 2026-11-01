import express, { type Request, type Response, type NextFunction } from 'express';
import { TradingService } from './trading-service.js';

/** Loopback-only API, JSON mutations and exact same-origin checks prevent web CSRF. */
export function createApp(service = new TradingService()) {
  const app=express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    const host=req.headers.host??'';
    if(!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {res.status(403).json({error:'Nur lokale Zugriffe sind erlaubt.'});return;}
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const origin=req.headers.origin;
      if(origin && origin!==`http://${host}`) {res.status(403).json({error:'Anfragen anderer Webseiten sind nicht erlaubt.'});return;}
      if(!req.is('application/json')) {res.status(415).json({error:'application/json erforderlich.'});return;}
    }
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    next();
  });
  app.use(express.json({limit:'128kb'}));
  app.get('/api/health',(_req,res)=>res.json({ok:true,application:'NodeDesk',paperOnly:true}));
  app.get('/api/state',(_req,res)=>res.json(service.snapshot()));
  app.get('/api/events',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.flushHeaders();
    const send=(state:unknown)=>res.write(`data: ${JSON.stringify(state)}\n\n`);
    send(service.snapshot());service.on('change',send);
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
    req.on('close',()=>{clearInterval(heartbeat);service.off('change',send);});
  });
  app.post('/api/connection',async(req,res,next)=>{
    try {
      const body=req.body;
      if(!body || !['simulation','paper'].includes(body.mode))throw new Error('Modus muss simulation oder paper sein.');
      if(body.host!==undefined && typeof body.host!=='string')throw new Error('Host muss eine Zeichenkette sein.');
      if(body.port!==undefined && !Number.isInteger(body.port))throw new Error('Port muss eine ganze Zahl sein.');
      if(body.clientId!==undefined && !Number.isInteger(body.clientId))throw new Error('Client-ID muss eine ganze Zahl sein.');
      res.json(await service.connect(body));
    }catch(error){next(error);}
  });
  app.post('/api/arm',(req,res,next)=>{try{res.json(service.arm(req.body?.armed));}catch(error){next(error);}});
  app.post('/api/strategy/start',(req,res,next)=>{try{res.json(service.start(req.body?.strategy));}catch(error){next(error);}});
  app.post('/api/strategy/stop',(_req,res)=>res.json(service.stop()));
  app.post('/api/orders/:id/cancel',(req,res,next)=>{try{res.json(service.cancel(req.params.id));}catch(error){next(error);}});
  app.post('/api/reset',(_req,res,next)=>{try{res.json(service.reset());}catch(error){next(error);}});
  app.use('/api',(_req,res)=>res.status(404).json({error:'API-Endpunkt nicht gefunden.'}));
  app.use((error:Error, _req:Request,res:Response,_next:NextFunction)=>res.status(400).json({error:error.message || 'Ungültige Anfrage.'}));
  return {app,service};
}
