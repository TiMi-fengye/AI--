#!/usr/bin/env python3
"""Build the public, synthetic HR explainer video with Python stdlib + FFmpeg.

First run render-scenes.ps1 and synthesize-narration.ps1; intermediate assets
stay in .delivery/video-build. Never reads application configuration or data.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import json
import math
import re
import shutil
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "视频/人力资源管理系统使用与技术介绍"
VIDEO_NAME = "人力资源管理系统使用与技术介绍.mp4"
FPS = 25
SAMPLE_RATE = 24000


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run(args, **kwargs):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", **kwargs)
    if result.returncode:
        raise RuntimeError(f"Command failed: {args[0]}\n{result.stderr[-5000:]}")
    return result


def probe(path):
    return json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                           "-of", "json", path]).stdout)


def subtitle_chunks(text, width=31):
    """Prefer punctuation boundaries; keep every narrated character in order."""
    remaining, result = text.strip(), []
    while len(remaining) > width:
        choices = [i + 1 for i, c in enumerate(remaining[:width]) if c in "，；：、。！？"]
        cut = choices[-1] if choices and choices[-1] >= 12 else width
        result.append(remaining[:cut])
        remaining = remaining[cut:]
    if remaining:
        result.append(remaining)
    return result


def stamp(seconds, sep=","):
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def ass_stamp(seconds):
    cs = int(round(seconds * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(text):
    return text.replace("\\", "\\\\").replace("{", r"\{").replace("}", r"\}")


def write_ass(path, cues):
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Microsoft YaHei,40,&H00FFFFFF,&H00FFFFFF,&H00231810,&H80231810,0,0,0,0,100,100,0,0,1,1.2,0,2,100,100,58,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [f"Dialogue: 0,{ass_stamp(c['start'])},{ass_stamp(c['end'])},Main,,0,0,0,,"
             + r"{\fad(90,70)}" + ass_escape(c["text"]) for c in cues]
    path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8-sig")


def prepare_scene(index, scene, narration, audio_dir, work):
    assert narration["id"] == scene["id"], "Narration and storyboard do not match"
    assert "".join(p["text"] for p in narration["parts"]) == scene["narration"], "Stale narration"
    samples = bytearray(b"\0\0" * int(SAMPLE_RATE * 0.42))
    cues = []
    for part in narration["parts"]:
        with wave.open(str(audio_dir / part["file"]), "rb") as wav:
            assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, SAMPLE_RATE)
            frames = wav.readframes(wav.getnframes())
        start = len(samples) / 2 / SAMPLE_RATE
        duration = len(frames) / 2 / SAMPLE_RATE
        chunks = subtitle_chunks(part["text"])
        # Each sentence is independently synthesized; cues never drift across sentences.
        spoken = max(0.25, duration - 0.12)
        offset = 0
        for chunk in chunks:
            begin = start + spoken * offset / len(part["text"])
            offset += len(chunk)
            end = start + spoken * offset / len(part["text"])
            cues.append({"start": begin, "end": end, "text": chunk})
        samples.extend(frames)
        samples.extend(b"\0\0" * int(SAMPLE_RATE * 0.06))
    samples.extend(b"\0\0" * int(SAMPLE_RATE * 0.52))
    frame_count = math.ceil(len(samples) / 2 / SAMPLE_RATE * FPS)
    target_samples = frame_count * SAMPLE_RATE // FPS
    samples.extend(b"\0\0" * (target_samples - len(samples) // 2))
    prefix = f"scene-{index:03d}"
    with wave.open(str(work / f"{prefix}.wav"), "wb") as wav:
        wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
        wav.writeframes(samples)
    write_ass(work / f"{prefix}.ass", cues)
    return {"index": index, "id": scene["id"], "title": scene["title"],
            "chapter": scene["chapter"], "duration": frame_count / FPS,
            "frames": frame_count, "cues": cues, "prefix": prefix}


def render_segment(info, frames_dir, work, preset):
    image_path = frames_dir / f"{info['prefix']}.png"
    if not image_path.is_file():
        raise FileNotFoundError(image_path)
    ass_path = work / f"{info['prefix']}.ass"
    # Run in the intermediate directory so ASS filter paths are ASCII and unambiguous.
    image_name = f"input-{info['index']:03d}.png"
    shutil.copyfile(image_path, work / image_name)
    duration = info["duration"]
    vf = (f"subtitles={ass_path.name},fade=t=in:st=0:d=0.20,"
          f"fade=t=out:st={duration-0.20:.3f}:d=0.20,format=yuv420p")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-loop", "1", "-framerate", FPS, "-i", image_name,
         "-i", f"{info['prefix']}.wav", "-vf", vf,
         "-af", "loudnorm=I=-17:TP=-1.5:LRA=8,afade=t=in:d=0.08",
         "-t", f"{duration:.3f}", "-r", FPS, "-c:v", "libx264",
         "-preset", preset, "-crf", "21", "-threads", "3",
         "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
         "-video_track_timescale", "12800", "-movflags", "+faststart",
         f"{info['prefix']}.mp4"], cwd=work)
    return info["index"]


def write_player(output, story, chapters, duration):
    links = "\n".join(f'<button type="button" data-time="{c["start"]:.3f}"><time>'
                      f'{stamp(c["start"]).split(",")[0][3:]}</time><span>{html.escape(c["title"])}</span></button>'
                      for c in chapters)
    video = html.escape(VIDEO_NAME)
    document = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>人力资源管理系统 · 视频指南</title><style>
:root{color-scheme:dark;font-family:'Microsoft YaHei',system-ui,sans-serif;background:#0a1422;color:#f0f5ff}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:42px 32px}header{display:flex;gap:16px;justify-content:space-between;align-items:center}h1{font-size:clamp(23px,3vw,38px);margin:10px 0}p{color:#aebed1;line-height:1.9}small,.eyebrow{color:#65e2c3}.eyebrow{letter-spacing:2px;font-size:12px}.tag{border:1px solid #2b485b;border-radius:30px;padding:8px 14px;font-size:13px;white-space:nowrap}.layout{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:24px;margin-top:26px}video{width:100%;background:#000;border-radius:14px;display:block;border:1px solid #294151}.box{background:#101f30;border:1px solid #263c50;border-radius:16px;padding:22px}h2{font-size:18px;margin:0 0 16px}nav{max-height:620px;overflow:auto}button{width:100%;display:flex;gap:14px;text-align:left;align-items:flex-start;border:0;border-radius:8px;background:transparent;color:#c7d4e2;cursor:pointer;padding:12px 9px;font:inherit;font-size:14px;line-height:1.5}button:hover,button.active{background:#1d3947;color:#79efd0}time{font:12px/1.8 monospace;color:#76d7c2}button:focus-visible,a:focus-visible{outline:2px solid #79efd0;outline-offset:3px}a{color:#79efd0}.links{display:flex;gap:20px;flex-wrap:wrap;margin-top:16px}.notice{margin-top:22px;border-left:3px solid #f0b06c;padding:4px 18px}.status{color:#f0b06c;font-size:14px;min-height:22px}.progress{display:block;background:#203346;border:0;height:4px;width:100%;margin:16px 0}.progress::-webkit-progress-value{background:#65e2c3}.meta{display:flex;gap:20px;font-size:13px;color:#aebed1;margin:16px 0}.footer{font-size:12px;color:#7e94ac;margin-top:28px} @media(max-width:950px){main{padding:22px 16px}.layout{grid-template-columns:1fr}nav{max-height:330px}header{align-items:flex-start}.tag{font-size:11px} .box{padding:16px}}
</style></head><body><main><header><div><div class="eyebrow">HR SYSTEM / VIDEO HANDBOOK</div><h1>人力资源管理系统</h1><p>使用与技术介绍 · 从人员日常操作，到架构与阿里云部署</p></div><span class="tag">__DATE__ · 离线交付</span></header>
<div class="layout"><section aria-label="视频播放"><video id="video" controls preload="metadata" playsinline poster="封面.jpg"><source src="__VIDEO__" type="video/mp4">请用支持 MP4 的现代浏览器或直接打开视频文件。</video><progress class="progress" id="progress" max="100" value="0" aria-label="播放进度"></progress><div class="meta"><span>__DURATION__</span><span>1080p / 25fps</span><span>中文配音 · 内嵌字幕</span></div><p id="status" class="status" role="status"></p><div class="links"><a href="__VIDEO__" download>保存 MP4</a><a href="字幕.srt" download>下载字幕</a><a href="分镜脚本.json">查看分镜</a><a href="视频信息.json">视频参数</a></div><div class="notice"><p>画面是基于公开源码制作的操作示意，使用虚构演示资料。当前生产状态依据 2026-11-13 验收记录；短信验证码已开发，尚未部署启用。</p></div></section><aside class="box"><h2>视频章节</h2><small>点击跳转，按角色快速定位</small><nav aria-label="视频章节">__LINKS__</nav></aside></div>
<footer class="footer">保留本 HTML、MP4 与封面在同一目录，双击本文件并点击播放。无需联网、账号或外部播放器库。MP4 字幕已经写入画面。系统功能变更后，请同步更新分镜并重新生成视频。</footer></main>
<script>'use strict';const v=document.getElementById('video'),buttons=Array.from(document.querySelectorAll('[data-time]')),s=document.getElementById('status');let pendingTime=null;function seekTo(t){if(v.readyState===0){pendingTime=t;v.load();return;}v.currentTime=Math.min(t,Math.max(0,(v.duration||t+1)-.05));v.play().catch(()=>{s.textContent='已定位，请点击视频的播放按钮。';});}buttons.forEach(b=>b.addEventListener('click',()=>seekTo(Number(b.dataset.time))));v.addEventListener('loadedmetadata',()=>{if(pendingTime!==null){const t=pendingTime;pendingTime=null;seekTo(t);}});v.addEventListener('timeupdate',()=>{document.getElementById('progress').value=v.duration?v.currentTime/v.duration*100:0;let last=-1;buttons.forEach((b,i)=>{if(v.currentTime+.15>=Number(b.dataset.time))last=i;});buttons.forEach((b,i)=>{b.classList.toggle('active',i===last);if(i===last)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');});});v.addEventListener('error',()=>{s.textContent='未能读取视频。请确认 MP4 与本 HTML 在同一目录，也可直接使用视频播放器打开 MP4。';});v.addEventListener('playing',()=>{s.textContent='';});</script></body></html>
"""
    document = document.replace("__DATE__", html.escape(story["date"]))
    document = document.replace("__DURATION__", stamp(round(duration)).split(",")[0][3:])
    document = document.replace("__VIDEO__", video).replace("__LINKS__", links)
    (output / "离线播放.html").write_text(document, encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--work", type=Path, default=ROOT / ".delivery/video-build")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--preset", default="veryfast")
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--reuse-segments", action="store_true", help="Only reuse with unchanged reviewed assets")
    args = parser.parse_args()
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        parser.error("Install FFmpeg and ffprobe before running this script")
    output, work = args.output.resolve(), args.work.resolve()
    output.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    story = read_json(output / "分镜脚本.json")
    narration = read_json(work / "audio/narration.json")
    if len(narration["scenes"]) != len(story["scenes"]):
        raise ValueError("Narration scene count mismatch")
    infos = [prepare_scene(i, s, n, work / "audio", work)
             for i, (s, n) in enumerate(zip(story["scenes"], narration["scenes"]), 1)]
    elapsed, chapters, cues = 0.0, [], []
    for info in infos:
        info["start"] = elapsed
        chapters.append({k: info[k] for k in ("id", "title", "chapter", "start", "duration")})
        for c in info["cues"]:
            cues.append({"start": round(c["start"] + elapsed, 3), "end": round(c["end"] + elapsed, 3), "text": c["text"]})
        elapsed += info["duration"]
    srt = "\n\n".join(f"{i}\n{stamp(c['start'])} --> {stamp(c['end'])}\n{c['text']}" for i, c in enumerate(cues, 1)) + "\n"
    (output / "字幕.srt").write_text(srt, encoding="utf-8-sig")
    (output / "字幕.vtt").write_text("WEBVTT\n\n" + "\n\n".join(
        f"{stamp(c['start'],'.')} --> {stamp(c['end'],'.')}\n{c['text']}" for c in cues) + "\n", encoding="utf-8")
    write_json(work / "timeline.json", {"duration": elapsed, "chapters": chapters, "cues": cues})
    write_player(output, story, chapters, elapsed)
    print(f"PREPARED scenes={len(infos)} duration={elapsed:.2f}s subtitles={len(cues)}", flush=True)
    if args.prepare_only:
        return
    pending = [i for i in infos if not (args.reuse_segments and (work / f"{i['prefix']}.mp4").exists())]
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, args.jobs))) as pool:
        futures = [pool.submit(render_segment, i, work / "frames", work, args.preset) for i in pending]
        for future in concurrent.futures.as_completed(futures):
            print(f"ENCODED scene={future.result():02d}/{len(infos)}", flush=True)
    (work / "concat.txt").write_text("\n".join(f"file '{i['prefix']}.mp4'" for i in infos) + "\n", encoding="ascii")
    metadata = [";FFMETADATA1", "title=人力资源管理系统使用与技术介绍", "artist=HR 系统项目", "comment=公开源码操作示意 / 虚构演示数据"]
    for info in infos:
        title = re.sub(r"[=;#\\\n]", " ", info["title"])
        metadata.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(info['start']*1000)}",
                         f"END={round((info['start']+info['duration'])*1000)}", "title=" + title])
    (work / "chapters.txt").write_text("\n".join(metadata) + "\n", encoding="utf-8")
    video_path = output / VIDEO_NAME
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "concat.txt",
         "-i", "chapters.txt", "-map", "0:v", "-map", "0:a", "-map_metadata", "1", "-map_chapters", "1",
         "-c", "copy", "-movflags", "+faststart", video_path], cwd=work)
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", work / "frames/scene-001.png",
         "-frames:v", "1", "-q:v", "2", output / "封面.jpg"])
    actual = probe(video_path)
    video_stream = next(s for s in actual["streams"] if s["codec_type"] == "video")
    audio_stream = next(s for s in actual["streams"] if s["codec_type"] == "audio")
    assert (video_stream["width"], video_stream["height"]) == (1920, 1080)
    assert video_stream["codec_name"] == "h264" and audio_stream["codec_name"] == "aac"
    assert abs(float(actual["format"]["duration"]) - elapsed) < 1.0
    chapter_probe = json.loads(run(["ffprobe", "-v", "error", "-show_chapters", "-of", "json", video_path]).stdout)
    assert len(chapter_probe["chapters"]) == len(chapters)
    assert all(abs(float(a["start_time"]) - b["start"]) < 0.002
               for a, b in zip(chapter_probe["chapters"], chapters))
    assert all(0 <= c["start"] < c["end"] <= float(actual["format"]["duration"]) for c in cues)
    assert all(a["end"] <= b["start"] + 0.001 for a, b in zip(cues, cues[1:]))
    # Decode the full output, not only its container header.
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-xerror", "-i", video_path,
         "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"])
    with video_path.open("rb") as video_file:
        video_hash = hashlib.file_digest(video_file, "sha256").hexdigest()
    info = {
        "title": story["title"], "date": story["date"], "file": VIDEO_NAME,
        "durationSeconds": round(float(actual["format"]["duration"]), 3),
        "durationDisplay": stamp(round(float(actual["format"]["duration"]))).split(",")[0][3:],
        "sizeBytes": video_path.stat().st_size,
        "sha256": video_hash,
        "video": {k: video_stream[k] for k in ("codec_name", "width", "height", "pix_fmt", "r_frame_rate")},
        "audio": {k: audio_stream[k] for k in ("codec_name", "sample_rate", "channels")},
        "voice": narration["voice"], "voiceEngine": narration["engine"], "voiceRate": narration["rate"],
        "subtitles": {"burnedIn": True, "external": ["字幕.srt", "字幕.vtt"], "cueCount": len(cues),
                      "timing": "Each sentence uses its actual synthesized WAV length; long sentences split proportionally."},
        "sceneCount": len(infos), "chapters": chapters,
        "style": "操作示意动画，非生产录屏；虚构演示资料",
        "productionBaseline": story["baseline"],
        "checks": {"fullAudioVideoDecode": "passed", "dimensionsAndCodecs": "passed", "durationAlignment": "passed",
                   "chapterCountAndTiming": "passed", "subtitlesMonotonicAndInRange": "passed"},
        "deliveryFiles": [VIDEO_NAME, "离线播放.html", "字幕.srt", "字幕.vtt", "封面.jpg", "分镜脚本.json", "视频信息.json", "README.md"]
    }
    write_json(output / "视频信息.json", info)
    print(json.dumps({"status": "VIDEO_OK", "duration": info["durationDisplay"], "bytes": info["sizeBytes"],
                      "sha256": info["sha256"], "scenes": len(infos)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
