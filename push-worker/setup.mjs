// Run interactively on the owner's computer. No secrets are committed or uploaded to GitHub.
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const email=process.argv[2];
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email||'')){console.error('Usage: node setup.mjs you@example.com');process.exit(1);}
const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), jwk=privateKey.export({format:'jwk'});
const raw=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x,'base64url'),Buffer.from(jwk.y,'base64url')]).toString('base64url');
const secrets={PAIRING_KEY:randomBytes(32).toString('hex'),VAPID_PUBLIC_KEY:raw,VAPID_PRIVATE_JWK:JSON.stringify(jwk),VAPID_SUBJECT:'mailto:'+email};
const filename='.push-secrets.local.json';
try{writeFileSync(filename,JSON.stringify(secrets,null,2),{flag:'wx',mode:0o600});}
catch{console.error('A local secret backup already exists. Reuse it instead of rotating keys accidentally.');process.exit(1);}
console.log('Secret backup: '+filename+' (keep it private).');
const r=spawnSync('npx',['wrangler','deploy','--secrets-file',filename],{stdio:'inherit',shell:process.platform==='win32'});
if(r.status!==0){console.error('Deploy did not finish. After resolving it: npx wrangler deploy --secrets-file '+filename);process.exit(1);}
console.log('Paste the deployed HTTPS Worker URL and this pairing key into 30 Days of… → Settings → Notifications.');
console.log(secrets.PAIRING_KEY);
