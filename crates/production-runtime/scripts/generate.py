#!/usr/bin/env python3
"""Generate schema, TS and example files from the Rust contract, never the reverse."""
import argparse, json, pathlib, subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
def ts(s):
    if s is True: return "unknown"
    if s is False: return "never"
    if "$ref" in s: return s["$ref"].split("/")[-1]
    if "const" in s: return json.dumps(s["const"])
    if "enum" in s: return " | ".join(json.dumps(x) for x in s["enum"])
    for combinator, join in [("oneOf", " | "), ("anyOf", " | "), ("allOf", " & ")]:
        if combinator in s: return "(" + join.join(ts(x) for x in s[combinator]) + ")"
    typ = s.get("type")
    if isinstance(typ, list): return "(" + " | ".join(ts({**s,"type":x}) for x in typ) + ")"
    if typ == "string": return "string"
    if typ in ("number", "integer"): return "number"
    if typ == "boolean": return "boolean"
    if typ == "null": return "null"
    if typ == "array":
        if "prefixItems" in s: return "readonly [" + ", ".join(ts(x) for x in s["prefixItems"]) + "]"
        return "ReadonlyArray<" + ts(s.get("items", {})) + ">"
    if typ == "object" or "properties" in s:
        props = s.get("properties", {}); required = s.get("required", [])
        fields = ["readonly " + json.dumps(k) + ("" if k in required else "?") + ": " + ts(v) for k,v in props.items()]
        if not props and s.get("additionalProperties", True) is not False:
            return "Readonly<Record<string, " + ts(s.get("additionalProperties", {})) + ">>"
        return "{ " + "; ".join(fields) + " }"
    return "unknown"

def run(binary, check):
    generated=ROOT/"generated"; generated.mkdir(exist_ok=True)
    schemas={name:json.loads(subprocess.check_output([binary,cmd])) for name,cmd in [("document","schema"),("commands","command-schema"),("tools","tool-schema")]}
    types={}; outputs={}
    def annotate(x):
        if isinstance(x,dict):
            if x.get("type")=="string": x["x-maxUtf8Bytes"]=65536
            for value in list(x.values()): annotate(value)
        elif isinstance(x,list):
            for value in x: annotate(value)
    for name,schema in schemas.items():
        annotate(schema)
        schema["x-nativeSemanticValidationRequired"]=True
        schema["x-documentProfile"]="producer.production/1"
        outputs[f"{name}.schema.json"]=json.dumps(schema,indent=2,ensure_ascii=False)+"\n"
        for k,v in schema.get("$defs",{}).items():
            value=ts(v)
            if k in types and types[k]!=value: raise AssertionError(f"colliding generated type: {k}")
            types[k]=value
        types[{"document":"Document","commands":"Command","tools":"Request"}[name]]=ts(schema)
    outputs["contract.d.ts"]="// Generated from Rust. Types are structural; always use native admission.\n"+"\n".join(f"export type {k} = {v};" for k,v in sorted(types.items()))+"\n"
    outputs["classic-like.json"]=subprocess.check_output([binary,"fixture"],text=True)
    outputs["nested-timeline.json"]=subprocess.check_output([binary,"nested-fixture"],text=True)
    outputs["responsive-layout.json"]=subprocess.check_output([binary,"layout-fixture"],text=True)
    outputs["analytic-effects.json"]=subprocess.check_output([binary,"analytic-fixture"],text=True)
    for name,body in outputs.items():
        path=generated/name
        if check:
            if not path.exists() or path.read_text()!=body: raise AssertionError(f"stale generated contract: {path}")
        else: path.write_text(body)
    print(f"{'Verified' if check else 'Generated'} {len(outputs)} Rust-derived artifacts")
if __name__=="__main__":
    p=argparse.ArgumentParser();p.add_argument("--binary",required=True);p.add_argument("--check",action="store_true");a=p.parse_args();run(a.binary,a.check)
