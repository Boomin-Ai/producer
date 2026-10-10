// Independent FFmpeg 7.1.1 decoder using the installed Producer libraries.
// Synthetic lab files only. No capture, playback, packet retention or mutation.
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/samplefmt.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

struct detector { double markers[128]; unsigned used; int active; unsigned frames; };
static int detect(struct detector *d, const AVFrame *f, AVRational base) {
    if (f->sample_rate != 48000 || f->best_effort_timestamp == AV_NOPTS_VALUE || f->ch_layout.nb_channels < 1) return -1;
    double pts = f->best_effort_timestamp * av_q2d(base) * 1000.0;
    for (int i=0;i<f->nb_samples;i+=480) {
        int end=i+480<f->nb_samples?i+480:f->nb_samples;
        double sum=0;
        for (int j=i;j<end;++j) {
            double sample;
            switch (f->format) {
                case AV_SAMPLE_FMT_FLTP: sample=((float *)f->extended_data[0])[j];break;
                case AV_SAMPLE_FMT_FLT: sample=((float *)f->extended_data[0])[j*f->ch_layout.nb_channels];break;
                case AV_SAMPLE_FMT_S16P: sample=((int16_t *)f->extended_data[0])[j]/32768.0;break;
                case AV_SAMPLE_FMT_S16: sample=((int16_t *)f->extended_data[0])[j*f->ch_layout.nb_channels]/32768.0;break;
                default:return -1;
            }
            sum+=sample*sample;
        }
        int active=sqrt(sum/(end-i))>2000.0/32768.0;
        double edge=pts+i/48.0;
        if(active&&!d->active&&(!d->used||edge-d->markers[d->used-1]>=150)) {
            if(d->used==128)return -1;
            d->markers[d->used++]=edge;
        }
        d->active=active;
    }
    ++d->frames;return 0;
}
static int drain(AVCodecContext *ctx,AVFrame *f,struct detector *d,AVRational base) {
    int code;
    while((code=avcodec_receive_frame(ctx,f))>=0) {
        if(detect(d,f,base)<0){av_frame_unref(f);return -1;}
        av_frame_unref(f);
    }
    return code==AVERROR(EAGAIN)||code==AVERROR_EOF?0:-1;
}
int main(int argc,char **argv) {
    AVFormatContext *format=NULL;AVCodecContext *ctx=NULL;AVPacket *packet=NULL;AVFrame *frame=NULL;
    struct detector d={0};int result=1,code,stream;const AVCodec *codec=NULL;
    if(strcmp(av_version_info(),"n7.1.1")){fprintf(stderr,"Pinned FFmpeg 7.1.1 required\n");return 1;}
    if(argc!=2){fprintf(stderr,"Usage: decode-audio-markers <lab.mp4>\n");return 1;}
    if(avformat_open_input(&format,argv[1],NULL,NULL)<0||avformat_find_stream_info(format,NULL)<0)goto cleanup;
    stream=av_find_best_stream(format,AVMEDIA_TYPE_AUDIO,-1,-1,&codec,0);if(stream<0)goto cleanup;
    ctx=avcodec_alloc_context3(codec);packet=av_packet_alloc();frame=av_frame_alloc();
    if(!ctx||!packet||!frame||avcodec_parameters_to_context(ctx,format->streams[stream]->codecpar)<0)goto cleanup;
    ctx->pkt_timebase=format->streams[stream]->time_base;
    if(avcodec_open2(ctx,codec,NULL)<0)goto cleanup;
    while((code=av_read_frame(format,packet))>=0) {
        if(packet->stream_index==stream) {
            if(avcodec_send_packet(ctx,packet)<0||drain(ctx,frame,&d,ctx->pkt_timebase)<0)goto cleanup;
        }
        av_packet_unref(packet);
    }
    if(code!=AVERROR_EOF||avcodec_send_packet(ctx,NULL)<0||drain(ctx,frame,&d,ctx->pkt_timebase)<0)goto cleanup;
    printf("{\"decoder\":\"FFmpeg %s\",\"decoded_frames\":%u,\"window_max_ms\":10,\"audio_marker_pts_ms\":[",av_version_info(),d.frames);
    for(unsigned i=0;i<d.used;++i)printf("%s%.6f",i?",":"",d.markers[i]);
    printf("]}\n");result=0;
cleanup:
    av_frame_free(&frame);av_packet_free(&packet);avcodec_free_context(&ctx);avformat_close_input(&format);
    if(result)fprintf(stderr,"Independent audio decoding failed\n");return result;
}
