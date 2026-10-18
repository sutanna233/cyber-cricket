/* ===========================================================
   赛博斗蛐蛐 · 放置 ARPG —— 资源层（贴图 + 音频）
   CC.assets：贴图池（meme 抠图 → 程序化兜底 → 运行时占位块）
              音频池（wav 采样；缺文件一律 WebAudio 振荡器合成）
   -----------------------------------------------------------
   铁律：
   1. load() 永不 reject，缺任何文件都只降级；
   2. 无 DOM / 无 Canvas / 无 WebAudio（Node 无头）时全部静默降级，不抛错；
   3. 不用 Math.random —— 表现层随机也走 CC.util.RNG（可复现）。
   =========================================================== */
(function () {
  'use strict';

  const CC = (globalThis.CC = globalThis.CC || {});
  const U = CC.util || {};

  const hasWin = typeof window !== 'undefined';
  const hasDoc = typeof document !== 'undefined';
  let BASE = 'assets/';

  // ---------------------------------------------------------------- 清单
  const UNIT_IDS = [
    'tomori', 'xujiayin', 'kun', 'dingzhen', 'bao', 'sunge', 'bili', 'yingma',
    'oligei', 'fawang', 'liulaoshi', 'daxiang', 'xiongmao', 'zhenxiang', 'chongwang',
  ];

  // 512×512 抠图里"真正有像素"的内容框（实测，tools/_rendercheck/measure*.ps1）
  // 渲染层按这些框裁切绘制，保证 15 只单位视觉体量一致。
  // <<<TEX_META_BEGIN>>> 由 tools/_rendercheck/gen_tex_meta.js 生成，勿手改
  // 口径：box = alpha>64 的内容包围盒；ratio = alpha>16 的非透明占比（与 tests/_loader 一致）
  // 重算：node tools/_rendercheck/gen_tex_meta.js    校验：--check
  const TEX_META_STAMP = "2026-10-18T18:20:22.611Z";
  const MEME_TEX = {
    bao: { box: [93, 41, 493, 505], ratio: 0.4528, w: 512, h: 512, size: 259027, mtime: 1792343280141, sha: "250d92056f80" },
    bili: { box: [57, 67, 495, 511], ratio: 0.5257, w: 512, h: 512, size: 283543, mtime: 1792343285005, sha: "aa47321e15af" },
    chongwang: { box: [24, 64, 491, 449], ratio: 0.4462, w: 512, h: 512, size: 224402, mtime: 1792343304543, sha: "f7c63a3fea41" },
    daxiang: { box: [61, 98, 511, 475], ratio: 0.4425, w: 512, h: 512, size: 220773, mtime: 1792343297189, sha: "f1ad798672d5" },
    dingzhen: { box: [61, 71, 511, 511], ratio: 0.4964, w: 512, h: 512, size: 253610, mtime: 1792343277737, sha: "a2cf47f45974" },
    fawang: { box: [23, 151, 488, 458], ratio: 0.3424, w: 512, h: 512, size: 147560, mtime: 1792343292238, sha: "2f32d9584a20" },
    kun: { box: [71, 35, 455, 499], ratio: 0.5435, w: 512, h: 512, size: 222153, mtime: 1792343275316, sha: "9b13924a0685" },
    liulaoshi: { box: [136, 54, 467, 511], ratio: 0.4159, w: 512, h: 512, size: 198972, mtime: 1792343294677, sha: "128e85bda40d" },
    oligei: { box: [91, 146, 480, 511], ratio: 0.3921, w: 512, h: 512, size: 141050, mtime: 1792343289841, sha: "232c515d2028" },
    sunge: { box: [59, 75, 511, 511], ratio: 0.4771, w: 512, h: 512, size: 168327, mtime: 1792343282553, sha: "60bafb502a11" },
    tomori: { box: [148, 31, 364, 497], ratio: 0.3043, w: 512, h: 512, size: 132749, mtime: 1792343268136, sha: "77ece0404248" },
    xiongmao: { box: [48, 25, 463, 492], ratio: 0.6173, w: 512, h: 512, size: 248310, mtime: 1792344947238, sha: "66dcfd3ba14f" },
    xujiayin: { box: [51, 23, 460, 487], ratio: 0.3863, w: 512, h: 512, size: 193429, mtime: 1792343272958, sha: "d14dd4a7a7e3" },
    yingma: { box: [37, 45, 501, 480], ratio: 0.7349, w: 512, h: 512, size: 233365, mtime: 1792343658649, sha: "7ffaf274ea94" },
    zhenxiang: { box: [74, 27, 438, 491], ratio: 0.3917, w: 512, h: 512, size: 151508, mtime: 1792343302120, sha: "694caecb0013" },
  };
  const ROOT_TEX = {
    bao: { box: [32, 54, 479, 493], ratio: 0.4786, w: 512, h: 512, size: 97557, mtime: 1792339942333, sha: "e2342c1bfaa9" },
    bili: { box: [32, 50, 479, 493], ratio: 0.4846, w: 512, h: 512, size: 75349, mtime: 1792339943086, sha: "9b3a60131469" },
    chongwang: { box: [32, 54, 479, 493], ratio: 0.5146, w: 512, h: 512, size: 106162, mtime: 1792339946318, sha: "83c215887d49" },
    daxiang: { box: [32, 54, 479, 493], ratio: 0.4994, w: 512, h: 512, size: 85837, mtime: 1792339945027, sha: "9017e846b6c6" },
    dingzhen: { box: [32, 54, 479, 493], ratio: 0.4851, w: 512, h: 512, size: 111301, mtime: 1792339941959, sha: "0cc6b02712da" },
    fawang: { box: [32, 51, 479, 493], ratio: 0.5205, w: 512, h: 512, size: 93370, mtime: 1792339944175, sha: "7081fa895e3e" },
    ge: { box: [32, 54, 479, 493], ratio: 0.4924, w: 512, h: 512, size: 97181, mtime: 1792339945464, sha: "05a561c3c821" },
    kun: { box: [32, 48, 479, 493], ratio: 0.4929, w: 512, h: 512, size: 98027, mtime: 1792339941617, sha: "8533cd3940dd" },
    liulaoshi: { box: [32, 54, 479, 493], ratio: 0.5165, w: 512, h: 512, size: 114543, mtime: 1792339944596, sha: "9a6222d4ad11" },
    oligei: { box: [32, 54, 479, 493], ratio: 0.4826, w: 512, h: 512, size: 94877, mtime: 1792339943806, sha: "2f96b327e29b" },
    sunge: { box: [32, 54, 479, 493], ratio: 0.4931, w: 512, h: 512, size: 86984, mtime: 1792339942741, sha: "7e3d0936eef6" },
    yingma: { box: [32, 54, 479, 493], ratio: 0.4856, w: 512, h: 512, size: 78476, mtime: 1792339943436, sha: "1e27541479b9" },
    zhenxiang: { box: [32, 54, 479, 493], ratio: 0.4828, w: 512, h: 512, size: 104085, mtime: 1792339945885, sha: "89f72fc61cfd" },
  };
  const ROOT_BOX_FALLBACK = [31, 53, 480, 493];   // 未列入 ROOT_TEX 的兜底贴图
  const FX_META = {"aoe_warn":[512,512],"boom":[256,256],"crit":[256,256],"glitch":[256,256],"impact":[256,192],"ring":[256,256],"shadow":[256,128],"slash":[256,128],"slash_arc":[256,256],"spark":[128,128],"star":[128,128]};
  const SHEET_META = {"bg":{"arena.png":[1280,720],"jar_top.png":[1280,720],"menu.png":[1280,720]},"ui":{"paused.png":[512,256]}};
  // <<<TEX_META_END>>>

  const MIN_USABLE = 0.05;   // 非透明占比下限（低于此值视为退化贴图，继续回退）

  // 特效键（顺序即加载顺序；尺寸从生成表里取，缺失时退回 128×128）
  const FX_KEYS = ['slash', 'slash_arc', 'boom', 'spark', 'ring', 'star', 'impact', 'glitch', 'aoe_warn', 'shadow', 'crit'];

  // 背景：记录实测几何，供渲染层把画面元素映射到世界平面
  // （几何来自 tools/_rendercheck/measure4.ps1 的亮度行剖面，非 alpha；尺寸由 gen_tex_meta.js 复核）
  const BG_META = {
    arena:   { size: [1280, 720], floor: [12, 96, 1268, 666] },   // 地面椭圆 bbox
    jar_top: { size: [1280, 720], ring: [0, 133, 1280, 719] },    // 蛐蛐罐口椭圆环 bbox
    menu:    { size: [1280, 720], sky: [0, 0, 1280, 400] },      // 只取天际线以上（不含下方月亮/地面椭圆）
  };

  // ---------------------------------------------------------------- 实例池
  const pool = {};                 // key → entry
  const info = { cached: false, source: 'missing' };

  function createCanvas(w, h) {
    try {
      if (hasDoc && document.createElement) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
      }
      if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    } catch (e) { /* 降级 */ }
    return null;
  }

  function makeImage(path) {
    try {
      if (typeof Image === 'function') { const im = new Image(); return im; }
      if (hasDoc && document.createElement) return document.createElement('img');
    } catch (e) { /* 降级 */ }
    return null;
  }

  function unitName(id) {
    const f = CC.fighters;
    const u = f && f.get ? f.get(id) : null;
    return (u && u.name) || id;
  }
  function unitPalette(id) {
    const f = CC.fighters;
    const u = f && f.get ? f.get(id) : null;
    if (u && u.palette && u.palette.length) return u.palette;
    // 无 fighters 时按 id 散列出稳定颜色
    const h = (U.hashParts ? U.hashParts([id]) : 0x9e3779b9) >>> 0;
    const hue = h % 360;
    return ['hsl(' + hue + ',72%,62%)', 'hsl(' + ((hue + 40) % 360) + ',46%,17%)'];
  }

  // ---- 程序化占位块（渐变圆角块 + 名字首字），无 Canvas 环境返回 null ----
  const placeholderCache = {};
  function makePlaceholder(key) {
    if (placeholderCache[key] !== undefined) return placeholderCache[key];
    const cv = createCanvas(192, 208);
    let out = null;
    if (cv) {
      let g = null;
      try { g = cv.getContext('2d'); } catch (e) { g = null; }
      if (g) {
        const pal = unitPalette(key);
        const main = pal[0] || '#7fe3ff', dark = pal[1] || '#12232e';
        try {
          if (g.createLinearGradient) {
            const grad = g.createLinearGradient(0, 0, 0, 208);
            grad.addColorStop(0, main); grad.addColorStop(1, dark);
            g.fillStyle = grad;
          } else { g.fillStyle = main; }
          if (g.roundRect) { g.beginPath(); g.roundRect(6, 6, 180, 196, 18); g.fill(); }
          else { g.fillRect(6, 6, 180, 196); }
          g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3;
          if (g.stroke) { if (g.roundRect) { g.beginPath(); g.roundRect(6, 6, 180, 196, 18); g.stroke(); } else { g.strokeRect(6, 6, 180, 196); } }
          // 名字首字
          const nm = unitName(key) || key;
          const ch = String(nm).slice(0, 1);
          g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(6, 148, 180, 54);
          g.fillStyle = '#ffffff';
          g.font = 'bold 92px "PingFang SC","Microsoft YaHei",sans-serif';
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.fillText(ch, 96, 116);
          g.font = 'bold 22px "PingFang SC","Microsoft YaHei",sans-serif';
          g.fillStyle = 'rgba(255,255,255,0.92)';
          g.fillText(String(nm).length > 6 ? String(nm).slice(0, 6) : String(nm), 96, 176);
        } catch (e) { /* 画不出来也不抛 */ }
        out = cv;
      }
    }
    placeholderCache[key] = out;
    return out;
  }

  // ---- 白化变体（受击闪白用；首次需要时才生成并缓存）----
  const flashCache = {};
  function flashVariant(key) {
    if (flashCache[key] !== undefined) return flashCache[key];
    flashCache[key] = null;
    const e = pool[key];
    const img = e && e.state === 'ready' ? e.img : null;
    const w = (img && (img.naturalWidth || img.width)) || 0;
    const h = (img && (img.naturalHeight || img.height)) || 0;
    if (img && w && h) {
      const cv = createCanvas(w, h);
      let g = null;
      if (cv) { try { g = cv.getContext('2d'); } catch (err) { g = null; } }
      if (g) {
        try {
          g.drawImage(img, 0, 0, w, h);
          if ('globalCompositeOperation' in g) g.globalCompositeOperation = 'source-atop';
          g.fillStyle = 'rgba(255,255,255,0.9)';
          g.fillRect(0, 0, w, h);
          if ('globalCompositeOperation' in g) g.globalCompositeOperation = 'source-over';
          flashCache[key] = cv;
        } catch (e2) { flashCache[key] = null; }
      }
    }
    return flashCache[key];
  }

  // ---------------------------------------------------------------- 注册
  function registerUnit(id) {
    pool[id] = {
      key: id, kind: 'unit',
      // 查找顺序：meme 抠图 → 程序化兜底 → 运行时占位块（占位块不需要网络请求）
      candidates: [
        { path: BASE + 'units/meme/' + id + '.png', source: 'meme' },
        { path: BASE + 'units/' + id + '.png', source: 'fallback' },
      ],
      img: null, state: 'pending', usedPath: null, source: 'missing', rejected: [],
      box: null, ratio: undefined, measured: null, table: null, metaSource: 'pending',
    };
  }
  function registerFx(key) {
    pool[key] = {
      key: key, kind: 'fx',
      candidates: [{ path: BASE + 'fx/' + key + '.png', source: 'fx' }],
      img: null, state: 'pending', usedPath: null, source: 'missing', rejected: [],
    };
  }
  function registerBg(key) {
    pool[key] = {
      key: key, kind: 'bg',
      candidates: [{ path: BASE + 'bg/' + key + '.png', source: 'bg' }],
      img: null, state: 'pending', usedPath: null, source: 'missing', rejected: [],
    };
  }
  function registerUi(key) {
    pool[key] = {
      key: key, kind: 'ui',
      candidates: [{ path: BASE + 'ui/' + key + '.png', source: 'ui' }],
      img: null, state: 'pending', usedPath: null, source: 'missing', rejected: [],
    };
  }

  UNIT_IDS.forEach(registerUnit);
  FX_KEYS.forEach(registerFx);
  ['arena', 'jar_top', 'menu'].forEach(registerBg);
  ['paused'].forEach(registerUi);

  // ---------------------------------------------------------------- 载入
  // 元数据来源优先级：
  //   1) 运行时按真实像素测量（浏览器 / 有 getImageData 的环境）—— 重抠贴图后永不失效
  //   2) 生成表 MEME_TEX / ROOT_TEX（无 Canvas 的无头测试环境）
  //   3) 全尺寸兜底（0,0,w-1,h-1）
  const META = {
    mode: 'table',        // 'measured' | 'table'
    measured: 0,          // 已按像素测量的贴图数
    zeroProxy: 0,         // 「读出来全透明、但表里明明非空」的个数（用于识别桩环境）
    decided: false,
    stamp: TEX_META_STAMP,
    staleNote: null,
  };

  /** 按真实像素测量：box = alpha>64 包围盒，ratio = alpha>16 占比（与 tests/_loader 同口径） */
  function measureAlpha(img, w0, h0) {
    const w = w0 || img.naturalWidth || img.width || 0;
    const h = h0 || img.naturalHeight || img.height || 0;
    if (!w || !h) return null;
    const cv = createCanvas(w, h);
    if (!cv) return null;
    let g = null;
    try { g = cv.getContext('2d'); } catch (e) { g = null; }
    if (!g || typeof g.drawImage !== 'function' || typeof g.getImageData !== 'function') return null;
    let data = null;
    try {
      if (g.clearRect) g.clearRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      const im = g.getImageData(0, 0, w, h);
      data = im && im.data;
    } catch (e) { return null; }   // 跨域污染 / 桩环境
    if (!data || data.length < 4) return null;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, inBox = 0, opaque = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const a = data[(row + x) * 4 + 3];
        if (a > 16) opaque++;
        if (a > 64) {
          inBox++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    return {
      ratio: opaque / (w * h),
      box: inBox ? { x0: x0, y0: y0, x1: x1, y1: y1 } : null,
      empty: inBox === 0,
    };
  }

  /** 表里的声明值（可能是旧数据 → 只作降级用） */
  function tableMeta(entry, cand) {
    if (entry.kind !== 'unit') return null;
    const t = cand.source === 'meme' ? MEME_TEX[entry.key] : ROOT_TEX[entry.key];
    if (!t) return cand.source === 'meme' ? null : { box: ROOT_BOX_FALLBACK, ratio: null };
    return { box: t.box, ratio: t.ratio, size: t.size, mtime: t.mtime, sha: t.sha };
  }

  /** 测量 → 采纳/否定的决策：桩环境读回全零，必须识别出来并回退到表 */
  function applyMeasurement(entry, m) {
    const t = entry.table;
    const looksBlank = !m.box || m.box === null || m.ratio <= 0.000001;
    const tableSaysContent = !!(t && (t.ratio === null || t.ratio === undefined || t.ratio > 0.1));
    if (!META.decided) {
      // 首次测量即定调：读回全透明但表里非空 → canvas 读回不可信（打桩环境/跨域污染）
      META.decided = true;
      if (looksBlank && tableSaysContent) {
        META.mode = 'table';
        META.zeroProxy++;
        META.staleNote = 'pixel-readback-untrusted';
        adoptTableMetaAll();
        return false;
      }
      META.mode = 'measured';
    }
    if (META.mode === 'table') {
      if (looksBlank && tableSaysContent) META.zeroProxy++;
      return false;
    }
    entry.measured = { box: m.box, ratio: Math.round(m.ratio * 10000) / 10000 };
    entry.ratio = entry.measured.ratio;
    entry.box = m.box || fullBox(entry);
    entry.metaSource = 'measured';
    META.measured++;
    return true;
  }

  function fullBox(entry) {
    const w = entry.imgW || 0, h = entry.imgH || 0;
    return { x0: 0, y0: 0, x1: Math.max(0, w - 1), y1: Math.max(0, h - 1) };
  }

  /** 统一按当前 mode 采纳 box/ratio（表模式会覆盖掉已测量的值） */
  function adoptTableMetaAll() {
    Object.keys(pool).forEach(function (k) {
      const e = pool[k];
      if (e.kind !== 'unit' || e.state !== 'ready') return;
      if (META.mode === 'table') {
        const t = e.table;
        e.box = (t && t.box) ? { x0: t.box[0], y0: t.box[1], x1: t.box[2], y1: t.box[3] } : fullBox(e);
        e.ratio = (t && t.ratio !== null && t.ratio !== undefined) ? t.ratio : (e.measured ? e.measured.ratio : null);
        e.metaSource = 'table';
      } else if (e.measured) {
        e.box = e.measured.box || fullBox(e);
        e.ratio = e.measured.ratio;
        e.metaSource = 'measured';
      }
    });
  }

  function ratioOf(entry) {
    if (entry.ratio !== undefined && entry.ratio !== null) return entry.ratio;
    const t = entry.table;
    return (t && t.ratio !== null && t.ratio !== undefined) ? t.ratio : null;
  }

  function candidateUsable(entry, cand) {
    if (entry.kind !== 'unit') return true;
    // 只在「已经确知退化」时跳过候选；未知（未测量、表里也没数据）一律先试
    const m = tableMeta(entry, cand);
    const ratio = (entry.ratio !== undefined && entry.ratio !== null) ? entry.ratio : (m ? m.ratio : null);
    if (cand.source === 'meme' && ratio !== null && ratio < MIN_USABLE) return false;   // 实测抠图几乎空白
    return true;
  }

  function boxFor(entry, cand) {
    if (entry.kind !== 'unit') return null;
    const m = tableMeta(entry, cand);
    if (entry.metaSource === 'measured' && entry.measured && entry.measured.box) return entry.measured.box;
    if (m && m.box) return { x0: m.box[0], y0: m.box[1], x1: m.box[2], y1: m.box[3] };
    return fullBox(entry);
  }

  function loadEntry(entry, done) {
    let i = 0;
    const next = () => {
      if (i >= entry.candidates.length) {
        entry.state = 'missing';
        entry.source = 'missing';
        entry.usedPath = null;
        makePlaceholder(entry.key);
        done();
        return;
      }
      const cand = entry.candidates[i++];
      if (!candidateUsable(entry, cand)) {
        entry.rejected.push({ path: cand.path, reason: 'degenerate-texture' });
        next();
        return;
      }
      const img = makeImage(cand.path);
      if (!img || typeof img.src === 'undefined') {
        entry.rejected.push({ path: cand.path, reason: 'no-image-support' });
        next();
        return;
      }
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          entry.img = img; entry.imgW = w; entry.imgH = h;
          entry.usedPath = cand.path; entry.source = cand.source; entry.state = 'ready';
          entry.table = tableMeta(entry, cand);
          if (entry.table && entry.table.ratio !== null && entry.table.ratio !== undefined && entry.ratio === undefined) {
            entry.ratio = entry.table.ratio;
          }
          // 先按真实像素测；桩环境读回全零会被 applyMeasurement 否掉并回退到表
          const m = (w && h && META.mode !== 'table') ? measureAlpha(img, w, h) : null;
          let adopted = false;
          if (m) adopted = applyMeasurement(entry, m);
          if (!adopted) {
            entry.box = boxFor(entry, cand);
            entry.metaSource = META.mode === 'measured' ? 'measured' : 'table';
          } else {
            entry.box = entry.box || boxFor(entry, cand);
          }
          flashCache[entry.key] = undefined;
          done();
        } else {
          entry.rejected.push({ path: cand.path, reason: 'load-error' });
          next();
        }
      };
      try {
        img.onload = () => finish(true);
        img.onerror = () => finish(false);
        img.src = cand.path;
      } catch (e) {
        entry.rejected.push({ path: cand.path, reason: 'assign-error' });
        next();
      }
    };
    next();
  }

  // ---------------------------------------------------------------- 音频
  const VOL = { master: 0.9, sfx: 1, music: 0.7 };
  const AUD = {
    ctx: null, masterGain: null, sfxGain: null, musicGain: null,
    samples: {}, missing: {}, decoded: 0, failed: 0, enabled: false,
    noiseBuf: null, musicState: null, musicTimer: null, synthCount: 0, fileCount: 0,
    paused: false,
  };

  // 合成配方：{ 波形, 起始/结束频率, 时长, 音量, 噪声比, 扫频曲线 }
  const RECIPES = {
    hit_light:   { type: 'square',   f0: 920,  f1: 430, dur: 0.07, gain: 0.22 },
    hit_heavy:   { type: 'square',   f0: 520,  f1: 150, dur: 0.14, gain: 0.3, noise: 0.25 },
    crit:        { type: 'sawtooth', f0: 1500, f1: 170, dur: 0.24, gain: 0.34, noise: 0.3 },
    ko:          { type: 'sine',     f0: 430,  f1: 46,  dur: 0.9,  gain: 0.38, noise: 0.2 },
    skill_cast:  { type: 'triangle', f0: 280,  f1: 990, dur: 0.16, gain: 0.22 },
    ult_release: { type: 'sawtooth', f0: 130,  f1: 34,  dur: 1.15, gain: 0.4, noise: 0.55 },
    ui_click:    { type: 'square',   f0: 1280, f1: 1280, dur: 0.035, gain: 0.16 },
    ui_hover:    { type: 'sine',     f0: 880,  f1: 1180, dur: 0.04, gain: 0.1 },
    place:       { type: 'triangle', f0: 620,  f1: 1240, dur: 0.12, gain: 0.24 },
    spawn:       { type: 'triangle', f0: 420,  f1: 1250, dur: 0.22, gain: 0.26, noise: 0.15 },
    summon:      { type: 'sawtooth', f0: 240,  f1: 760, dur: 0.3, gain: 0.22 },
    dash:        { type: 'sawtooth', f0: 760,  f1: 120, dur: 0.2, gain: 0.24, noise: 0.35 },
    whoosh:      { type: 'sawtooth', f0: 1200, f1: 240, dur: 0.16, gain: 0.18, noise: 0.5 },
    explode:     { type: 'sawtooth', f0: 320,  f1: 40,  dur: 0.55, gain: 0.36, noise: 0.6 },
    heal:        { type: 'sine',     f0: 660,  f1: 1320, dur: 0.3, gain: 0.2 },
    buff:        { type: 'triangle', f0: 380,  f1: 820, dur: 0.24, gain: 0.18 },
    aoe_warn:    { type: 'square',   f0: 300,  f1: 300, dur: 0.18, gain: 0.12 },
    start:       { type: 'square',   f0: 520,  f1: 1560, dur: 0.34, gain: 0.26 },
    charge:      { type: 'triangle', f0: 220,  f1: 620,  dur: 0.42, gain: 0.16 },
    ult_charge:  { type: 'sawtooth', f0: 90,   f1: 520,  dur: 1.3,  gain: 0.24, noise: 0.18 },
    block:       { type: 'square',   f0: 640,  f1: 120,  dur: 0.22, gain: 0.3, noise: 0.45 },
    level_up:    { type: 'triangle', f0: 520,  f1: 1760, dur: 0.5, gain: 0.28 },
    win:         { type: 'triangle', f0: 620,  f1: 1240, dur: 0.7, gain: 0.3 },
    lose:        { type: 'sine',     f0: 400,  f1: 120, dur: 0.9, gain: 0.3 },
    default:     { type: 'square',   f0: 700,  f1: 500, dur: 0.08, gain: 0.16 },
  };
  const SFX_NAMES = Object.keys(RECIPES);

  function audioCtx() {
    if (AUD.ctx) return AUD.ctx;
    if (AUD.disabled) return null;
    try {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof AC !== 'function') { AUD.disabled = true; return null; }
      const ctx = new AC();
      AUD.ctx = ctx;
      AUD.enabled = true;
      AUD.masterGain = ctx.createGain();
      AUD.masterGain.gain.value = VOL.master;
      AUD.masterGain.connect(ctx.destination);
      AUD.sfxGain = ctx.createGain();
      AUD.sfxGain.gain.value = VOL.sfx;
      AUD.sfxGain.connect(AUD.masterGain);
      AUD.musicGain = ctx.createGain();
      AUD.musicGain.gain.value = VOL.music;
      AUD.musicGain.connect(AUD.masterGain);
      return ctx;
    } catch (e) {
      AUD.disabled = true;
      AUD.ctx = null;
      return null;
    }
  }

  function noiseBuffer(ctx) {
    if (AUD.noiseBuf) return AUD.noiseBuf;
    try {
      const len = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      const rng = U.RNG ? U.RNG(0x5eed1e) : null;
      for (let i = 0; i < len; i++) {
        const r = rng ? rng.next() : ((i * 1103515245 + 12345) % 65536) / 65536;
        d[i] = (r * 2 - 1) * (1 - i / len);
      }
      AUD.noiseBuf = buf;
      return buf;
    } catch (e) { return null; }
  }

  function synth(name, opts) {
    const ctx = audioCtx();
    if (!ctx) return null;
    const rc = RECIPES[name] || RECIPES.default;
    const o = opts || {};
    const now = ctx.currentTime;
    const vol = (rc.gain || 0.2) * (o.vol === undefined ? 1 : o.vol);
    try {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = rc.type || 'square';
      const rate = o.rate || 1;
      osc.frequency.setValueAtTime(Math.max(20, rc.f0 * rate), now);
      try {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, rc.f1 * rate), now + rc.dur);
      } catch (e1) { osc.frequency.value = rc.f1 * rate; }
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), now + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + rc.dur);
      osc.connect(g); g.connect(AUD.sfxGain || AUD.masterGain || ctx.destination);
      osc.start(now); osc.stop(now + rc.dur + 0.02);
      if (rc.noise) {
        const nb = noiseBuffer(ctx);
        if (nb) {
          const src = ctx.createBufferSource(); src.buffer = nb;
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(vol * rc.noise, now);
          ng.gain.exponentialRampToValueAtTime(0.0001, now + rc.dur * 0.9);
          src.connect(ng); ng.connect(AUD.sfxGain || ctx.destination);
          src.start(now); src.stop(now + Math.min(0.5, rc.dur));
        }
      }
      AUD.synthCount++;
      return { kind: 'synth', name: name };
    } catch (e) {
      return null;
    }
  }

  function canFetchSample() {
    return hasWin && typeof fetch === 'function' && !AUD.disabled;
  }

  function fetchSample(name, url, cb) {
    if (AUD.samples[name] || AUD.missing[name]) { cb(AUD.samples[name] || null); return; }
    if (!canFetchSample()) { AUD.missing[name] = true; cb(null); return; }
    let done = false;
    const fin = (buf) => {
      if (done) return; done = true;
      if (buf) { AUD.samples[name] = buf; AUD.decoded++; } else { AUD.missing[name] = true; AUD.failed++; }
      cb(buf || null);
    };
    try {
      fetch(url).then((res) => {
        if (!res || !res.ok) throw new Error('http ' + (res && res.status));
        return res.arrayBuffer();
      }).then((ab) => {
        const ctx = audioCtx();
        if (!ctx || !ctx.decodeAudioData) { fin(null); return; }
        let settled = false;
        const ok = (buf) => { if (!settled) { settled = true; fin(buf); } };
        const bad = () => { if (!settled) { settled = true; fin(null); } };
        try {
          const pr = ctx.decodeAudioData(ab, ok, bad);
          if (pr && typeof pr.then === 'function') pr.then(ok, bad);
        } catch (e) { bad(); }
      }).catch(() => fin(null));
    } catch (e) { fin(null); }
  }

  function playSample(buf, opts) {
    const ctx = audioCtx();
    if (!ctx || !buf) return null;
    const o = opts || {};
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (o.rate) src.playbackRate.value = o.rate;
      const g = ctx.createGain();
      const vol = (o.vol === undefined ? 1 : o.vol) * VOL.sfx;
      g.gain.value = vol;
      src.connect(g); g.connect(AUD.sfxGain || AUD.masterGain || ctx.destination);
      src.start(0);
      AUD.fileCount++;
      return { kind: 'file', src: src };
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- 导出对象
  function texture(key) {
    const e = pool[key];
    if (!e || e.state !== 'ready' || !e.img) return null;
    return e.img;
  }

  function asset(key) {
    // 通用取图：贴图已就绪返回 Image，否则 null（渲染层自己画占位/矢量兜底）
    return texture(key);
  }

  function textureInfo(key) {
    const e = pool[key];
    if (!e) return { key: key, usedPath: null, source: 'missing', ok: false, reason: 'unknown-key', box: null, ratio: null, metaSource: 'none' };
    return {
      key: key,
      usedPath: e.usedPath,
      source: e.source,       // 'meme' | 'fallback' | 'fx' | 'bg' | 'ui' | 'missing'
      ok: e.state === 'ready',
      kind: e.kind,
      width: e.imgW || 0,
      height: e.imgH || 0,
      box: e.box ? { x0: e.box.x0, y0: e.box.y0, x1: e.box.x1, y1: e.box.y1 } : null,
      ratio: (e.ratio === undefined ? null : e.ratio),
      metaSource: e.metaSource || 'pending',   // 'measured' | 'table' | 'pending'
      rejected: e.rejected.slice(),
    };
  }

  /** 贴图元数据自检：来源（像素实测 / 生成表）、被拒绝的候选、生成表时间戳 */
  function texMeta() {
    return {
      mode: META.mode, measured: META.measured, zeroProxy: META.zeroProxy,
      decided: META.decided, stamp: META.stamp, note: META.staleNote,
      table: { meme: Object.keys(MEME_TEX), root: Object.keys(ROOT_TEX), fx: Object.keys(FX_META) },
      units: UNIT_IDS.map(function (id) {
        const e = pool[id] || {};
        return {
          id: id, source: e.source || 'pending', metaSource: e.metaSource || 'pending',
          ratio: e.ratio === undefined ? null : e.ratio, box: e.box || null,
          usedPath: e.usedPath || null,
        };
      }),
    };
  }

  function contentBox(key) {
    const e = pool[key];
    if (e && e.box) return e.box;
    const w = (e && e.imgW) || 0, h = (e && e.imgH) || 0;
    return { x0: 0, y0: 0, x1: Math.max(0, w - 1), y1: Math.max(0, h - 1), w: w, h: h };
  }

  function placeholder(key) {
    if (key === undefined) return null;
    if (placeholderCache[key] === undefined) makePlaceholder(key);
    return placeholderCache[key] || null;
  }

  function flash(key) { return flashVariant(key); }

  let loadPromise = null;
  function load() {
    // 幂等：重复调用返回同一个 Promise（外壳可以先 fire-and-forget，之后再 await）
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      const keys = Object.keys(pool);
      let left = keys.length;
      let settled = false;
      const all = [];
      const finish = (why) => {
        if (settled) return;
        settled = true;
        info.cached = true;
        info.source = why;
        auditMetaAgainstTable();
        if (AUD.pendingMusic !== undefined && AUD.pendingMusic !== null) {
          const nm = AUD.pendingMusic; AUD.pendingMusic = null; music(nm);
        }
        resolve(stats());
      };
      if (!left) { finish('empty'); return; }
      keys.forEach((k) => {
        all.push(new Promise((done) => loadEntry(pool[k], done)));
      });
      // 超时兜底：任何一个请求卡住也不能卡住开机（无头环境立即走完）
      const timer = (typeof setTimeout === 'function')
        ? setTimeout(() => finish('timeout'), hasWin ? 6000 : 0)
        : null;
      Promise.all(all).then(() => {
        if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
        finish(hasWin ? 'loaded' : 'headless');
      }).catch(() => {
        if (timer && typeof clearTimeout === 'function') clearTimeout(timer);
        finish('error');
      });
    });
    return loadPromise;
  }

  /** 贴图全部就绪？外壳可在开画前 await，避免首帧画成占位块 */
  function whenReady() {
    return load();
  }

  function stats() {
    const out = { total: 0, ready: 0, missing: 0, bySource: {}, byKind: {} };
    Object.keys(pool).forEach((k) => {
      const e = pool[k];
      out.total++;
      if (e.state === 'ready') out.ready++; else out.missing++;
      out.bySource[e.source] = (out.bySource[e.source] || 0) + 1;
      if (!out.byKind[e.kind]) out.byKind[e.kind] = { ready: 0, total: 0 };
      out.byKind[e.kind].total++;
      if (e.state === 'ready') out.byKind[e.kind].ready++;
    });
    return out;
  }

  /** 生成表 vs 实测像素的偏差审计：表过期在浏览器里会立刻暴露（写进 texMeta().note） */
  function auditMetaAgainstTable() {
    if (META.mode !== 'measured') return;
    const drift = [];
    UNIT_IDS.forEach(function (id) {
      const e = pool[id];
      if (!e || e.state !== 'ready' || e.metaSource !== 'measured') return;
      const t = e.source === 'meme' ? MEME_TEX[id] : ROOT_TEX[id];
      if (!t || !t.box) return;
      const b = e.measured.box;
      const boxDiff = b ? (Math.abs(b.x0 - t.box[0]) > 4 || Math.abs(b.y0 - t.box[1]) > 4 ||
        Math.abs(b.x1 - t.box[2]) > 4 || Math.abs(b.y1 - t.box[3]) > 4) : true;
      const ratioDiff = t.ratio === null || t.ratio === undefined ? false : Math.abs(t.ratio - e.measured.ratio) > 0.02;
      if (boxDiff || ratioDiff) {
        drift.push({ id: id, tableBox: t.box, measuredBox: b ? [b.x0, b.y0, b.x1, b.y1] : null, tableRatio: t.ratio, measuredRatio: e.measured.ratio });
      }
    });
    if (drift.length) {
      META.drift = drift;
      META.staleNote = 'table-stale:' + drift.length + '（贴图被重抠 → 运行 node tools/_rendercheck/gen_tex_meta.js 重算）';
    } else {
      META.drift = [];
    }
  }

  function failedList() {
    const out = [];
    Object.keys(pool).forEach((k) => {
      const e = pool[k];
      if (e.state !== 'ready') out.push({ key: k, kind: e.kind, rejected: e.rejected.slice() });
    });
    return out;
  }

  // ---------------------------------------------------------------- 音频出口
  function play(name, opts) {
    const o = opts || {};
    try {
      if (AUD.paused) return null;
      const url = BASE + 'sfx/' + name + '.wav';
      const buf = AUD.samples[name];
      if (buf) return playSample(buf, o);
      if (!AUD.missing[name] && canFetchSample()) {
        // 先用振荡器顶上，文件到货后自动切到采样
        const s = synth(name, o);
        fetchSample(name, url, () => { });
        return s;
      }
      return synth(name, o);
    } catch (e) { return null; }
  }

  function playVoice(unitId, opts) {
    try {
      if (AUD.paused) return null;
      const key = 'voice_' + unitId;
      if (AUD.samples[key]) return playSample(AUD.samples[key], opts);
      if (!AUD.missing[key] && canFetchSample()) {
        fetchSample(key, BASE + 'sfx/voice_' + unitId + '.wav', () => { });
      }
      return null;   // 人声缺文件静默
    } catch (e) { return null; }
  }

  function playSkill(unitId, slot, opts) {
    try {
      if (AUD.paused) return null;
      const s = String(slot === undefined || slot === null ? '1' : slot);
      const norm = (s === 's1' ? '1' : s === 's2' ? '2' : s === 'ult' ? 'ult' : s);
      const key = 'skill_' + unitId + '_' + norm;
      if (AUD.samples[key]) return playSample(AUD.samples[key], opts);
      if (!AUD.missing[key] && canFetchSample()) {
        fetchSample(key, BASE + 'sfx/skill_' + unitId + '_' + norm + '.wav', () => { });
      }
      return null;   // 技能音缺文件静默（表现层另有 skill_cast 合成音）
    } catch (e) { return null; }
  }

  // ---- 合成 BGM：小调琶音循环（wav 缺失时兜底）----
  const MUSIC_PATTERNS = {
    bgm_battle_loop: { root: 110.00, steps: [0, 3, 7, 10, 12, 10, 7, 3], step: 0.22, gain: 0.10, wave: 'triangle' },
    bgm_menu_loop:   { root: 82.41,  steps: [0, 7, 12, 7],             step: 0.42, gain: 0.08, wave: 'sine' },
    default:         { root: 98.00,  steps: [0, 5, 7, 12],             step: 0.3,  gain: 0.08, wave: 'triangle' },
  };

  function startSynthMusic(name) {
    const ctx = audioCtx();
    if (!ctx) return null;
    const pat = MUSIC_PATTERNS[name] || MUSIC_PATTERNS.default;
    const state = { name: name, i: 0, timer: null, synth: true };
    const tick = () => {
      if (AUD.paused) return;
      const c = audioCtx();
      if (!c) return;
      try {
        const semi = pat.steps[state.i % pat.steps.length];
        const f = pat.root * Math.pow(2, semi / 12);
        const now = c.currentTime;
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = pat.wave;
        osc.frequency.setValueAtTime(f, now);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(pat.gain, now + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + pat.step * 1.8);
        osc.connect(g); g.connect(AUD.musicGain || AUD.masterGain || c.destination);
        osc.start(now); osc.stop(now + pat.step * 2);
      } catch (e) { /* 静默 */ }
      state.i++;
    };
    try {
      tick();
      if (typeof setInterval === 'function') state.timer = setInterval(tick, Math.max(120, pat.step * 1000));
    } catch (e) { /* 静默 */ }
    AUD.musicState = state;
    return state;
  }

  function stopMusic() {
    const st = AUD.musicState;
    if (st) {
      if (st.timer && typeof clearInterval === 'function') clearInterval(st.timer);
      if (st.src) { try { st.src.stop(); } catch (e) { /* 已停 */ } }
    }
    AUD.musicState = null;
    return null;
  }

  function music(name) {
    try {
      if (!name) return stopMusic();
      if (name === 'none') return stopMusic();
      if (AUD.musicState && AUD.musicState.name === name) return AUD.musicState;
      stopMusic();
      if (!AUD.ctx && !audioCtx()) { AUD.pendingMusic = name; return null; }
      const key = 'music_' + name;
      if (AUD.samples[key]) return { name: name, kind: 'file' };
      if (!AUD.missing[key] && canFetchSample()) {
        fetchSample(key, BASE + 'music/' + name + '.wav', () => { });
      }
      return startSynthMusic(name);
    } catch (e) { return null; }
  }

  function setVolume(v) {
    const o = v || {};
    try {
      if (o.master !== undefined) VOL.master = Math.max(0, Math.min(1, o.master));
      if (o.sfx !== undefined) VOL.sfx = Math.max(0, Math.min(1, o.sfx));
      if (o.music !== undefined) VOL.music = Math.max(0, Math.min(1, o.music));
      if (AUD.masterGain) AUD.masterGain.gain.value = VOL.master;
      if (AUD.sfxGain) AUD.sfxGain.gain.value = VOL.sfx;
      if (AUD.musicGain) AUD.musicGain.gain.value = VOL.music;
    } catch (e) { /* 静默 */ }
    return { master: VOL.master, sfx: VOL.sfx, music: VOL.music };
  }

  function pauseAll() {
    AUD.paused = true;
    try { if (AUD.ctx && AUD.ctx.state === 'running' && AUD.ctx.suspend) AUD.ctx.suspend(); } catch (e) { /* 静默 */ }
    return true;
  }
  function resumeAll() {
    AUD.paused = false;
    try {
      if (!AUD.ctx) audioCtx();
      if (AUD.ctx && AUD.ctx.state === 'suspended' && AUD.ctx.resume) AUD.ctx.resume();
    } catch (e) { /* 静默 */ }
    return true;
  }
  function sfxReady() {
    return !!(AUD.ctx || AUD.decoded > 0);
  }

  function audioInfo() {
    return {
      webAudio: !!AUD.ctx,
      enabled: AUD.enabled,
      decodedSamples: AUD.decoded,
      failedSamples: AUD.failed,
      synthPlays: AUD.synthCount,
      filePlays: AUD.fileCount,
      missing: Object.keys(AUD.missing),
      volumes: { master: VOL.master, sfx: VOL.sfx, music: VOL.music },
      music: AUD.musicState ? AUD.musicState.name : null,
    };
  }

  CC.assets = {
    // 契约接口
    load: load,
    whenReady: whenReady,      // 同 load()（幂等），外壳可 await 后再开画，避免首帧画成占位块
    texture: texture,
    textureInfo: textureInfo,
    sfxReady: sfxReady,
    play: play,
    playVoice: playVoice,
    playSkill: playSkill,
    music: music,
    setVolume: setVolume,
    pauseAll: pauseAll,
    resumeAll: resumeAll,
    // 渲染/UI 用到的附加接口（不影响契约）
    asset: asset,
    placeholder: placeholder,
    flash: flash,
    contentBox: contentBox,
    fxSize: function (key) { return FX_META[key] || [128, 128]; },
    bgMeta: BG_META,
    sheetMeta: function () { return SHEET_META; },
    unitIds: UNIT_IDS.slice(),
    fxKeys: FX_KEYS.slice(),
    sfxNames: SFX_NAMES.slice(),
    base: BASE,
    setBase: function (b) {
      // 仅供测试/换目录用：改基址并重建候选路径
      BASE = String(b || 'assets/');
      if (BASE.charAt(BASE.length - 1) !== '/') BASE += '/';
      Object.keys(pool).forEach(function (k) {
        const e = pool[k];
        if (e.kind === 'unit') {
          e.candidates = [
            { path: BASE + 'units/meme/' + k + '.png', source: 'meme' },
            { path: BASE + 'units/' + k + '.png', source: 'fallback' },
          ];
        } else if (e.kind === 'fx') e.candidates = [{ path: BASE + 'fx/' + k + '.png', source: 'fx' }];
        else if (e.kind === 'bg') e.candidates = [{ path: BASE + 'bg/' + k + '.png', source: 'bg' }];
        else if (e.kind === 'ui') e.candidates = [{ path: BASE + 'ui/' + k + '.png', source: 'ui' }];
      });
      return BASE;
    },
    ready: function (key) { const e = pool[key]; return !!(e && e.state === 'ready'); },
    stats: stats,
    failed: failedList,
    texMeta: texMeta,
    audio: audioInfo,
    pools: pool,
  };
})();
