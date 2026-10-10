// Opt-in diagnostic of authenticated RTCP events. Retains counters/clock fields only.
#pragma once
#include <array>
#include <atomic>
#include <memory>
#include <mutex>
#include <sstream>
#include <span>
#include "api/rtc_event_log/rtc_event_log_factory.h"
#include "logging/rtc_event_log/events/rtc_event_rtcp_packet_incoming.h"
#include "logging/rtc_event_log/events/rtc_event_rtcp_packet_outgoing.h"
#include "rtc_base/time_utils.h"
namespace livekit_ffi {
struct XrObservation {
  bool incoming = false; uint8_t block = 0;
  uint32_t sender = 0, target = 0, last_rr = 0, delay = 0;
  int64_t at_us = 0;
};
struct SenderReportObservation {
  bool incoming=false; uint32_t ssrc=0, ntp_seconds=0, ntp_fraction=0, rtp_timestamp=0;
  int64_t observed_us=0;
};
struct RtcpPeerObservation {
  uint64_t id = 0, incoming_packets = 0, outgoing_packets = 0;
  uint64_t sender_reports = 0, receiver_reports = 0, incoming_rrtr = 0, outgoing_rrtr = 0;
  uint64_t incoming_dlrr = 0, outgoing_dlrr = 0, malformed = 0, overwritten = 0;
  bool active = true;
  std::array<SenderReportObservation,64> sr{}; size_t sr_size=0, sr_next=0; uint64_t sr_overwritten=0;
  std::array<XrObservation,64> xr{}; size_t size = 0, next = 0;
};
struct RtcpProbeState {
  std::mutex mutex;
  std::array<RtcpPeerObservation,16> peers{}; size_t size = 0;
  std::atomic<uint64_t> contention{0}, capacity_exceeded{0};
};
inline std::mutex rtcp_registry_mutex;
inline std::weak_ptr<RtcpProbeState> rtcp_registry;
inline std::atomic<uint64_t> rtcp_logs_created{0}, rtcp_logs_destroyed{0}, rtcp_logs_alive{0};
inline uint32_t rtcp_read32(const uint8_t* p) {
  return (uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3];
}
inline uint16_t rtcp_read16(const uint8_t* p) { return uint16_t(p[0])<<8|p[1]; }
inline void rtcp_record_xr(RtcpPeerObservation& peer, XrObservation observation) {
  if (peer.size == peer.xr.size()) peer.overwritten++; else peer.size++;
  peer.xr[peer.next] = observation; peer.next = (peer.next+1)%peer.xr.size();
}
inline void rtcp_observe(RtcpPeerObservation& peer, std::span<const uint8_t> packet, bool incoming, int64_t at_us) {
  if (incoming) peer.incoming_packets++; else peer.outgoing_packets++;
  size_t offset = 0;
  while (offset < packet.size()) {
    const auto remaining = packet.size()-offset;
    if (remaining<4 || (packet[offset]>>6)!=2) { peer.malformed++; return; }
    const auto* p = packet.data()+offset;
    size_t bytes = (size_t(rtcp_read16(p+2))+1)*4;
    if (bytes>remaining) { peer.malformed++; return; }
    const size_t total = bytes;
    if (p[0]&32) {
      if (bytes<4 || p[bytes-1]==0 || p[bytes-1]>bytes-4 || bytes!=remaining) { peer.malformed++; return; }
      bytes -= p[bytes-1];
    }
    const auto type=p[1];
    if (type==200) {
      if(bytes<28) { peer.malformed++; return; } peer.sender_reports++;
      if(peer.sr_size==peer.sr.size()) peer.sr_overwritten++; else peer.sr_size++;
      peer.sr[peer.sr_next]={incoming,rtcp_read32(p+4),rtcp_read32(p+8),rtcp_read32(p+12),rtcp_read32(p+16),at_us};
      peer.sr_next=(peer.sr_next+1)%peer.sr.size();
    }
    if (type==201) { if(bytes<8) { peer.malformed++; return; } peer.receiver_reports++; }
    if (type==207) {
      if (bytes<8) { peer.malformed++; return; }
      const uint32_t sender=rtcp_read32(p+4);
      size_t block_offset=8;
      while (block_offset<bytes) {
        if (bytes-block_offset<4) { peer.malformed++; return; }
        const auto* block=p+block_offset;
        const size_t block_bytes=(size_t(rtcp_read16(block+2))+1)*4;
        if(block_bytes>bytes-block_offset) { peer.malformed++; return; }
        if(block[0]==4) {
          if(block_bytes!=12) { peer.malformed++; return; }
          const uint32_t compact=(rtcp_read32(block+4)<<16)|(rtcp_read32(block+8)>>16);
          if(incoming) peer.incoming_rrtr++; else peer.outgoing_rrtr++;
          rtcp_record_xr(peer,{incoming,4,sender,0,compact,0,at_us});
        } else if(block[0]==5) {
          if((block_bytes-4)%12!=0) { peer.malformed++; return; }
          for(size_t i=4;i<block_bytes;i+=12) {
            if(incoming) peer.incoming_dlrr++; else peer.outgoing_dlrr++;
            rtcp_record_xr(peer,{incoming,5,sender,rtcp_read32(block+i),rtcp_read32(block+i+4),rtcp_read32(block+i+8),at_us});
          }
        }
        block_offset+=block_bytes;
      }
    }
    offset+=total;
  }
}
class RtcpExchangeLog final : public webrtc::RtcEventLog {
 public:
  RtcpExchangeLog(std::shared_ptr<RtcpProbeState> state, std::unique_ptr<webrtc::RtcEventLog> delegate)
      : state_(std::move(state)), delegate_(std::move(delegate)) {
    const auto id=rtcp_logs_created.fetch_add(1)+1; rtcp_logs_alive.fetch_add(1);
    std::lock_guard<std::mutex> lock(state_->mutex);
    if(state_->size<state_->peers.size()) { slot_=state_->size++; state_->peers[slot_].id=id; }
    else state_->capacity_exceeded.fetch_add(1);
  }
  ~RtcpExchangeLog() override {
    delegate_->StopLogging(); delegate_.reset();
    if(slot_<state_->peers.size()) { std::lock_guard<std::mutex> lock(state_->mutex); state_->peers[slot_].active=false; }
    rtcp_logs_alive.fetch_sub(1); rtcp_logs_destroyed.fetch_add(1);
  }
  bool StartLogging(std::unique_ptr<webrtc::RtcEventLogOutput> output,int64_t period) override {
    return delegate_->StartLogging(std::move(output),period);
  }
  void StopLogging() override { delegate_->StopLogging(); }
  void StopLogging(std::function<void()> callback) override { delegate_->StopLogging(std::move(callback)); }
  void Log(std::unique_ptr<webrtc::RtcEvent> event) override {
    if(event && slot_<state_->peers.size()) {
      const webrtc::Buffer* packet=nullptr; bool incoming=false;
      if(event->GetType()==webrtc::RtcEvent::Type::RtcpPacketIncoming) {
        packet=&static_cast<const webrtc::RtcEventRtcpPacketIncoming*>(event.get())->packet(); incoming=true;
      } else if(event->GetType()==webrtc::RtcEvent::Type::RtcpPacketOutgoing) {
        packet=&static_cast<const webrtc::RtcEventRtcpPacketOutgoing*>(event.get())->packet();
      }
      if(packet) {
        std::unique_lock<std::mutex> lock(state_->mutex,std::try_to_lock);
        if(lock.owns_lock()) rtcp_observe(state_->peers[slot_],{packet->data(),packet->size()},incoming,webrtc::TimeMicros());
        else state_->contention.fetch_add(1);
      }
    }
    delegate_->Log(std::move(event));
  }
 private:
  std::shared_ptr<RtcpProbeState> state_;
  std::unique_ptr<webrtc::RtcEventLog> delegate_;
  size_t slot_=16;
};
class RtcpExchangeFactory final : public webrtc::RtcEventLogFactoryInterface {
 public:
  RtcpExchangeFactory():state_(std::make_shared<RtcpProbeState>()) {
    std::lock_guard<std::mutex> lock(rtcp_registry_mutex); rtcp_registry=state_;
  }
  std::unique_ptr<webrtc::RtcEventLog> Create(const webrtc::Environment& env) const override {
    return std::make_unique<RtcpExchangeLog>(state_,webrtc::RtcEventLogFactory().Create(env));
  }
 private:
  std::shared_ptr<RtcpProbeState> state_;
};
inline std::string rtcp_exchange_report() {
  std::shared_ptr<RtcpProbeState> state;
  { std::lock_guard<std::mutex> lock(rtcp_registry_mutex); state=rtcp_registry.lock(); }
  std::ostringstream out;
  out << "{\"logs_alive\":" << rtcp_logs_alive.load() << ",\"logs_created\":" << rtcp_logs_created.load()
      << ",\"logs_destroyed\":" << rtcp_logs_destroyed.load() << ",\"registry_expired\":" << (state?"false":"true")
      << ",\"raw_packets_retained\":false,\"peers\":[";
  if(state) {
    std::lock_guard<std::mutex> lock(state->mutex);
    for(size_t i=0;i<state->size;++i) {
      const auto& p=state->peers[i]; if(i) out << ',';
      out << "{\"id\":" << p.id << ",\"active\":" << (p.active?"true":"false")
          << ",\"incoming_packets\":" << p.incoming_packets << ",\"outgoing_packets\":" << p.outgoing_packets
          << ",\"sender_reports\":" << p.sender_reports << ",\"receiver_reports\":" << p.receiver_reports
          << ",\"incoming_rrtr\":" << p.incoming_rrtr << ",\"outgoing_rrtr\":" << p.outgoing_rrtr
          << ",\"incoming_dlrr\":" << p.incoming_dlrr << ",\"outgoing_dlrr\":" << p.outgoing_dlrr
          << ",\"malformed\":" << p.malformed << ",\"overwritten_observations\":" << p.overwritten << ",\"xr\":[";
      for(size_t j=0;j<p.size;++j) {
        const auto& x=p.xr[(p.next+p.xr.size()-p.size+j)%p.xr.size()]; if(j) out << ',';
        out << "{\"incoming\":" << (x.incoming?"true":"false") << ",\"block\":" << unsigned(x.block)
            << ",\"sender_ssrc\":" << x.sender << ",\"target_ssrc\":" << x.target
            << ",\"last_rr\":" << x.last_rr << ",\"delay\":" << x.delay << ",\"observed_us\":" << x.at_us << '}';
      }
      out << "],\"sender_report_history\":[";
      for(size_t j=0;j<p.sr_size;++j) {
        const auto& sr=p.sr[(p.sr_next+p.sr.size()-p.sr_size+j)%p.sr.size()]; if(j) out << ',';
        out << "{\"incoming\":" << (sr.incoming?"true":"false") << ",\"ssrc\":" << sr.ssrc
            << ",\"ntp_seconds\":" << sr.ntp_seconds << ",\"ntp_fraction\":" << sr.ntp_fraction
            << ",\"rtp_timestamp\":" << sr.rtp_timestamp << ",\"observed_us\":" << sr.observed_us << '}';
      }
      out << "],\"sender_report_history_overwritten\":" << p.sr_overwritten << '}';
    }
    out << "],\"contention_dropped\":" << state->contention.load() << ",\"capacity_exceeded\":" << state->capacity_exceeded.load();
  } else out << ']';
  out << '}'; return out.str();
}
}
