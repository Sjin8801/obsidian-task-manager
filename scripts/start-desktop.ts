import { spawn } from 'node:child_process';
import electron from 'electron';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron as unknown as string, ['dist/desktop/main.cjs'], { stdio: 'inherit', env });
child.on('error', () => { console.error('Could not start Electron. Run npm ci first.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
