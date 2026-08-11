FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node index.html server.mjs site.webmanifest ./
COPY --chown=node:node favicon.ico icon-192x192.png icon-256x256.png icon-512x512.png ./
COPY --chown=node:node assets ./assets

RUN node --check server.mjs && node -e "const fs=require('fs');const checks=[['icon-192x192.png',192],['icon-256x256.png',256],['icon-512x512.png',512]];for(const [p,size] of checks){const b=fs.readFileSync(p);if(b.toString('hex',0,8)!=='89504e470d0a1a0a'||b.readUInt32BE(16)!==size||b.readUInt32BE(20)!==size)throw new Error(p+' must be a real '+size+'x'+size+' PNG')}const favicon=fs.readFileSync('favicon.ico');if(favicon.toString('hex',0,4)!=='00000100')throw new Error('favicon.ico must be a real ICO file');const manifest=JSON.parse(fs.readFileSync('site.webmanifest','utf8'));for(const p of ['/icon-192x192.png?v=20260811-v2','/icon-256x256.png?v=20260811-v2','/icon-512x512.png?v=20260811-v2'])if(!manifest.icons.some(icon=>icon.src===p))throw new Error('Manifest is missing '+p)"

ENV NODE_ENV=production
EXPOSE 4173

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
