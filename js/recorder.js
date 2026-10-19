(function () {
  'use strict';
  const CC = globalThis.CC;
  const $ = (id) => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const canvas = $('recording');
  let active = null;
  const urls = [];
  const FORMATS = {
    mp4: ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4'],
    webm: ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'],
  };
  function supportedFormats(format) {
    if (typeof MediaRecorder !== 'function' || typeof MediaRecorder.isTypeSupported !== 'function') return [];
    return (FORMATS[format] || []).filter(type => MediaRecorder.isTypeSupported(type));
  }

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
    active.controller.abort();
    active.finish();
  }

  function commentaryConfig() {
    const provider = { baseUrl: $('commentary-base').value.trim(), model: $('commentary-model').value.trim(),
      apiKey: $('commentary-key').value.trim() };
    const speech = { baseUrl: $('speech-base').value.trim(), model: $('speech-model').value,
      voiceId: $('speech-voice').value.trim(), speed: Number($('speech-speed').value),
      apiKey: $('speech-reuse-key').checked ? provider.apiKey : $('speech-key').value.trim() };
    if (!provider.baseUrl || !provider.model || !provider.apiKey) throw new Error('请填写语言模型接口、模型名称和 API Key');
    if (!speech.baseUrl || !speech.voiceId || !speech.apiKey) throw new Error('请填写配音接口、音色 ID 和配音密钥');
    if (!Number.isFinite(speech.speed) || speech.speed < 0.5 || speech.speed > 2) throw new Error('语速请填写0.5～2之间的数值');
    return { provider, speech };
  }

  function commentaryProgress(job) {
    const labels = { queued: '准备生成解说…', analyzing: '复盘战斗并整理关键事件…',
      writing: '大模型正在撰写自然语言解说…', voicing: '正在生成自然配音 ' + job.completed + '/' + job.total + '…',
      loading: '正在预载配音，准备同步录制…' };
    status(labels[job.state] || '正在准备解说…');
  }

  async function record(event) {
    if (event) event.preventDefault();
    if (active) return;
    $('error').textContent = '';
    $('record').disabled = true;
    const job = { cancelled: false, controller: new AbortController(), finish: () => {} }; active = job;
    $('cancel').disabled = false;
    let stream, recorder, timer, audioCapture, narration;
    try {
      if (typeof MediaRecorder !== 'function' || !canvas.captureStream) throw new Error('此浏览器不支持录像，请使用最新版 Chrome 或 Edge');
      const format = $('record-format').value;
      const candidates = supportedFormats(format);
      if (!candidates.length) throw new Error('当前浏览器不支持所选录像格式，请切换格式后重试');
      const seed = Number($('seed').value);
      if (!$('seed').value.trim() || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('请输入有效整数种子');
      const settings = $('commentary-enabled').checked ? commentaryConfig() : null;
      $('commentary-settings').closest('fieldset').disabled = true;
      $('record-format').disabled = true;
      // 在按钮手势内激活音频，不能等资源加载后再 resume。
      audioCapture = CC.assets.captureAudio();
      if (!await audioCapture.activate()) {
        status('请点击「生成并下载录像」启用声音并开始录制');
        return;
      }
      const body = { seed, mode: query.get('battle') || 'team' };
      if (query.has('lineup')) body.lineup = JSON.parse(query.get('lineup'));
      if (query.has('size')) body.size = JSON.parse(query.get('size'));
      status('校验管理员权限并准备阵容…');
      const response = await fetch('/api/admin/replay', { method: 'POST', signal: job.controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const config = await response.json();
      if (!response.ok || !config.ok) throw new Error(config.error || '无法创建录像');
      delete config.ok;
      await CC.assets.load();
      if (settings) narration = await CC.commentaryExport.prepare(config, settings.provider, settings.speech,
        { signal: job.controller.signal, onProgress: commentaryProgress });
      if (job.cancelled) throw new Error('已取消导出');
      const match = CC.battle.createMatch(config);
      const names = (side) => config.lineup[side].map((e) => CC.fighters.get(e.id).name).join('、');
      $('lineup').textContent = (config.mode === 'brawl' ? '自由乱斗' : '阵营对战') + ' · 左：' + names('A') + ' · 右：' + names('B');
      CC.render.init(canvas);
      CC.render.reset();
      const view = { phase: 'fighting', paused: false, seed, exportReport: true };
      CC.render.draw(match, view);
      stream = canvas.captureStream(30);
      const audioTracks = audioCapture.stream.getAudioTracks();
      if (!audioTracks.length || audioTracks.some((track) => track.readyState !== 'live')) throw new Error('游戏音轨未就绪，请重新开始录制');
      audioTracks.forEach((track) => stream.addTrack(track));
      for (const mimeType of candidates) {
        try { recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3000000, audioBitsPerSecond: 128000 }); break; }
        catch (error) { /* 同一格式继续尝试兼容的编码组合 */ }
      }
      if (!recorder) throw new Error('无法启动所选格式的录像编码器，请切换格式后重试');
      const chunks = [];
      const done = new Promise((resolve, reject) => {
        recorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        recorder.onstop = resolve;
        recorder.onerror = () => reject(new Error('录像编码失败，请重试'));
      });
      job.finish = () => { clearInterval(timer); if (recorder.state !== 'inactive') recorder.stop(); };
      recorder.start(1000);
      CC.assets.music('bgm_battle_loop');
      CC.assets.play('start');
      view.commentary = narration ? narration.advance(0) : null;
      CC.render.draw(match, view);
      $('cancel').disabled = false;
      const started = performance.now();
      let endingAt = null;
      timer = setInterval(() => {
        try {
          const elapsed = performance.now() - started;
          const target = Math.floor(elapsed * 60 / 1000);
          const events = [];
          while (!match.battle.over && match.battle.tick < target) {
            match.battle.step(); events.push(...match.battle.events);
          }
          match.battle.events.length = 0;
          match.battle.events.push(...events);
          view.commentary = narration ? narration.advance(elapsed / 1000) : null;
          if (match.battle.over) {
            if (endingAt === null) {
              if (narration && (match.hash() !== narration.finalHash || match.battle.tick !== narration.durationTicks)) {
                throw new Error('录像与解说的战况校验不一致，请刷新后重新导出');
              }
              endingAt = elapsed;
            }
            view.phase = 'report'; view.report = match.report();
            status(narration ? '对战结束，等待结局解说完整播完…' : '对战结束，正在保存录像…');
            const finished = elapsed / 1000 >= Math.max(endingAt / 1000 + 5, narration ? narration.endSeconds : 0);
            if (finished) job.finish();
          } else {
            status('正在录制 · 种子 ' + seed + ' · ' + match.battle.time.toFixed(1) + ' 秒');
            if (match.battle.tick >= CC.engine.SAFETY_TIME * 60) { job.cancelled = true; $('error').textContent = '对战未在保护时限内结束，已停止导出'; job.finish(); }
          }
          CC.render.draw(match, view);
          match.battle.events.length = 0;
        } catch (error) { job.cancelled = true; $('error').textContent = error.message; job.finish(); }
      }, 1000 / 30);
      await done;
      if (job.cancelled) { status('已取消导出'); return; }
      const mimeType = recorder.mimeType || (chunks.find(chunk => chunk.type) || {}).type || candidates[0];
      const extension = /^video\/mp4\b/i.test(mimeType) ? 'mp4' : /^video\/webm\b/i.test(mimeType) ? 'webm' : null;
      if (!extension || extension !== format) throw new Error('录像容器与所选格式不一致，请重新导出');
      let video = new Blob(chunks, { type: mimeType });
      if (extension === 'webm') video = await CC.webm.withDuration(video, performance.now() - started);
      if (!video.size) throw new Error('未生成有效视频');
      revokeDownloads();
      const filename = 'cyber-cricket-' + seed + '-' + config.mode;
      config.result = match.report(); config.finalHash = match.hash();
      config.recordingFormat = extension;
      if (narration) config.commentary = narration.metadata;
      const url = link('video-download', video, filename + '.' + extension);
      $('video-download').textContent = '下载 ' + extension.toUpperCase() + ' 录像';
      link('replay-download', new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }), filename + '.json');
      $('downloads').classList.remove('hidden');
      $('preview').src = url; $('preview').classList.remove('hidden');
      status((narration ? '含解说的有声 ' : '有声 ') + extension.toUpperCase() + ' 录像已生成 · 种子 ' + seed + ' · 对局 ' + match.battle.time.toFixed(1) + ' 秒 · ' + (video.size / 1048576).toFixed(1) + ' MB');
      $('video-download').click();
    } catch (error) {
      $('error').textContent = job.cancelled ? '' : error.message;
      status(job.cancelled ? '已取消导出' : '导出失败');
    } finally {
      clearInterval(timer);
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      CC.assets.music('none');
      CC.assets.stopNarration();
      CC.assets.pauseAll();
      if (audioCapture) audioCapture.stop();
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (narration) await narration.release();
      $('commentary-settings').closest('fieldset').disabled = false;
      $('record-format').disabled = false;
      active = null; $('record').disabled = false; $('cancel').disabled = true;
    }
  }
  $('seed').value = query.get('seed') || '20261019';
  if (!supportedFormats('mp4').length) {
    $('record-format').value = 'webm';
    $('format-support').textContent = '当前浏览器不支持直接录制MP4，已选择WebM。';
  } else $('format-support').textContent = '支持直接导出MP4，配音、字幕和完整结算一并保留。';
  $('speech-reuse-key').addEventListener('change', () => { $('speech-key').disabled = $('speech-reuse-key').checked; });
  $('commentary-preset').addEventListener('change', () => {
    if ($('commentary-preset').value === 'minimax') {
      $('commentary-base').value = 'https://api.minimax.cn/v1';
      $('commentary-model').value = 'MiniMax-M3.1-Flash';
    } else {
      $('speech-reuse-key').checked = false; $('speech-key').disabled = false;
    }
  });
  $('export-form').addEventListener('submit', record);
  $('cancel').addEventListener('click', cancel);
  window.addEventListener('beforeunload', () => { cancel(); revokeDownloads(); });
  if (query.get('auto') === '1') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => record(), { once: true });
    else record();
  }
})();
