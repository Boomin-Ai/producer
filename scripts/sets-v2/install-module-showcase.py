#!/usr/bin/env python3
"""Explicit cutover of the isolated dev profile, preserving all room media."""
import json,sqlite3,shutil,datetime,os
from pathlib import Path
root=Path(__file__).resolve().parents[2]
identity=json.loads((root/'src-tauri/tauri.sets-v2-dev.conf.json').read_text())['identifier']
assert identity=='ai.boomin.producer.sets-v2-dev'
profile=Path.home()/'Library/Application Support'/identity
library=profile/'sets-library';library.mkdir(parents=True,exist_ok=True)
backup=profile/'module-cutover-backups'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup.mkdir(parents=True,exist_ok=False);os.chmod(backup,0o700)
names=['head-to-head-grand-arena','decision-room','open-floor','atmosphere','just-facts']
for name in names:
 target=library/(name+'.json')
 if target.exists():shutil.copyfile(target,backup/target.name)
 temporary=target.with_suffix('.json.install')
 shutil.copyfile(root/'docs/shows'/(name+'.json'),temporary)
 os.replace(temporary,target)
db=profile/'sets-v2-dev/producer.db'
if db.exists():
 conn=sqlite3.connect(db);copy=sqlite3.connect(backup/'producer.db');conn.backup(copy);copy.close();os.chmod(backup/'producer.db',0o600)
 changed=0
 for rowid,raw in conn.execute('SELECT id,config FROM live_rooms').fetchall():
  try:config=json.loads(raw or '{}')
  except ValueError:continue
  presentation=config.get('presentation');doc=presentation.get('package') if isinstance(presentation,dict) else None
  if not isinstance(doc,dict) or doc.get('id')!='head-to-head-grand-arena':continue
  fresh=json.loads((root/'docs/shows/head-to-head-grand-arena.json').read_text())
  for key,value in fresh['set']['values'].items():
   previous=doc.get('set',{}).get('values',{}).get(key,{})
   if previous.get('type')==value['type'] and isinstance(previous.get('default'),str):value['default']=previous['default'][:value['maxLength']]
  presentation['package']=fresh;conn.execute('UPDATE live_rooms SET config=? WHERE id=?',(json.dumps(config),rowid));changed+=1
 conn.commit();conn.close();print('Converted',changed,'configured Grand Arena rooms; source assignments preserved.')
print('Installed five presentation/2 packages in the isolated dev catalog. Private backups retained.')
