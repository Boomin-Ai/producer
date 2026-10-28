#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <math.h>
extern void *producer_preview_attach(void *,double,double,double,double,int,double *,double *);
extern void producer_preview_set_frame(void *,double,double,double,double,double *,double *);
extern void producer_preview_detach(void *);
void producer_person_mask_register_native(void) {}
@interface FlippedContainer:NSView
@end
@implementation FlippedContainer
-(BOOL)isFlipped{return YES;}
@end
static void check(NSView *preview,WKWebView *web,NSView *content,double x,double y,double w,double h){
 NSRect local=[web convertRect:preview.frame fromView:content];
 double top=(web.isFlipped?local.origin.y-NSMinY(web.bounds):NSMaxY(web.bounds)-NSMaxY(local))-web.safeAreaInsets.top;
 if(fabs(local.origin.x-NSMinX(web.bounds)-web.safeAreaInsets.left-x)>.01||fabs(top-y)>.01||fabs(local.size.width-w)>.01||fabs(local.size.height-h)>.01){fprintf(stderr,"FAIL native preview differs from DOM viewport rect\n");exit(1);}
}
int main(){@autoreleasepool{
 [NSApplication sharedApplication];
 for(int flipped=0;flipped<3;flipped++){
  fprintf(stderr,"Checking native layout case %d (2 is full-size titlebar)\n",flipped);
  NSWindow *window=[[NSWindow alloc]initWithContentRect:NSMakeRect(0,0,1100,800) styleMask:(NSWindowStyleMaskTitled|(flipped==2?NSWindowStyleMaskFullSizeContentView:0)) backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed=NO;
  NSView *content=flipped==1?[[FlippedContainer alloc]initWithFrame:NSMakeRect(0,0,1100,800)]:[[NSView alloc]initWithFrame:NSMakeRect(0,0,1100,800)];window.contentView=content;
  NSView *wrapper=[[NSView alloc]initWithFrame:flipped==2?content.bounds:NSMakeRect(17,24,1050,744)];[content addSubview:wrapper];
  WKWebView *web=[[WKWebView alloc]initWithFrame:flipped==2?wrapper.bounds:NSMakeRect(9,11,1024,700)];[wrapper addSubview:web];
  if(flipped==2&&web.safeAreaInsets.top<=0){fprintf(stderr,"FAIL full-size fixture has no titlebar inset\n");return 1;}
  double pw=0,ph=0;void *handle=producer_preview_attach((__bridge void *)window,30,90,640,360,1,&pw,&ph);if(!handle)return 1;
  NSView *preview=(__bridge NSView *)handle;check(preview,web,content,30,90,640,360);
  // The DOM rectangle can stay unchanged while native titlebar/container
  // geometry moves; a new native move must use the current webview origin.
  wrapper.frame=NSMakeRect(25,43,1050,721);
  producer_preview_set_frame(handle,30,90,640,360,&pw,&ph);check(preview,web,content,30,90,640,360);
  producer_preview_set_frame(handle,50,110,720,405,&pw,&ph);check(preview,web,content,50,110,720,405);
  producer_preview_detach(handle);[window close];
 }
 puts("PASS preview attach/move use actual nested webview coordinates in inset, flipped and full-size titlebar content views");
}return 0;}
