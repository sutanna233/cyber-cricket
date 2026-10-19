(function () {
  'use strict';
  const CC = globalThis.CC;
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const canvas = $('recording');
  let active = null;
  const urls = [];

  function status(message) { $('status').textContent = message; }
  function revokeDownloads() { while (urls.length) URL.revokeObjectURL(urls.pop()); }
  function link(id, blob, filename) {
    const url = URL.createObjectURL(blob); urls.push(url);
    $(id).href = url; $(id).download = filename;
    return url;
  }
  function cancel() {
    if (!active) return;
    active.cancelled = true;
    active.finish();
  }

  async function record(event) {
    if (event) event.preventDefault();
    if (active) return;
    $('error').textContent = '';
    $('record').disabled = true;
    const job = { cancelled: false, finish: () => {} }; active = job;
    let stream, recorder, timer;
    try {
      if (typeof MediaRecorder !== 'function' || !canvas.captureStream) throw new Error('此浏览器不支持录像，请使用最新版 Chrome 或 Edge');
      const seed = Number($('seed').value);
      if (!$('seed').value.trim() || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('请输入有效整数种子');
      const body = { seed, mode: query.get('battle') || 'team' };
      if (query.has('lineup')) body.lineup = JSON.parse(query.get('lineup'));
      if (query.has('size')) body.size = JSON.parse(query.get('size'));
      status('校验管理员权限并准备阵容…');
      const response = await fetch('/api/admin/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const config = await response.json();
      if (!response.ok || !config.ok) throw new Error(config.error || '无法创建录像');
      delete config.ok;
      await CC.assets.load();
      CC.assets.setVolume({ master: 0 });
      const match = CC.battle.createMatch(config);
      const names = (side) => config.lineup[side].map((e) => CC.fighters.get(e.id).name).join('、');
      $('lineup').textContent = (config.mode === 'brawl' ? '自由乱斗' : '阵营对战') + ' · 左：' + names('A') + ' · 右：' + names('B');
      CC.render.init(canvas);
      const view = { phase: 'fighting', paused: false, seed };
      CC.render.draw(match, view);
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('浏览器没有可用的 WebM 编码器');
      stream = canvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3000000 });
      const chunks = [];
      const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('录像编码失败，请重试'));
      });
      job.finish = () => { clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.start(1000);
      $('cancel').disabled = false;
      const started = performance.now();
      let endingAt = null;
      timer = setInterval(() => {
        try {
          const elapsed = performance.now() - started;
          const target = Math.floor(elapsed * 60 / 1000);
          while (!match.battle.over && match.battle.tick < target) match.battle.step();
          if (match.battle.over) {
            if (endingAt === null) endingAt = elapsed;
            view.phase = 'report'; view.report = match.report();
            status('对战结束，正在保存录像…');
            if (elapsed - endingAt >= 1500) job.finish();
          } else {
            status('正在录制 · 种子 ' + seed + ' · ' + match.battle.time.toFixed(1) + ' 秒');
            if (match.battle.tick >= CC.engine.SAFETY_TIME * 60) { job.cancelled = true; $('error').textContent = '对战未在保护时限内结束，已停止导出'; job.finish(); }
          }
          CC.render.draw(match, view);
        } catch (error) { job.cancelled = true; $('error').textContent = error.message; job.finish(); }
      }, 1000 / 30);
      await done;
      if (job.cancelled) { status('已取消导出'); return; }
      const video = await CC.webm.withDuration(new Blob(chunks, { type: mimeType }), performance.now() - started);
      if (!video.size) throw new Error('未生成有效视频');
      revokeDownloads();
      const filename = 'cyber-cricket-' + seed + '-' + config.mode;
      config.result = match.report(); config.finalHash = match.hash();
      const url = link('video-download', video, filename + '.webm');
      link('replay-download', new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }), filename + '.json');
      $('downloads').classList.remove('hidden');
      $('preview').src = url; $('preview').classList.remove('hidden');
      status('录像已生成 · 种子 ' + seed + ' · 对局 ' + match.battle.time.toFixed(1) + ' 秒 · ' + (video.size / 1048576).toFixed(1) + ' MB');
      $('video-download').click();
    } catch (error) {
      $('error').textContent = error.message;
      status('导出失败');
    } finally {
      clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      if (stream) stream.getTracks().forEach((track) => track.stop());
      active = null; $('record').disabled = false; $('cancel').disabled = true;
    }
  }
  $('seed').value = query.get('seed') || '20261019';
  $('export-form').addEventListener('submit', record);
  $('cancel').addEventListener('click', cancel);
  window.addEventListener('beforeunload', () => { cancel(); revokeDownloads(); });
  if (query.get('auto') === '1') record();
})();
