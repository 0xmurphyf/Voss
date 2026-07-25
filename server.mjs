import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize} from 'node:path';
const root=process.cwd(),port=Number.parseInt(process.env.PORT || '4173',10);
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'};
createServer(async(req,res)=>{try{const raw=decodeURIComponent((req.url||'/').split('?')[0]);const relative=raw==='/'?'index.html':raw.replace(/^\/+/, '');const path=normalize(join(root,relative));if(!path.startsWith(root))throw new Error('invalid path');const info=await stat(path);if(!info.isFile())throw new Error('not a file');const body=await readFile(path);res.writeHead(200,{'Content-Type':types[extname(path)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body)}catch{res.writeHead(404);res.end('Not found')}}).listen(port,'0.0.0.0',()=>console.log(`VOXX listening on http://127.0.0.1:${port}`));
