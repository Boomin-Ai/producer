/* Native source appearance; OBS effect dialect compiled by Metal/GL/D3D11.
 * Shape and outline are measured in placement pixels. Border stays inside the
 * source extent so editing never changes source dimensions or capture consent. */
#ifndef PRODUCER_SOURCE_APPEARANCE_EFFECT_H
#define PRODUCER_SOURCE_APPEARANCE_EFFECT_H
static const char PRODUCER_SOURCE_APPEARANCE_EFFECT[] =
"uniform float4x4 ViewProj;\n"
"uniform texture2d image;\n"
"uniform float2 extent;\n"
"uniform float radius; uniform float circle; uniform float outline;\n"
"uniform float red; uniform float green; uniform float blue;\n"
"uniform float grayscale; uniform float opacity;\n"
"sampler_state textureSampler { Filter = Linear; AddressU = Clamp; AddressV = Clamp; };\n"
"struct VertData { float4 pos : POSITION; float2 uv : TEXCOORD0; };\n"
"VertData VSDefault(VertData v) { VertData o; o.pos = mul(float4(v.pos.xyz,1.0),ViewProj); o.uv=v.uv; return o; }\n"
"float4 PSDefault(VertData v) : TARGET {\n"
" float2 halfSize=extent*0.5; float2 p=(v.uv-0.5)*extent;\n"
" float r=min(radius,min(halfSize.x,halfSize.y));\n"
" float2 q=abs(p)-(halfSize-r);\n"
" float d=length(max(q,0.0))+min(max(q.x,q.y),0.0)-r;\n"
" if(circle>0.5) d=length(p)-min(halfSize.x,halfSize.y);\n"
" float coverage=saturate(0.5-d);\n"
" float border=outline>0.0 ? saturate(d+outline+0.5) : 0.0;\n"
" float4 c=image.Sample(textureSampler,v.uv);\n"
" float luma=dot(c.rgb,float3(0.2126,0.7152,0.0722));\n"
" c.rgb=lerp(c.rgb,float3(luma,luma,luma),grayscale);\n"
" c=lerp(c,float4(red,green,blue,1.0),border);\n"
" return c*(coverage*opacity);\n"
"}\n"
"technique Draw { pass { vertex_shader=VSDefault(v); pixel_shader=PSDefault(v); } }\n";
#endif
