// ==UserScript==
// @name         无锡职院公选课抢课助手
// @namespace    wxut.xk.helper
// @version      2.1
// @description  教务系统公选课自动选课：目标课程小窗设置、定时开始、限速重试、自动确认
// @match        https://zhjw.wxut.edu.cn/jsxsd/*
// @match        https://zhjw.wxut.edu.cn/jsxsd/xsxk/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const CFG_KEY = 'wxut_xk_cfg_v2';
  const POS_KEY = 'wxut_xk_pos_v2';
  const OPEN_KEY = 'wxut_xk_open_v2';
  const AUTOSTART_KEY = 'wxut_xk_autostart_v2';

  const DEFAULTS = {
    targets: [{ name: 'AIGC应用', teacher: '史荧中', cat: '文化', place: '' }],
    maxCourses: 2,
    startAt: '', // HH:MM:SS，留空表示立即开始
    pollMs: 1200,
    gapMs: 2500,
    maxAttempts: 80,
    ultimate: false,
    ultimateMs: 800,
  };

  // ------------------------------------------------------------ 本地存储

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        /* 忽略隐私模式等异常 */
      }
    },
  };

  // ------------------------------------------------------------ 跨 iframe 共享状态

  const state = (() => {
    try {
      if (!window.top.__xkState) {
        window.top.__xkState = {
          running: false,
          countdownTimer: null,
          success: [],
          catOfKey: {},
          baseline: [],
          lastCat: '',
          lastNeed: '',
          tabAt: {},
          tabCat: '',
          failAt: {},
          alertFail: false,
          fullNote: {},
          lastRefreshClick: 0,
          allDone: false,
          attempts: {},
          clickedAt: {},
          lastClicked: '',
          logEl: null,
          statusEl: null,
          cfg: null,
          log: [],
        };
      }
      return window.top.__xkState;
    } catch (e) {
      return {
        running: false,
        countdownTimer: null,
        success: [],
        catOfKey: {},
        baseline: [],
        lastCat: '',
        lastNeed: '',
        tabAt: {},
        tabCat: '',
        failAt: {},
        alertFail: false,
        fullNote: {},
        lastRefreshClick: 0,
        allDone: false,
        attempts: {},
        clickedAt: {},
        lastClicked: '',
        logEl: null,
        statusEl: null,
        cfg: null,
        log: [],
      };
    }
  })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keyOf = (t) => `${t.name || ''}|${t.teacher || ''}|${t.cat || ''}`;
  const labelOf = (t) => t.name || (t.cat ? `${t.cat}（任意）` : '任意课程');

  // ------------------------------------------------------------ 日志与状态

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    state.log.unshift(line);
    if (state.log.length > 80) state.log.pop();
    if (state.logEl) {
      const div = document.createElement('div');
      div.textContent = line;
      // 日志元素可能属于另一个 frame，用其所属 document 创建节点
      state.logEl.prepend(state.logEl.ownerDocument.importNode(div, true));
      while (state.logEl.childElementCount > 80) state.logEl.lastElementChild.remove();
    }
    console.log('[抢课]', msg);
  }

  function setStatus(text) {
    if (state.statusEl) state.statusEl.textContent = text;
  }

  function updateStatus() {
    if (!state.running) return;
    const cfg = state.cfg || loadCfg();
    const m = {};
    for (const k of state.success) {
      const c = state.catOfKey[k];
      if (c) m[c] = (m[c] || 0) + 1;
    }
    const detail = Object.keys(m).length
      ? `（${Object.entries(m).map(([c, n]) => c + n).join(' ')}）`
      : '';
    setStatus(`运行中 已选 ${state.success.length}/${cfg.maxCourses}${detail}`);
  }

  // ------------------------------------------------------------ 弹窗拦截（每个 frame 各拦自己的）

  function hookWindow(win) {
    if (!win || win.__xkHooked) return;
    try {
      win.__xkHooked = true;
      const rawAlert = win.alert.bind(win);
      const rawConfirm = win.confirm.bind(win);
      win.alert = (msg) => {
        if (!state.running) return rawAlert(msg);
        const text = String(msg);
        log('提示：' + text);
        if (/成功/.test(text) && state.lastClicked && !state.success.includes(state.lastClicked)) {
          state.success.push(state.lastClicked);
          state.catOfKey[state.lastClicked] = state.lastCat || '';
          updateStatus();
        }
        if (/已满|失败|冲突|不可选|不能选|未开放/.test(text)) state.alertFail = true;
      };
      win.confirm = (msg) => {
        if (!state.running) return rawConfirm(msg);
        log('确认：' + msg);
        return true;
      };
    } catch (e) {
      /* 个别环境不允许改写，忽略 */
    }
  }

  hookWindow(window);

  // ------------------------------------------------------------ 页面/iframe

  function amHost() {
    try {
      const top = window.top;
      if (top.document && top.document.body && !top.document.querySelector('frameset')) {
        return window === top;
      }
      // frameset 结构：可视面积最大的 frame 负责显示面板
      let best = top;
      let bestArea = (top.innerWidth || 0) * (top.innerHeight || 0);
      const walk = (w) => {
        for (let i = 0; i < w.frames.length; i++) {
          const f = w.frames[i];
          try {
            if (!f.document) continue;
            const area = (f.innerWidth || 0) * (f.innerHeight || 0);
            if (area > bestArea) {
              bestArea = area;
              best = f;
            }
            walk(f);
          } catch (e) {
            /* 跨域跳过 */
          }
        }
      };
      walk(top);
      return window === best;
    } catch (e) {
      return window === window.top;
    }
  }

  function collectWins() {
    const wins = [];
    const walk = (win) => {
      try {
        if (win.document && win.document.body) wins.push(win);
        for (let i = 0; i < win.frames.length; i++) walk(win.frames[i]);
      } catch (e) {
        /* 跨域跳过 */
      }
    };
    walk(window.top);
    return wins;
  }

  function courseRows(doc) {
    const rows = [];
    doc.querySelectorAll('table tr').forEach((tr) => {
      const text = (tr.innerText || tr.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      const btn = [...tr.querySelectorAll('a,button,input')].find((el) => {
        const t = (el.innerText || el.value || '').trim();
        return t === '选课' || t === '选择' || t === '选定';
      });
      if (!btn) return;
      rows.push({ tr, text, btn, doc, remaining: rowRemaining(tr) });
    });
    return rows;
  }

  const REMAIN_CACHE = new WeakMap();

  // 从表头找“余量/已选/容量”列，算出这门课还剩几个位置
  function tableRemainMap(table) {
    if (REMAIN_CACHE.has(table)) return REMAIN_CACHE.get(table);
    let map = null;
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [...tr.children].filter((td) => /^(TD|TH)$/.test(td.tagName));
      if (cells.length < 2) continue;
      const texts = cells.map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, '').trim());
      const rem = texts.findIndex((t) => /余量|剩余/.test(t));
      const sel = texts.findIndex((t) => /已选/.test(t));
      const cap = texts.findIndex((t) => /容量|上限|限额/.test(t));
      if (rem >= 0 || (sel >= 0 && cap >= 0)) {
        map = { rem, sel, cap };
        break;
      }
    }
    REMAIN_CACHE.set(table, map);
    return map;
  }

  function rowRemaining(tr) {
    const table = tr.closest('table');
    const map = table ? tableRemainMap(table) : null;
    if (!map) return null;
    const cells = [...tr.children].filter((td) => /^(TD|TH)$/.test(td.tagName));
    const cellText = (i) =>
      i >= 0 && i < cells.length ? (cells[i].innerText || cells[i].textContent || '').replace(/\s+/g, '') : '';
    const num = (s) => {
      const m = s.match(/-?\d+/);
      return m ? parseInt(m[0], 10) : null;
    };
    if (map.rem >= 0) return num(cellText(map.rem));
    if (map.sel >= 0 && map.cap >= 0) {
      const s = num(cellText(map.sel));
      const c = num(cellText(map.cap));
      if (s !== null && c !== null) return c - s;
    }
    return null;
  }

  // 是否已满：表格余量优先，其次看文字
  function rowIsFull(row) {
    if (row.remaining !== null && row.remaining !== undefined) return row.remaining <= 0;
    if (/已满|无余量|名额已满|余量为\s*0/.test(row.text)) return true;
    const m = row.text.match(/余量[:：]?\s*(-?\d+)/);
    if (m) return parseInt(m[1], 10) <= 0;
    const m2 = row.text.match(/已选\s*(\d+)\s*[\/／]\s*(\d+)/);
    if (m2) return parseInt(m2[1], 10) >= parseInt(m2[2], 10);
    return false;
  }

  // 终极模式查询间隔（毫秒），支持运行中随时调整
  function ultimateInterval(cfg) {
    const v = Number(state.cfg && state.cfg.ultimateMs) || Number(cfg.ultimateMs) || 800;
    return Math.max(300, Math.min(10000, v));
  }

  function pickButtons(doc) {
    return [...doc.querySelectorAll('a,button,input')].filter((el) => {
      const t = (el.innerText || el.value || '').trim();
      if (/退课|取消/.test(t)) return false;
      return t === '选课' || t === '选择' || t === '选定' || /^选课/.test(t);
    });
  }

  function hasCourseUi() {
    for (const win of collectWins()) {
      if (pickButtons(win.document).length) return true;
    }
    return false;
  }

  // 选课轮次页上的“进入选课 / 开始选课”
  function findEntry() {
    for (const win of collectWins()) {
      const el = [...win.document.querySelectorAll('a,button,input')].find((n) => {
        const t = (n.innerText || n.value || '').trim();
        return /进入选课|开始选课|去选课|进入$/.test(t) && !/退课/.test(t);
      });
      if (el) return el;
    }
    return null;
  }

  // 选课页上的“查询/刷新”按钮
  function findRefreshBtn() {
    for (const win of collectWins()) {
      const el = [...win.document.querySelectorAll('a,button,input')].find((n) =>
        /^(查询|搜索|刷新|检索)$/.test((n.innerText || n.value || '').trim())
      );
      if (el) return el;
    }
    return null;
  }

  function matches(text, t) {
    if (t.name && !text.includes(t.name)) return false;
    if (t.teacher && !text.includes(t.teacher)) return false;
    if (t.place && !text.includes(t.place)) return false;
    return !!(t.name || t.teacher || t.cat);
  }

  // 保底目标（只填类别、不填课名）：必须是该系统上识别出来的同类课程
  function matchesTarget(text, t, doc) {
    if (t.name) return matches(text, t);
    if (t.teacher && !text.includes(t.teacher)) return false;
    if (t.place && !text.includes(t.place)) return false;
    if (!t.cat) return true; // 终极模式：课名和类别都空 = 任意有空位的课
    return courseCat(text, doc) === t.cat;
  }

  function courseCat(text, doc) {
    return catFromText(text) || pageCat(doc) || state.tabCat || '';
  }

  function rowCat(text, t, doc) {
    return catFromText(text) || pageCat(doc) || (t && t.cat) || state.tabCat || '';
  }

  function rowKey(row) {
    return (row.text || '').replace(/\s+/g, '').slice(0, 80);
  }

  function findTarget(rows, t) {
    return rows.find((r) => matches(r.text, t));
  }

  // 选上之后，课程容器里的“选课”会变成“退课”按钮
  function selectedInDoc(doc, t) {
    if (!t.name) return false; // 保底目标用按钮变化判断
    return [...doc.querySelectorAll('tr,li,div,section')].some((n) => {
      const txt = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 600) return false;
      if (!matches(txt, t)) return false;
      return [...n.querySelectorAll('a,button,input')].some((el) =>
        /^退课$/.test((el.innerText || el.value || '').trim())
      );
    });
  }

  // 点完之后按钮从“选课”变成别的（退课/已选）或被移除
  function buttonChanged(row) {
    const btn = row && row.btn;
    if (!btn || !btn.isConnected) return false;
    const txt = (btn.innerText || btn.value || '').trim();
    return !/^选课/.test(txt);
  }

  // ------------------------------------------------------------ 课程类别（文化 / 艺术）

  function catFromText(txt) {
    if (/公共艺术|艺术类|艺术素质|艺术选修|艺术课/.test(txt)) return '艺术';
    if (/文化素质|文化类|人文素质|文化选修|文化课/.test(txt)) return '文化';
    return '';
  }

  // 当前高亮的分类标签（例如“公共艺术课”页签）
  function pageCat(doc) {
    const nodes = [...doc.querySelectorAll('.active,.cur,.selected,.layui-this,.on,.current')];
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || '').replace(/\s+/g, '');
      if (!t || t.length > 30) continue;
      if (/公共艺术|艺术类/.test(t)) return '艺术';
      if (/文化素质|文化类/.test(t)) return '文化';
    }
    return '';
  }

  function detectCat(text, t, doc) {
    return catFromText(text) || (t && t.cat) || pageCat(doc) || '';
  }

  // 页面上已选课程（带“退课”按钮），用于判断还缺哪一类
  function scanExisting() {
    const have = new Set();
    for (const win of collectWins()) {
      const doc = win.document;
      for (const el of doc.querySelectorAll('a,button,input')) {
        if (!/^退课$/.test((el.innerText || el.value || '').trim())) continue;
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
          const txt = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 300) continue;
          const c = catFromText(txt) || pageCat(doc);
          if (c) {
            have.add(c);
            break;
          }
        }
      }
    }
    return [...have];
  }

  function catsSatisfied() {
    const have = new Set(state.baseline || []);
    for (const k of state.success) {
      const c = state.catOfKey[k];
      if (c) have.add(c);
    }
    return have;
  }

  // 选课页左侧/上方的“文化素质课 / 公共艺术课”分类入口
  function catTab(doc, cat) {
    const want =
      cat === '艺术'
        ? /^(公共)?艺术(类|课|选修|素质课)?$/
        : /^(文化素质|文化类|人文素质|文化选修)(课|类)?$/;
    for (const n of doc.querySelectorAll('a,button,li,[role="tab"],.tab,.menu-item')) {
      const t = (n.innerText || n.textContent || '').replace(/\s+/g, '').trim();
      if (t && t.length <= 12 && want.test(t)) return n;
    }
    return null;
  }

  // 表格结构认不出时，从“选课”按钮往上找最近的课程容器
  function looseFind(doc, t) {
    const btns = [...doc.querySelectorAll('a,button,input')].filter((b) =>
      /^选课$/.test((b.innerText || b.value || '').trim())
    );
    for (const b of btns) {
      let p = b.parentElement;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        const txt = (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt.length > 400) break;
        if (matchesTarget(txt, t, doc)) return { btn: b, text: txt, doc };
      }
    }
    return null;
  }

  // 兼容 layui / element 等自定义弹窗的“确定”
  function autoConfirm(doc) {
    const sels = [
      '.layui-layer-btn0',
      '.layui-layer-dialog .layui-layer-btn a',
      '.el-message-box__btns .el-button--primary',
      '.ant-modal-confirm-btns .ant-btn-primary',
    ];
    for (const s of sels) {
      const el = doc.querySelector(s);
      if (el && /确定|确认|是|选课/.test(el.innerText || el.textContent || '')) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------ 配置

  function loadCfg() {
    const saved = store.get(CFG_KEY, null);
    return Object.assign({}, DEFAULTS, saved || {});
  }

  function collectCfg() {
    const el = document.getElementById('xk-win');
    if (!el) return state.cfg || loadCfg();
    const ultimate = el.querySelector('#xk-ultimate').checked;
    const targets = [...el.querySelectorAll('.xk-target')]
      .map((row) => ({
        name: row.querySelector('.xk-name').value.trim(),
        teacher: row.querySelector('.xk-teacher').value.trim(),
        cat: row.querySelector('.xk-cat').value || '',
        place: row.querySelector('.xk-place').value.trim(),
      }))
      .filter((t) => t.name || t.cat || ultimate);
    return Object.assign({}, state.cfg, {
      targets,
      maxCourses: Math.max(1, Math.min(2, parseInt(el.querySelector('#xk-max').value, 10) || 2)),
      startAt: el.querySelector('#xk-start-at').value || '',
      ultimate,
      ultimateMs: Math.round(
        Math.max(0.3, Math.min(10, parseFloat(el.querySelector('#xk-speed').value) || 0.8)) * 1000
      ),
    });
  }

  function persist() {
    const cfg = collectCfg();
    state.cfg = cfg;
    store.set(CFG_KEY, cfg);
    return cfg;
  }

  // ------------------------------------------------------------ 运行逻辑

  function msUntil(hms) {
    if (!hms) return 0;
    const [h, m, s] = hms.split(':').map((x) => parseInt(x, 10) || 0);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, s || 0, 0);
    return target.getTime() - now.getTime();
  }

  function start() {
    const cfg = persist();
    if (!cfg.targets.length) {
      setStatus('请先填写目标课程');
      log('目标是空的：填课程名，或只选类别做保底');
      return;
    }

    // 还在“选课轮次列表”页：自动点“进入选课”，到新页面后自动开始
    if (!hasCourseUi()) {
      const entry = findEntry();
      if (entry) {
        state.running = true;
        log('当前是选课轮次页，正在点“进入选课”，进入后会自动开始');
        store.set(AUTOSTART_KEY, Date.now());
        setStatus('正在进入选课…');
        entry.click();
        return;
      }
    }

    state.running = true;
    state.success = [];
    state.attempts = {};
    state.clickedAt = {};
    state.catOfKey = {};
    state.lastNeed = '';
    state.tabAt = {};
    state.tabCat = '';
    state.failAt = {};
    state.alertFail = false;
    state.fullNote = {};
    state.lastRefreshClick = 0;
    state.allDone = false;
    state.cfg = cfg;
    collectWins().forEach((w) => hookWindow(w));
    state.baseline = scanExisting();
    if (state.baseline.length) log(`页面上已有：${state.baseline.join('、')}类`);

    const wait = msUntil(cfg.startAt);
    if (wait > 0) {
      log(`已挂起，${cfg.startAt} 开始（约 ${Math.ceil(wait / 1000)} 秒后）`);
      const tick = () => {
        if (!state.running) return;
        const left = msUntil(cfg.startAt);
        if (left <= 0) {
          log('时间到，开始选课');
          loop(cfg);
          return;
        }
        setStatus(`等待 ${cfg.startAt}（剩 ${Math.ceil(left / 1000)} 秒）`);
        state.countdownTimer = setTimeout(tick, 500);
      };
      tick();
    } else {
      log('开始选课');
      loop(cfg);
    }
  }

  function stop() {
    state.running = false;
    clearTimeout(state.countdownTimer);
    setStatus('已停止');
    log('已停止');
  }

  async function loop(cfg) {
    let emptyRounds = 0;
    while (state.running && state.success.length < cfg.maxCourses) {
      const interval = ultimateInterval(cfg);
      // 终极模式：定时点一次“查询”，让余量刷新
      if (cfg.ultimate && Date.now() - (state.lastRefreshClick || 0) > Math.max(2000, interval * 3)) {
        const rb = findRefreshBtn();
        if (rb) {
          state.lastRefreshClick = Date.now();
          try {
            rb.click();
          } catch (e) {
            /* 忽略 */
          }
          await sleep(600);
        }
      }

      const wins = collectWins();
      let visibleRows = 0;
      const candidates = [];
      const seen = new Set();

      for (const win of wins) {
        const rows = courseRows(win.document);
        const picks = pickButtons(win.document);
        visibleRows += rows.length + picks.length;
        if (!rows.length && !picks.length) continue;
        for (const t of cfg.targets) {
          const k = keyOf(t);
          if (state.success.includes(k) || seen.has(k)) continue;
          if (state.success.length >= cfg.maxCourses) break;
          if (!cfg.ultimate && (state.attempts[k] || 0) >= cfg.maxAttempts) continue;
          if (Date.now() - (state.clickedAt[k] || 0) < cfg.gapMs) continue;

          // 保底目标可能对应多门课：优先挑最近没失败过的
          let list = rows.filter((r) => matchesTarget(r.text, t, win.document));
          if (!list.length) {
            const loose = looseFind(win.document, t);
            if (loose) list = [loose];
          }
          if (!list.length) continue;
          // 终极模式：只要还有余量的，满了就跳过，等它放位
          const usable = cfg.ultimate ? list.filter((r) => !rowIsFull(r)) : list;
          if (!usable.length) {
            if (Date.now() - (state.fullNote[k] || 0) > 30000) {
              state.fullNote[k] = Date.now();
              log(`「${labelOf(t)}」已满，持续监控中…`);
            }
            continue;
          }
          const fresh = usable.filter(
            (r) => Date.now() - (state.failAt[k + '||' + rowKey(r)] || 0) > 180000
          );
          const row = fresh[0] || usable[0];
          seen.add(k);
          candidates.push({ t, k, row, win, cat: rowCat(row.text, t, win.document) });
        }
      }

      // 目标在另一个分类里时，自动切到对应分类页
      let switched = false;
      for (const t of cfg.targets) {
        const k = keyOf(t);
        if (!t.cat || state.success.includes(k)) continue;
        if (candidates.some((c) => c.k === k)) continue;
        if (Date.now() - (state.tabAt[t.cat] || 0) < 4000) continue;
        let tab = null;
        for (const win of wins) {
          tab = catTab(win.document, t.cat);
          if (tab) break;
        }
        if (tab) {
          state.tabAt[t.cat] = Date.now();
          state.tabCat = t.cat;
          log(`切换到「${t.cat}」分类列表`);
          try {
            tab.click();
          } catch (e) {
            log('切换失败：' + e.message);
          }
          await sleep(700);
          switched = true;
          break;
        }
      }
      // 切分类会重绘列表，丢弃这一轮的旧节点，下一轮重新扫描
      if (switched) {
        await sleep(cfg.pollMs);
        continue;
      }

      // 先补还没覆盖的类别（文化 / 艺术），再按优先级补
      let pick = null;
      if (candidates.length) {
        const have = catsSatisfied();
        const need = ['文化', '艺术'].filter(
          (c) => !have.has(c) && candidates.some((x) => x.cat === c)
        );
        pick = candidates.find((x) => need.includes(x.cat)) || candidates[0];
        if (need.length && pick.cat && pick.cat !== state.lastNeed) {
          log(`先补「${pick.cat}」类（已选：${[...have].join('、') || '无'}）`);
          state.lastNeed = pick.cat;
        }
      }

      let acted = false;
      if (pick) {
        acted = true;
        const { t, k, row, win, cat } = pick;
        state.clickedAt[k] = Date.now();
        state.attempts[k] = (state.attempts[k] || 0) + 1;
        state.lastClicked = k;
        state.lastCat = cat;
        log(`点击「${labelOf(t)}」第 ${state.attempts[k]} 次${cat ? `（${cat}类）` : ''}`);
        state.alertFail = false;
        try {
          row.btn.click();
        } catch (e) {
          log('点击失败：' + e.message);
        }
        await sleep(400);
        if (autoConfirm(win.document)) await sleep(300);

        // 选上后课程块里的“选课”会变成“退课”
        const ok = buttonChanged(row) || selectedInDoc(win.document, t);
        if (ok && !state.success.includes(k)) {
          state.success.push(k);
          state.catOfKey[k] = cat;
          log(`「${labelOf(t)}」已选上${cat ? `（${cat}类）` : ''}`);
        } else if (!ok && state.alertFail) {
          state.failAt[k + '||' + rowKey(row)] = Date.now();
          log('这门没抢到，换下一门');
        }
        updateStatus();
      }

      // 所有目标都已完成，收工
      if (state.success.length && cfg.targets.every((t) => state.success.includes(keyOf(t)))) {
        log('目标都已抢到，停止');
        state.allDone = true;
        break;
      }

      if (!visibleRows) {
        emptyRounds++;
        if (emptyRounds === 1) log('没找到课程：请先进入“选课轮次”里的选课页，看到“选课”按钮再开始');
      } else {
        emptyRounds = 0;
      }
      if (!acted) updateStatus();
      await sleep(cfg.ultimate ? interval : cfg.pollMs);
    }

    if (state.success.length >= cfg.maxCourses) {
      log(`已选满 ${cfg.maxCourses} 门，自动停止`);
      setStatus(`完成 ${state.success.length}/${cfg.maxCourses}`);
    } else if (state.allDone) {
      setStatus('目标已全部抢到');
    } else if (!state.running) {
      setStatus('已停止');
    }
    state.running = false;
  }

  function testScan() {
    const cfg = persist();
    const wins = collectWins();
    let rows = [];
    let picks = 0;
    for (const win of wins) {
      rows = rows.concat(courseRows(win.document));
      picks += pickButtons(win.document).length;
    }
    if (!rows.length && !picks) {
      log(findEntry() ? '当前是选课轮次页：点“开始”会自动进入选课' : '没找到课程：先进入能点“选课”的列表页再检测');
      return;
    }
    log(`页面共 ${picks || rows.length} 个“选课”入口`);
    refreshPlaceOptions();
    cfg.targets.forEach((t) => {
      let hit = rows.find((r) => matchesTarget(r.text, t, r.doc || window.document));
      if (!hit) {
        for (const win of wins) {
          hit = looseFind(win.document, t);
          if (hit) break;
        }
      }
      const c = hit ? rowCat(hit.text, t, hit.doc || window.document) : t.cat;
      log(
        hit
          ? `找到「${labelOf(t)}」${c ? `（${c}类）` : '（类别未识别）'}：${hit.text.slice(0, 60)}`
          : `未找到「${labelOf(t)}」`
      );
    });
    const ex = scanExisting();
    if (ex.length) log(`页面上已选：${ex.join('、')}类`);
  }

  // 抓一段课程结构，方便按真实页面调选择器
  function copyStructure() {
    let snippet = '';
    for (const win of collectWins()) {
      const btn = pickButtons(win.document)[0];
      if (btn) {
        let p = btn;
        for (let i = 0; i < 5 && p.parentElement; i++) p = p.parentElement;
        snippet = p.outerHTML;
        break;
      }
      const table = win.document.querySelector('table');
      if (table) {
        snippet = table.outerHTML;
        break;
      }
    }
    if (!snippet) {
      log('没抓到课程结构');
      return;
    }
    snippet = snippet.slice(0, 6000);
    console.log('[抢课] 页面结构：\n' + snippet);
    const done = () => log('结构已复制，直接发我即可');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(snippet).then(done).catch(() => window.prompt('复制下面的内容发我', snippet));
    } else {
      window.prompt('复制下面的内容发我', snippet);
    }
  }

  // ------------------------------------------------------------ 导出课程表

  const FIELD_PATTERNS = [
    ['code', /课程(编号|号|代码|编码)/],
    ['name', /课程名称|课程名/],
    ['credit', /学分/],
    ['teacher', /任课教师|教师|老师/],
    ['time', /上课时间|节次|时间/],
    ['place', /上课地点|地点|教室/],
    ['cat', /通选课类别|课程类别|通识类别|课程性质|类别/],
  ];

  function headerFields(cells) {
    const map = {};
    cells.forEach((text, idx) => {
      for (const [key, re] of FIELD_PATTERNS) {
        if (map[key] === undefined && re.test(text)) map[key] = idx;
      }
    });
    return map.name !== undefined ? map : null;
  }

  function extractTableCourses(doc) {
    const out = [];
    doc.querySelectorAll('table').forEach((table) => {
      let map = null;
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [...tr.children].filter((td) => /^(TD|TH)$/.test(td.tagName));
        if (!cells.length) continue;
        const texts = cells.map((c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim());
        if (!map) {
          map = headerFields(texts);
          continue;
        }
        const val = (k) => (map[k] !== undefined ? texts[map[k]] || '' : '');
        const name = val('name');
        if (!name || /合计|总计|小计/.test(name)) continue;
        out.push({
          code: val('code'),
          name,
          credit: val('credit'),
          teacher: val('teacher'),
          time: val('time'),
          place: val('place'),
          cat: val('cat'),
        });
      }
    });
    return out;
  }

  // 卡片式课程：按“字段名：值”解析
  function extractCardCourses(doc) {
    const out = [];
    const seen = new Set();
    for (const btn of pickButtons(doc)) {
      let p = btn.parentElement;
      let block = null;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        const t = (p.innerText || p.textContent || '').trim();
        if (t.length > 30 && t.length < 1500) {
          block = p;
          break;
        }
      }
      if (!block) continue;
      const txt = (block.innerText || block.textContent || '').replace(/\s+/g, ' ').trim();
      if (seen.has(txt)) continue;
      seen.add(txt);
      const get = (re) => (txt.match(re) || [])[1] || '';
      const nameEl = block.querySelector('.name,.title,h3,h4,.course-name,.kc-name');
      out.push({
        code: get(/课程(?:编号|号|代码|编码)[:：]\s*([A-Za-z0-9_-]+)/),
        name: nameEl ? (nameEl.innerText || nameEl.textContent || '').trim() : '',
        credit: get(/学分[:：]\s*([\d.]+)/),
        teacher: get(/(?:任课)?教师[:：]\s*([^\s|,，]+)/),
        time: get(/上课时间[:：]\s*([^|]+?)(?=\s*(?:上课地点|地点|学分|$))/),
        place: get(/(?:上课地点|地点)[:：]\s*([^|]+?)(?=\s*(?:学分|类别|$))/),
        cat: get(/(?:通选课类别|课程类别|类别)[:：]\s*([^\s|,，]+)/),
      });
    }
    return out;
  }

  function extractAllCourses() {
    const out = [];
    const seen = new Set();
    for (const win of collectWins()) {
      let rows = extractTableCourses(win.document);
      if (!rows.length) rows = extractCardCourses(win.document);
      for (const r of rows) {
        if (!r.name) continue;
        const k = [r.code, r.name, r.time, r.teacher].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
      }
    }
    return out;
  }

  function nextPageBtn() {
    const sels = [
      '.layui-laypage-next',
      '.pagination .next',
      '.pager .next',
      'a[title="下一页"]',
      'a[title="下页"]',
    ];
    for (const win of collectWins()) {
      for (const s of sels) {
        const el = win.document.querySelector(s);
        if (el && !/disabled/.test(el.className)) return el;
      }
      const el = [...win.document.querySelectorAll('a,button')].find((n) =>
        /^(下一页|下页|>)$/.test((n.innerText || '').trim())
      );
      if (el && !/disabled/.test(el.className)) return el;
    }
    return null;
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  async function exportCourses() {
    const all = [];
    const seen = new Set();
    let page = 0;
    while (page < 30) {
      page++;
      for (const r of extractAllCourses()) {
        const k = [r.code, r.name, r.time, r.teacher].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(r);
      }
      const next = nextPageBtn();
      if (!next) break;
      log(`已读取第 ${page} 页，继续翻页…`);
      next.click();
      await sleep(1500);
    }
    if (!all.length) {
      log('没读到课程：先进入选课列表页，看到课程再点“导出”');
      return;
    }
    const header = ['课程编号', '课程名称', '学分', '教师', '上课时间', '上课地点', '通选课类别'];
    const lines = [header].concat(
      all.map((r) => [r.code, r.name, r.credit, r.teacher, r.time, r.place, r.cat])
    );
    const csv = '\ufeff' + lines.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `公选课列表_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
    log(`共导出 ${all.length} 门（${page} 页），CSV 已下载`);
    console.log('[抢课] 课程数据', all);
  }

  // ------------------------------------------------------------ 小窗 UI

  const CSS = `
  #xk-win{position:fixed;z-index:2147483647;right:16px;top:16px;width:348px;
    background:#fff;border:1px solid #2476c9;border-radius:10px;
    box-shadow:0 10px 30px rgba(15,50,90,.22);
    font:12px/1.55 "Microsoft YaHei","PingFang SC",sans-serif;color:#1f2d3d;overflow:hidden}
  #xk-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
    background:linear-gradient(135deg,#2476c9,#3f9ae0);color:#fff;user-select:none}
  #xk-head b{font-size:13px;font-weight:700;flex:1}
  #xk-state{font-size:11px;opacity:.92;white-space:nowrap}
  #xk-min{border:0;background:rgba(255,255,255,.18);color:#fff;width:22px;height:22px;
    border-radius:5px;cursor:pointer;line-height:20px}
  #xk-body{padding:10px}
  .xk-hint{color:#6b7a90;margin-bottom:6px}
  .xk-target{border:1px solid #e6ecf3;border-radius:7px;padding:6px;margin-bottom:6px;background:#fbfcfe}
  .xk-line1,.xk-line2{display:flex;gap:6px}
  .xk-line2{margin-top:6px}
  .xk-target input{min-width:0;border:1px solid #cfd8e3;border-radius:5px;padding:4px 6px;
    font:12px/1.4 inherit;color:#1f2d3d}
  .xk-target .xk-name{flex:1.4}
  .xk-target .xk-teacher{flex:1}
  .xk-target select{width:92px;border:1px solid #cfd8e3;border-radius:5px;padding:3px 2px;
    font:12px/1.4 inherit;color:#1f2d3d;background:#fff}
  .xk-target .xk-place{flex:1}
  .xk-opt{display:flex;align-items:center;gap:6px;margin:2px 0 8px;color:#c0392b;font-size:11px}
  .xk-opt input{accent-color:#c0392b}
  .xk-speed{display:flex;align-items:center;gap:5px;margin:-3px 0 8px 20px;color:#44546a;font-size:11px}
  .xk-speed input{width:52px;border:1px solid #cfd8e3;border-radius:5px;padding:2px 4px;
    font:11px/1.4 inherit;text-align:center}
  .xk-del{border:0;background:#f2f5f9;color:#9aa7b8;border-radius:5px;width:24px;cursor:pointer}
  #xk-add{width:100%;border:1px dashed #9dc0e8;background:#f7fbff;color:#2476c9;
    border-radius:5px;padding:4px;cursor:pointer;margin-bottom:8px}
  .xk-row2{display:flex;gap:8px;align-items:center;margin-bottom:8px;color:#44546a;flex-wrap:wrap}
  .xk-row2 input{border:1px solid #cfd8e3;border-radius:5px;padding:3px 4px;font:12px inherit}
  #xk-max{width:40px;text-align:center}
  #xk-start-at{width:86px}
  .xk-btns{display:flex;gap:6px;margin-bottom:6px}
  .xk-btns button{flex:1;border:0;border-radius:6px;padding:6px 0;cursor:pointer;font:12px inherit}
  #xk-start{background:#2476c9;color:#fff}
  #xk-stop{background:#eef2f7;color:#44546a}
  #xk-scan,#xk-copy,#xk-export{background:#eef2f7;color:#44546a}
  #xk-status{color:#2476c9;min-height:18px;margin-bottom:4px}
  #xk-recommend{color:#2476c9;font-size:11px;margin:-3px 0 7px 20px}
  #xk-log{max-height:132px;overflow:auto;background:#f7f9fc;border:1px solid #eef1f6;
    border-radius:6px;padding:4px 6px;font-size:11px;color:#5b6b80}
  #xk-win.xk-fold #xk-body{display:none}
  #xk-tip{color:#9aa7b8;font-size:11px;margin-top:4px}
  `;

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function addTargetRow(t) {
    const list = document.getElementById('xk-list');
    const row = document.createElement('div');
    row.className = 'xk-target';
    row.innerHTML = `
      <div class="xk-line1">
        <input class="xk-name" placeholder="课程名（留空=任意）" value="${escapeAttr(t.name || '')}">
        <input class="xk-teacher" placeholder="教师（可选）" value="${escapeAttr(t.teacher || '')}">
        <button class="xk-del" title="删除">×</button>
      </div>
      <div class="xk-line2">
        <select class="xk-cat" title="课程类别">
          <option value="">类别不限</option>
          <option value="文化">文化</option>
          <option value="艺术">艺术</option>
        </select>
        <input class="xk-place" list="xk-places" placeholder="教室（可选，如 崇德205）" value="${escapeAttr(t.place || '')}">
      </div>
    `;
    list.appendChild(row);
    row.querySelector('.xk-cat').value = t.cat || '';
    row.querySelector('.xk-del').onclick = () => {
      row.remove();
      if (!list.childElementCount) addTargetRow({ name: '', teacher: '' });
      persist();
    };
    row.querySelectorAll('input,select').forEach((inp) => {
      inp.addEventListener('change', persist);
    });
  }

  // 把当前页面出现过的教室填进下拉候选
  function refreshPlaceOptions() {
    const dl = document.getElementById('xk-places');
    if (!dl) return;
    const places = new Set();
    for (const win of collectWins()) {
      for (const r of extractTableCourses(win.document)) if (r.place) places.add(r.place);
      for (const r of extractCardCourses(win.document)) if (r.place) places.add(r.place);
    }
    const list = [...places].sort();
    if (!list.length) return;
    dl.innerHTML = list.map((p) => `<option value="${escapeAttr(p)}"></option>`).join('');
  }

  function buildUI() {
    const cfg = loadCfg();
    state.cfg = cfg;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const win = document.createElement('div');
    win.id = 'xk-win';
    win.innerHTML = `
      <div id="xk-head">
        <b>公选课助手</b>
        <span id="xk-state">待机</span>
        <button id="xk-min" title="折叠">—</button>
      </div>
      <div id="xk-body">
        <div class="xk-hint">目标（按优先级；终极模式下全部留空=任意有空位的课）</div>
        <div id="xk-list"></div>
        <button id="xk-add">+ 添加一门</button>
        <div class="xk-row2">
          <label>最多选 <input id="xk-max" type="number" min="1" max="2" value="${cfg.maxCourses}"> 门</label>
          <label>开始 <input id="xk-start-at" type="time" step="1" value="${cfg.startAt}"></label>
        </div>
        <label class="xk-opt"><input id="xk-ultimate" type="checkbox"${cfg.ultimate ? ' checked' : ''}> 终极模式：有课直接抢（过滤已满、持续查询）</label>
        <div id="xk-recommend">推荐打开过滤已满课程</div>
        <div class="xk-speed">查询间隔 <input id="xk-speed" type="number" min="0.3" max="10" step="0.1" value="${(cfg.ultimateMs || 800) / 1000}"> 秒</div>
        <datalist id="xk-places"></datalist>
        <div class="xk-btns">
          <button id="xk-start">开始</button>
          <button id="xk-stop">停止</button>
          <button id="xk-scan">检测</button>
          <button id="xk-copy">结构</button>
          <button id="xk-export">导出</button>
        </div>
        <div id="xk-status">未运行</div>
        <div id="xk-log"></div>
        <div id="xk-tip">先进入“学生选课”的课程列表页，再点开始</div>
      </div>
    `;
    document.body.appendChild(win);

    state.logEl = win.querySelector('#xk-log');
    state.statusEl = win.querySelector('#xk-status');
    state.log.slice().reverse().forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      state.logEl.prepend(div);
    });

    cfg.targets.forEach((t) => addTargetRow(t));
    if (!cfg.targets.length) addTargetRow({ name: '', teacher: '' });

    win.querySelector('#xk-add').onclick = () => addTargetRow({ name: '', teacher: '' });
    win.querySelector('#xk-start').onclick = start;
    win.querySelector('#xk-stop').onclick = stop;
    win.querySelector('#xk-scan').onclick = testScan;
    win.querySelector('#xk-copy').onclick = copyStructure;
    win.querySelector('#xk-export').onclick = exportCourses;
    win.querySelector('#xk-max').addEventListener('change', persist);
    win.querySelector('#xk-start-at').addEventListener('change', persist);
    win.querySelector('#xk-ultimate').addEventListener('change', persist);
    win.querySelector('#xk-speed').addEventListener('change', persist);

    if (store.get(OPEN_KEY, true) === false) win.classList.add('xk-fold');
    win.querySelector('#xk-min').onclick = () => {
      win.classList.toggle('xk-fold');
      store.set(OPEN_KEY, !win.classList.contains('xk-fold'));
    };

    // 拖动 + 记忆位置
    const pos = store.get(POS_KEY, null);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      win.style.left = pos.left + 'px';
      win.style.top = pos.top + 'px';
      win.style.right = 'auto';
    }
    const head = win.querySelector('#xk-head');
    head.addEventListener('mousedown', (e) => {
      if (e.target.id === 'xk-min') return;
      const rect = win.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      const move = (ev) => {
        win.style.left = Math.max(0, ev.clientX - dx) + 'px';
        win.style.top = Math.max(0, ev.clientY - dy) + 'px';
        win.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        store.set(POS_KEY, {
          left: parseInt(win.style.left, 10) || 0,
          top: parseInt(win.style.top, 10) || 0,
        });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    log('助手已加载；填好目标后点“检测”确认能对上课程（Alt+X 折叠）');
    setTimeout(refreshPlaceOptions, 1200);
  }

  // ------------------------------------------------------------ 启动

  if (!amHost()) return;
  const boot = () => {
    if (!document.body) {
      setTimeout(boot, 300);
      return;
    }
    buildUI();

    // 从“选课轮次页”跳转过来后自动接着跑
    const ts = store.get(AUTOSTART_KEY, 0);
    if (ts && Date.now() - ts < 10 * 60 * 1000) {
      let tries = 0;
      const waitStart = () => {
        tries++;
        if (hasCourseUi()) {
          store.set(AUTOSTART_KEY, 0);
          log('已进入选课页，自动开始');
          start();
          return;
        }
        if (tries > 30) {
          store.set(AUTOSTART_KEY, 0);
          log('没等到课程列表，请手动点“开始”');
          return;
        }
        setTimeout(waitStart, 500);
      };
      setTimeout(waitStart, 800);
    }
  };
  boot();

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'x' || e.key === 'X')) {
      const win = document.getElementById('xk-win');
      if (win) win.classList.toggle('xk-fold');
    }
  });

  // 控制台调试/二次导出用
  try {
    window.__xk = { extractAllCourses, exportCourses };
  } catch (e) {
    /* 忽略 */
  }
})();
