"""Portable authored sets for the native New Studio gallery."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEY = {
    "clips": ((.99,.27,.16), "#FF8B72", "THE CLIP DESK", "CAPTURE  /  REFRAME  /  CLIP"),
    "podcast": ((.92,.65,.43), "#E9AE7C", "ON RECORD", "THE CONVERSATION"),
    "pilot": ((.39,.73,1.), "#8ECEFF", "PILOT LAB", "BUILD  /  TEST  /  SHOW"),
    "game-show": ((.96,.78,.34), "#FFE09B", "YES OR NO?", "A TWO-CHOICE GAME SHOW"),
}

ORANGE = """
let track=uv.x+.54*uv.y;
let run=track+.08*sin(t*.34);
let glow=exp(-abs(run-.73)*4.);
var rgb=vec3<f32>(.065,.031,.046)+vec3<f32>(.41,.069,.045)*glow;
let rail=1.-smoothstep(.001,.004,abs(run-.38));
let red=1.-smoothstep(.18,.49,abs(uv.x+.39*uv.y-1.13));
rgb+=vec3<f32>(.59,.13,.056)*red+rail*vec3<f32>(.20,.051,.018);
let tick = 1.-smoothstep(.04,.12,abs(fract(uv.x*31.)-.5));
rgb+=vec3<f32>(.28,.090,.070)*tick*smoothstep(.958,.981,uv.y)*(1.-smoothstep(.981,.991,uv.y));
"""
BRASS = """
let q=uv.x+.09*sin(2.4*uv.y);
let ribs=cos(q*94.);
let relief=pow(.5+.5*ribs,9.);
let pool=exp(-length((uv-vec2<f32>(.14,.13))*vec2<f32>(1.4,1.0))*1.9);
let rim=exp(-length((uv-vec2<f32>(.93,.62+.032*sin(t*.32)))*vec2<f32>(1.3,.78))*3.);
var rgb=vec3<f32>(.066,.034,.032)+pool*vec3<f32>(.42,.17,.12)
    +rim*vec3<f32>(.30,.136,.084)+relief*vec3<f32>(.066,.031,.020)*(pool+rim);
"""
PRISM = """
let tilt=uv.x-uv.y*.64;
let a=smoothstep(.18,.183,tilt);
let b=smoothstep(.45,.453,tilt);
let c=smoothstep(.68,.683,tilt);
let pulse=exp(-abs(tilt-.55-.079*sin(t*.29))*6.5);
var rgb=vec3<f32>(.028,.052,.114)
 +a*vec3<f32>(.018,.042,.11)+b*vec3<f32>(.042,.10,.23)-c*vec3<f32>(.051,.118,.235)
 +pulse*vec3<f32>(.027,.082,.22);
let edge = 1.-smoothstep(.0007,.0032,min(abs(tilt-.18),min(abs(tilt-.45),abs(tilt-.68))));
let plane = (uv.y+uv.x*.4);
rgb+=edge*vec3<f32>(.118,.42,.59)+.11*exp(-abs(plane-.67)*3.)*vec3<f32>(.18,.49,.82);
"""
GAME = """
let slope=uv.x+.38*uv.y;
let split=smoothstep(.69,.72,slope);
let beam=exp(-abs(slope-.72)*9.);
var rgb=mix(vec3<f32>(.042,.23,.217),vec3<f32>(.26,.107,.066),split)
 +beam*vec3<f32>(.14,.12,.042);
let rays=1.-smoothstep(.002,.012,abs(sin(24.*atan2(uv.y+.20,uv.x-.5))));
rgb+=.09*rays*exp(-2.5*uv.y)*vec3<f32>(.51,.8,.55);
let spot=exp(-length((uv-vec2<f32>(.67+.045*sin(t*.44),.28))*vec2<f32>(1.6,1.))*3.);
rgb+=spot*vec3<f32>(.43,.31,.084);
"""
BACKDROPS={"clips":ORANGE,"podcast":BRASS,"pilot":PRISM,"game-show":GAME}

def v(values):
    return f"vec{len(values)}<f32>(" + ", ".join(f"{x:.5f}" for x in values) + ")"

def rect(bounds,w,h):
    return dict(zip(("x","y","width","height"),(x*scale for x,scale in zip(bounds,(w,h,w,h)))))

def pass_(id, shader, *inputs):
    return dict(kind="fragment", id=id, shader=shader, inputs=[
        dict(kind="pass", id=src) if isinstance(src,str) else src for src in inputs
    ])

def tile(id, source, bounds, fit, accent, underneath):
    if fit=="contain":
        sampling="""
let fit=min(vec2<f32>(1.,aspect),vec2<f32>(1./aspect,1.));
let q=.5+(local-.5-frame.screenPan)/(fit*max(frame.controls.z,1.));
let visible=all(q>=vec2<f32>(0.)) && all(q<=vec2<f32>(1.));
"""
    else:
        scale="max(frame.controls.x,1.)" if source=="camera" else "1."
        sampling=f"""
let q=.5+(local-.5)*min(vec2<f32>(aspect,1./aspect),vec2<f32>(1.))/{scale};
let visible=true;
"""
    return pass_(id,f"""
let box={v(bounds)};
let size=box.zw*frame.info.xy;
let local=(uv-box.xy)/box.zw;
let p=(local-.5)*size;
let corner=10.;
let edge=abs(p)-(size*.5-corner);
let sd=length(max(edge,vec2<f32>(0.)))+min(max(edge.x,edge.y),0.)-corner;
let sampleSize=max(vec2<f32>(textureDimensions(input1)),vec2<f32>(1.));
let aspect=(size.x/size.y)/(sampleSize.x/sampleSize.y);
{sampling}
let sample=textureSample(input1,linear_sampler,clamp(q,vec2<f32>(0.),vec2<f32>(1.)));
let accent={v(accent)};
let bias=.10*exp(-length((local-vec2<f32>(.4,.1))*vec2<f32>(1.,1.5))*2.8);
let idle=vec3<f32>(.032,.033,.049)+accent*bias;
let image=mix(idle,sample.rgb,select(0.,sample.a,visible));
let inner=1.-smoothstep(-2.35,-1.0,sd);
let outer=1.-smoothstep(-.4,.95,sd);
let rim=accent*(.49+.32*(1.-smoothstep(.04,.7,local.y)));
let back=textureSample(input0,linear_sampler,uv).rgb;
let shadow=.50*exp(-max(sd,0.)/22.);
return vec4<f32>(mix(back*(1.-shadow),mix(rim,image,inner),outer),1.);
""",underneath,dict(kind="source",id=source))

def answer_shader(yes,no):
    body=""
    for bounds,color,condition in [(yes,(.095,.71,.51),"frame.controls.w > .5"),(no,(.80,.30,.11),"frame.controls.w < -.5")]:
        body+=f"""
{{
let box={v(bounds)};
let q=(uv-box.xy)/box.zw;
let inside=all(q>=vec2<f32>(0.)) && all(q<=vec2<f32>(1.));
let selected={condition};
let idle=vec3<f32>(.049,.064,.066)+{v(color)}*.14;
let a=select(idle,{v(color)}*.53,selected);
let border=min(min(q.x,q.y),min(1.-q.x,1.-q.y));
let rail=select(1.,.21,border>.017);
let pulse=.9+.10*cos(t*4.);
let mark=q-vec2<f32>(.73,.54);
let short=vec2<f32>(.066,.15);
let long=vec2<f32>(.105,-.32);
let d0=length(mark-short*clamp(dot(mark,short)/dot(short,short),0.,1.));
let delta=mark-short;
let d1=length(delta-long*clamp(dot(delta,long)/dot(long,long),0.,1.));
let check=1.-smoothstep(.012,.021,min(d0,d1));
let answer=a+{v(color)}*rail*select(.43,pulse,selected);
rgb=select(rgb,mix(answer,vec3<f32>(.98,.96,.84),check*select(0.,1.,selected)),inside);
}}
"""
    return body

def build_layout(workflow, mode, portrait):
    w,h=(1080,1920) if portrait else (1920,1080)
    accent,ink,name,caption=KEY[workflow]
    nodes=[]
    labels=[]
    def text(id,value,x,y,wide,points,color="#FFF4E7",weight=650,align="left"):
        nodes.append(dict(id=id, frame=rect((x,y,wide,points*1.33*len(value.splitlines())/h),w,h),
            flow=dict(kind="overlay"),content=dict(kind="text",value=value,font="0"*64),
            style=dict(text=dict(fontSize=points,weight=weight,align=align,ink=dict(color=color,opacity=1.0)))))
        labels.append(id)
    text("kicker",caption,.05,.035,.90,26 if portrait else 23,ink,700)
    text("masthead",name,.048,.069,.91,89 if portrait else 87,weight=850)
    background=BACKDROPS[workflow]
    tiles=[]
    if workflow=="game-show":
        if portrait:
            question=(.052,.191,.897)
            yes=(.052,.328,.427,.092); no=(.52,.328,.427,.092)
            camera=(.052,.475,.434,.365); guest=(.515,.475,.434,.365)
        else:
            question=(.482,.279,.463)
            yes=(.484,.529,.218,.151); no=(.729,.529,.218,.151)
            camera=(.050,.224,.395,.322); guest=(.050,.578,.395,.322)
        x,y,wide=question
        text("question","Is the Moon bigger\nthan Earth?",x,y,wide,65 if portrait else 59,weight=770)
        text("round-label","QUESTION",x,y-(.029 if portrait else .052),wide,24,ink,780)
        for id,bounds in (("yes",yes),("no",no)):
            x,y,wide,tall=bounds
            text(id,id.upper(),x,y+.024,wide,68 if portrait else 72,align="center",weight=820)
        text("host-caption","HOST",camera[0]+.016,camera[1]+camera[3]-.034,.22,23,ink)
        text("contestant-caption","CONTESTANT",guest[0]+.016,guest[1]+guest[3]-.034,.32,23,ink)
        tiles=[("host","camera",camera,"cover"),("guest","rtc-guest",guest,"cover")]
        background+=answer_shader(yes,no)
    elif workflow=="podcast" and mode=="main":
        host=(.051,.165,.898,.348) if portrait else (.047,.206,.444,.688)
        guest=(.051,.539,.898,.348) if portrait else (.508,.206,.444,.688)
        tiles=[("host","camera",host,"cover"),("guest","rtc-guest",guest,"cover")]
        for role,bounds in (("Host",host),("Guest",guest)):
            label_y=bounds[1]+bounds[3]-(.030 if portrait else .056)
            text(role.lower()+"-caption",role.upper(),bounds[0]+.018,label_y,.40,25,ink,780)
    elif mode=="host":
        bounds=(.050,.166,.90,.715) if portrait else (.049,.207,.902,.703)
        tiles=[("host","camera",bounds,"cover")]
        text("host-caption","HOST",bounds[0]+.017,bounds[1]+bounds[3]-(.033 if portrait else .055),.28,24,ink,780)
    else:
        bounds=(.043,.175,.914,.709) if portrait else (.049,.205,.902,.710)
        host=(.065,.719,.380,.143) if portrait else (.070,.680,.225,.199)
        tiles=[("shared-window","screen",bounds,"contain"),("host","camera",host,"cover")]
        text("input-caption","SCREEN SHARE",bounds[0]+.019,bounds[1]+.016,.46,24,ink,760)
    background="""
let t=frame.info.z;
let foot=1.-smoothstep(.7,1.7,abs(uv.y-.925)*frame.info.y);
let head=1.-smoothstep(.7,1.7,abs(uv.y-.153)*frame.info.y);
let span=step(.049,uv.x)*(1.-step(.952,uv.x));
let grain=fract(52.9829189*fract(dot(floor(uv*frame.info.xy),vec2<f32>(.06711056,.00583715))))-.5;
"""+background+f"""
rgb+=({v(accent)})*span*(.265*foot+.197*head)+grain*.016;
return vec4<f32>(rgb,1.);
"""
    passes=[pass_("backdrop",background)]
    for id,source,bounds,fit in tiles:
        nodes.append(dict(id=id,frame=rect(bounds,w,h),flow=dict(kind="overlay"),
                          content=dict(kind="source",source=source,fit=fit)))
        passes.append(tile(id,source,bounds,fit,accent,passes[-1]["id"]))
    passes.append(pass_("typography","""
let back=textureSample(input0,linear_sampler,uv);
let ink=textureSample(input1,linear_sampler,uv);
return vec4<f32>(back.rgb*(1.-ink.a)+ink.rgb,1.);
""",passes[-1]["id"],dict(kind="layers",nodes=labels)))
    orient="vertical" if portrait else "landscape"
    layout=dict(orientation=orient,width=w,height=h,root=dict(id="root",frame=rect((0,0,1,1),w,h),
                flow=dict(kind="overlay"),content=dict(kind="group"),children=nodes))
    return layout,dict(profile="producer.render/1",passes=passes)

def design(kind):
    modes=[("main",{"clips":"Screen Share","podcast":"Interview","pilot":"Screen Share","game-show":"Question"}[kind])]
    if kind!="game-show":
        modes.append(("host","Host"))
    layouts={}; graphs={}; segments=[]
    for mode,label in modes:
        ids={}
        for orient in ("landscape","vertical"):
            key=orient if mode=="main" else f"{mode}-{orient}"
            layouts[key],graphs[key]=build_layout(kind,mode,orient=="vertical")
            ids[orient]=key
        segments.append(dict(id=mode,title=label,**ids))
    return dict(
        set=dict(layouts=layouts,graphs=graphs,outputGraphs={key:key for key in layouts},
                 theme={"quiz":"#FFE09B"} if kind=="game-show" else {}),
        show=dict(set=f"{kind}-studio",authority="local",segments=segments))

if __name__=="__main__":
    (HERE/"catalog.json").write_text(json.dumps({kind:design(kind) for kind in KEY},indent=2)+"\n")
