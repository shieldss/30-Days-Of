// Run the isolated local alarm fixture with fresh credentials, never production keys.
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const signer=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'jwk'});
const key=Buffer.concat([Buffer.from([4]),Buffer.from(signer.x,'base64url'),Buffer.from(signer.y,'base64url')]);
const config=fileURLToPath(new URL('./config.capnp',import.meta.url));
const result=spawnSync(process.argv[2]||'workerd',['test',config],{stdio:'inherit',env:{...process.env,
 TEST_VAPID_PRIVATE_JWK:JSON.stringify(signer),
 TEST_VAPID_PUBLIC_KEY:key.toString('base64url'),
 TEST_PAIRING_KEY:randomBytes(32).toString('hex')
}});
if(result.error)throw result.error;
process.exitCode=result.status??1;
