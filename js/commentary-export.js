/* 录像解说专用：生成前预载全部语音，录制中只按已校验的时间轴播放。 */
(function () {
  'use strict';
  const CC = (globalThis.CC = globalThis.CC || {});

  function abortError() { return new Error('已取消导出'); }
  function wait(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const done = () => { signal.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(done, ms);
      const cancel = () => { clearTimeout(timer); reject(abortError()); };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  async function json(url, options) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || '无法生成录像解说');
    return body;
  }
  async function prepare(replay, provider, speech, options) {
    const signal = options.signal;
    let id = null;
    const release = () => id ? fetch('/api/admin/commentary/' + id, { method: 'DELETE', keepalive: true }).catch(() => {}) : Promise.resolve();
    try {
      if (signal.aborted) throw abortError();
      // 创建请求只返回任务ID；取消时先取到ID再删除，避免留下无法取消的后台任务。
      let job = await json('/api/admin/commentary', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replay, provider, speech }) });
      id = job.id;
      if (signal.aborted) throw abortError();
      const started = Date.now();
      while (job.state !== 'ready') {
        if (signal.aborted) throw abortError();
        if (job.state === 'error' || job.state === 'cancelled') throw new Error(job.error || '解说生成已取消');
        if (Date.now() - started > 10 * 60 * 1000) throw new Error('解说准备超时，请重试');
        options.onProgress(job);
        await wait(750, signal);
        job = await json('/api/admin/commentary/' + id, { signal });
      }
      options.onProgress({ state: 'loading' });
      const segments = [];
      for (const line of job.segments) {
        const response = await fetch(line.audioUrl, { signal });
        if (!response.ok) throw new Error('解说语音已过期，请重新生成');
        const buffer = await CC.assets.decodeNarration(await response.arrayBuffer());
        // 使用实际解码时长复验，不让错误的服务时长造成重叠或截尾。
        if (Math.abs(buffer.duration - line.duration) > 0.1) throw new Error('解说语音时长校验失败，请重试');
        segments.push({ ...line, buffer });
      }
      if (signal.aborted) throw abortError();
      let next = 0, playing = null;
      const output = {
        finalHash: job.finalHash, durationTicks: job.durationTicks, endSeconds: job.endSeconds,
        metadata: { model: job.model, voice: job.voice, segments: job.segments.map(({ audioUrl, ...s }) => s) },
        advance: function (seconds) {
          let newest = null;
          while (next < segments.length && segments[next].start <= seconds) newest = segments[next++];
          if (newest && (seconds < newest.end || newest.type === 'result')
              && (!playing || playing.end <= seconds || newest.type === 'result')) {
            CC.assets.playNarration(newest.buffer);
            playing = { ...newest, start: seconds, end: seconds + newest.buffer.duration };
            output.endSeconds = Math.max(output.endSeconds, playing.end + 0.4);
            const metadata = output.metadata.segments.find(s => s.factId === newest.factId);
            metadata.playedStart = playing.start; metadata.playedEnd = playing.end;
          }
          return playing && seconds < playing.end ? playing : null;
        },
        release: release,
      };
      return output;
    } catch (error) { await release(); throw error; }
  }
  CC.commentaryExport = { prepare: prepare };
})();
