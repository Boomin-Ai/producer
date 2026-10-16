import hashlib,json,pathlib
lab=pathlib.Path(__file__).resolve().parents[1]
runs=[]
for name in ["transport-rtcp-baseline","transport-rtcp-rrtr","transport-rtcp-sender-maps","transport-sender-clock-rejoin"]:
    p=lab/"evidence"/(name+".json"); report=json.loads(p.read_text()); probe=report["rtcp_exchange_probe"]
    assert not probe["raw_packets_retained"] and probe["contention_dropped"]==probe["capacity_exceeded"]==0
    logs=probe["peers"] # Legacy field name: these are factory log instances, not distinct PeerConnections.
    assert logs and all(s["incoming_packets"]>10 and s["outgoing_packets"]>10 and s["malformed"]==0 for s in logs)
    requests=sum(s["outgoing_rrtr"] for s in logs); replies=sum(s["incoming_dlrr"] for s in logs)
    assert requests>0 if report["rrtr_lab_experiment_requested"] else requests==0
    assert replies==0
    relay=json.loads((lab/"evidence"/(name+"-packet.json")).read_text())
    assert relay["profile"]=="baseline" and relay["overflow_drops"]==relay["send_errors"]==relay["peer_limit_drops"]==0
    assert all(s["dropped"]==s["delayed"]==0 for kind,s in relay["packets"].items() if kind.endswith(":control"))
    receivers={s["ssrc"] for s in report["receiver_stats"]}
    request_records=[x for s in logs for x in s["xr"] if not x["incoming"] and x["block"]==4]
    assert all(x["sender_ssrc"] not in receivers for x in request_records)
    item={"run":name,"evidence_sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"outgoing_rrtr":requests,
          "incoming_dlrr":replies,"control_packets_unimpaired":True,"observed_request_reporter_differs_from_downtrack_ssrcs":bool(request_records),
          "request_ring_overwrites":sum(s["overwritten_observations"] for s in logs),"retained_factory_log_instances":probe["logs_alive"]}
    if name.endswith("sender-maps") or name=="transport-sender-clock-rejoin":
        assert report["timed_mixer_probe"]["sources_created"]==report["timed_mixer_probe"]["sources_destroyed"]==6
        assert report["timed_mixer_probe"]["sources_alive"]==0
        sr=[x for s in logs for x in s["sender_report_history"] if x["incoming"]]
        maps=[]
        for receiver in report["receiver_stats"]:
            entries=[x for x in sr if x["ssrc"]==receiver["ssrc"]]
            assert len(entries)>=2
            a,b=entries[-2:]
            dt=b["ntp_seconds"]-a["ntp_seconds"]+(b["ntp_fraction"]-a["ntp_fraction"])/2**32
            ticks=(b["rtp_timestamp"]-a["rtp_timestamp"])%2**32
            expected=48000 if receiver["kind"]=="audio" else 90000
            assert dt>0 and 0<ticks<2**31 and abs(ticks/dt/expected-1)<.01
            maps.append({"identity":receiver["identity"],"kind":receiver["kind"],"sid":receiver["sid"],"ssrc":receiver["ssrc"],
                         "received_reports_retained":len(entries),"report_interval_seconds":dt,"inferred_rtp_clock_hz":ticks/dt,
                         "expected_fixture_clock_hz":expected})
        assert len(maps)==6
        item["sender_report_maps"]=maps
    if name=="transport-sender-clock-rejoin":
        origin_maps=report["sender_report_origin_maps"]
        assert len(origin_maps)==6 and all(m["two_report_map_available"] and not m["obs_connected"] for m in origin_maps)
        audio=[m for m in origin_maps if m["kind"]=="audio"]
        assert len(audio)==3 and all(m["last_decoded_audio_origin_ntp_us"] is not None for m in audio)
        item["end_of_run_sender_origin_maps"]=origin_maps
    runs.append(item)
result={"runs":runs,"rtcp_exchange_failure_observed":True,"sfu_ssrc_routing_cause":"source-supported hypothesis; patched SFU not executed",
        "sender_report_pairs_available_for_common_map_experiment":True,"obs_presentation_adapter_changed":False,
        "common_clock_qualified":False,"g1_complete":False}
(lab/"evidence/rtcp-exchange-verification.json").write_text(json.dumps(result,indent=2)+"\n")
print("Verified native RTT requests without replies, intact control relay and six incoming RTP/NTP report pairs")
