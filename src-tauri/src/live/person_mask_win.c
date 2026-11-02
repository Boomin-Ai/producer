/* Windows Cutout. One bounded inference job, one completed mask, no worker GPU
 * access. Removing the filter joins its worker before freeing the model/session.
 * GPU readback maps the PREVIOUS staged frame, never the just-submitted copy. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "obs_min.h"
#include "person_mask.effect.h"
#include "vendor/onnxruntime/onnxruntime_c_api.h"
#define N 192
#define PIXELS (N*N)
#define GS_DYNAMIC (1 << 1)
extern const uint8_t *producer_person_mask_model(size_t *length);
extern gs_texture_t *gs_texture_create(uint32_t, uint32_t, enum gs_color_format, uint32_t, const uint8_t **, uint32_t);
extern void gs_texture_set_image(gs_texture_t *, const uint8_t *, uint32_t, bool);

struct pm_win {
    obs_source_t *ctx;
    HANDLE thread, wake;
    CRITICAL_SECTION lock;
    volatile LONG stop, busy, status, generation, job_generation;
    LONG mask_generation;
    float input[PIXELS*3];
    uint8_t mask[PIXELS];
    uint64_t completed, uploaded;
    uint32_t width, height;
    int mode, quality, stage_index;
    bool analyzed, staged[2];
    LONG staged_generation[2];
    float feather, erode, blur, edge;
    uint64_t last_submit;
    gs_effect_t *effect;
    gs_texrender_t *src, *analysis, *blur_a, *blur_b, *refine;
    gs_stagesurf_t *stage[2];
    gs_texture_t *mask_texture;
};
static bool ok(const OrtApi *api, OrtStatus *s) {
    if (!s) return true;
    fprintf(stderr,"[cutout] inference unavailable: %s\n",api->GetErrorMessage(s));
    api->ReleaseStatus(s); return false;
}
static HMODULE load_runtime(void) {
    wchar_t path[32768];
    DWORD n=GetModuleFileNameW(NULL,path,32768);
    if(n && n<32768) {
        wchar_t *slash=wcsrchr(path,L'\\');
        if(slash) { slash[1]=0; if(wcslen(path)+16<32768) {
            wcscat_s(path,32768,L"onnxruntime.dll");
            HMODULE lib=LoadLibraryExW(path,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
            if(lib) return lib;
        }}
    }
    n=GetEnvironmentVariableW(L"PRODUCER_ENGINE_DIR",path,32768);
    if(!n || n>=32750) return NULL;
    /* Explicit development artifact root only; never use the working directory. */
    wcscat_s(path,32768,L"\\onnxruntime.dll");
    return LoadLibraryExW(path,NULL,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
}
static DWORD WINAPI worker(void *data) {
    struct pm_win *f=data;
    HMODULE lib=load_runtime();
    const OrtApi *api=NULL; OrtEnv *env=NULL; OrtSessionOptions *opts=NULL;
    OrtSession *session=NULL; OrtMemoryInfo *memory=NULL; OrtAllocator *allocator=NULL;
    char *input_name=NULL,*output_name=NULL;
    if(!lib) { fprintf(stderr,"[cutout] bundled ONNX Runtime could not load (%lu)\n",GetLastError()); goto done; }
    const OrtApiBase *(ORT_API_CALL *base)(void)=(void *)GetProcAddress(lib,"OrtGetApiBase");
    if(!base || !(api=base()->GetApi(ORT_API_VERSION))) goto done;
    size_t length=0; const uint8_t *model=producer_person_mask_model(&length);
    if(!ok(api,api->CreateEnv(ORT_LOGGING_LEVEL_WARNING,"Producer Cutout",&env)) ||
       !ok(api,api->CreateSessionOptions(&opts)) ||
       !ok(api,api->SetIntraOpNumThreads(opts,1)) ||
       !ok(api,api->SetInterOpNumThreads(opts,1)) ||
       !ok(api,api->SetSessionGraphOptimizationLevel(opts,ORT_ENABLE_ALL)) ||
       !ok(api,api->CreateSessionFromArray(env,model,length,opts,&session)) ||
       !ok(api,api->CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&memory)) ||
       !ok(api,api->GetAllocatorWithDefaultOptions(&allocator)) ||
       !ok(api,api->SessionGetInputName(session,0,allocator,&input_name)) ||
       !ok(api,api->SessionGetOutputName(session,0,allocator,&output_name))) goto done;
    InterlockedExchange(&f->status,1);
    while(!InterlockedCompareExchange(&f->stop,0,0)) {
        if(WaitForSingleObject(f->wake,INFINITE)!=WAIT_OBJECT_0 || InterlockedCompareExchange(&f->stop,0,0)) break;
        const LONG generation=InterlockedCompareExchange(&f->job_generation,0,0);
        OrtValue *input=NULL,*output=NULL; OrtTensorTypeAndShapeInfo *shape=NULL;
        const int64_t dimensions[]={1,3,N,N};
        bool success=ok(api,api->CreateTensorWithDataAsOrtValue(memory,f->input,sizeof(f->input),dimensions,4,ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&input));
        if(success)success=ok(api,api->Run(session,NULL,(const char*const*)&input_name,(const OrtValue*const*)&input,1,(const char*const*)&output_name,1,&output));
        size_t count=0; float *values=NULL;
        if(success)success=ok(api,api->GetTensorTypeAndShape(output,&shape)) && ok(api,api->GetTensorShapeElementCount(shape,&count)) && count==PIXELS*2 && ok(api,api->GetTensorMutableData(output,(void**)&values));
        uint8_t mask[PIXELS];
        if(success) {
            for(size_t i=0;i<PIXELS;i++) {
                /* The model emits softmax probabilities for background/person. */
                float p=values[PIXELS+i];
                mask[i]=(uint8_t)(fminf(1.f,fmaxf(0.f,p))*255.f+.5f);
            }
            EnterCriticalSection(&f->lock);
            if(generation==InterlockedCompareExchange(&f->generation,0,0) && !InterlockedCompareExchange(&f->stop,0,0)) {
                memcpy(f->mask,mask,sizeof(mask)); f->mask_generation=generation; f->completed++;
            }
            LeaveCriticalSection(&f->lock);
        }
        if(shape)api->ReleaseTensorTypeAndShapeInfo(shape);
        if(output)api->ReleaseValue(output);
        if(input)api->ReleaseValue(input);
        InterlockedExchange(&f->busy,0);
        if(!success)break;
    }
 done:
    InterlockedExchange(&f->status,-1);
    if(api) {
        if(input_name)allocator->Free(allocator,input_name);
        if(output_name)allocator->Free(allocator,output_name);
        if(memory)api->ReleaseMemoryInfo(memory);
        if(session)api->ReleaseSession(session);
        if(opts)api->ReleaseSessionOptions(opts);
        if(env)api->ReleaseEnv(env);
    }
    if(lib)FreeLibrary(lib);
    return 0;
}
static float clamp(double n) { return isfinite(n)?(float)fmin(1.,fmax(0.,n)):0; }
static void defaults(obs_data_t *s) {
    obs_data_set_default_string(s,"mode","soft"); obs_data_set_default_string(s,"quality","auto");
    obs_data_set_default_double(s,"feather",.35); obs_data_set_default_double(s,"erode",.25);
    obs_data_set_default_double(s,"blur",.6); obs_data_set_default_double(s,"edge_refine",.65);
}
static void update(void *data, obs_data_t *s) {
    struct pm_win *f=data; const char *m=obs_data_get_string(s,"mode"),*q=obs_data_get_string(s,"quality");
    obs_enter_graphics();
    int mode=!strcmp(m,"off")?0:!strcmp(m,"cut")?2:1;
    if(mode!=f->mode) { InterlockedIncrement(&f->generation); f->uploaded=0; f->staged[0]=f->staged[1]=false; }
    f->mode=mode;
    f->quality=!strcmp(q,"fast")?1:!strcmp(q,"accurate")?3:2;
    f->feather=clamp(obs_data_get_double(s,"feather")); f->erode=clamp(obs_data_get_double(s,"erode"));
    f->blur=clamp(obs_data_get_double(s,"blur")); f->edge=clamp(obs_data_get_double(s,"edge_refine"));
    obs_leave_graphics();
}
static void destroy(void *data) {
    struct pm_win *f=data;
    if(!f)return;
    InterlockedExchange(&f->stop,1);
    if(f->wake)SetEvent(f->wake);
    if(f->thread) { WaitForSingleObject(f->thread,INFINITE); CloseHandle(f->thread); }
    if(f->wake)CloseHandle(f->wake);
    obs_enter_graphics();
    if(f->mask_texture)gs_texture_destroy(f->mask_texture);
    for(int j=0;j<2;j++)if(f->stage[j])gs_stagesurface_destroy(f->stage[j]);
    if(f->effect)gs_effect_destroy(f->effect);
    gs_texrender_t *trs[]={f->src,f->analysis,f->blur_a,f->blur_b,f->refine};
    for(int j=0;j<5;j++)if(trs[j])gs_texrender_destroy(trs[j]);
    obs_leave_graphics();
    DeleteCriticalSection(&f->lock); free(f);
}
static void *create(obs_data_t *s, obs_source_t *ctx) {
    struct pm_win *f=calloc(1,sizeof(*f)); if(!f)return NULL;
    f->ctx=ctx; InitializeCriticalSection(&f->lock); f->generation=1;
    obs_enter_graphics();
    char *error=NULL; f->effect=gs_effect_create(PRODUCER_PERSON_MASK_EFFECT,"Producer Cutout",&error);
    if(error) { fprintf(stderr,"[cutout] shader: %s\n",error); bfree(error); }
    f->src=gs_texrender_create(GS_RGBA,GS_ZS_NONE); f->analysis=gs_texrender_create(GS_BGRA,GS_ZS_NONE);
    f->blur_a=gs_texrender_create(GS_RGBA,GS_ZS_NONE); f->blur_b=gs_texrender_create(GS_RGBA,GS_ZS_NONE); f->refine=gs_texrender_create(GS_RGBA,GS_ZS_NONE);
    for(int j=0;j<2;j++)f->stage[j]=gs_stagesurface_create(N,N,GS_BGRA);
    f->mask_texture=gs_texture_create(N,N,GS_R8,1,NULL,GS_DYNAMIC);
    obs_leave_graphics();
    f->wake=CreateEventW(NULL,FALSE,FALSE,NULL);
    if(!f->effect||!f->src||!f->analysis||!f->blur_a||!f->blur_b||!f->refine||!f->stage[0]||!f->stage[1]||!f->mask_texture||!f->wake) { destroy(f); return NULL; }
    update(f,s);
    f->thread=CreateThread(NULL,0,worker,f,0,NULL);
    if(!f->thread){destroy(f);return NULL;}
    return f;
}
static void draw(gs_effect_t *e,const char *tech,gs_texture_t *t,uint32_t w,uint32_t h) {
    gs_eparam_t *image=gs_effect_get_param_by_name(e,"image");
    gs_technique_t *p=gs_effect_get_technique(e,tech); if(!p||!image||!t)return;
    gs_effect_set_texture_srgb(image,t);
    size_t n=gs_technique_begin(p);
    for(size_t j=0;j<n;j++)if(gs_technique_begin_pass(p,j)){gs_draw_sprite(t,0,w,h);gs_technique_end_pass(p);}
    gs_technique_end(p);
}
static bool pass(struct pm_win *f,gs_texrender_t *tr,uint32_t w,uint32_t h,const char *tech,gs_texture_t *src,uint32_t cx,uint32_t cy) {
    gs_texrender_reset(tr); if(!gs_texrender_begin(tr,w,h))return false;
    struct vec4 clear={0};gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,(float)cx,0,(float)cy,-100,100);
    gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_ZERO);
    bool srgb=gs_framebuffer_srgb_enabled();gs_enable_framebuffer_srgb(strcmp(tech,"Refine")!=0);
    draw(f->effect,tech,src,cx,cy);
    gs_enable_framebuffer_srgb(srgb);gs_blend_state_pop();gs_texrender_end(tr);return true;
}
static void tick(void *data,float seconds) { (void)seconds; ((struct pm_win*)data)->analyzed=false; }
static void analyze(struct pm_win *f,gs_texture_t *src,uint32_t w,uint32_t h) {
    if(f->analyzed)return; f->analyzed=true;
    if(f->width!=w||f->height!=h) {
        f->width=w;f->height=h;InterlockedIncrement(&f->generation);f->uploaded=0;f->staged[0]=f->staged[1]=false;
    }
    const LONG generation=InterlockedCompareExchange(&f->generation,0,0);
    const int prev=f->stage_index^1;
    uint64_t now=GetTickCount64(),interval=f->quality==1?100:f->quality==3?33:66;
    if(f->staged[prev]&&f->staged_generation[prev]==generation&&now-f->last_submit>=interval&&InterlockedCompareExchange(&f->status,0,0)==1&&InterlockedCompareExchange(&f->busy,1,0)==0) {
        uint8_t *pixels=NULL;uint32_t stride=0;
        if(gs_stagesurface_map(f->stage[prev],&pixels,&stride)) {
            for(int y=0;y<N;y++)for(int x=0;x<N;x++)for(int c=0;c<3;c++)
                f->input[c*PIXELS+y*N+x]=pixels[y*stride+x*4+2-c]/127.5f-1.f;
            gs_stagesurface_unmap(f->stage[prev]); f->last_submit=now;
            InterlockedExchange(&f->job_generation,generation);SetEvent(f->wake);
        }else InterlockedExchange(&f->busy,0);
    }
    gs_texrender_reset(f->analysis);
    if(gs_texrender_begin(f->analysis,N,N)) {
        struct vec4 clear={0};gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,(float)w,0,(float)h,-100,100);
        bool srgb=gs_framebuffer_srgb_enabled();gs_enable_framebuffer_srgb(true);
        gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_ZERO);
        draw(obs_get_base_effect(OBS_EFFECT_DEFAULT),"Draw",src,w,h);
        gs_blend_state_pop();gs_enable_framebuffer_srgb(srgb);gs_texrender_end(f->analysis);
        gs_stage_texture(f->stage[f->stage_index],gs_texrender_get_texture(f->analysis));
        f->staged[f->stage_index]=true;f->staged_generation[f->stage_index]=generation;f->stage_index^=1;
    }
    if(TryEnterCriticalSection(&f->lock)) {
        if(f->mask_generation==generation&&f->completed!=f->uploaded) {
            gs_texture_set_image(f->mask_texture,f->mask,N,false);f->uploaded=f->completed;
        }
        LeaveCriticalSection(&f->lock);
    }
}
static void render(void *data,gs_effect_t *unused) {
    (void)unused;struct pm_win *f=data;obs_source_t *target=obs_filter_get_target(f->ctx);
    uint32_t w=target?obs_source_get_base_width(target):0,h=target?obs_source_get_base_height(target):0;
    const enum gs_color_space preferred[]={GS_CS_SRGB};
    if(!f->mode||!w||!h||InterlockedCompareExchange(&f->status,0,0)<0||obs_source_get_color_space(target,1,preferred)!=GS_CS_SRGB){obs_source_skip_video_filter(f->ctx);return;}
    bool linear=gs_set_linear_srgb(true),srgb=gs_framebuffer_srgb_enabled();
    gs_texrender_reset(f->src);gs_blend_state_push();gs_blend_function_separate(GS_BLEND_SRCALPHA,GS_BLEND_INVSRCALPHA,GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
    bool captured=gs_texrender_begin_with_color_space(f->src,w,h,GS_CS_SRGB);
    /* skip_video_filter supplies the default effect when the filter target is
     * a synchronous input (images/text), and handles async cameras/custom draw.
     * Calling video_render(parent) directly leaves image_source without shaders. */
    if(captured) { struct vec4 clear={0};gs_clear(GS_CLEAR_COLOR,&clear,0,0);gs_ortho(0,(float)w,0,(float)h,-100,100);obs_source_skip_video_filter(f->ctx);gs_texrender_end(f->src); }
    gs_blend_state_pop();gs_texture_t *src=captured?gs_texrender_get_texture(f->src):NULL;
    if(!src){gs_set_linear_srgb(linear);gs_enable_framebuffer_srgb(srgb);obs_source_skip_video_filter(f->ctx);return;}
    analyze(f,src,w,h);gs_enable_framebuffer_srgb(true);
    if(!f->uploaded) {draw(obs_get_base_effect(OBS_EFFECT_DEFAULT),"Draw",src,w,h);goto done;}
    gs_texture_t *blurred=NULL,*mask=f->mask_texture;
    if(f->mode==1) {
        uint32_t bw=w/2?w/2:1,bh=h/2?h/2:1;float step=1+f->blur*10;
        struct vec2 d={step/bw,0};gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"blur_dir"),&d);
        if(pass(f,f->blur_a,bw,bh,"Blur",src,w,h)) {
            d.x=0;d.y=step/bh;gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"blur_dir"),&d);
            if(pass(f,f->blur_b,bw,bh,"Blur",gs_texrender_get_texture(f->blur_a),w,h))blurred=gs_texrender_get_texture(f->blur_b);
        }
    }
    struct vec2 texel={1.f/N,1.f/N},refined_texel=texel;
    gs_effect_set_texture(gs_effect_get_param_by_name(f->effect,"mask"),mask);
    gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"mask_texel"),&texel);
    gs_effect_set_float(gs_effect_get_param_by_name(f->effect,"edge_refine"),f->quality==1?0:f->edge);
    if(f->edge>0&&f->quality!=1) {
        uint32_t longest=w>h?w:h,limit=f->quality==3?1280:720;
        uint32_t rw=longest>limit?(uint32_t)((uint64_t)w*limit/longest):w,rh=longest>limit?(uint32_t)((uint64_t)h*limit/longest):h;
        rw=rw?rw:1;rh=rh?rh:1;
        if(pass(f,f->refine,rw,rh,"Refine",src,w,h)){mask=gs_texrender_get_texture(f->refine);refined_texel.x=1.f/rw;refined_texel.y=1.f/rh;}
    }
    gs_effect_set_texture(gs_effect_get_param_by_name(f->effect,"mask"),mask);
    gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"refine_texel"),&refined_texel);
    /* Each technique end clears effect values. D3D11 requires every scalar
     * used by this pass, even if a preceding refinement pass set it. */
    gs_effect_set_vec2(gs_effect_get_param_by_name(f->effect,"mask_texel"),&texel);
    gs_effect_set_float(gs_effect_get_param_by_name(f->effect,"edge_refine"),f->quality==1?0:f->edge);
    gs_effect_set_float(gs_effect_get_param_by_name(f->effect,"feather"),f->feather);
    gs_effect_set_float(gs_effect_get_param_by_name(f->effect,"erode"),f->erode*8);
    if(blurred)gs_effect_set_texture_srgb(gs_effect_get_param_by_name(f->effect,"blurred"),blurred);
    gs_blend_state_push();gs_blend_function(GS_BLEND_ONE,GS_BLEND_INVSRCALPHA);
    draw(f->effect,f->mode==1&&blurred?"Soft":"Cut",src,w,h);gs_blend_state_pop();
 done:
    gs_enable_framebuffer_srgb(srgb);gs_set_linear_srgb(linear);
}
static const char *name(void *p){(void)p;return "Cutout";}
void producer_person_mask_register(void) {
    struct obs_source_info i={0};i.id=PRODUCER_PERSON_MASK_ID;i.type=OBS_SOURCE_TYPE_FILTER;i.output_flags=OBS_SOURCE_VIDEO|OBS_SOURCE_SRGB;
    i.get_name=name;i.create=create;i.destroy=destroy;i.get_defaults=defaults;i.update=update;i.video_render=render;i.video_tick=tick;
    obs_register_source_s(&i,sizeof(i));
}
/* Bounded diagnostic, no image/data transport through IPC. */
int producer_person_mask_status(obs_source_t *filter) {
    struct pm_win *f=obs_obj_get_data(filter);return f?(int)InterlockedCompareExchange(&f->status,0,0):-1;
}
uint64_t producer_person_mask_completed(obs_source_t *filter) {
    struct pm_win *f=obs_obj_get_data(filter);if(!f)return 0;
    EnterCriticalSection(&f->lock);uint64_t n=f->completed;LeaveCriticalSection(&f->lock);return n;
}
