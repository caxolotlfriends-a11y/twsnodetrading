import { z } from 'zod';
import type { Strategy } from './types';
const id=z.string().min(1).max(100).refine(s=>!['__proto__','constructor','prototype'].includes(s));
const number=z.number().finite();
const config=z.object({
  label:z.string().max(100).optional(),symbol:z.string().max(20).optional(),
  operator:z.enum(['gt','gte','lt','lte']).optional(),value:number.optional(),
  quantity:number.optional(),side:z.enum(['BUY','SELL']).optional(),
  orderType:z.enum(['MKT','LMT']).optional(),limitPrice:number.optional(),intervalSeconds:number.optional(),
});
const schema=z.object({id,name:z.string().min(1).max(100),nodes:z.array(z.object({
  id,kind:z.enum(['market','compare','and','or','not','timer','order']),
  position:z.object({x:number,y:number}),config,
})).max(60),edges:z.array(z.object({id,source:id,target:id})).max(120)}).superRefine((s,ctx)=>{
  if(new Set(s.nodes.map(n=>n.id)).size!==s.nodes.length||new Set(s.edges.map(e=>e.id)).size!==s.edges.length)
    ctx.addIssue({code:'custom',message:'Doppelte IDs sind nicht erlaubt.'});
});
/** Drafts may be incomplete. Execution validation belongs to the engine. */
export function parseStrategyDocument(input:unknown):Strategy {
  const parsed=schema.safeParse(input);
  if(!parsed.success)throw new Error('Ungültige Strategie-Datei: Name, Nodes, Positionen oder Konfiguration prüfen.');
  return parsed.data;
}
