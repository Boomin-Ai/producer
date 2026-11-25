// A prepared scene is immutable. Renderers share the scene's grid and pipeline;
// each output owns its depth attachment through NRRoom, just like graph scratch.
#import <simd/simd.h>
typedef struct { simd_float4 eye,right,up,forward,projection,sun,sunlight,ambient; } NRShot;
typedef struct { simd_float4 position,size,rotation,color,surface,detail; } NRInstance;
typedef struct { simd_float3 eye,target; float seconds,fov; } NRCameraKey;

@interface NRGeometry : NSObject {
@public
    NSData *objects,*keys;
    NSDictionary<NSNumber *, id<MTLBuffer>> *imported;
    id<MTLRenderPipelineState> pipeline;
    id<MTLDepthStencilState> depthState;
    id<MTLBuffer> grid, indices;
    NSUInteger indexCount, flatIndexOffset;
    id<MTLTexture> environment;
    NRShot light;
}
@end
@implementation NRGeometry
@end

static simd_float3 vector3(NSArray *a) {
    return (simd_float3){[a[0] floatValue],[a[1] floatValue],[a[2] floatValue]};
}
static simd_float4 xyz4(simd_float3 v) { return (simd_float4){v.x,v.y,v.z,0}; }

static NRGeometry *prepareGeometry(id<MTLDevice> device,const NRGraphSpec *spec,NSError **error) {
    NSData *data=[NSData dataWithBytes:spec->geometry length:strlen(spec->geometry)];
    NSDictionary *scene=[NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    if(!scene)return nil;
    NRGeometry *geometry=[NRGeometry new];
    // One immutable resource bundle per Metal device for this built-in mesh pipeline.
    static NSMutableDictionary *resources;
    static dispatch_once_t once;
    dispatch_once(&once,^{ resources=[NSMutableDictionary new]; });
    @synchronized(resources) {
        NSNumber *key=@(device.registryID);
        NRGeometry *shared=resources[key];
        if(!shared){
            shared=[NRGeometry new];
            id<MTLLibrary> lib=[device newLibraryWithSource:[NSString stringWithUTF8String:spec->source] options:nil error:error];
            if(!lib)return nil;
            MTLRenderPipelineDescriptor *desc=[MTLRenderPipelineDescriptor new];
            desc.vertexFunction=[lib newFunctionWithName:@"mesh_vertex"];
            desc.fragmentFunction=[lib newFunctionWithName:@"mesh_surface"];
            desc.colorAttachments[0].pixelFormat=MTLPixelFormatBGRA8Unorm;
            desc.depthAttachmentPixelFormat=MTLPixelFormatDepth32Float;
            shared->pipeline=[device newRenderPipelineStateWithDescriptor:desc error:error];
            MTLDepthStencilDescriptor *ds=[MTLDepthStencilDescriptor new];
            ds.depthCompareFunction=MTLCompareFunctionLess;ds.depthWriteEnabled=YES;
            shared->depthState=[device newDepthStencilStateWithDescriptor:ds];
            enum { W=128,H=48 };
            NSMutableData *vertices=[NSMutableData dataWithLength:(W+1)*(H+1)*sizeof(simd_float2)];
            NSMutableData *triangles=[NSMutableData dataWithLength:(W*H*6+6)*sizeof(uint16_t)];
            simd_float2 *v=vertices.mutableBytes; uint16_t *ix=triangles.mutableBytes;
            for(int y=0;y<=H;y++)for(int x=0;x<=W;x++)
                *v++=(simd_float2){(float)x/W,(float)y/H};
            for(int y=0;y<H;y++)for(int x=0;x<W;x++){
                uint16_t a=y*(W+1)+x,b=a+W+1;
                *ix++=a;*ix++=b;*ix++=a+1;*ix++=a+1;*ix++=b;*ix++=b+1;
            }
            uint16_t corners[]={0,H*(W+1),W,W,H*(W+1),H*(W+1)+W};
            memcpy(ix,corners,sizeof(corners));
            shared->indexCount=W*H*6;
            shared->flatIndexOffset=shared->indexCount*sizeof(uint16_t);
            shared->grid=[device newBufferWithBytes:vertices.bytes length:vertices.length options:MTLResourceStorageModeShared];
            shared->indices=[device newBufferWithBytes:triangles.bytes length:triangles.length options:MTLResourceStorageModeShared];
            if(!shared->grid||!shared->indices||!shared->depthState||!shared->pipeline)return nil;
            resources[key]=shared;
        }
        geometry->pipeline=shared->pipeline;geometry->depthState=shared->depthState;
        geometry->grid=shared->grid;geometry->indices=shared->indices;
        geometry->indexCount=shared->indexCount;geometry->flatIndexOffset=shared->flatIndexOffset;
    }
    NSMutableData *objects=[NSMutableData data];
    NSMutableDictionary *buffers=[NSMutableDictionary new];
    NSArray *meshes=@[@"sphere",@"torus",@"panel",@"disc",@"glb",@"vertexClip"];
    for(NSDictionary *o in scene[@"objects"]) {
        NRInstance obj={0};
        obj.position=xyz4(vector3(o[@"position"]));obj.size=xyz4(vector3(o[@"scale"]));
        obj.rotation=xyz4(vector3(o[@"rotation"])*(float)(M_PI/180));
        obj.color=xyz4(vector3(o[@"color"]));
        if([o[@"textureAspect"] isKindOfClass:NSNumber.class])obj.color.w=[o[@"textureAspect"] floatValue];
        obj.surface=(simd_float4){[o[@"roughness"] floatValue],[o[@"metallic"] floatValue],[o[@"emission"] floatValue],[o[@"tube"] floatValue]};
        NSArray *engrave=o[@"engraving"]; NSNumber *slot=o[@"input"];
        obj.detail=(simd_float4){[engrave[0] floatValue],[engrave[1] floatValue],(float)[meshes indexOfObject:o[@"mesh"]],[slot isKindOfClass:NSNumber.class]?slot.floatValue:-1};
        BOOL clip=[o[@"mesh"] isEqual:@"vertexClip"];
        if(clip)obj.position.w=[o[@"phase"] floatValue];
        NSNumber *sharedBuffer=o[@"sharedBuffer"];
        if(clip && sharedBuffer){
            id<MTLBuffer> buffer=buffers[sharedBuffer];
            if(!buffer)return nil;
            buffers[@(objects.length/sizeof(obj))]=buffer;
        } else if (clip || [o[@"mesh"] isEqual:@"glb"]) {
            NSData *bytes=[[NSData alloc] initWithBase64EncodedString:o[@"vertices"] options:0];
            if(!bytes.length || (clip ? bytes.length<16 : bytes.length%64!=0)) return nil;
            id<MTLBuffer> buffer=[device newBufferWithBytes:bytes.bytes length:bytes.length options:MTLResourceStorageModeShared];
            if(!buffer)return nil;
            buffers[@(objects.length/sizeof(obj))]=buffer;
        }
        [objects appendBytes:&obj length:sizeof(obj)];
    }
    geometry->objects=objects; geometry->imported=buffers;
    geometry->light.sun=xyz4(vector3(scene[@"lightDirection"]));
    geometry->light.sunlight=xyz4(vector3(scene[@"lightColor"]));
    geometry->light.ambient=xyz4(vector3(scene[@"ambient"]));
    NSDictionary *probe=scene[@"probe"];
    if(probe){
        NSUInteger w=[probe[@"width"] unsignedIntegerValue],h=[probe[@"height"] unsignedIntegerValue];
        NSData *bytes=[[NSData alloc]initWithBase64EncodedString:probe[@"pixels"] options:0];
        if(!w||!h||w>1024||h>512||bytes.length!=w*h*4)return nil;
        MTLTextureDescriptor *desc=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm_sRGB width:w height:h mipmapped:YES];
        desc.storageMode=MTLStorageModeShared;desc.usage=MTLTextureUsageShaderRead;
        geometry->environment=[device newTextureWithDescriptor:desc];
        if(!geometry->environment)return nil;
        [geometry->environment replaceRegion:MTLRegionMake2D(0,0,w,h) mipmapLevel:0 withBytes:bytes.bytes bytesPerRow:w*4];
        id<MTLCommandQueue> queue=[device newCommandQueue];
        id<MTLCommandBuffer> cmd=[queue commandBuffer];
        id<MTLBlitCommandEncoder> blit=[cmd blitCommandEncoder];
        [blit generateMipmapsForTexture:geometry->environment];[blit endEncoding];[cmd commit];[cmd waitUntilCompleted];
        if(!cmd || cmd.status!=MTLCommandBufferStatusCompleted)return nil;
        geometry->light.ambient.w=1;
    }
    NSArray *path=scene[@"portraitCamera"];
    if(spec->width>=spec->height || ![path isKindOfClass:NSArray.class])path=scene[@"camera"];
    NSMutableData *keys=[NSMutableData data];
    for(NSDictionary *k in path){
        NRCameraKey key={vector3(k[@"eye"]),vector3(k[@"target"]),[k[@"seconds"] floatValue],[k[@"fov"] floatValue]};
        [keys appendBytes:&key length:sizeof(key)];
    }
    geometry->keys=keys;
    return geometry;
}

static NRShot evaluateShot(NRGeometry *geometry,float seconds,float aspect) {
    const NRCameraKey *keys=geometry->keys.bytes;
    size_t count=geometry->keys.length/sizeof(*keys);
    float t=fmodf(fmaxf(seconds,0),keys[count-1].seconds);
    size_t i=1;
    while(i<count-1 && t>keys[i].seconds)i++;
    NRCameraKey a=keys[i-1],b=keys[i];
    float u=(t-a.seconds)/(b.seconds-a.seconds);
    // Cubic Hermite motion with tangents in units per second.
    NRCameraKey prev=keys[i>1?i-2:0],next=keys[MIN(count-1,i+1)];
    float dt=b.seconds-a.seconds;
    float h1=u*(1-u)*(1-u)*dt/(b.seconds-prev.seconds);
    float h2=u*u*(u-1)*dt/(next.seconds-a.seconds);
    float f=u*u*(3-2*u);
    simd_float3 eye=a.eye+(b.eye-a.eye)*f+h1*(b.eye-prev.eye)+h2*(next.eye-a.eye);
    simd_float3 aim=a.target+(b.target-a.target)*f+h1*(b.target-prev.target)+h2*(next.target-a.target);
    simd_float3 delta=aim-eye;
    simd_float3 forward=simd_length_squared(delta)>1e-8f?simd_normalize(delta):(simd_float3){0,0,-1};
    simd_float3 up=fabsf(forward.y)>.999f?(simd_float3){0,0,1}:(simd_float3){0,1,0};
    simd_float3 right=simd_normalize(simd_cross(forward,up));
    NRShot shot=geometry->light;
    shot.eye=xyz4(eye);shot.eye.w=seconds;shot.forward=xyz4(forward);shot.right=xyz4(right);shot.up=xyz4(simd_cross(right,forward));
    float focal=1/tanf((a.fov+(b.fov-a.fov)*f)*(float)(M_PI/360));
    shot.projection=(simd_float4){focal/aspect,focal,.04f,2000.f};
    return shot;
}
