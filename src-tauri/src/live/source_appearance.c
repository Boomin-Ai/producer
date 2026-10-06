/* Shared native filter for source editing and isolated set placements.
 * Per-placement set overrides must attach to a placement wrapper, never mutate
 * the shared capture source. Audio and source dimensions remain untouched. */
#include "obs_min.h"
#include "source_appearance.effect.h"
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
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
