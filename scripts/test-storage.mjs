import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Never use a remote Docker endpoint or inherited database credentials.
const context = spawnSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {encoding:'utf8',timeout:5000});
const host = context.stdout?.trim();
if (context.status !== 0 || !host?.startsWith('unix://')) {
  process.stderr.write('A local Unix Docker context is required.\n');
  process.exit(1);
}
const name = `bridge-store-test-${randomUUID().slice(0,8)}`;
const password = randomUUID();
const docker = (args, opts={}) => spawnSync('docker',['--host',host,...args],{encoding:'utf8',timeout:180000,...opts});
let created=false;
const cleanup=()=>{if(created){created=false;docker(['rm','-f',name],{timeout:15000});}};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{cleanup();process.exit(signal==='SIGINT'?130:143);});
try {
  const result=docker(['run','-d','--rm','--name',name,'-p','127.0.0.1::3306','--tmpfs','/var/lib/mysql','-e','MYSQL_ROOT_PASSWORD','-e','MYSQL_DATABASE=bridge_test','mysql:8.4'],{env:{...process.env,MYSQL_ROOT_PASSWORD:password}});
  // A failed/timeout run may have created this uniquely named container.
  created=true;
  if(result.status!==0)throw new Error('container_start_failed');
  let ready=false;
  for(let i=0;i<90;i++){
    if(docker(['exec',name,'mysqladmin','ping','--silent'],{timeout:2000}).status===0){ready=true;break;}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready)throw new Error('mysql_startup_deadline');
  const port=docker(['port',name,'3306/tcp'],{timeout:5000}).stdout?.trim().split(':').at(-1);
  if(!/^\d+$/.test(port??''))throw new Error('container_port_missing');
  const files=process.argv.slice(2);
  if(files.some(file=>!/^test\/[a-z0-9_.-]+\.test\.mjs$/i.test(file)))throw new Error('invalid_test_path');
  const run=spawnSync(process.execPath,['--test',...(files.length?files:['test/storage.integration.test.mjs'])],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),stdio:'inherit',timeout:60000,killSignal:'SIGKILL',
    env:{...process.env,BRIDGE_TEST_HOST:'127.0.0.1',BRIDGE_TEST_PORT:port,BRIDGE_TEST_USER:'root',BRIDGE_TEST_PASSWORD:password,BRIDGE_TEST_DATABASE:'bridge_test'},
  });
  process.exitCode=run.status??1;
} catch {process.stderr.write('Isolated storage verification failed.\n');process.exitCode=1;}
finally {cleanup();}
