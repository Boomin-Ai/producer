import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './client.mjs';

if (process.platform !== 'darwin') throw new Error('Run the Mac installer on macOS');
const configPath = resolve(process.argv[2] ?? 'bridge.local.json');
const config = await loadConfig(configPath);
if (config.peer !== 'mac') throw new Error('Mac installer requires peer=mac');
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
await chmod(config.stateDir, 0o700); await chmod(config.tokenFile, 0o600); await chmod(configPath, 0o600);
const escape = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const args = [process.execPath, fileURLToPath(new URL('./client.mjs',import.meta.url)), configPath];
const label = 'ai.boomin.producer-agent-bridge';
const agents = join(homedir(),'Library','LaunchAgents'); await mkdir(agents,{recursive:true});
const path = join(agents,label+'.plist');
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(s=>'<string>'+escape(s)+'</string>').join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
<key>StandardOutPath</key><string>${escape(join(config.stateDir,'listener.stdout.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(config.stateDir,'listener.stderr.log'))}</string>
</dict></plist>`;
await writeFile(path,plist,{mode:0o600});
execFileSync('/usr/bin/plutil',['-lint',path],{stdio:'inherit'});
execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,path],{stdio:'inherit'});
console.log('Mac listener registered and started. Run control.mjs status to verify its connection.');
