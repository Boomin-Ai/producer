import hashlib, json, pathlib
lab = pathlib.Path(__file__).resolve().parents[1]
results = []
for name in ["transport-timed-mixer-churn", "transport-timed-mixer-90s", "transport-timed-mixer-video-jitter", "transport-timed-mixer-rrtr-churn"]:
    file = lab/"evidence"/(name+".json")
    report = json.loads(file.read_text()); probe = report["timed_mixer_probe"]
    assert probe["sources_alive"] == 0
    assert probe["sources_created"] == probe["sources_destroyed"] == len(probe["sources"])
    assert all(not s["active"] and s["frames"] > 0 for s in probe["sources"])
    assert probe["contention_dropped"] == probe["capacity_exceeded"] == 0
    source_match = None
    if name == "transport-timed-mixer-video-jitter":
        audio = [s for s in report["receiver_stats"] if s["kind"] == "audio"]
        assert len(audio) == 1 and audio[0]["ssrc"] == probe["sources"][0]["ssrc"]
        source_match = {"identity": audio[0]["identity"], "publication_sid": audio[0]["sid"], "ssrc":audio[0]["ssrc"]}
        packets = json.loads((lab/"evidence"/(name+"-packet.json")).read_text())
        assert packets["profile"] == "video-jitter" and packets["packet_profile_effect_observed"]
        assert any(s["delayed"] > 100 for kind,s in packets["packets"].items() if kind.endswith(":video"))
    results.append({"run":name,"evidence_sha256":hashlib.sha256(file.read_bytes()).hexdigest(),
                    "generations":len(probe["sources"]),"frames":sum(s["frames"] for s in probe["sources"]),
                    "ntp_valid_frames":sum(s["ntp_valid_frames"] for s in probe["sources"]),
                    "source_to_publication_match":source_match,"remaining_source_wrappers":0,
                    "rrtr_experiment_requested":report.get("rrtr_lab_experiment_requested",False)})
result = {"scope":"decoded mixer metadata and wrapper lifetime; OBS adapter unchanged", "runs":results,
          "native_archive_rebuild_required_for_probe":False,"common_clock_qualified":False,"g1_complete":False}
(lab/"evidence/timed-mixer-verification.json").write_text(json.dumps(result,indent=2)+"\n")
print("Verified four live probe runs, source association, packet jitter and all source-wrapper destruction")
