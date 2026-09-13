import { readFile } from 'node:fs/promises';
import { createPoolFromEnvironment } from './connection.mjs';
import { migrate } from './migrations.mjs';
const args=process.argv.slice(2);
if(args.length!==2 || args[0]!=='--config') {process.stderr.write('Usage: node src/storage/migrate-cli.mjs --config <storage-reference-json>\n');process.exitCode=1;}
else {
 let pool;
 try {pool=createPoolFromEnvironment(JSON.parse(await readFile(args[1],'utf8')));const result=await migrate(pool);process.stdout.write(JSON.stringify({module:'bridge',component:'storage',operation:'migrate',status:'succeeded',version:result.version,applied:result.applied})+'\n');}
 catch {process.stderr.write(JSON.stringify({module:'bridge',component:'storage',operation:'migrate',status:'failed',code:'migration_failed'})+'\n');process.exitCode=1;}
 finally {if(pool)await pool.end();}
}
