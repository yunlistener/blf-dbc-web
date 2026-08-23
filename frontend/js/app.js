/* CANoe 风格前端逻辑:文件 → 报文树 → 多信号曲线 → Trace → 统计 */
"use strict";

const PALETTE = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff",
                 "#4dd6c8", "#f472b6", "#a3e635", "#fb923c", "#60a5fa",
                 "#fda4af", "#93c5fd", "#c4b5fd", "#86efac", "#fcd34d",
                 "#7dd3fc", "#f0abfc", "#bef264", "#fdba74", "#a5b4fc"];  // 20 色循环
const MAX_SERIES = 64;   // 最多同时显示 64 个信号

const state = {
  blf: null,
  dbc: null,
  stats: null,
  signals: [],       // 已选信号 [{frame_id, signal, unit, color, slot, data, channel, dbc, plotId}]
  plots: [],         // 示波器 [{id, el, canvasEl, uplot, sigs: [...]}]
  plotIds: [],       // 示波器 id 有序列表(含空示波器)
  plotSeq: 1,        // 下一个示波器 ID
  xRange: null,      // 时间轴同步范围(缩放后 {min, max});null = 自动
  trace: { frameId: null, channel: null, offset: 0, limit: 200, search: null, range: null },
  config: {},        // 工程配置(总线/波特率/文件/通道映射)
  channels: [],      // [{channel, frames, dbc, messages}]
  hasData: null,     // Set<frame_id> 日志中实际出现的报文 ID
  lastCursorT: null, // 最后光标时刻(相对秒,信号行 tooltip 显示用)
  jitterMarks: [],   // [{t, color}] 抖动峰值时间点(相对秒),示波器 x 轴标记
  anchorT: null,     // 测量锚点时间(相对秒);点击设置,再点清除
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
  // 忽略 ResizeObserver 良性循环警告(浏览器自动重调度,非真实错误)
  if (e.message && e.message.includes("ResizeObserver loop")) return;
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
/* 值表信号格式化显示:数值 或 名称(值) */
function fmtSigVal(s, v) {
  if (v != null && typeof v === "number" && s.choices) {
    const c = s.choices[String(v)];
    if (c && c.name) return `${c.name}(${v})`;
  }
  return fmtVal(v);
}

/* 带单位的信号值显示:数值信号 → "92.5 °C";值表信号无单位,原样 */
function fmtSigValUnit(s, v) {
  const t = fmtSigVal(s, v);
  return (s.unit && v != null && typeof v === "number") ? `${t} ${s.unit}` : t;
}

/* 统计数值加单位(供表格用) */
function fmtUnit(s, v) {
  return (v == null) ? "—" : (s.unit ? `${v} ${s.unit}` : String(v));
}

const cursorTip = document.getElementById("cursor-tip");
function hideCursorTip() { cursorTip.style.display = "none"; }

function showCursorTipAt(x, y, html) {
  cursorTip.innerHTML = html;
  cursorTip.style.display = "block";
  // 防止超出视口边缘
  let tx = x + 14, ty = y - 12;
  const tw = cursorTip.offsetWidth, th = cursorTip.offsetHeight;
  if (tx + tw > window.innerWidth - 8) tx = x - tw - 14;
  if (ty + th > window.innerHeight - 8) ty = y - th - 14;
  cursorTip.style.left = Math.max(8, tx) + "px";
  cursorTip.style.top = Math.max(8, ty) + "px";
}

/* 更新已选信号列的值(不弹 tooltip) */
function updateSigVals(u, x) {
  const idx = u.posToIdx(x);
  const p = state.plots.find(pp => pp.uplot === u);
  if (!p) return;
  p.sigs.forEach((s, i) => {
    const v = u.data[i + 1] ? u.data[i + 1][idx] : null;
    const valEl = document.getElementById(`sigval-${s.slot}`);
    if (valEl) valEl.textContent = fmtSigValUnit(s, v);
  });
}

/* 光标移动:更新信号列值 + 显示 tooltip(时间 + 本示波器信号值) */
function onCursorMove(u, x, y) {
  updateSigVals(u, x);
  const t = u.posToVal(x, "x");
  state.lastCursorT = t;   // 记录最后光标时刻(信号行 tooltip 用)
  const idx = u.posToIdx(x);
  const p = state.plots.find(pp => pp.uplot === u);
  const rows = [`<div class="tip-row">时间 <b>${t.toFixed(3)} s</b></div>`];
  // 双点测量:锚点存在时显示 Δt 与频率
  if (state.anchorT != null) {
    const dt = t - state.anchorT;
    rows.push(`<div class="tip-row" style="color:#ffd75e">锚点 ${state.anchorT.toFixed(3)}s · Δ <b>${dt >= 0 ? "+" : ""}${dt.toFixed(3)} s</b>` +
      (dt !== 0 ? ` (${(1 / Math.abs(dt)).toFixed(2)} Hz)` : "") + `</div>`);
  }
  if (p) p.sigs.forEach((s, i) => {
    const v = u.data[i + 1] ? u.data[i + 1][idx] : null;
    rows.push(`<div class="tip-row"><span class="dot" style="background:${s.color}"></span>` +
      `${s.signal}: <b>${fmtSigVal(s, v)}</b><span class="u">${s.unit || ""}</span>${ecuTagHtml(s)}</div>`);
  });
  // x/y 是 bbox 内 CSS 坐标 → 转页面坐标(bbox 是物理像素,除以 pxRatio)
  const rect = u.over.getBoundingClientRect();
  const pxr = uPlot.pxRatio || 1;
  showCursorTipAt(rect.left + u.bbox.left / pxr + x, rect.top + u.bbox.top / pxr + y, rows.join(""));
}

/* 发送 ECU 的彩色 tag HTML(信号所属报文的第一发送者) */
function ecuTagHtml(s) {
  const ecu = s.senders && s.senders.length ? s.senders[0] : "";
  if (!ecu) return "";
  const nc = nodeColor(ecu);
  return ` <span class="msg-tag" style="background:${nc}26;border-color:${nc}55;color:${nc}">${ecu}</span>`;
}

/* 已选信号行 hover:显示该信号详情(时间/ECU/值表名称/说明) */
function showSigRowTip(s, el) {
  const rect = el.getBoundingClientRect();
  const ch = state.channels.find(c => c.channel === s.channel);
  const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === s.frame_id) : null;
  const val = document.getElementById(`sigval-${s.slot}`)?.textContent || "—";
  const t = state.lastCursorT != null ? state.lastCursorT.toFixed(3) + " s" : "—";
  const html =
    `<div class="tip-row"><b>${s.signal}</b> <span class="u">${s.unit || ""}</span>${ecuTagHtml(s)}</div>` +
    `<div class="tip-dim">报文 ${msg ? msg.name : ""} (0x${s.frame_id.toString(16)}) · 通道 ${s.channel} · 时间 ${t}</div>` +
    `<div class="tip-row">当前值 <b>${val}</b></div>` +
    (s.comment ? `<div class="tip-dim" style="white-space:normal;max-width:280px">💬 ${s.comment}</div>` : "");
  showCursorTipAt(rect.right + 8, rect.top, html);
}

/* 左侧已选信号列:颜色标记 + 信号名 + 当前值 + 示波器分配 + 移除 */
function renderSigSidebar() {
  const box = document.getElementById("sig-sidebar");
  if (!state.signals.length) {
    box.innerHTML = `<div class="sig-sidebar-title">已选信号</div>
      <div class="hint" style="padding:8px;font-size:11px">点击左侧信号树选择</div>`;
    return;
  }
  // 示波器 id 列表(含空示波器)
  const plotIds = state.plotIds.slice().sort((a, b) => a - b);
  const plotOptions = pid => plotIds.map(x =>
    `<option value="${x}" ${x === pid ? "selected" : ""}>示波器 ${x}</option>`).join("");
  box.innerHTML = `<div class="sig-sidebar-title">已选信号 (${state.signals.length}/${MAX_SERIES})
      <span class="sig-sidebar-actions">
        <button class="btn-mini" onclick="addPlot()" title="增加空示波器">+</button>
        <button class="btn-mini" onclick="removePlot()" title="删除空示波器">−</button>
      </span></div>` +
    state.signals.map(s => `
      <div class="sig-sidebar-row" id="sigrow-${s.slot}">
        <span class="dot" style="background:${s.color}"></span>
        <span class="sname" title="${s.signal}">${s.signal}</span>
        <span class="sval" id="sigval-${s.slot}">—</span>
        <select class="plot-sel" title="显示在哪个示波器" onchange="moveSignalToPlot(${s.slot}, this.value)">${plotOptions(s.plotId)}</select>
        <span class="srm" title="移除" onclick="removeSignal(${s.slot})">✕</span>
      </div>`).join("");
  // 行 hover → tooltip 显示信号详情
  state.signals.forEach(s => {
    const row = document.getElementById(`sigrow-${s.slot}`);
    if (!row) return;
    row.addEventListener("mouseenter", () => showSigRowTip(s, row));
    row.addEventListener("mouseleave", hideCursorTip);
  });
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
  saveSelectedSignals();   // 持久化:刷新后恢复
  draw();   // syncPlots 会自动移除空示波器
  if (currentTab() === "sigstats") loadSigStats();
}

/* 将信号移动到指定示波器 */
function moveSignalToPlot(slot, pid) {
  const s = state.signals.find(x => x.slot === slot);
  if (!s) return;
  s.plotId = parseInt(pid, 10);
  saveSelectedSignals();   // 窗口分配也持久化(刷新后保持合并关系)
  draw();                  // 全量重建:目标窗口 y 范围自动重算(覆盖全部信号)
}

/* 已选信号持久化(localStorage,含 blf 名防止跨文件误恢复) */
const LS_SIG = "selectedSignals";
function saveSelectedSignals() {
  try {
    localStorage.setItem(LS_SIG, JSON.stringify({
      blf: state.blf,
      signals: state.signals.map(s => ({ frame_id: s.frame_id, signal: s.signal, channel: s.channel, plotId: s.plotId })),
    }));
  } catch (e) { /* 忽略 */ }
}
// 页面关闭/刷新前兜底保存(防任何遗漏路径)
window.addEventListener("beforeunload", () => {
  if (state.signals.length) saveSelectedSignals();
});
async function restoreSelectedSignals() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SIG) || "null");
    if (!saved || saved.blf !== state.blf || !saved.signals || !saved.signals.length) return 0;
    const items = Array.from(document.querySelectorAll(".chan-group .sig-item"));
    let restored = 0;
    for (const rec of saved.signals.slice(0, MAX_SERIES)) {
      const item = items.find(el =>
        el.dataset.sig === rec.signal &&
        el.dataset.ch === String(rec.channel) &&
        parseInt(el.closest(".msg-item").querySelector(".msg-id").textContent, 16) === rec.frame_id);
      const ch = state.channels.find(c => c.channel === rec.channel);
      const msg = ch && ch.messages ? ch.messages.find(m => m.frame_id === rec.frame_id) : null;
      if (item && msg && state.hasData.has(rec.frame_id)) {
        await toggleSignal(msg, rec.signal, item, rec.channel);
        restored++;
      }
    }
    // 恢复窗口分配:按保存的 plotId 分组(刷新后保持信号合并到同一示波器的关系)
    const savedIds = saved.signals.map(r => r.plotId).filter(x => x != null);
    if (savedIds.length && state.signals.length) {
      state.plotIds = [...new Set(savedIds)].sort((a, b) => a - b);
      state.signals.forEach((s, i) => { s.plotId = savedIds[i] ?? s.plotId; });
      state.plotSeq = Math.max(state.plotSeq, ...state.plotIds) + 1;
      draw();
    }
    return restored;
  } catch (e) {
    return 0;
  }
}

/* ============ 多示波器示波器(CANoe 式) ============ */
function draw() {
  renderSigSidebar();   // 左侧已选信号列(含示波器分配下拉)
  if (!state.signals.length) {
    state.plots.forEach(p => { if (p.uplot) p.uplot.destroy(); p.el.remove(); });
    state.plots = [];
    hideCursorTip();
    return;
  }
  syncPlots();
}

/* 按示波器 id 列表同步所有 plot 实例(含空示波器) */
function syncPlots() {
  const wrap = document.getElementById("plot-wrap");
  const ids = state.plotIds.slice().sort((a, b) => a - b);
  const keep = new Set(ids);
  // 销毁消失的示波器
  state.plots = state.plots.filter(p => {
    if (!keep.has(p.id)) { if (p.uplot) p.uplot.destroy(); p.el.remove(); return false; }
    return true;
  });
  // 创建缺失的示波器容器
  ids.forEach(id => {
    let p = state.plots.find(x => x.id === id);
    if (!p) {
      const el = document.createElement("div");
      el.className = "plot-item";
      const title = document.createElement("div");
      title.className = "plot-title";
      el.appendChild(title);
      const canvasEl = document.createElement("div");
      canvasEl.className = "plot-canvas";
      el.appendChild(canvasEl);
      wrap.appendChild(el);
      p = { id, el, canvasEl, uplot: null, title };
      state.plots.push(p);
    }
    p.sigs = state.signals.filter(s => s.plotId === id);
  });
  state.plots.forEach(p => updatePlotData(p));
  resizeChart();   // 强制同步所有窗口尺寸(防创建时布局未就绪导致画布异常)
}

/* 添加一个空示波器 */
function addPlot() {
  state.plotIds.push(state.plotSeq++);
  draw();
}
/* 移除最后一个空示波器(非空提示) */
function removePlot() {
  for (let i = state.plotIds.length - 1; i >= 0; i--) {
    if (!state.signals.some(s => s.plotId === state.plotIds[i])) {
      state.plotIds.splice(i, 1);
      draw();
      return;
    }
  }
  showTip("所有示波器都含有信号,请先移除信号再删除示波器");
}

/* 单个示波器的数据与实例 */
function updatePlotData(p) {
  const sigs = p.sigs;
  // 标题:示波器号 + 色点 + 信号名
  p.title.innerHTML = `<span style="color:#4da3ff;font-weight:600">示波器 ${p.id}</span>` +
    (sigs.length
      ? sigs.map(s => `<span class="pt-dot" style="background:${s.color}"></span><span>${s.signal}${s.unit ? " (" + s.unit + ")" : ""}</span>`).join("")
      : `<span style="color:#5c6472">(空)在左侧已选信号中分配信号,或点 [+]</span>`);
  // 空示波器:不创建 uPlot
  if (!sigs.length) {
    if (p.uplot) { p.uplot.destroy(); p.uplot = null; }
    p.canvasEl.innerHTML = "";
    return;
  }
  // x 轴:本示波器内信号时间并集
  const xSet = new Set();
  for (const s of sigs) for (const t of s.data.times) xSet.add(t);
  const x = Array.from(xSet).sort((a, b) => a - b);
  const per = {};
  sigs.forEach((s, i) => {
    const v = new Array(x.length).fill(null);
    const t = s.data.times;
    let j = 0;
    for (let k = 0; k < x.length; k++) {
      while (j < t.length && t[j] < x[k]) j++;
      if (j < t.length && t[j] === x[k]) {
        const raw = s.data.values[j];
        // 值表信号 decode 返回 {name, value} 对象 → 取 value 数值画线
        v[k] = (raw != null && typeof raw === "object" && "value" in raw) ? raw.value : raw;
      }
    }
    per[i + 1] = v;
  });
  const data = [x, ...sigs.map((_, i) => per[i + 1] || [])];
  if (!p.uplot) {
    p.uplot = new uPlot(makePlotOpts(p), data, p.canvasEl);
    // 强制 canvas 物理尺寸 = 逻辑尺寸 × pxRatio(修正创建时 canvas 尺寸异常)
    const cv = p.canvasEl.querySelector("canvas");
    if (cv) {
      cv.width = Math.round(p.uplot.width * uPlot.pxRatio);
      cv.height = Math.round(p.uplot.height * uPlot.pxRatio);
      cv.style.width = p.uplot.width + "px";
      cv.style.height = p.uplot.height + "px";
    }
    p.uplot.redraw();
  } else {
    p.uplot.setData(data);
  }
  // 每个信号独立 y 轴范围(CANoe 式):用该信号自身数据,同窗互不压扁
  sigs.forEach((s, i) => {
    const key = i === 0 ? "y" : "y" + (i + 1);
    let lo = Infinity, hi = -Infinity;
    for (const v of per[i + 1]) {
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) { lo = 0; hi = 1; }
    else if (lo === hi) { lo -= 1; hi += 1; }          // 恒值信号(如全 0)扩开
    else { const pad = (hi - lo) * 0.15; lo -= pad; hi += pad; }
    p.uplot.setScale(key, { min: lo, max: hi });
  });
  // 显式设置 x 范围:uPlot 对后创建的窗口 x scale 不自动计算(实测 undefined),
  // 导致 x 轴 _show=false 不绘制 → 这里手动算(数据范围或同步范围)
  const xData = p.uplot.data[0];
  if (state.xRange) {
    p.uplot.setScale("x", state.xRange);
  } else if (xData && xData.length) {
    p.uplot.setScale("x", { min: xData[0], max: xData[xData.length - 1] });
  }
  // x 轴显示:只有最后一个非空窗口(动态更新,窗口增减/信号移动时生效)
  const maxNonEmpty = Math.max(-1, ...state.plots.filter(x => x.sigs && x.sigs.length).map(x => x.id));
  const xAxis = p.uplot.axes[0];
  if (xAxis && xAxis.show !== (p.id === maxNonEmpty)) {
    xAxis.show = p.id === maxNonEmpty;
    p.uplot.redraw();
  }
  // 刷新本示波器信号的已选列值
  const b = p.uplot.bbox;
  const pxr = uPlot.pxRatio || 1;
  updateSigVals(p.uplot, b.width / pxr / 2);
}

/* 时间轴同步:任一示波器缩放/平移 → 广播到所有示波器 */
let syncingX = false;
function broadcastX(u, min, max) {
  if (syncingX) return;
  syncingX = true;
  state.xRange = { min, max };
  state.plots.forEach(p => {
    if (p.uplot && p.uplot !== u) p.uplot.setScale("x", { min, max });
  });
  syncingX = false;
}

/* 单个示波器窗口的 uPlot 配置 */
function makePlotOpts(p) {
  const sigs = p.sigs;
  // 共享时间轴:只有最后一个非空窗口显示 x 轴刻度(其余隐藏,网格线保留)
  const maxNonEmpty = Math.max(-1, ...state.plots.filter(x => x.sigs && x.sigs.length).map(x => x.id));
  const isLast = p.id === maxNonEmpty;
  // 每个信号独立 y 轴(CANoe 式):第 1 个左轴,其余右轴(信号色刻度),同窗不互相压扁
  const series = [{}, ...sigs.map((s, i) => ({
    show: true, label: s.signal, stroke: () => s.color,
    scale: i === 0 ? "y" : "y" + (i + 1),
    auto: true, width: 2,
    points: { show: () => false },
  }))];
  const scales = { x: { time: false } };
  // 预创建 10 个 y 轴 scale(窗口信号数增减时 series 引用的 scale 始终存在)
  for (let i = 0; i < 10; i++) scales[i === 0 ? "y" : "y" + (i + 1)] = { auto: true };
  const axes = [
    // x 轴(下):只在最后一个非空窗口显示 → 视觉上共享一条时间轴
    // ⚠️ 必须显式 scale:"x",否则 uPlot 会按 side 猜测分配成 y scale(实测 y 轴错位)
    { scale: "x", show: isLast, stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
      ticks: { stroke: "#3a4150" }, font: "11px ui-monospace, Menlo",
      values: (u, vals) => vals.map(v => v.toFixed(2) + "s") },
    // 第 1 个信号:左 y 轴
    { scale: "y", side: 0, show: true, stroke: "#8a93a3", grid: { stroke: "#242830", width: 1 },
      ticks: { stroke: "#3a4150" }, font: "10px ui-monospace, Menlo", size: 46 },
  ];
  // 其余信号:独立右轴(信号色刻度);未使用的 y 轴显式隐藏,防止 uPlot 自动生成多余轴
  for (let i = 1; i < 10; i++) {
    const key = "y" + (i + 1);
    const s = sigs[i];
    axes.push(s
      ? { scale: key, side: 2, show: true, stroke: s.color,
          grid: { show: false }, ticks: { stroke: s.color },
          font: "10px ui-monospace, Menlo", size: 40 }
      : { scale: key, side: 2, show: false });
  }
  return {
    width: Math.max(200, p.canvasEl.clientWidth - 8),
    height: Math.max(100, p.canvasEl.clientHeight - 4),
    legend: { show: false },
    series,
    scales,
    axes,
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
        broadcastX(u, min, max);
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
          const { min, max } = u.scales.x;
          broadcastX(u, min, max);
        }, { passive: false });
        u.over.addEventListener("mouseleave", hideCursorTip);   // 移出图表 → 隐藏 tooltip
        // 双点测量:点击设置/清除锚点(黄色三角标记,移动光标显示 Δt)
        u.over.addEventListener("click", (e) => {
          state.anchorT = (state.anchorT == null) ? u.posToVal(e.offsetX, "x") : null;
          state.plots.forEach(pp => { if (pp.uplot) pp.uplot.redraw(); });
        });
      }],
      // 时间轴顶部标记:测量锚点(黄)+ 本示波器信号的抖动峰值
      draw: [(u) => {
        const ctx = u.ctx;
        ctx.save();
        if (state.anchorT != null) {
          const px = u.valToPos(state.anchorT, "x", true);
          if (px != null && isFinite(px)) {
            ctx.fillStyle = "#ffd75e";
            ctx.globalAlpha = 0.95;
            ctx.beginPath();
            ctx.moveTo(px - 4, 0);
            ctx.lineTo(px + 4, 0);
            ctx.lineTo(px, -7);
            ctx.fill();
          }
        }
        if (showJitterMarks() && state.jitterMarks && state.jitterMarks.length) {
          const p = state.plots.find(pp => pp.uplot === u);
          const sigNames = new Set((p ? p.sigs : []).map(s => s.signal));
          state.jitterMarks.forEach(m => {
            if (!sigNames.has(m.signal)) return;
            const px = u.valToPos(m.t, "x", true);
            if (px == null || !isFinite(px)) return;
            ctx.fillStyle = m.color;
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.moveTo(px - 4, 0);
            ctx.lineTo(px + 4, 0);
            ctx.lineTo(px, -7);
            ctx.fill();
          });
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }],
    },
  };
}

/* ---------- 配置抽屉 ---------- */
/* 抖动峰值标记开关(localStorage 持久化,默认开) */
function showJitterMarks() {
  return localStorage.getItem("jitterMarks") !== "0";
}
function onJitterMarkToggle() {
  localStorage.setItem("jitterMarks",
    document.getElementById("cfg-jitter-mark").checked ? "1" : "0");
  state.plots.forEach(p => { if (p.uplot) p.uplot.redraw(); });
}

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
  if (!state.plots.length) return;
  const wrap = document.getElementById("plot-wrap");
  const w = Math.max(200, wrap.clientWidth - 8);       // 上下排列:窗口横贯全宽
  state.plots.forEach(p => {
    if (!p.uplot) return;
    const h = Math.max(80, p.el.clientHeight - 26);    // 减标题高度
    p.uplot.setSize({ width: w, height: h });
    // 高 DPI 修正:setSize 后手动同步 canvas 物理尺寸
    const cv = p.canvasEl.querySelector("canvas");
    if (cv) {
      const pxr = uPlot.pxRatio || 1;
      cv.width = Math.round(w * pxr);
      cv.height = Math.round(h * pxr);
      cv.style.width = w + "px";
      cv.style.height = h + "px";
    }
  });
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
  document.getElementById("cfg-jitter-mark").checked = showJitterMarks();   // 显示开关状态
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
  state.plots.forEach(p => { if (p.uplot) p.uplot.destroy(); });
  state.plots = [];
  state.plotIds = [];
  state.plotSeq = 1;
  state.xRange = null;
  document.getElementById("plot-wrap").innerHTML = "";
  hideCursorTip();
  document.getElementById("busload-box").dataset.loaded = "";   // 文件切换 → Bus Load 重新加载
  state.trace = { frameId: null, channel: null, offset: 0, limit: 200, search: null, range: null };

  state.stats = await api(`/api/blf/${state.blf}/stats`);
  state.t0 = state.stats.first_timestamp || 0;   // 绝对时间基准:曲线/读数/表格显示相对时间
  state.hasData = new Set((state.stats.by_id || []).map(e => e.frame_id));  // 日志中实际出现的报文
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
      const sender = (m.senders && m.senders.length) ? m.senders[0] : "";
      const senderTip = (m.senders || []).join(", ");
      const nc = sender ? nodeColor(sender) : "";
      mhead.innerHTML = `<span class="caret">▸</span>
        ${sender ? `<span class="msg-tag" style="background:${nc}26;border-color:${nc}55;color:${nc}" title="发送节点: ${senderTip}">${sender}</span>` : ""}
        <span class="msg-id">${m.frame_id_hex}</span>
        <span class="msg-name">${m.name}</span>
        <span class="msg-count">${m.signal_count} 信号</span>`;
      mhead.onclick = () => {
        const list = wrap.querySelector(".sig-list");
        const show = list.style.display === "none";
        list.style.display = show ? "" : "none";
        mhead.querySelector(".caret").textContent = show ? "▾" : "▸";
      };
      // 日志中无此报文 → 灰色标记(点击信号时快速提示)
      if (!state.hasData.has(m.frame_id)) mhead.classList.add("no-data");
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

  // 恢复上次选择的信号(刷新保留);无保存则自动选中第一个有数据的报文前两个信号
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(LS_SIG) || "null");
    restored = !!(saved && saved.blf === state.blf && saved.signals && saved.signals.length);
  } catch (e) { /* 忽略 */ }
  if (restored) {
    const n = await restoreSelectedSignals();
    if (n > 0) showTip(`已恢复上次选择的 ${n} 个信号`);
    return;
  }
  const firstCh = state.channels.find(c => c.messages && c.messages.length);
  if (firstCh) {
    const m0 = firstCh.messages.find(m => state.hasData.has(m.frame_id));
    const items = Array.from(document.querySelectorAll(".chan-group .sig-item"));
    const findItem = (sig) => items.find(el =>
      el.dataset.sig === sig &&
      el.dataset.ch === String(firstCh.channel) &&
      el.closest(".msg-item")?.querySelector(".msg-id")?.textContent === m0.frame_id_hex);
    if (m0 && m0.signals.length >= 2) {
      toggleSignal(m0, m0.signals[0], findItem(m0.signals[0]), firstCh.channel);
      toggleSignal(m0, m0.signals[1], findItem(m0.signals[1]), firstCh.channel);
    } else if (m0 && m0.signals.length > 0) {
      toggleSignal(m0, m0.signals[0], findItem(m0.signals[0]), firstCh.channel);
    }
  }

  // 初始化 Trace 面板
  onTraceMsgChange();
}

/* ECU 节点标签调色板:同一节点始终同色 */
const NODE_COLORS = ["#4da3ff", "#ffb84d", "#5ad47a", "#ff6b6b", "#c77dff",
                     "#4dd6c8", "#f472b6", "#a3e635", "#fb923c", "#60a5fa"];
function nodeColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NODE_COLORS[h % NODE_COLORS.length];
}

/* 信号树搜索:按报文 ID(hex)/报文名/发送 ECU/信号名实时过滤 */
function filterTree(q) {
  q = (q || "").trim().toLowerCase();
  const qHex = q.replace(/^0x/, "");
  document.querySelectorAll(".chan-group").forEach(g => {
    let groupVisible = false;
    g.querySelectorAll(".msg-item").forEach(item => {
      const head = item.querySelector(".msg-head");
      const idTxt = head.querySelector(".msg-id").textContent.toLowerCase();     // "0x21"
      const nameTxt = head.querySelector(".msg-name").textContent.toLowerCase();
      const sigList = item.querySelector(".sig-list");
      const caret = head.querySelector(".caret");

      let msgMatch = false;
      let sigMatch = false;
      if (!q) {
        msgMatch = true;
      } else {
        const senderTxt = head.querySelector(".msg-tag")?.textContent.toLowerCase() || "";
        msgMatch = idTxt.includes(q) || idTxt.replace("0x", "").includes(qHex) ||
                   nameTxt.includes(q) || senderTxt.includes(q);
        // 信号匹配:显示命中的信号项
        sigList.querySelectorAll(".sig-item").forEach(si => {
          const sn = si.querySelector(".sig-name").textContent.toLowerCase();
          const hit = sn.includes(q);
          si.style.display = hit ? "" : "none";
          if (hit) sigMatch = true;
        });
      }

      const show = !q || msgMatch || sigMatch;
      item.style.display = show ? "" : "none";
      if (show) {
        if (q && sigMatch && !msgMatch) {
          // 只有信号命中 → 展开信号列表展示匹配项
          sigList.style.display = "";
          caret.textContent = "▾";
        } else if (!q) {
          // 清空搜索 → 恢复默认折叠
          sigList.style.display = "none";
          caret.textContent = "▸";
        }
        groupVisible = true;
      }
    });
    g.style.display = groupVisible ? "" : "none";
    g.querySelector(".chan-body").style.display = groupVisible ? "" : "none";
    g.querySelector(".chan-head .caret").textContent = groupVisible ? "▾" : "▸";
  });
}

/* 信号树排序:按 frame ID 或发送 ECU */
let treeSortMode = "id";
function toggleTreeSort() {
  treeSortMode = treeSortMode === "id" ? "ecus" : "id";
  document.getElementById("tree-sort").textContent =
    treeSortMode === "id" ? "排序: ID" : "排序: ECU";
  sortTree();
}
function sortTree() {
  const mode = treeSortMode;
  document.querySelectorAll(".chan-group .chan-body").forEach(body => {
    const items = Array.from(body.querySelectorAll(".msg-item"));
    items.sort((a, b) => {
      const idA = parseInt(a.querySelector(".msg-id").textContent, 16);
      const idB = parseInt(b.querySelector(".msg-id").textContent, 16);
      if (mode === "ecus") {
        const ea = (a.querySelector(".msg-tag")?.textContent || "").toLowerCase();
        const eb = (b.querySelector(".msg-tag")?.textContent || "").toLowerCase();
        if (ea !== eb) return ea < eb ? -1 : 1;
      }
      return idA - idB;
    });
    items.forEach(it => body.appendChild(it));
  });
  // 排序后重新应用当前搜索
  filterTree(document.getElementById("tree-search").value);
}

async function toggleSignal(msg, signal, item, channel) {
  const existing = state.signals.find(s => s.signal === signal && s.frame_id === msg.frame_id && s.channel === channel);
  if (existing) {
    state.signals = state.signals.filter(s => s !== existing);
    item.classList.remove("active");
    saveSelectedSignals();
    draw();   // syncPlots 自动销毁空示波器
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
  // 日志中无此报文 → 快速提示,不进入加载(避免卡在选中态)
  if (state.hasData && !state.hasData.has(msg.frame_id)) {
    item.classList.remove("active");
    showTip(`报文 ${msg.frame_id_hex} 在日志中无数据(该通道未发送),无法画曲线`);
    return;
  }

  let detail, data;
  try {
    detail = await api(`/api/dbc/${dbc}/messages/${msg.frame_id_hex}`);
    data = await api(`/api/blf/${state.blf}/decode?dbc=${encodeURIComponent(dbc)}` +
      `&frame_id=${msg.frame_id_hex}&signal=${encodeURIComponent(signal)}&channel=${channel}&max_points=200000`);
  } catch (e) {
    item.classList.remove("active");   // 失败回滚选中态,可再次点击
    showTip(`加载失败: ${e.message}`);
    return;
  }
  if (!data.times || !data.times.length) {
    item.classList.remove("active");
    showTip(`报文 ${msg.frame_id_hex} 在日志中无数据(该通道未发送),无法画曲线`);
    return;
  }
  const sigDef = detail.signals.find(s => s.name === signal);
  const unit = sigDef?.unit || "";
  // 值表信号:保存 choices 映射 {raw值: {name, value}},读数时显示名称
  const choices = sigDef?.choices || null;
  const comment = sigDef?.comment || "";        // 信号说明文字
  const senders = detail.senders || [];          // 发送 ECU

  // 绝对时间戳 → 相对时间(以日志起始为 0)
  data.times = data.times.map(t => t - state.t0);
  // 槽位分配须与 push 同步完成(避免并发请求拿到相同槽位)
  const usedSlots = new Set(state.signals.map(s => s.slot));
  const slot = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
                31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
                45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58,
                59, 60, 61, 62, 63, 64].find(i => !usedSlots.has(i));
  // 默认每信号新建一个示波器
  const pid = state.plotSeq++;
  state.plotIds.push(pid);
  state.signals.push({ frame_id: msg.frame_id, signal, unit, color, slot, data, channel, dbc, choices, comment, senders, plotId: pid });
  saveSelectedSignals();   // 持久化:刷新后恢复
  draw();
  // 信号统计 tab 已打开时,新选信号要刷新统计
  if (currentTab() === "sigstats") loadSigStats();
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
  // 缩放区间导出:示波器有缩放时,只导出当前 x 轴范围(时间同步,取任一示波器)
  const p0 = state.plots.find(x => x.uplot);
  if (p0) {
    const sx = p0.uplot.scales.x;
    if (sx.min != null && sx.max != null) {
      q.set("start", String(sx.min));
      q.set("end", String(sx.max));
    }
  }
  window.open(`/api/blf/${state.blf}/export?${q}`, "_blank");
  showTip("正在导出 CSV(按当前缩放区间)…");
};

document.getElementById("btn-reset").onclick = () => {
  state.xRange = null;
  state.plots.forEach(p => {
    if (!p.uplot) return;
    const x = p.uplot.data[0];
    if (x && x.length) p.uplot.setScale("x", { min: x[0], max: x[x.length - 1] });
  });
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

/* 按示波器当前缩放区间过滤 Trace(读取 uPlot x 轴范围) */
function applyTraceRange() {
  const p0 = state.plots.find(x => x.uplot);
  if (!p0) { showTip("请先在示波器上缩放出区间"); return; }
  const sx = p0.uplot.scales.x;
  if (sx.min == null || sx.max == null) { showTip("请先在示波器上缩放出区间"); return; }
  state.trace.range = { start: sx.min, end: sx.max };
  state.trace.offset = 0;
  document.getElementById("trace-range-clear").style.display = "";
  loadTrace();
}
function clearTraceRange() {
  state.trace.range = null;
  state.trace.offset = 0;
  document.getElementById("trace-range-clear").style.display = "none";
  loadTrace();
}

async function loadTrace() {
  const fid = state.trace.frameId;
  const ch = state.trace.channel;
  if (fid == null) {
    document.getElementById("trace-body").innerHTML =
      `<tr><td colspan="6" class="hint">请选择报文</td></tr>`;
    return;
  }
  const body = document.getElementById("trace-body");
  body.innerHTML = `<tr><td colspan="6" class="hint">加载中…</td></tr>`;
  // 用该通道绑定的 DBC
  const chan = state.channels.find(c => c.channel === ch);
  const dbc = chan && chan.dbc;
  if (!dbc) {
    body.innerHTML = `<tr><td colspan="6" class="hint">通道 ${ch} 未配置 DBC,请先在右侧配置中设置</td></tr>`;
    return;
  }
  let url = `/api/blf/${state.blf}/frames?dbc=${encodeURIComponent(dbc)}` +
    `&frame_id=${fid}&channel=${ch}&limit=${state.trace.limit}&offset=${state.trace.offset}&decode=false`;
  if (state.trace.range) {
    url += `&start=${state.trace.range.start}&end=${state.trace.range.end}`;
  }
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
      <td class="t-id">${f.id_hex}</td><td>${f.name}</td>
      <td>${f.dlc}${f.is_fd ? `<span class="fd-tag">FD</span>` : ""}</td>
      <td>CH${f.channel}</td>
      <td class="t-data">${f.data}</td>`;
    body.appendChild(tr);
  }
  if (!r.returned) body.innerHTML = `<tr><td colspan="6" class="hint">${state.trace.search ? "无匹配帧" : "无数据"}</td></tr>`;
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
  document.getElementById("panel-sigstats").style.display = name === "sigstats" ? "" : "none";
  if (name === "trace" && !state.trace.frameId) onTraceMsgChange();
  if (name === "stats") { renderStats(); loadBusLoad(); }
  if (name === "sigstats") loadSigStats();
}

/* Bus Load 概览条(ID 统计 tab 顶部) */
async function loadBusLoad() {
  const box = document.getElementById("busload-box");
  if (box.dataset.loaded) return;
  try {
    const r = await api(`/api/blf/${state.blf}/bus-load`);
    const items = Object.entries(r.channels || {}).map(([ch, v]) =>
      `<div class="busload-item">通道 ${ch} <b>${v.bus_load_pct}%</b>
        <span class="dim">${v.frames.toLocaleString()} 帧 · 占用 ${v.bus_time_s}s/${v.duration_s}s</span></div>`).join("");
    box.innerHTML = `<div class="busload-item">总线负载 <b>${r.bus_type.toUpperCase()}</b>
        <span class="dim">仲裁 ${(r.arbitration_baudrate / 1000)}k · 数据 ${(r.data_baudrate / 1000)}k</span></div>` + items;
    box.dataset.loaded = "1";
  } catch (e) {
    box.innerHTML = `<div class="busload-item dim">Bus Load 加载失败: ${e.message}</div>`;
  }
}

/* ---------- 示波器高度三档 ---------- */
let chartMode = 1;   // 0=全部页面 1=2/3 页面 2=全部收缩
function cycleChartMode() {
  chartMode = (chartMode + 1) % 3;
  applyChartMode();
}
function applyChartMode() {
  const chart = document.getElementById("chart");
  const tabs = document.getElementById("tabs");
  const ind = document.getElementById("chart-mode-ind");
  const panelIds = ["panel-trace", "panel-stats", "panel-sigstats"];
  if (chartMode === 0) {
    // 全部页面:只有示波器
    chart.style.display = "";
    chart.style.flex = "1";
    chart.style.minHeight = "";
    tabs.style.display = "none";
    panelIds.forEach(id => document.getElementById(id).style.display = "none");
    ind.textContent = "▔ 全页";
    hideCursorTip();
  } else {
    chart.style.display = "";
    chart.style.minHeight = "";
    tabs.style.display = "";
    if (chartMode === 1) {
      chart.style.flex = "2";          // 示波器 2/3,面板 1/3
      ind.textContent = "▁▔ 2/3";
    } else {
      chart.style.flex = "0 1 0%";     // 全部收缩:示波器收起,面板占满
      chart.style.minHeight = "0";
      ind.textContent = "▁ 收起";
    }
    switchTab(currentTab());           // 恢复当前 tab 的面板显示
  }
  setTimeout(resizeChart, 60);         // 高度变化 → 同步 uPlot
}

/* 当前底部 tab */
function currentTab() {
  return document.querySelector("#tabs .tab.active")?.dataset.tab || "trace";
}

/* 信号统计 tab:已选信号的数值统计 + 所属报文周期/抖动/丢帧 */
async function loadSigStats() {
  const box = document.getElementById("sigstats-box");
  if (!state.signals.length) {
    box.innerHTML = `<div class="hint">请先选择信号(点击左侧信号树)</div>`;
    return;
  }
  box.innerHTML = `<div class="hint">加载中…</div>`;
  state.jitterMarks = [];   // 重建抖动峰值标记
  try {
    const ch = state.channels.find(c => c.channel === state.signals[0].channel);
    const dbc = (ch && ch.dbc) || state.signals[0].dbc;
    const rows = [];
    const msgCache = {};
    for (const s of state.signals) {
      const st = await api(`/api/blf/${state.blf}/signal-stats?dbc=${encodeURIComponent(dbc)}` +
        `&frame_id=0x${s.frame_id.toString(16)}&signal=${encodeURIComponent(s.signal)}&channel=${s.channel}`);
      let cs = msgCache[s.frame_id];
      if (!cs) {
        cs = await api(`/api/blf/${state.blf}/cycle-stats?dbc=${encodeURIComponent(dbc)}` +
          `&frame_id=0x${s.frame_id.toString(16)}&channel=${s.channel}`);
        msgCache[s.frame_id] = cs;
      }
      // 抖动峰值时间点 → 示波器 x 轴标记(记录信号名,按示波器过滤)
      if (cs.jitter_max_at != null) {
        state.jitterMarks.push({ t: cs.jitter_max_at - state.t0, color: s.color, signal: s.signal });
      }
      rows.push({ s, st, cs });
    }
    // 信号统计表
    let html = `<table class="sig-stats"><thead><tr>
      <th>信号</th><th>通道</th><th>点数</th><th>min</th><th>max</th><th>mean</th><th>std</th><th>最后值</th><th>超范围</th>
      </tr></thead><tbody>`;
    for (const { s, st } of rows) {
      const oorTitle = st.range_min != null || st.range_max != null
        ? `定义范围 [${st.range_min ?? "—"}, ${st.range_max ?? "—"}]` : "";
      html += `<tr>
        <td><span class="dot" style="background:${s.color};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px"></span>${s.signal}</td>
        <td>CH${s.channel}</td>
        <td>${st.count}</td>
        <td>${fmtUnit(s, st.min)}</td><td>${fmtUnit(s, st.max)}</td>
        <td>${fmtUnit(s, st.mean)}</td><td>${fmtUnit(s, st.std)}</td>
        <td>${fmtUnit(s, st.last)}</td>
        <td title="${oorTitle}" class="${(st.out_of_range ?? 0) > 0 ? "warn" : ""}">${st.out_of_range != null ? `${st.out_of_range} 个` : "—"}</td>
      </tr>`;
      if (st.choices_dist) {
        const dist = Object.entries(st.choices_dist)
          .map(([k, v]) => `${k}: ${v}`).join(" · ");
        html += `<tr><td colspan="8" style="color:#8a93a3">状态分布: ${dist}</td></tr>`;
      }
    }
    html += `</tbody></table>`;
    // 报文周期段
    const seenMsg = new Set();
    html += `<table class="sig-stats"><tbody>`;
    for (const { s, cs } of rows) {
      if (seenMsg.has(s.frame_id)) continue;
      seenMsg.add(s.frame_id);
      const exp = cs.expected_ms ? `${cs.expected_ms} ms` : "—";
      html += `<tr class="sec"><td colspan="8">报文 ${cs.name} (0x${s.frame_id.toString(16)}) · CH${s.channel}</td></tr>
        <tr>
          <td>期望周期</td><td>${exp}</td><td>实测平均</td><td>${cs.avg_ms ?? "—"} ms</td>
          <td>min</td><td>${cs.min_ms ?? "—"} ms</td><td>max</td><td>${cs.max_ms ?? "—"} ms</td>
        </tr>
        <tr>
          <td>抖动(峰峰)</td><td class="${(cs.jitter_ms ?? 0) > (cs.expected_ms || 1) * 0.3 ? "warn" : ""}">${cs.jitter_ms ?? "—"} ms${cs.jitter_max_at != null ? ` <span style="color:#8a93a3">@ ${(cs.jitter_max_at - state.t0).toFixed(3)}s</span>` : ""}</td>
          <td>丢帧</td><td class="${(cs.lost_frames ?? 0) > 0 ? "warn" : ""}">${cs.lost_frames ?? "—"}</td>
          <td>丢帧率</td><td>${cs.lost_pct ?? "—"}%</td><td colspan="2"></td>
        </tr>`;
    }
    html += `</tbody></table>`;
    box.innerHTML = html;
    // 抖动峰值标记已更新 → 重绘示波器
    state.plots.forEach(p => { if (p.uplot) p.uplot.redraw(); });
  } catch (e) {
    box.innerHTML = `<div class="hint">加载失败: ${e.message}</div>`;
  }
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