import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
export async function buildNative() {
 if(process.platform!=='darwin')throw new Error('Native proof currently requires macOS');
 const dir=await mkdtemp(join(tmpdir(),'producer-native-set-proof-'));
 const contents=join(dir,'Producer.app','Contents');await mkdir(join(contents,'MacOS'),{recursive:true});
 await symlink('/Applications/Producer.app/Contents/Frameworks',join(contents,'Frameworks'));
 await symlink('/Applications/Producer.app/Contents/PlugIns',join(contents,'PlugIns'));
 await writeFile(join(contents,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>producer</string><key>CFBundleName</key><string>Producer</string><key>CFBundleIdentifier</key><string>ai.boomin.producer</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`);
 const executable=join(contents,'MacOS','producer');
 await exec('/usr/bin/clang',['-fobjc-arc','-fblocks','-Wno-incompatible-pointer-types','scripts/presentation-proof/native.m','src-tauri/src/live/source_appearance.c','-F/Applications/Producer.app/Contents/Frameworks','-framework','libobs','-framework','AppKit','-Wl,-rpath,/Applications/Producer.app/Contents/Frameworks','-o',executable]);
 await exec('/usr/bin/codesign',['--force','--sign','-',executable]);
 return {dir,executable};
}
