// Prepared only on the control lane. Scratch targets belong to a renderer and
// its command queue; preview and program never share writable graph textures.
#include "geometry.inc"

@interface NRFragmentPass : NSObject {
@public
    id<MTLRenderPipelineState> pipeline;
    NRGeometry *geometry;
    uint32_t width,height;
    uint64_t groups;
    int32_t inputs[2];
    float params[4];
}
@end
@implementation NRFragmentPass
@end

@interface NRVisualResources : NSObject
@property(nonatomic,copy) NSArray<id<MTLTexture>> *images;
@property(nonatomic,copy) NSArray<NRFragmentPass*> *passes;
@end
@implementation NRVisualResources
@end

static id<MTLRenderPipelineState> fragmentPipeline(id<MTLDevice> device,NSString *source,
                                                    NSString *entry,NSError **error) {
    static NSCache *cache;
    static dispatch_once_t once;
    dispatch_once(&once,^{cache=[NSCache new];cache.countLimit=128;});
    NSArray *key=@[@(device.registryID),source,entry];
    id<MTLRenderPipelineState> cached=[cache objectForKey:key];
    if(cached)return cached;
    NSString *vertex=@"\nusing namespace metal;\nvertex float4 producer_fullscreen(uint i [[vertex_id]]) {"
        "return float4(i==1?3.0:-1.0,i==2?3.0:-1.0,0.0,1.0);}";
    id<MTLLibrary> library=[device newLibraryWithSource:[source stringByAppendingString:vertex] options:nil error:error];
    if(!library)return nil;
    MTLRenderPipelineDescriptor *descriptor=[MTLRenderPipelineDescriptor new];
    descriptor.vertexFunction=[library newFunctionWithName:@"producer_fullscreen"];
    descriptor.fragmentFunction=[library newFunctionWithName:entry];
    descriptor.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm;
    if(!descriptor.vertexFunction||!descriptor.fragmentFunction)return nil;
    cached=[device newRenderPipelineStateWithDescriptor:descriptor error:error];
    if(cached)[cache setObject:cached forKey:key];
    return cached;
}

static BOOL encodeLayers(NRRoom *r,id<MTLCommandBuffer> command,id<MTLTexture> target,
                         uint64_t groups,const NRDraw *draws,size_t count,NRVisualResources *resources,
                         id<MTLTexture> __strong *live,id<MTLTexture> __strong *graphOutputs) {
    uint32_t w=(uint32_t)target.width,h=(uint32_t)target.height;
    MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];
    pass.colorAttachments[0].texture=target;
    pass.colorAttachments[0].loadAction=MTLLoadActionClear;
    pass.colorAttachments[0].storeAction=MTLStoreActionStore;
    pass.colorAttachments[0].clearColor=groups?MTLClearColorMake(0,0,0,0):MTLClearColorMake(.018,.027,.038,1);
        NSArray *text=resources.images;
        id<MTLRenderCommandEncoder> encoder=[command renderCommandEncoderWithDescriptor:pass];if(!encoder)return NO;[encoder setRenderPipelineState:r->_pipeline];
        [encoder setFragmentTexture:r->_white atIndex:0];
        for(size_t i=0;i<count;i++) {
            NRDraw d=draws[i];
            if(d.kind==5 || (groups && (d.group>=64 || !(groups & (1ull << d.group)))))continue;id<MTLTexture> texture=nil;
            if(d.kind==1){if(d.source>=8||!live[d.source])continue;texture=live[d.source];}
            if(d.kind==1 && d.reserved==1){
                float boxW=d.rect[2]*w, boxH=d.rect[3]*h;
                float fit=fminf(boxW/texture.width,boxH/texture.height);
                float fitW=texture.width*fit,fitH=texture.height*fit;
                d.rect[0]+=(boxW-fitW)/(2*w); d.rect[1]+=(boxH-fitH)/(2*h);
                d.rect[2]=fitW/w; d.rect[3]=fitH/h;
                d.metrics[1]=fitW; d.metrics[2]=fitH;
            }
            if(d.kind==2||d.kind==3){if(d.source>=text.count)continue;texture=text[d.source];}
            if(d.kind==4){
                if(d.source>=64 || !graphOutputs[d.source])continue;
                texture=graphOutputs[d.source];d.kind=3;
            }
            [encoder setVertexBytes:&d length:sizeof(d) atIndex:0];[encoder setFragmentBytes:&d length:sizeof(d) atIndex:0];
            if(texture)[encoder setFragmentTexture:texture atIndex:0];
            [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:6];
        }
        [encoder endEncoding];
    return YES;
}

static BOOL encodeGraphs(NRRoom *r,id<MTLCommandBuffer> command,uint32_t output,
                         const NRDraw *draws,size_t count,NRVisualResources *resources,
                         id<MTLTexture> __strong *live, id<MTLTexture> __strong *results) {
    @synchronized(r->_commitGate[output]) {
        BOOL explicitOutput=NO;
        for(size_t i=0;i<count;i++){
            const NRDraw *draw=&draws[i];
            if(draw->kind!=4 && draw->kind!=5)continue;
            if(draw->kind==5)explicitOutput=YES;
            if(draw->reserved>draw->source || draw->source>=resources.passes.count)return NO;
            for(uint32_t slot=draw->reserved;slot<=draw->source;slot++){
                NRFragmentPass *p=resources.passes[slot];
                BOOL final=draw->kind==5 && slot==draw->source;
                id<MTLTexture> target=final?r->_rgb[output]:r->_graphSurfaces[output][slot];
                if(!target || target.width!=p->width || target.height!=p->height){
                    if(final)return NO;
                    MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm width:p->width height:p->height mipmapped:NO];
                    d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageRenderTarget|MTLTextureUsageShaderRead;
                    target=[r->_device newTextureWithDescriptor:d];
                    if(!target)return NO;
                    r->_graphSurfaces[output][slot]=target;
                }
                if(p->groups) {
                    if(!encodeLayers(r,command,target,p->groups,draws,count,resources,live,results))return NO;
                    results[slot]=target;
                    continue;
                }
                MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];
                pass.colorAttachments[0].texture=target;
                if(p->geometry) {
                    id<MTLTexture> depth=r->_graphDepth[output];
                    if(!depth || depth.width!=p->width || depth.height!=p->height){
                        MTLTextureDescriptor *d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatDepth32Float width:p->width height:p->height mipmapped:NO];
                        d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageRenderTarget;
                        depth=[r->_device newTextureWithDescriptor:d];if(!depth)return NO;
                        r->_graphDepth[output]=depth;
                    }
                    pass.depthAttachment.texture=depth;
                    pass.depthAttachment.loadAction=MTLLoadActionClear;
                    pass.depthAttachment.clearDepth=1;
                    pass.depthAttachment.storeAction=MTLStoreActionDontCare;
                    pass.colorAttachments[0].loadAction=MTLLoadActionClear;
                    pass.colorAttachments[0].clearColor=MTLClearColorMake(0,0,0,0);
                } else pass.colorAttachments[0].loadAction=MTLLoadActionDontCare;
                pass.colorAttachments[0].storeAction=MTLStoreActionStore;
                id<MTLRenderCommandEncoder> enc=[command renderCommandEncoderWithDescriptor:pass];
                if(!enc)return NO;
                [enc setRenderPipelineState:p->pipeline];
                [enc setFragmentSamplerState:r->_graphSampler atIndex:0];
                for(int k=0;k<2;k++){
                    int idx=p->inputs[k];
                    id<MTLTexture> tex=nil;
                    if(idx>=0 && idx<8 && (((uint32_t)draw->accent[1])&(1u<<idx)))tex=live[idx];
                    else if(idx>=8 && idx<136 && (size_t)(idx-8)<resources.images.count)tex=resources.images[idx-8];
                    else if(idx>=136 && idx-136<(int)slot)tex=results[idx-136];
                    [enc setFragmentTexture:(tex?:r->_graphEmpty) atIndex:k];
                }
                if(p->geometry) {
                    NRGeometry *g=p->geometry;
                    NRShot shot=evaluateShot(g,draw->accent[2],(float)p->width/p->height);
                    [enc setDepthStencilState:g->depthState];
                    [enc setVertexBuffer:g->grid offset:0 atIndex:0];
                    [enc setVertexBytes:&shot length:sizeof(shot) atIndex:1];
                    [enc setFragmentBytes:&shot length:sizeof(shot) atIndex:1];
                    const NRInstance *obj=g->objects.bytes;
                    for(NSUInteger n=0;n<g->objects.length/sizeof(*obj);n++,obj++){
                        [enc setVertexBytes:obj length:sizeof(*obj) atIndex:2];
                        [enc setFragmentBytes:obj length:sizeof(*obj) atIndex:2];
                        BOOL flat=obj->detail.z>=2;
                        [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:flat?6:g->indexCount indexType:MTLIndexTypeUInt16 indexBuffer:g->indices indexBufferOffset:flat?g->flatIndexOffset:0];
                    }
                } else {
                    float uniforms[8]={(float)p->width,(float)p->height,draw->accent[2],draw->accent[3]};
                    memcpy(uniforms+4,p->params,sizeof(p->params));
                    [enc setFragmentBytes:uniforms length:sizeof(uniforms) atIndex:0];
                    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
                }
                [enc endEncoding];
                if(!final)results[slot]=target;
            }
        }
        if(!explicitOutput && !encodeLayers(r,command,r->_rgb[output],0,draws,count,resources,live,results))return NO;
        for(size_t i=0;i<64;i++)if(!results[i])r->_graphSurfaces[output][i]=nil;
    }
    return YES;
}
