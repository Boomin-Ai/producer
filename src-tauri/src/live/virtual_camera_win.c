/* A private output placement. Never attach the mirror to a shared capture:
 * only this view is flipped, so recordings, streams and the editor stay intact.
 * All pointer changes/destruction are serialized by the graphics context. */
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include "obs_min.h"
typedef struct obs_canvas obs_canvas_t;
extern obs_canvas_t *obs_canvas_get_ref(obs_canvas_t *);
extern void obs_canvas_release(obs_canvas_t *);
extern void obs_canvas_render(obs_canvas_t *);
extern void gs_matrix_translate3f(float, float, float);
extern void gs_matrix_scale3f(float, float, float);
struct mirror {
    obs_source_t *self, *child;
    obs_canvas_t *canvas;
    uint32_t width, height;
    LONG mirrored;
};
static const char *name(void *p) { (void)p; return "Producer virtual camera placement"; }
static void *create(obs_data_t *s, obs_source_t *self) {
    (void)s;
    struct mirror *p = calloc(1, sizeof(*p));
    if (p) p->self = self;
    return p;
}
static void clear(struct mirror *p) {
    if (p->child) {
        obs_source_remove_active_child(p->self, p->child);
        obs_source_release(p->child);
        p->child = NULL;
    }
    if (p->canvas) { obs_canvas_release(p->canvas); p->canvas = NULL; }
}
static void destroy(void *data) {
    struct mirror *p = data;
    obs_enter_graphics();
    clear(p);
    obs_leave_graphics();
    free(p);
}
static uint32_t width(void *p) { return ((struct mirror *)p)->width; }
static uint32_t height(void *p) { return ((struct mirror *)p)->height; }
static void render(void *data, gs_effect_t *effect) {
    (void)effect;
    struct mirror *p = data;
    gs_matrix_push();
    if (InterlockedCompareExchange(&p->mirrored, 0, 0)) {
        gs_matrix_translate3f((float)p->width, 0, 0);
        gs_matrix_scale3f(-1, 1, 1);
    }
    if (p->canvas) obs_canvas_render(p->canvas);
    else if (p->child) obs_source_video_render(p->child);
    gs_matrix_pop();
}
void producer_vcam_mirror_register(void) {
    struct obs_source_info i = {0};
    i.id = "producer_vcam_mirror";
    i.type = OBS_SOURCE_TYPE_INPUT;
    i.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_SRGB;
    i.get_name = name; i.create = create; i.destroy = destroy;
    i.get_width = width; i.get_height = height; i.video_render = render;
    obs_register_source_s(&i, sizeof(i));
}
bool producer_vcam_mirror_source(obs_source_t *source, obs_source_t *child,
                                obs_canvas_t *canvas, uint32_t w, uint32_t h) {
    struct mirror *p = obs_obj_get_data(source);
    if (!p || (!child && !canvas) || child == source || !w || !h) return false;
    obs_enter_graphics();
    if(p->child==child && p->canvas==canvas) {p->width=w;p->height=h;obs_leave_graphics();return true;}
    obs_source_t *ref = child ? obs_source_get_ref(child) : NULL;
    obs_canvas_t *cref = canvas ? obs_canvas_get_ref(canvas) : NULL;
    if ((child && (!ref || !obs_source_add_active_child(source, ref))) || (canvas && !cref)) {
        if (ref) obs_source_release(ref);
        if (cref) obs_canvas_release(cref);
        obs_leave_graphics();
        return false;
    }
    clear(p);
    p->child = ref; p->canvas = cref; p->width = w; p->height = h;
    obs_leave_graphics();
    return true;
}
void producer_vcam_mirror_set(obs_source_t *source, bool on) {
    struct mirror *p = obs_obj_get_data(source);
    if (p) InterlockedExchange(&p->mirrored, on ? 1 : 0);
}
