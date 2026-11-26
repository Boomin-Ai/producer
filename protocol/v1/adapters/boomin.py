#!/usr/bin/env python3
"""Project one Producer shot into Boomin's boomin.workspace.v2 entity and prompt sheet format."""
import argparse
import hashlib
import json
import os
import subprocess


def local_id(kind, value):
    # Boomin shares one 80-character namespace across object types.
    return kind + "-" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def workspace(sheet):
    entities = []
    names = {}
    for source, entity in sheet["entities"].items():
        names[source] = local_id("entity", source)
        entities.append({
            "local_id": names[source], "kind": entity["kind"], "name": entity["name"],
            "traits": entity["traits"], "prompt_scaffold": entity["promptScaffold"],
        })
        if entity.get("voice") and entity["voice"]["provider"] == "elevenlabs":
            entities[-1]["voice_id"] = entity["voice"]["id"]
    direction = sheet["direction"]
    mentions = [{"start": x["start"], "end": x["end"], "entity": {"$ref": names[x["entity"]]}}
                for x in direction["mentions"]]
    spec = {"action": direction["action"], "camera": sheet["resolvedSetup"]["camera"],
            "lighting": sheet["resolvedSetup"].get("lighting"),
            "producer": {"production": sheet["production"], "revision": sheet["revision"],
                         "shot": sheet["shot"], "duration":sheet["duration"], "cut":sheet["cut"],
                         "beats":sheet["resolvedBeats"], "references":direction["references"],
                         "inputs":sheet["inputs"], "intendedModel":sheet["intendedModel"]}}
    return {"schema_version": "boomin.workspace.v2", "objects": {
        "entities": entities, "prompt_sheets": [{"local_id": local_id("sheet",sheet["shot"]),
            "title": sheet["title"], "part_kind": "shot", "shot_spec": spec,
            "prompt_doc": {"text": direction["prompt"], "mentions": mentions}}],
        "flows": [], "collections": []}, "params": [], "bindings": []}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package")
    parser.add_argument("shot")
    parser.add_argument("--core", default=os.environ.get("PRODUCER_CORE","producer-core"))
    args = parser.parse_args()
    sheet = json.loads(subprocess.check_output([args.core,"bundle-sheet",args.package,args.shot]))
    print(json.dumps(workspace(sheet), ensure_ascii=False, indent=2))
