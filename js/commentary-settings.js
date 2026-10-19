/* 录像页的本机配置：只有用户选择保存时才写入当前站点的 localStorage。 */
(function () {
  'use strict';
  const STORAGE_KEY = 'cyber-cricket-commentary-config-v1';
  const FIELDS = [
    ['preset', 'commentary-preset', 20],
    ['baseUrl', 'commentary-base', 2048],
    ['model', 'commentary-model', 200],
    ['apiKey', 'commentary-key', 8192],
    ['speechBaseUrl', 'speech-base', 2048],
    ['speechModel', 'speech-model', 200],
    ['speechVoice', 'speech-voice', 100],
    ['speechSpeed', 'speech-speed', 16],
    ['speechApiKey', 'speech-key', 8192],
  ];
  const KEYS = new Set(['version', 'reuseKey', ...FIELDS.map((field) => field[0])]);
  let mounted = false;

  function mount() {
    if (mounted) return;
    const get = (id) => document.getElementById(id);
    const form = get('export-form'), remember = get('commentary-remember');
    const saveButton = get('commentary-save'), clearButton = get('commentary-clear');
    const status = get('commentary-settings-status'), reuse = get('speech-reuse-key');
    if (!form || !remember || !saveButton || !clearButton || !status || !reuse
        || FIELDS.some((field) => !get(field[1]))) return;
    mounted = true;
    const show = (text) => { status.textContent = text; };
    const storage = () => {
      const value = globalThis.localStorage;
      if (!value) throw new Error('storage unavailable');
      return value;
    };
    const choice = (id, value, fallback) => {
      const options = get(id).options;
      return options ? Array.from(options).some((option) => option.value === value) : fallback.includes(value);
    };
    function valid(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
          || typeof value.reuseKey !== 'boolean' || Object.keys(value).some((key) => !KEYS.has(key))) return false;
      for (const [key, , max] of FIELDS) {
        if (typeof value[key] !== 'string' || value[key].length > max || /[\u0000-\u001f\u007f]/u.test(value[key])) return false;
      }
      return choice('commentary-preset', value.preset, ['minimax', 'custom'])
        && choice('speech-model', value.speechModel, ['speech-2.8-hd', 'speech-2.8-turbo'])
        && value.speechSpeed.trim() !== '' && Number.isFinite(Number(value.speechSpeed))
        && Number(value.speechSpeed) >= 0.5 && Number(value.speechSpeed) <= 2;
    }
    function save() {
      const value = { version: 1, reuseKey: reuse.checked };
      for (const [key, id] of FIELDS) value[key] = get(id).value.trim();
      if (!valid(value)) {
        show('配置格式不正确或内容过长，请检查后重新保存。');
        return false;
      }
      try {
        storage().setItem(STORAGE_KEY, JSON.stringify(value));
        show('已保存在当前浏览器，下次打开会自动填入。');
        return true;
      } catch (_) {
        show('当前浏览器无法保存本地配置，仍可临时使用当前输入。');
        return false;
      }
    }
    function remove(clearPasswords) {
      remember.checked = false;
      if (clearPasswords) { get('commentary-key').value = ''; get('speech-key').value = ''; }
      try {
        storage().removeItem(STORAGE_KEY);
        show(clearPasswords ? '已清除本地配置和页面中的密钥。' : '已取消本地保存，当前输入仍可用于本次导出。');
      } catch (_) {
        show(clearPasswords ? '页面密钥已清空；浏览器未允许删除本地配置。' : '浏览器未允许删除本地配置，请检查站点存储设置。');
      }
    }

    try {
      const saved = storage().getItem(STORAGE_KEY);
      if (saved !== null) {
        // Bound the serialized input before parsing data from an older or modified browser store.
        if (typeof saved !== 'string' || saved.length > 40000) throw new Error('invalid saved data');
        const value = JSON.parse(saved);
        if (!valid(value)) throw new Error('invalid saved data');
        for (const [key, id] of FIELDS) get(id).value = value[key];
        reuse.checked = value.reuseKey;
        get('speech-key').disabled = reuse.checked;
        remember.checked = true;
        show('已填入此浏览器保存的配置。');
      }
    } catch (_) {
      remember.checked = false;
      show('无法读取本地配置，可重新保存或临时填写。');
    }

    saveButton.addEventListener('click', (event) => {
      event.preventDefault(); remember.checked = true;
      if (!save()) remember.checked = false;
    });
    clearButton.addEventListener('click', (event) => { event.preventDefault(); remove(true); });
    remember.addEventListener('change', () => {
      if (!remember.checked) remove(false);
      else if (!save()) remember.checked = false;
    });
    reuse.addEventListener('change', () => { get('speech-key').disabled = reuse.checked; });
    // Run before the recorder disables the form or reads the one-off export configuration.
    form.addEventListener('submit', () => {
      if (remember.checked && !save()) remember.checked = false;
    }, true);
  }

  // Export-page scripts sit after the form; restore before an optional automatic export.
  mount();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
