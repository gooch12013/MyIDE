# MyIDE read-back helper. SPDX-License-Identifier: MIT
#
# A long-lived process run by MyIDE with the Python that has mlx-audio installed. It reads one JSON
# request per line on stdin and answers one JSON line per request on stdout:
#   {"id": 1, "model": "<hf repo>", "text": "...", "voice": "af_heart", "lang": "a", "speed": 1.0,
#    "ref": "/path/clone.wav", "ref_text": "...", "instruct": "voice description (VoiceDesign)",
#    "rate": 1.0, "out": "/path/out.wav"}
#   -> {"id": 1, "state": "downloading" | "loading"}   (only while a model is fetched or loaded)
#   -> {"id": 1, "ok": true, "secs": 0.9} | {"id": 1, "ok": false, "error": "..."}
#   {"stop": true} cancels everything sent so far: playback stops, queued lines are skipped.
# Models stay loaded, one per Hugging Face repo, after their first use. Without "out" the line plays
# through afplay (at "rate"); with it, the WAV is written there and nothing plays.
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time

out = sys.stdout
sys.stdout = sys.stderr  # libraries print; only our JSON goes to MyIDE
lock = threading.Lock()


def send(msg):
    with lock:
        out.write(json.dumps(msg) + "\n")
        out.flush()


try:  # Kokoro: espeakng-loader's library looks for its data where it was built unless told
    import espeakng_loader

    os.environ.setdefault("ESPEAK_DATA_PATH", espeakng_loader.get_data_path())
except ImportError:
    pass

try:
    import mlx.core as mx
    import numpy as np
    from huggingface_hub import try_to_load_from_cache
    from mlx_audio.audio_io import write
    from mlx_audio.tts.utils import load
except Exception as e:  # noqa: BLE001
    send({"ready": False, "error": f"{type(e).__name__}: {e}"})
    sys.exit(1)

models = {}
jobs = queue.Queue()
stopped = 0  # requests with an id up to this were cancelled
seen = 0
player = None


def reader():
    global stopped, seen
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("stop"):
            stopped = seen
            p = player
            if p and p.poll() is None:
                p.kill()
        else:
            seen = max(seen, int(msg.get("id", 0)))
            jobs.put(msg)
    os._exit(0)  # MyIDE went away


def model(req):
    name = req["model"]
    if name not in models:
        cached = os.path.isdir(name) or isinstance(try_to_load_from_cache(name, "config.json"), str)
        send({"id": req["id"], "state": "loading" if cached else "downloading"})
        models[name] = load(name)
    return models[name]


def speak(req):
    global player
    m = model(req)
    kw = {"text": req["text"], "speed": req.get("speed") or 1.0}
    for k, arg in (("voice", "voice"), ("lang", "lang_code"), ("ref", "ref_audio"), ("ref_text", "ref_text"), ("instruct", "instruct")):
        if req.get(k):
            kw[arg] = req[k]
    t0 = time.time()
    audio = [np.array(r.audio) for r in m.generate(**kw)]
    if not audio:
        raise RuntimeError("no audio was generated")
    path = req.get("out") or tempfile.mktemp(suffix=".wav", prefix="myide-speak-")
    write(path, np.concatenate(audio), m.sample_rate)
    secs = round(time.time() - t0, 2)
    if not req.get("out"):
        try:
            if req["id"] > stopped:
                player = subprocess.Popen(["/usr/bin/afplay", "-r", str(req.get("rate") or 1.0), path])
                player.wait()
        finally:
            os.unlink(path)
    return secs


threading.Thread(target=reader, daemon=True).start()
send({"ready": True})
while True:
    req = jobs.get()
    if req["id"] <= stopped:
        send({"id": req["id"], "ok": True, "stopped": True})
        continue
    try:
        send({"id": req["id"], "ok": True, "secs": speak(req)})
    except Exception as e:  # noqa: BLE001
        send({"id": req["id"], "ok": False, "error": f"{type(e).__name__}: {e}"})
    mx.clear_cache()
