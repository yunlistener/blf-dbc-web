/* CANoe 风格前端逻辑:文件 → 报文树 → 多信号曲线 → Trace → 统计 */
"use strict";

const PALETTE = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff", "#4dd6c8"];
const MAX_SERIES = 6;   // uPlot 系列数固定,槽位复用

const state = {
  blf: null,
  dbc: null,
  stats: null,
  signals: [],       // 已选信号 [{frame_id, signal, unit, color, slot, data, channel, dbc}]
  uplot: null,
  trace: { frameId: null, channel: null, offset: 0, limit: 200 },
  config: {},        // 工程配置(总线/波特率/文件/通道映射)
  channels: [],      // [{channel, frames, dbc, messages}]
};

function showTip(msg) { document.getElementById("st-tip").textContent = msg; }

/* 信号值格式化:数值保留 6 位有效数字;值表(choices)显示名称(值);dict/数组转 JSON;null 显示 — */
function fmtVal(v) {
  if (v == null) return "—";
  if (typeof v === "number") return String(Number(v.toPrecision(6)));
  if (typeof v === "object") {
    // cantools 值表信号: {name: 'Valid', value: 0, _comments: {}}
    if ("name" in v) return v.value != null ? `${v.name}(${v.value})` : String(v.name);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}
window.addEventListener("error", (e) => {
  const stack = (e.error && e.error.stack || "").split("\n")[1] || "";
  showTip("JS错误: " + e.message + " " + stack.trim());
});
window.addEventListener("unhandledrejection", (e) => showTip("异常: " + e.reason));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
  return r.json();
}

/* ---------- 文件上传 ---------- */
let pendingFiles = [];

function openUpload() {
  pendingFiles = [];
  document.getElementById("file-input").value = "";
  renderUploadList();
  document.getElementById("upload-modal").style.display = "flex";
}

function closeUpload() {
  document.getElementById("upload-modal").style.display = "none";
}

document.getElementById("file-input").addEventListener("change", (e) => {
  pendingFiles = Array.from(e.target.files || []);
  renderUploadList();
});

const dropZone = document.getElementById("drop-zone");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  pendingFiles = Array.from(e.dataTransfer.files || []).filter(f => /\.(blf|dbc)$/i.test(f.name));
  renderUploadList();
});

function renderUploadList() {
  const list = document.getElementById("upload-list");
  const btn = document.getElementById("btn-upload-go");
  list.innerHTML = pendingFiles.length
    ? pendingFiles.map((f, i) =>
        `<div class="upload-row" id="up-row-${i}"><span>${f.name}</span><span class="up-size">${(f.size / 1024).toFixed(1)} KB</span><span class="up-status">待上传</span></div>`).join("")
    : `<div class="hint">尚未选择文件</div>`;
  btn.disabled = pendingFiles.length === 0;
}

async function startUpload() {
  const btn = document.getElementById("btn-upload-go");
  btn.disabled = true;
  btn.textContent = "上传中…";
  let ok = 0, fail = 0;
  for (let i = 0; i < pendingFiles.length; i++) {
    const f = pendingFiles[i];
    const row = document.getElementById(`up-row-${i}`);
    const status = row.querySelector(".up-status");
    status.textContent = "上传中…";
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api("/api/files/upload", { method: "POST", body: fd });
      status.textContent = "✓ 完成";
      status.className = "up-status ok";
      ok++;
    } catch (err) {
      status.textContent = "✗ " + (err.message || "失败");
      status.className = "up-status err";
      fail++;
    }
  }
  btn.textContent = "上传";
  if (ok > 0) {
    showTip(`上传完成:成功 ${ok} 个${fail ? `,失败 ${fail} 个` : ""}`);
    await loadFiles();   // 重新加载文件列表和报文树
    closeUpload();
  } else {
    showTip("上传失败,请检查文件格式(.blf / .dbc)");
    btn.disabled = false;
  }
}

/* ---------- uPlot ---------- */
function onCursorMove(u, x, y) {
  const t = u.posToVal(x, "x");
  document.getElementById("ro-time").textContent = t.toFixed(3) + " s";
  const idx = u.posToIdx(x);
  const box = document.getElementById("ro-signals");
  box.innerHTML = "";
  state.signals.forEach(s => {
    const v = u.data[s.slot] ? u.data[s.slot][idx] : null;
    let display = fmtVal(v);
    // 值表信号:数值 → 查 choices 显示 名称(值),如 Valid(0)
    if (v != null && typeof v === "number" && s.choices) {
      const c = s.choices[String(v)];
      if (c && c.name) display = `${c.name}(${v})`;
    }
    const div = document.createElement("span");
    div.className = "ro-sig-val";
    div.innerHTML = `<span class="dot" style="background:${s.color}"></span>
      ${s.signal}: <b>${display}</b>
      <span class="u">${s.unit || ""}</span>`;
    box.appendChild(div);
    // 同步左侧信号列的当前值
    const valEl = document.getElementById(`sigval-${s.slot}`);
    if (valEl) valEl.textContent = display;
  });
}

/* 左侧已选信号列:颜色标记 + 信号名 + 当前值 + 移除 */
function renderSigSidebar() {
  const box = document.getElementById("sig-sidebar");
  if (!state.signals.length) {
    box.innerHTML = `<div class="sig-sidebar-title">已选信号</div>
      <div class="hint" style="padding:8px;font-size:11px">点击左侧信号树选择</div>`;
    return;
  }
  box.innerHTML = `<div class="sig-sidebar-title">已选信号 (${state.signals.length}/${MAX_SERIES})</div>` +
    state.signals.map(s => `
      <div class="sig-sidebar-row">
        <span class="dot" style="background:${s.color}"></span>
        <span class="sname" title="${s.signal}">${s.signal}</span>
        <span class="sval" id="sigval-${s.slot}">—</span>
        <span class="srm" title="移除" onclick="removeSignal(${s.slot})">✕</span>
      </div>`).join("");
}

/* 从已选列表移除信号 */
function removeSignal(slot) {
  const s = state.signals.find(x => x.slot === slot);
  if (!s) return;
  state.signals = state.signals.filter(x => x !== s);
  // 同步信号树中的选中态
  document.querySelectorAll(".sig-item.active").forEach(el => {
    if (el.dataset.sig === s.signal && String(el.dataset.ch) === String(s.channel)) {
      el.classList.remove("active");
    }
  });
  if (state.uplot) state.uplot.setSeries(slot, { show: false });
  draw();
}

function draw() {
  const u = state.uplot;
  const el = document.getElementById("plot-wrap");
  renderSigSidebar();   // 左侧已选信号列
  if (!state.signals.length) {
    if (u) {
      for (let i = 1; i <= MAX_SERIES; i++) u.setSeries(i, { show: false });
      u.setData([[], ...Array(MAX_SERIES).fill([])]);
    }
    document.getElementById("ro-signals").innerHTML = "";
    return;
  }
  // 时间轴对齐
  const xSet = new Set();
  for (const s of state.signals) for (const t of s.data.times) xSet.add(t);
  const x = Array.from(xSet).sort((a, b) => a - b);
  const per = {};
  for (const s of state.signals) {
    const v = new Array(x.length).fill(null);
    const t = s.data.times;
    let j = 0;
    for (let i = 0; i < x.length; i++) {
      while (j < t.length && t[j] < x[i]) j++;
      if (j < t.length && t[j] === x[i]) {
        const raw = s.data.values[j];
        // 值表信号 decode 返回 {name, value} 对象 → 取 value 数值画线
        v[i] = (raw != null && typeof raw === "object" && "value" in raw) ? raw.value : raw;
      }
    }
    per[s.slot] = v;
  }
  if (!u) {
    state.uplot = new uPlot(
      makeUplotOpts(),
      [x, ...Array(MAX_SERIES).fill([])],
      el);
    // 强制 canvas 物理尺寸 = 逻辑尺寸 × pxRatio(修正创建时 canvas 尺寸异常的问题)
    const cv = el.querySelector("canvas");
    if (cv) {
      cv.width = Math.round(state.uplot.width * uPlot.pxRatio);
      cv.height = Math.round(state.uplot.height * uPlot.pxRatio);
      cv.style.width = state.uplot.width + "px";
      cv.style.height = state.uplot.height + "px";
    }
    state.uplot.redraw();
  }
  // 每次绘制都同步系列显示配置(新加入的信号可能晚于创建)
  state.signals.forEach(s => applySeries(s));
  const data = [x];
  for (let i = 1; i <= MAX_SERIES; i++) data.push(per[i] || []);
  state.uplot.setData(data);
  // 注:不再手动赋值 scale 范围(uPlot 全自动:setData 后 x/y auto 计算;
  // 缩放走 setScale,手动赋值会绕过其状态管理导致滚轮/框选失效)
  // 手动刷新读数面板(注意:bbox 是物理像素,须除以 pxRatio 转 CSS 像素)
  const b = state.uplot.bbox;
  const pxr = uPlot.pxRatio || 1;
  onCursorMove(state.uplot, b.width / pxr / 2, b.height / pxr / 2);
}

/* 更新/隐藏某个系列槽位的显示配置 */
function applySeries(s) {
  const u = state.uplot;
  if (!u) return;
  const sl = u.series[s.slot];
  if (!sl) return;
  // 注意:uPlot 的 setSeries() 只处理 show/focus,其他字段必须直接操作 series 对象;
  // stroke/points.show 等绘制时被当作函数调用,必须用函数形式
  sl.show = true;
  sl.label = s.signal;
  sl.stroke = () => s.color;
  sl.scale = "y";
  sl.auto = true;
  sl.width = 1.5;
  if (sl.points) sl.points.show = () => false;
}

function makeUplotOpts() {
  const el = document.getElementById("plot-wrap");
  return {
    width: Math.max(200, el.clientWidth - 16),   // 防止窄窗口下宽度为负
    height: Math.max(200, el.clientHeight - 16),
    legend: { show: false },
    // 槽位 series 显式挂到 y scale 并参与 auto 计算(否则只算第一个信号,其它曲线消失)
    series: [{}, ...Array.from({ length: MAX_SERIES }, () => ({ show: false, scale: "y", auto: true }))],
    scales: {
      x: { time: false },   // auto 保持默认,由数据自动确定范围
      y: {
        auto: true,
        // 信号恒为同一值(如一直为 0)时 y 范围零跨度 → 扩开一格,否则画不出线。
        // ⚠️ range 必须返回数组(uPlot 内部直接 e[0]/e[1],返回 null 会崩)
        range: (u, dataMin, dataMax) => {
          if (dataMin == null || !isFinite(dataMin)) return [0, 1];
          if (dataMin === dataMax) return [dataMin - 1, dataMax + 1];
          const pad = (dataMax - dataMin) * 0.1;
          return [dataMin - pad, dataMax + pad];
        },
      },
    },
    axes: [
      { stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
        ticks: { stroke: "#3a4150" }, font: "11px ui-monospace, Menlo",
        values: (u, vals) => vals.map(v => v.toFixed(2) + "s") },
      { stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
        ticks: { stroke: "#3a4150" }, font: "11px ui-monospace, Menlo", size: 58 },
    ],
    series: [{}, ...Array(MAX_SERIES).fill({ show: false })],
    cursor: {
      x: true, y: true,
      stroke: "#7dd3fc", width: 1, dash: [4, 3],
      move: (u, x, y) => {
        onCursorMove(u, x, y);
        return [x, y];
      },
    },
    select: { show: true, fill: "rgba(77,163,255,.12)", stroke: "#4da3ff" },
    hooks: {
      setSelect: [(u) => {
        const { min, max } = u.select;
        u.setScale("x", { min, max });
      }],
      ready: [(u) => {
        u.over.addEventListener("wheel", (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 0.85 : 1.18;
          const cx = u.posToVal(e.offsetX, "x");
          u.batch(() => {
            const { min, max } = u.scales.x;
            u.setScale("x", {
              min: cx - (cx - min) * factor,
              max: cx + (max - cx) * factor,
            });
          });
        }, { passive: false });
      }],
    },
  };
}

/* ---------- 配置抽屉 ---------- */
async function toggleConfigDrawer() {
  const drawer = document.getElementById("config-drawer");
  const opening = !drawer.classList.contains("open");
  // 立即切换展开/收起(同步),不等待网络 —— 避免快速连点时的异步竞态
  drawer.classList.toggle("open");
  if (opening) {
    // 展开后后台填充数据,失败只提示不阻塞
    fillConfig().catch(e => showTip("配置加载失败: " + e.message));
  }
  // 图表尺寸由 ResizeObserver 逐帧跟随(见下方),无需手动 setTimeout
}

function resizeChart() {
  if (!state.uplot) return;
  const el = document.getElementById("plot-wrap");
  const w = Math.max(200, el.clientWidth - 16);
  const h = Math.max(200, el.clientHeight - 16);
  state.uplot.setSize({ width: w, height: h });
  // 高 DPI 修正:setSize 后手动同步 canvas 物理尺寸(否则 canvas 不跟随容器,
  // 抽屉展开时曲线区域不收缩,溢出部分被抽屉盖住,看起来像覆盖)
  const cv = el.querySelector("canvas");
  if (cv) {
    const pxr = uPlot.pxRatio || 1;
    cv.width = Math.round(w * pxr);
    cv.height = Math.round(h * pxr);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
  }
  state.uplot.redraw();
}

function drawerOpen() {
  return document.getElementById("config-drawer").classList.contains("open");
}

/* 左侧信号树展开/收起(与右侧配置抽屉对称) */
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  sb.classList.toggle("collapsed");
  setTimeout(resizeChart, 280);   // 主区域宽度变化 → 同步图表
}

async function fillConfig() {
  const cfg = state.config || {};
  document.getElementById("cfg-bus-type").value = cfg.bus_type || "canfd";
  const arb = document.getElementById("cfg-baud-arb");
  const data = document.getElementById("cfg-baud-data");
  arb.value = String(cfg.baudrate_arb || 500000);
  if (![...arb.options].some(o => o.value === arb.value)) arb.value = "500000";
  data.value = String(cfg.baudrate_data || 2000000);
  if (![...data.options].some(o => o.value === data.value)) data.value = "2000000";
  syncBusTypeUI();
  // 文件下拉
  const { files } = await api("/api/files");
  const blfSel = document.getElementById("cfg-blf");
  blfSel.innerHTML = '<option value="">— 请选择 —</option>' + files
    .filter(f => f.kind === ".blf")
    .map(f => `<option value="${f.name}">${f.name}</option>`).join("");
  blfSel.value = cfg.blf || state.blf || "";
  await refreshBlfViews(files);
  document.getElementById("config-tip").textContent = "";
}

/* 刷新配置抽屉:Bus Log 基本信息 + 通道 DBC 预览(按当前选中的 BLF,不依赖已保存配置) */
async function refreshBlfViews(files) {
  const blfName = document.getElementById("cfg-blf").value;
  const fileList = files || (await api("/api/files")).files;
  const dbcs = fileList.filter(f => f.kind === ".dbc");
  const infoBox = document.getElementById("blf-info");
  const chanBox = document.getElementById("cfg-channels");
  if (!blfName) {
    infoBox.innerHTML = "";
    chanBox.innerHTML = `<div class="hint">请选择 Bus Log 文件</div>`;
    return;
  }
  try {
    const st = await api(`/api/blf/${blfName}/stats`);
    const size = fileList.find(f => f.name === blfName)?.size || 0;
    const t0 = st.first_timestamp;
    infoBox.innerHTML =
      `<div>帧数 <b>${st.total_frames.toLocaleString()}</b> · 时长 <b>${st.duration_s.toFixed(2)} s</b> · 通道 <b>${(st.channels || []).length}</b></div>` +
      `<div>大小 <b>${(size / 1048576).toFixed(1)} MB</b> · 开始 <b>${t0 ? new Date(t0 * 1000).toLocaleString() : "—"}</b></div>` +
      (st.error_frames ? `<div class="blf-err">⚠ 错误帧 ${st.error_frames}</div>` : "");
    // 通道预览:按当前选中 BLF 的通道渲染;未保存的新选择 → 映射视为空(待重新配置)
    const blfChanged = blfName !== (state.config.blf || null);
    const chanCfg = blfChanged ? {} : (state.config.channels || {});
    const chans = st.channels || [{ channel: 0, frames: st.total_frames }];
    renderChanList(chans, chanCfg, dbcs);
  } catch (e) {
    infoBox.innerHTML = `<span class="blf-err">解析失败: ${e.message}</span>`;
    chanBox.innerHTML = `<div class="hint">解析失败</div>`;
  }
}

/* 渲染通道 DBC 下拉列表 */
function renderChanList(chans, chanCfg, dbcs) {
  const box = document.getElementById("cfg-channels");
  if (!chans.length) {
    box.innerHTML = `<div class="hint">该文件无通道数据</div>`;
    return;
  }
  box.innerHTML = chans.map(ch => {
    const cur = chanCfg[String(ch.channel)] || "";
    const optsHtml = '<option value="">— DBC —</option>' + dbcs.map(d =>
      `<option value="${d.name}" ${d.name === cur ? "selected" : ""}>${d.name}</option>`).join("");
    return `<div class="chan-row">
      <span class="chan-tag">CH${ch.channel}</span>
      <span class="chan-frames">${ch.frames.toLocaleString()} 帧</span>
      <select data-chan="${ch.channel}">${optsHtml}</select>
    </div>`;
  }).join("");
}

function syncBusTypeUI() {
  const isFd = document.getElementById("cfg-bus-type").value === "canfd";
  document.getElementById("row-baud-data").style.display = isFd ? "" : "none";
}

async function saveConfig() {
  const tip = document.getElementById("config-tip");
  // 收集每通道 DBC 映射
  const channels = {};
  document.querySelectorAll("#cfg-channels select[data-chan]").forEach(s => {
    if (s.value) channels[s.dataset.chan] = s.value;
  });
  const blfChanged = document.getElementById("cfg-blf").value !== (state.config.blf || null);
  const payload = {
    bus_type: document.getElementById("cfg-bus-type").value,
    baudrate_arb: parseInt(document.getElementById("cfg-baud-arb").value, 10),
    baudrate_data: parseInt(document.getElementById("cfg-baud-data").value, 10),
    blf: document.getElementById("cfg-blf").value || null,
    // BLF 变更 → 通道映射重置(不同 BLF 的通道/网络不同,旧映射无意义,默认为空)
    channels: blfChanged ? {} : channels,
  };
  if (!payload.blf) {
    tip.textContent = "请选择 Bus Log 文件";
    return;
  }
  try {
    state.config = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    document.getElementById("config-drawer").classList.remove("open");  // 保存后缩回
    await loadFiles();   // loadFiles 会用 state.config 重新加载
    showTip("配置已保存并应用");
  } catch (e) {
    tip.textContent = "保存失败: " + e.message;
  }
}

/* ---------- 数据加载 ---------- */
async function loadFiles() {
  const { files } = await api("/api/files");
  const blfs = files.filter(f => f.kind === ".blf");
  const dbcs = files.filter(f => f.kind === ".dbc");
  // 优先用配置指定的 Bus Log,否则取第一个
  const cfg = state.config || {};
  state.blf = (cfg.blf && blfs.find(f => f.name === cfg.blf)) ? cfg.blf : (blfs[0]?.name || null);
  if (!state.blf) throw new Error("缺少 BLF 文件,请先上传");
  document.getElementById("file-blf").textContent = "Bus Log: " + state.blf;
  document.getElementById("file-dbc").textContent = `DBC 已上传: ${dbcs.length} 个`;

  // 重置分析状态(文件可能已切换)
  state.signals = [];
  if (state.uplot) { state.uplot.destroy(); state.uplot = null; }
  document.getElementById("plot-wrap").innerHTML = "";
  document.getElementById("ro-signals").innerHTML = "";
  state.trace = { frameId: null, channel: null, offset: 0, limit: 200, search: null };

  state.stats = await api(`/api/blf/${state.blf}/stats`);
  state.t0 = state.stats.first_timestamp || 0;   // 绝对时间基准:曲线/读数/表格显示相对时间
  // 构建通道列表:每通道 DBC 只来自通道映射(不自动兜底,未配置即空,由用户指定)
  const chanCfg = state.config.channels || {};
  state.channels = (state.stats.channels || [{ channel: 0, frames: state.stats.total_frames }]).map(c => ({
    channel: c.channel,
    frames: c.frames,
    dbc: chanCfg[String(c.channel)] || null,
    messages: null,
  }));
  document.getElementById("st-frames").textContent = `帧数 ${state.stats.total_frames}`;
  document.getElementById("st-duration").textContent = `时长 ${state.stats.duration_s.toFixed(1)} s`;
  document.getElementById("st-ids").textContent = `报文数 ${state.stats.unique_ids}`;
  showTip(`日志开始: ${state.t0 ? new Date(state.t0 * 1000).toLocaleString() : "—"}(时间显示为相对秒)`);
  await loadDbcTree();
  renderStats();
}

async function loadDbcTree() {
  const tree = document.getElementById("msg-tree");
  tree.innerHTML = "";
  const sel = document.getElementById("trace-msg");
  sel.innerHTML = '<option value="">— 选择报文 —</option>';

  // 并行加载各通道 DBC 的报文列表
  await Promise.all(state.channels.map(async (ch) => {
    if (!ch.dbc) { ch.messages = []; return; }
    try {
      const { messages } = await api(`/api/dbc/${ch.dbc}/messages`);
      ch.messages = messages;
    } catch (e) {
      ch.messages = [];
      ch.error = e.message;
    }
  }));

  for (const ch of state.channels) {
    const g = document.createElement("div");
    g.className = "chan-group";
    const head = document.createElement("div");
    head.className = "chan-head";
    head.innerHTML = `<span class="caret">▸</span><span class="chan-head-title">通道 ${ch.channel}</span>
      <span class="chan-head-info">${ch.frames.toLocaleString()} 帧</span>
      <span class="chan-head-dbc" title="${ch.dbc || "未配置 DBC"}">${ch.dbc || "未配置 DBC"}</span>`;
    head.onclick = () => {
      const list = g.querySelector(".chan-body");
      const show = list.style.display === "none";
      list.style.display = show ? "" : "none";
      head.querySelector(".caret").textContent = show ? "▾" : "▸";
    };
    g.appendChild(head);

    const body = document.createElement("div");
    body.className = "chan-body";
    if (!ch.messages.length) {
      body.innerHTML = `<div class="hint">${ch.error ? "DBC 加载失败: " + ch.error :
        (ch.dbc ? "该 DBC 无报文" : "未配置 DBC,请在右侧配置中为该通道选择 DBC 文件")}</div>`;
    }
    for (const m of ch.messages) {
      // Trace 下拉:选项值 = "frameId|channel"
      const opt = document.createElement("option");
      opt.value = `${m.frame_id}|${ch.channel}`;
      opt.textContent = `CH${ch.channel} ${m.frame_id_hex} ${m.name}`;
      sel.appendChild(opt);
      const wrap = document.createElement("div");
      wrap.className = "msg-item";

      const mhead = document.createElement("div");
      mhead.className = "msg-head";
      mhead.innerHTML = `<span class="caret">▸</span><span class="msg-id">${m.frame_id_hex}</span>
        <span class="msg-name">${m.name}</span>
        <span class="msg-count">${m.signal_count} 信号</span>`;
      mhead.onclick = () => {
        const list = wrap.querySelector(".sig-list");
        const show = list.style.display === "none";
        list.style.display = show ? "" : "none";
        mhead.querySelector(".caret").textContent = show ? "▾" : "▸";
      };
      wrap.appendChild(mhead);

      const list = document.createElement("div");
      list.className = "sig-list";
      list.style.display = "none";
      for (const s of m.signals) {
        const item = document.createElement("div");
        item.className = "sig-item";
        item.innerHTML = `<span class="sig-dot"></span>
          <span class="sig-name">${s}</span>
          <span class="sig-unit">${m.frame_id_hex}</span>`;
        item.onclick = () => toggleSignal(m, s, item, ch.channel);
        item.dataset.sig = s;
        item.dataset.ch = String(ch.channel);
        list.appendChild(item);
      }
      wrap.appendChild(list);
      body.appendChild(wrap);
    }
    g.appendChild(body);
    tree.appendChild(g);
  }
  document.getElementById("tree-hint")?.remove();

  // 自动选中第一个通道的前两个信号(demo 便利)
  const firstCh = state.channels.find(c => c.messages && c.messages.length);
  if (firstCh && firstCh.messages.length > 0) {
    const m0 = firstCh.messages[0];
    if (m0.signals.length >= 2) {
      const sigs = document.querySelectorAll(".chan-group .sig-item");
      toggleSignal(m0, m0.signals[0], sigs[0], firstCh.channel);
      toggleSignal(m0, m0.signals[1], sigs[1], firstCh.channel);
    } else if (m0.signals.length > 0) {
      toggleSignal(m0, m0.signals[0], document.querySelector(".chan-group .sig-item"), firstCh.channel);
    }
  }

  // 初始化 Trace 面板
  onTraceMsgChange();
}

async function toggleSignal(msg, signal, item, channel) {
  const existing = state.signals.find(s => s.signal === signal && s.frame_id === msg.frame_id && s.channel === channel);
  if (existing) {
    state.signals = state.signals.filter(s => s !== existing);
    item.classList.remove("active");
    if (state.uplot) state.uplot.setSeries(existing.slot, { show: false });
    draw();
    return;
  }
  if (state.signals.length >= MAX_SERIES) {
    showTip(`最多同时显示 ${MAX_SERIES} 个信号`);
    return;
  }
  item.classList.add("active");
  const used = new Set(state.signals.map(s => s.color));
  const color = PALETTE.find(c => !used.has(c)) || PALETTE[state.signals.length % PALETTE.length];

  const ch = state.channels.find(c => c.channel === channel);
  const dbc = ch && ch.dbc;
  if (!dbc) {
    item.classList.remove("active");
    showTip(`通道 ${channel} 未配置 DBC,请在右侧配置中为该通道选择 DBC 文件`);
    return;
  }

  const detail = await api(`/api/dbc/${dbc}/messages/${msg.frame_id_hex}`);
  const sigDef = detail.signals.find(s => s.name === signal);
  const unit = sigDef?.unit || "";
  // 值表信号:保存 choices 映射 {raw值: {name, value}},读数时显示名称
  const choices = sigDef?.choices || null;

  const data = await api(`/api/blf/${state.blf}/decode?dbc=${encodeURIComponent(dbc)}` +
    `&frame_id=${msg.frame_id_hex}&signal=${encodeURIComponent(signal)}&channel=${channel}&max_points=200000`);
  // 绝对时间戳 → 相对时间(以日志起始为 0)
  data.times = data.times.map(t => t - state.t0);
  // 槽位分配须与 push 同步完成(避免并发请求拿到相同槽位)
  const usedSlots = new Set(state.signals.map(s => s.slot));
  const slot = [1, 2, 3, 4, 5, 6].find(i => !usedSlots.has(i));
  state.signals.push({ frame_id: msg.frame_id, signal, unit, color, slot, data, channel, dbc, choices });
  draw();
}

/* ---------- 导出 ---------- */
document.getElementById("btn-export").onclick = () => {
  if (!state.signals.length) {
    showTip("请先选择至少一个信号");
    return;
  }
  const s = state.signals[0];
  const q = new URLSearchParams({
    dbc: s.dbc,
    frame_id: "0x" + s.frame_id.toString(16),
    channel: String(s.channel),
  });
  window.location.href = `/api/blf/${state.blf}/export?${q.toString()}`;
};

document.getElementById("btn-reset").onclick = () => {
  if (state.signals.length && state.uplot) {
    const x = state.uplot.data[0];
    state.uplot.setScale("x", { min: x[0], max: x[x.length - 1] });
  }
};
// 用 ResizeObserver 观察图表容器:抽屉/信号树展开动画期间容器宽度逐帧变化,
// canvas 同步逐帧跟随 → 收缩丝滑无跳变(uPlot setSize 轻量,小数据无压力)
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(() => resizeChart());
  ro.observe(document.getElementById("plot-wrap"));
}
window.addEventListener("resize", () => resizeChart());   // 整窗缩放兜底

/* 已选信号列宽度拖拽调整 */
(function initSigResizer() {
  const resizer = document.getElementById("sig-resizer");
  const sidebar = document.getElementById("sig-sidebar");
  let drag = null;
  resizer.addEventListener("mousedown", (e) => {
    drag = { startX: e.clientX, startW: sidebar.offsetWidth };
    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const w = Math.max(80, Math.min(320, drag.startW + (e.clientX - drag.startX)));
    sidebar.style.width = w + "px";
    // plot-wrap 宽度被 ResizeObserver 感知 → 曲线自动跟随
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = null;
    resizer.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    resizeChart();   // 兜底:确保曲线尺寸对齐
  });
})();

/* ---------- Trace 表格 ---------- */
function onTraceMsgChange() {
  const val = document.getElementById("trace-msg").value;
  if (!val) { state.trace.frameId = null; return; }
  const [fid, ch] = val.split("|");
  state.trace.frameId = parseInt(fid, 10);
  state.trace.channel = parseInt(ch, 10);
  state.trace.offset = 0;
  state.trace.search = null;
  fillTraceSig();
  document.getElementById("trace-sig-val").value = "";
  document.getElementById("trace-clear").style.display = "none";
  loadTrace();
}

/* 填充 Trace 搜索的信号下拉(当前报文的信号列表) */
function fillTraceSig() {
  const sel = document.getElementById("trace-sig");
  const ch = state.channels.find(c => c.channel === state.trace.channel);
  const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === state.trace.frameId) : null;
  sel.innerHTML = '<option value="">— 信号 —</option>' + (msg ? msg.signals
    .map(s => `<option value="${s}">${s}</option>`).join("") : "");
}

function doTraceSearch() {
  const signal = document.getElementById("trace-sig").value;
  const value = document.getElementById("trace-sig-val").value.trim();
  if (!signal || !value) {
    showTip("请选择信号并输入要搜索的值/状态名");
    return;
  }
  state.trace.search = { signal, value };
  state.trace.offset = 0;
  document.getElementById("trace-clear").style.display = "";
  loadTrace();
}

function clearTraceSearch() {
  state.trace.search = null;
  state.trace.offset = 0;
  document.getElementById("trace-sig-val").value = "";
  document.getElementById("trace-clear").style.display = "none";
  loadTrace();
}

async function loadTrace() {
  const fid = state.trace.frameId;
  const ch = state.trace.channel;
  if (fid == null) {
    document.getElementById("trace-body").innerHTML =
      `<tr><td colspan="5" class="hint">请选择报文</td></tr>`;
    return;
  }
  const body = document.getElementById("trace-body");
  body.innerHTML = `<tr><td colspan="5" class="hint">加载中…</td></tr>`;
  // 用该通道绑定的 DBC
  const chan = state.channels.find(c => c.channel === ch);
  const dbc = chan && chan.dbc;
  if (!dbc) {
    body.innerHTML = `<tr><td colspan="5" class="hint">通道 ${ch} 未配置 DBC,请先在右侧配置中设置</td></tr>`;
    return;
  }
  let url = `/api/blf/${state.blf}/frames?dbc=${encodeURIComponent(dbc)}` +
    `&frame_id=${fid}&channel=${ch}&limit=${state.trace.limit}&offset=${state.trace.offset}&decode=false`;
  if (state.trace.search) {
    url += `&sig_filter=${encodeURIComponent(state.trace.search.signal)}` +
           `&sig_value=${encodeURIComponent(state.trace.search.value)}`;
  }
  const r = await api(url);
  const info = document.getElementById("trace-info");
  if (state.trace.search) {
    info.innerHTML = `<span class="trace-search-on">🔍 ${state.trace.search.signal}=${state.trace.search.value}</span> · 匹配 ${state.trace.offset + 1}-${state.trace.offset + r.returned} 帧`;
  } else {
    info.textContent = `第 ${state.trace.offset + 1}-${state.trace.offset + r.returned} 帧`;
  }
  document.getElementById("trace-prev").disabled = state.trace.offset === 0;
  document.getElementById("trace-next").disabled = r.returned < state.trace.limit;

  body.innerHTML = "";
  for (const f of r.frames) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="t-time">${(f.timestamp - state.t0).toFixed(3)}</td>
      <td class="t-id">${f.id_hex}</td><td>${f.name}</td><td>${f.dlc}</td>
      <td class="t-data">${f.data}</td>`;
    body.appendChild(tr);
  }
  if (!r.returned) body.innerHTML = `<tr><td colspan="5" class="hint">${state.trace.search ? "无匹配帧" : "无数据"}</td></tr>`;
}

function tracePage(dir) {
  state.trace.offset = Math.max(0, state.trace.offset + dir * state.trace.limit);
  loadTrace();
}

/* ---------- ID 统计 ---------- */
function renderStats() {
  const box = document.getElementById("stats-box");
  const ids = state.stats.by_id;
  if (!ids.length) { box.innerHTML = `<div class="hint">无数据</div>`; return; }
  const max = Math.max(...ids.map(e => e.count));
  box.innerHTML = ids.map(e => {
    const hexId = e.frame_id_hex || "0x" + e.frame_id.toString(16);
    return `
    <div class="stat-row">
      <span class="stat-id">${hexId}</span>
      <div class="stat-bar-bg"><div class="stat-bar" style="width:${(e.count / max * 100).toFixed(1)}%"></div></div>
      <span class="stat-count">${e.count} 帧</span>
      <span class="stat-rate">${e.rate_hz != null ? e.rate_hz + " Hz" : "—"}</span>
    </div>`;
  }).join("");
}

/* ---------- 标签页 ---------- */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === name));
  document.getElementById("panel-trace").style.display = name === "trace" ? "" : "none";
  document.getElementById("panel-stats").style.display = name === "stats" ? "" : "none";
  if (name === "trace" && !state.trace.frameId) onTraceMsgChange();
  if (name === "stats") renderStats();
}

document.getElementById("cfg-bus-type").addEventListener("change", syncBusTypeUI);
// 切换 Bus Log → 即时刷新文件信息 + 通道 DBC 预览(未保存前映射视为空)
document.getElementById("cfg-blf").addEventListener("change", () => refreshBlfViews());

async function init() {
  try { state.config = await api("/api/config"); } catch (e) { state.config = {}; }
  await loadFiles();
}

init().catch(e => {
  document.getElementById("tree-hint").textContent = "加载失败: " + e.message;
});