"""Describe verified revision differences using document IDs and exact wire times."""
import hashlib
import json
from xml.etree import ElementTree as ET
from zipfile import ZipFile


def token(value):
    return str(value).replace("~","~0").replace("/","~1")


def field_changes(path, before, after):
    if before == after:
        return
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(before.keys() | after.keys()):
            child = path + "/" + token(key)
            if key not in after:
                yield {"path":child,"op":"removed","before":before[key]}
            elif key not in before:
                yield {"path":child,"op":"added","after":after[key]}
            else:
                yield from field_changes(child,before[key],after[key])
        return
    if isinstance(before,list) and isinstance(after,list) and all(isinstance(v,dict) and isinstance(v.get("id"),str) for v in before+after):
        left = {v["id"]:v for v in before}
        right = {v["id"]:v for v in after}
        if len(left)==len(before) and len(right)==len(after):
            if list(left) != list(right):
                yield {"path":path,"op":"order","before":list(left),"after":list(right)}
            yield from field_changes(path,left,right)
            return
    yield {"path":path,"op":"changed","before":before,"after":after}


def score_summary(path):
    with ZipFile(path) as score:
        with score.open("project.xml") as stream:
            xml = stream.read(8 * 1024 * 1024 + 1)
        if len(xml) > 8 * 1024 * 1024:
            raise ValueError("Score XML exceeds budget")
        tree = ET.fromstring(xml)
    tempo = tree.find("./Transport/Tempo")
    notes = [note.attrib for note in tree.findall(".//Note")]
    return {"tempoBpm":tempo.get("value") if tempo is not None else None,
            "instruments":[n.get("deviceName",n.get("deviceID")) for n in tree.iter() if n.get("deviceRole")=="instrument"],
            "notes":len(notes),"noteDataSha256":hashlib.sha256(json.dumps(notes,sort_keys=True).encode()).hexdigest()}


def report(parent, child, before_receipt, after_receipt, bounded):
    def load(root,receipt):
        raw = bounded(root/"manifest.json")
        if hashlib.sha256(raw).hexdigest() != receipt["revision"]:
            raise ValueError("Manifest changed after verification")
        manifest = json.loads(raw)
        document = bounded(root/"production.json")
        if hashlib.sha256(document).hexdigest() != manifest["documentSha256"]:
            raise ValueError("Document changed after verification")
        return manifest,json.loads(document)
    older, a = load(parent,before_receipt)
    newer, b = load(child,after_receipt)
    changes = list(field_changes("/production",a,b))
    changes.extend(field_changes("/manifest",older,newer))
    sessions = {}
    for key in sorted(older.get("musicSessions",{}).keys() & newer.get("musicSessions",{}).keys()):
        old = older["musicSessions"][key]["arrangementSha256"]
        new = newer["musicSessions"][key]["arrangementSha256"]
        if old != new:
            sessions[key] = {"before":score_summary(parent/"blobs"/old),"after":score_summary(child/"blobs"/new)}
    stable = []
    for seq in sorted(a["sequences"].keys() & b["sequences"].keys()):
        for field,timing in [("placements","range"),("cues","at")]:
            original = {p["id"]:p[timing] for p in a["sequences"][seq].get(field,[])}
            for item in b["sequences"][seq].get(field,[]):
                if original.get(item["id"]) == item[timing]:
                    stable.append({"sequence":seq,"kind":field,"id":item["id"],timing:item[timing]})
    return {"protocol":"producer.revision-report/1","parent":before_receipt["revision"],"revision":after_receipt["revision"],
            "author":after_receipt["author"],"changes":changes,"musicSessions":sessions,"preservedTiming":stable}
