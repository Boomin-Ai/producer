/* Shared native filter for source editing and isolated set placements.
 * Per-placement set overrides must attach to a placement wrapper, never mutate
 * the shared capture source. Audio and source dimensions remain untouched. */
#include "obs_min.h"
#include "source_appearance.effect.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
static void producer_shader_register(void);
struct appearance_filter {obs_source_t *source;gs_effect_t *effect;float radius,outline,gray,opacity,width,height,circle,r,g,b;};
/* Immutable video-only reference. The trusted owner binds it before adding it
 * to a graph; imported settings can neither choose nor replace its capture.
 * Two placements retain one capture, with independent filter chains. */
struct source_placement {obs_source_t *source,*capture;};
static const char *placement_name(void *unused){(void)unused;return "Set source placement";}
static void *placement_create(obs_data_t *settings,obs_source_t *source){
 (void)settings;struct source_placement *p=calloc(1,sizeof(*p));if(p)p->source=source;return p;
}
static void placement_destroy(void *data){
 struct source_placement *p=data;if(!p)return;
 if(p->capture){obs_source_remove_active_child(p->source,p->capture);obs_source_release(p->capture);}free(p);
}
static uint32_t placement_width(void *data){struct source_placement *p=data;return p->capture?obs_source_get_width(p->capture):0;}
static uint32_t placement_height(void *data){struct source_placement *p=data;return p->capture?obs_source_get_height(p->capture):0;}
static void placement_render(void *data,gs_effect_t *unused){
 (void)unused;struct source_placement *p=data;if(p->capture)obs_source_video_render(p->capture);
}
static void placement_children(void *data,void *callback,void *param){
 struct source_placement *p=data;
 if(p->capture)((void (*)(obs_source_t *,obs_source_t *,void *))callback)(p->source,p->capture,param);
}
/* Engine owner thread only, after source-readiness/grant checks. No IPC entry
 * point exposes this constructor. Refuse scenes/proxies to prevent cycles. */
obs_source_t *producer_source_placement_create(obs_source_t *capture){
 if(!capture || obs_source_get_type(capture)!=OBS_SOURCE_TYPE_INPUT ||
    !(obs_source_get_output_flags(capture)&OBS_SOURCE_VIDEO) ||
    strcmp(obs_source_get_id(capture),"producer_source_placement")==0)return NULL;
 obs_source_t *wrapper=obs_source_create_private("producer_source_placement","Set placement",NULL);
 if(!wrapper)return NULL;
 struct source_placement *p=obs_obj_get_data(wrapper);
 if(!p){obs_source_release(wrapper);return NULL;}
 obs_enter_graphics();p->capture=obs_source_get_ref(capture);
 bool linked=p->capture && obs_source_add_active_child(wrapper,p->capture);obs_leave_graphics();
 if(!linked){obs_source_release(wrapper);return NULL;}return wrapper;
}
static const char *name(void *unused){(void)unused;return "Source appearance";}
static float bounded(double n,float max){return isfinite(n)?fminf(max,fmaxf(0,(float)n)):0;}
static void update(void *data,obs_data_t *settings){
 struct appearance_filter *f=data;
 f->radius=bounded(obs_data_get_double(settings,"cornerRadius"),960);
 f->outline=bounded(obs_data_get_double(settings,"outlineWidth"),64);
 f->gray=bounded(obs_data_get_double(settings,"grayscale"),1);
 f->opacity=bounded(obs_data_get_double(settings,"opacity"),1);
 f->width=bounded(obs_data_get_double(settings,"displayWidth"),8192);
 f->height=bounded(obs_data_get_double(settings,"displayHeight"),8192);
 f->circle=strcmp(obs_data_get_string(settings,"shape"),"circle")==0?1:0;
 const char *color=obs_data_get_string(settings,"outlineColor");unsigned int rgb=0xffffff;
 if(color&&strlen(color)==7&&color[0]=='#')sscanf(color+1,"%6x",&rgb);
 f->r=((rgb>>16)&255)/255.f;f->g=((rgb>>8)&255)/255.f;f->b=(rgb&255)/255.f;
}
static void defaults(obs_data_t *s){
 obs_data_set_default_string(s,"shape","rectangle");obs_data_set_default_string(s,"outlineColor","#ffffff");
 obs_data_set_default_double(s,"cornerRadius",0);obs_data_set_default_double(s,"outlineWidth",0);
 obs_data_set_default_double(s,"grayscale",0);obs_data_set_default_double(s,"opacity",1);
 obs_data_set_default_double(s,"displayWidth",0);obs_data_set_default_double(s,"displayHeight",0);
}
static void *create(obs_data_t *settings,obs_source_t *source){
 struct appearance_filter *f=calloc(1,sizeof(*f));if(!f)return NULL;f->source=source;
 char *error=NULL;obs_enter_graphics();f->effect=gs_effect_create(PRODUCER_SOURCE_APPEARANCE_EFFECT,"source_appearance.effect",&error);obs_leave_graphics();
 if(!f->effect){blog(100,"[appearance] effect failed: %s",error?error:"unknown");if(error)bfree(error);free(f);return NULL;}
 if(error)bfree(error);update(f,settings);return f;
}
static void destroy(void *data){struct appearance_filter *f=data;if(!f)return;obs_enter_graphics();gs_effect_destroy(f->effect);obs_leave_graphics();free(f);}
static void scalar(struct appearance_filter *f,const char *key,float n){gs_effect_set_float(gs_effect_get_param_by_name(f->effect,key),n);}
static void render(void *data,gs_effect_t *unused){
 (void)unused;struct appearance_filter *f=data;obs_source_t *target=obs_filter_get_target(f->source);
 if(!target){obs_source_skip_video_filter(f->source);return;}
 uint32_t w=obs_source_get_base_width(target),h=obs_source_get_base_height(target);
 if(!w||!h||!obs_source_process_filter_begin(f->source,GS_RGBA,OBS_NO_DIRECT_RENDERING))return;
 struct vec2 extent={f->width>0?f->width:(float)w,f->height>0?f->height:(float)h};
 gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"extent"),&extent);
 scalar(f,"radius",f->radius);scalar(f,"circle",f->circle);scalar(f,"outline",f->outline);
 scalar(f,"red",f->r);scalar(f,"green",f->g);scalar(f,"blue",f->b);scalar(f,"grayscale",f->gray);scalar(f,"opacity",f->opacity);
 gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
 obs_source_process_filter_end(f->source,f->effect,w,h);gs_blend_state_pop();
}
void producer_source_appearance_register(void){
 producer_shader_register();
 struct obs_source_info info;memset(&info,0,sizeof(info));info.id="producer_source_appearance";info.type=OBS_SOURCE_TYPE_FILTER;info.output_flags=OBS_SOURCE_VIDEO;
 info.get_name=name;info.create=create;info.destroy=destroy;info.update=update;info.get_defaults=defaults;info.video_render=render;
 obs_register_source_s(&info,sizeof(info));
 memset(&info,0,sizeof(info));info.id="producer_source_placement";info.type=OBS_SOURCE_TYPE_INPUT;
 info.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_CUSTOM_DRAW;
 info.get_name=placement_name;info.create=placement_create;info.destroy=placement_destroy;
 info.get_width=placement_width;info.get_height=placement_height;info.video_render=placement_render;
 info.enum_active_sources=placement_children;info.enum_all_sources=placement_children;
 obs_register_source_s(&info,sizeof(info));
}

/* Trusted procedural source. Kernel and parameters are supplied only by the
 * bounded native presentation adapter. Off-air compilation; no per-frame IPC. */
struct shader_source {
 obs_source_t *source;gs_effect_t *effect;gs_texrender_t *texture;
 gs_eparam_t *time_param,*intensity_param,*frequency_param,*alpha_param;
 uint32_t width,height,rw,rh;float time,intensity,frequency,alpha;
 float last[4];bool painted;
};
static const char *shader_name(void *unused){(void)unused;return "Producer shader layer";}
static uint32_t shader_width(void *data){return ((struct shader_source*)data)->width;}
static uint32_t shader_height(void *data){return ((struct shader_source*)data)->height;}
static void shader_scalar(gs_effect_t *e,const char *name,float v){gs_effect_set_float(gs_effect_get_param_by_name(e,name),v);}
static void shader_palette(gs_effect_t *e,const char *name,const char *hex){
 unsigned rgb=0;sscanf(hex+1,"%6x",&rgb);
 struct vec4 color={((rgb>>16)&255)/255.f,((rgb>>8)&255)/255.f,(rgb&255)/255.f,1.f};
 gs_effect_set_vec4(gs_effect_get_param_by_name(e,name),&color);
}
static void shader_destroy(void *data){struct shader_source *s=data;if(!s)return;obs_enter_graphics();if(s->texture)gs_texrender_destroy(s->texture);if(s->effect)gs_effect_destroy(s->effect);obs_leave_graphics();free(s);}
static void *shader_create(obs_data_t *settings,obs_source_t *source){
 struct shader_source *s=calloc(1,sizeof(*s));if(!s)return NULL;s->source=source;
 const char *code=obs_data_get_string(settings,"_kernel");if(!code||!*code){free(s);return NULL;}
 s->width=(uint32_t)bounded(obs_data_get_double(settings,"width"),1920);s->height=(uint32_t)bounded(obs_data_get_double(settings,"height"),1920);
 const char *kind=obs_data_get_string(settings,"effect");
 const char *presets[]={"aurora","edgeGlow","lightSweep","plasma","silk","rings","grid","stars","petals","contours","prism","borderFlare"};
 float mode=0;for(int i=0;i<12;i++){if(strcmp(kind,presets[i])==0){mode=(float)i;break;}}
 bool low=strcmp(obs_data_get_string(settings,"quality"),"low")==0;
 float reduction=mode==0||(mode>=3&&mode<11)?(low?.25f:.5f):(low?.5f:1.f);
 s->rw=(uint32_t)fmaxf(1,ceilf(s->width*reduction));s->rh=(uint32_t)fmaxf(1,ceilf(s->height*reduction));
 s->intensity=bounded(obs_data_get_double(settings,"intensity"),2);s->frequency=bounded(obs_data_get_double(settings,"scale"),4);s->alpha=bounded(obs_data_get_double(settings,"opacity"),1);
 char *error=NULL;obs_enter_graphics();s->effect=gs_effect_create(code,"producer-presets.effect",&error);
 if(!s->effect){blog(100,"[shader] compile failed: %s",error?error:"unknown");if(error)bfree(error);obs_leave_graphics();free(s);return NULL;}
 if(error)bfree(error);s->texture=gs_texrender_create(GS_RGBA,GS_ZS_NONE);
 shader_scalar(s->effect,"effectType",mode);shader_scalar(s->effect,"speed",bounded(obs_data_get_double(settings,"speed"),4));shader_scalar(s->effect,"radius",bounded(obs_data_get_double(settings,"radius"),960));
 struct vec2 extent={(float)s->width,(float)s->height};gs_effect_set_vec2(gs_effect_get_param_by_name(s->effect,"extent"),&extent);
 shader_palette(s->effect,"paletteA",obs_data_get_string(settings,"colorA"));shader_palette(s->effect,"paletteB",obs_data_get_string(settings,"colorB"));shader_palette(s->effect,"paletteC",obs_data_get_string(settings,"colorC"));
 s->time_param=gs_effect_get_param_by_name(s->effect,"clockTime");s->intensity_param=gs_effect_get_param_by_name(s->effect,"intensity");s->frequency_param=gs_effect_get_param_by_name(s->effect,"frequency");s->alpha_param=gs_effect_get_param_by_name(s->effect,"alpha");
 obs_leave_graphics();if(!s->texture){shader_destroy(s);return NULL;}return s;
}
static void shader_render(void *data,gs_effect_t *unused){
 (void)unused;struct shader_source *s=data;if(!s->effect||!s->texture||s->alpha<=0)return;
 float values[]={floorf(s->time*30.f)/30.f,s->intensity,s->frequency,s->alpha};
 if(!s->painted||memcmp(values,s->last,sizeof(values))!=0){
  gs_texrender_reset(s->texture);
  if(!gs_texrender_begin(s->texture,s->rw,s->rh))return;
  struct vec4 clear={0,0,0,0};gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,(float)s->rw,0,(float)s->rh,-100,100);
  struct vec2 extent={(float)s->width,(float)s->height};gs_effect_set_vec2(gs_effect_get_param_by_name(s->effect,"extent"),&extent);
  gs_effect_set_float(s->time_param,values[0]);gs_effect_set_float(s->intensity_param,values[1]);gs_effect_set_float(s->frequency_param,values[2]);gs_effect_set_float(s->alpha_param,values[3]);
  gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
  gs_technique_t *tech=gs_effect_get_technique(s->effect,"Draw");size_t passes=gs_technique_begin(tech);
  for(size_t i=0;i<passes;i++){if(gs_technique_begin_pass(tech,i)){gs_draw_sprite(NULL,0,s->rw,s->rh);gs_technique_end_pass(tech);}}
  gs_technique_end(tech);gs_blend_state_pop();gs_texrender_end(s->texture);
  memcpy(s->last,values,sizeof(values));s->painted=true;
 }
 gs_effect_t *draw=obs_get_base_effect(OBS_EFFECT_DEFAULT);gs_effect_set_texture(gs_effect_get_param_by_name(draw,"image"),gs_texrender_get_texture(s->texture));
 gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
 gs_technique_t *tech=gs_effect_get_technique(draw,"Draw");size_t passes=gs_technique_begin(tech);for(size_t i=0;i<passes;i++){if(gs_technique_begin_pass(tech,i)){gs_draw_sprite(gs_texrender_get_texture(s->texture),0,s->width,s->height);gs_technique_end_pass(tech);}}gs_technique_end(tech);gs_blend_state_pop();
}
static void producer_shader_register(void){struct obs_source_info info;memset(&info,0,sizeof(info));info.id="producer_shader_layer";info.type=OBS_SOURCE_TYPE_INPUT;info.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_CUSTOM_DRAW;info.get_name=shader_name;info.create=shader_create;info.destroy=shader_destroy;info.get_width=shader_width;info.get_height=shader_height;info.video_render=shader_render;obs_register_source_s(&info,sizeof(info));}
obs_source_t *producer_shader_create(const char *json,const char *kernel){
 obs_data_t *settings=obs_data_create_from_json(json);if(!settings)return NULL;
 obs_data_set_string(settings,"_kernel",kernel);
 obs_source_t *source=obs_source_create_private("producer_shader_layer","Set GPU shader",settings);obs_data_release(settings);return source;
}
/* Main render thread only; the composition owns the source until unregistering
 * its animation callback. Updating uniforms never touches shared captures. */
void producer_shader_frame(obs_source_t *source,float time,float intensity,float scale,float opacity){struct shader_source *s=obs_obj_get_data(source);if(!s)return;s->time=time;s->intensity=intensity;s->frequency=scale;s->alpha=opacity;}

void producer_shader_extent(obs_source_t *source,float width,float height){struct shader_source *s=obs_obj_get_data(source);if(!s)return;uint32_t w=(uint32_t)fmaxf(1,fminf(3840,roundf(width))),h=(uint32_t)fmaxf(1,fminf(3840,roundf(height)));if(s->width!=w||s->height!=h){s->width=w;s->height=h;s->painted=false;}}
