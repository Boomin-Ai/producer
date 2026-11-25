#include <metal_stdlib>
using namespace metal;

struct Shot {
    float4 eye, right, up, forward;
    float4 projection; // horizontal and vertical focal scales, near, far
    float4 sun, sunlight, ambient;
};
struct Instance {
    float4 position, size, rotation, color;
    float4 surface; // roughness, metallic, emission, minor radius
    float4 detail;  // engraving frequency XY, primitive, input slot
};
struct Vertex {
    float4 clip [[position]];
    float3 world, normal;
    float2 uv;
    float4 albedoMetal, emissionRough;
};
float3 rotate_xyz(float3 v, float3 r) {
    float3 c=cos(r), s=sin(r);
    float3 a=float3(v.x, c.x*v.y-s.x*v.z, s.x*v.y+c.x*v.z);
    float3 b=float3(c.y*a.x+s.y*a.z, a.y, -s.y*a.x+c.y*a.z);
    return float3(c.z*b.x-s.z*b.y,s.z*b.x+c.z*b.y,b.z);
}
vertex Vertex mesh_vertex(uint index [[vertex_id]],device const float2 *grid [[buffer(0)]],
                          constant Shot &shot [[buffer(1)]],constant Instance &obj [[buffer(2)]]) {
    bool custom=obj.detail.z==4;
    bool clip=obj.detail.z==5;
    float2 uv=(custom||clip)?float2(0):grid[index];
    float u=uv.x*6.2831853, v=uv.y*6.2831853;
    float3 p,n;
    uint mesh=uint(obj.detail.z);
    Vertex out;
    out.albedoMetal=float4(obj.color.rgb,obj.surface.y);out.emissionRough=float4(0,0,0,obj.surface.x);
    if(clip){
        device const uint *header=reinterpret_cast<device const uint *>(grid);
        uint count=header[0],indices=header[1],frames=header[2],fps=header[3],id=header[4+index];
        device const uchar4 *colors=reinterpret_cast<device const uchar4 *>(header+4+indices);
        device const short *poses=reinterpret_cast<device const short *>(colors+count);
        float time=fmod(max(0.0,shot.eye.w+obj.position.w)*float(fps),float(frames));
        uint frame=uint(time);
        device const short *a=poses+8*(frame*count+id);
        device const short *b=poses+8*(((frame+1)%frames)*count+id);
        p=mix(float3(a[0],a[1],a[2]),float3(b[0],b[1],b[2]),fract(time))/8192.0;
        n=normalize(mix(float3(a[4],a[5],a[6]),float3(b[4],b[5],b[6]),fract(time))+float3(1e-5));
        out.albedoMetal=float4(pow(float3(colors[id].rgb)/255.0,float3(2.2))*obj.color.rgb,obj.surface.y);
        out.emissionRough=float4(0,0,0,obj.surface.x);
    } else if(custom){
        device const float4 *v=reinterpret_cast<device const float4 *>(grid)+4*index;
        p=v[0].xyz;n=v[1].xyz;out.albedoMetal=v[2];out.emissionRough=float4(v[3].xyz,v[1].w);
    } else if(mesh==0) {
        float a=uv.y*3.14159265;
        n=float3(cos(u)*sin(a),cos(a),sin(u)*sin(a)); p=n;
    } else if(mesh==1) {
        float2 axis=float2(cos(u),sin(u));
        n=float3(axis*cos(v),sin(v));
        p=float3(axis,0)+obj.surface.w*n;
    } else {
        p=float3(uv.x*2-1,1-uv.y*2,0); n=float3(0,0,1);
    }
    out.uv=uv; out.world=rotate_xyz(p*obj.size.xyz,obj.rotation.xyz)+obj.position.xyz;
    out.normal=normalize(rotate_xyz(n/obj.size.xyz,obj.rotation.xyz));
    float3 delta=out.world-shot.eye.xyz;
    float z=dot(delta,shot.forward.xyz);
    float near=shot.projection.z, far=shot.projection.w;
    out.clip=float4(dot(delta,shot.right.xyz)*shot.projection.x,
                    dot(delta,shot.up.xyz)*shot.projection.y,
                    far*(z-near)/(far-near), z);
    return out;
}
float ruling(float coord,float count) {
    float x=coord*count;
    float d=abs(fract(x+0.5)-0.5);
    float w=max(fwidth(x),0.0001);
    return count>0 ? (1-smoothstep(0.35*w,1.4*w,d))*(1-smoothstep(0.22,0.65,w)):0;
}
fragment float4 mesh_surface(Vertex in [[stage_in]],constant Shot &shot [[buffer(1)]],
             constant Instance &obj [[buffer(2)]],texture2d<float> first [[texture(0)]],
             texture2d<float> second [[texture(1)]],texture2d<float> environmentMap [[texture(2)]],sampler linear_sample [[sampler(0)]]) {
    uint kind=uint(obj.detail.z);
    float2 xy=2*in.uv-1;
    if(kind==3 && dot(xy,xy)>1) discard_fragment();
    float3 n=normalize(in.normal),l=normalize(shot.sun.xyz);
    float3 view=normalize(shot.eye.xyz-in.world);
    float nl=max(dot(n,l),0.0), nv=saturate(dot(n,view));
    float3 base=obj.color.rgb;
    float metallic=obj.surface.y;
    float engraving=max(ruling(in.uv.x,obj.detail.x), ruling(in.uv.y,obj.detail.y));
    float3 h=normalize(l+view+float3(0.00001));
    float spec=pow(saturate(dot(h,n)),mix(128.0,5.0,obj.surface.x));
    float rim=pow(1-nv,3.2);
    float3 rgb=base*(shot.ambient.rgb+shot.sunlight.rgb*(0.10+0.90*nl)*(1-0.42*metallic))
        +shot.sunlight.rgb*mix(float3(0.17),base,metallic)*spec
        +base*(obj.surface.z+rim*(0.35+metallic*0.60))
        +engraving*(base+float3(0.10))*0.62;
    if(kind==4 || kind==5) {
        float metal=in.albedoMetal.w, rough=clamp(in.emissionRough.w,0.04,1.);
        float3 reflection=reflect(-view,n);
        float sky=smoothstep(-0.2,0.8,reflection.y);
        float soft=0.025+rough*0.38;
        float stripe=exp(-abs(reflection.y-0.22)/soft)+0.65*exp(-abs(reflection.x+0.6)/soft);
        float3 environment=mix(float3(.09,.043,.025),float3(.20,.34,.54),sky)
            +float3(1.6,.82,.27)*stripe;
        if(shot.ambient.w>0.5){
            constexpr sampler probeSampler(coord::normalized,s_address::repeat,t_address::clamp_to_edge,filter::linear,mip_filter::linear);
            float2 envUV=float2(.5+atan2(reflection.x,reflection.z)/6.2831853,acos(clamp(reflection.y,-1.,1.))/3.14159265);
            environment=environmentMap.sample(probeSampler,envUV,level(rough*float(environmentMap.get_num_mip_levels()-1))).rgb*2.6;
        }
        float3 c=in.albedoMetal.rgb;
        rgb=c*(shot.ambient.rgb+nl*shot.sunlight.rgb)*(1-metal)+environment*mix(float3(.04),c,metal)+in.emissionRough.rgb;
        rgb=sqrt(saturate(rgb/(0.65+rgb)));
    }
    if(obj.detail.w>=0) {
        bool a=obj.detail.w<0.5;
        float2 extent=a ? float2(first.get_width(),first.get_height()):float2(second.get_width(),second.get_height());
        float aspect=(obj.size.x/obj.size.y)/(obj.color.w>0 ? obj.color.w : extent.x/extent.y);
        float2 uv=0.5+(in.uv-0.5)*min(float2(aspect,1/aspect),1.0);
        float4 video=a ? first.sample(linear_sample,uv):second.sample(linear_sample,uv);
        rgb=mix(rgb,video.rgb,video.a);
    }
    return float4(rgb,1);
}
