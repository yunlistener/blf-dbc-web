# BLF/DBC 网页解析分析平台

基于网页的 CAN 总线数据分析工具:上传 **BLF 日志文件**(/CANalyzer 记录格式)与 **DBC 数据库文件**(报文/信号定义),在浏览器中完成解析、解码与可视化。服务端部署在**树莓派**上,局域网内任意设备通过浏览器访问。

> 📦 代码仓库:https://github.com/yunlistener/blf-dbc-web

---

## 项目概述

| 项目 | 说明 |
|---|---|
| 目标 | 摆脱对商业工具的依赖,用网页完成日常 CAN 数据分析 |
| 使用方式 | 局域网内打开浏览器 → 上传 .blf + .dbc → 查看信号曲线、报文统计、导出数据 |
| 部署形态 | 树莓派 4/5(ARM64)常驻运行,支持 systemd 自启动 |
| 输入 | .blf(日志)、.dbc(数据库) |
| 输出 | 信号时序图、报文统计、解码后的 CSV/JSON(导出规划中) |

## 当前进度

| 阶段 | 状态 |
|---|---|
| **M1 后端 API**(上传/解析/统计/解码) | ✅ 完成,curl 端到端验证通过 |
| **M2 前端**( 风格:多信号曲线/光标读数/缩放) | ✅ 完成 |
| **M2 功能**(Trace 报文表格、ID 统计图、CSV 导出) | ✅ 完成 |
| **M2 剩余**(文件上传页面) | ⏳ 待做(API 已就绪) |
| **M3 树莓派部署**(systemd 服务、局域网访问、性能验证) | 🔶 已验证可运行;systemd 自启待做 |
| **M4 播放 + 大文件处理**(SQLite 数据源:构建中播放/内存恒定/全部显示) | ✅ 完成(dev,待验收后发布) |

## 核心功能(需求拆解一览)

| # | 模块 | 功能 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | 文件管理 | BLF/DBC 上传、列表、删除;大文件(GB 级)分块上传 | P0 | ✅ 基础版;分块 ⏳ |
| 2 | DBC 解析 | 报文 ID、信号定义(起始位/长度/缩放/偏移/单位/值表)展示 | P0 | ✅ |
| 3 | BLF 解析 | 流式读取 CAN/CAN FD 帧,按 ID 统计帧数、频率、错误帧 | P0 | ✅ |
| 4 | 信号解码 | 按 DBC 规则将原始帧解码为物理值(如 12.5 V、3000 rpm) | P0 | ✅ 支持时间区间 + 降采样 |
| 5 | 可视化 | 信号时序曲线(时间轴缩放/光标读数/多信号叠加)、ID 分布图 | P1 | ✅ 多信号叠加 + ID 统计图 |
| 6 | 数据导出 | 解码结果导出 CSV / JSON | P1 | ✅ CSV(单报文多信号) |
| 7 | 总线分析 | 总线负载率、周期抖动、CAN FD 统计、错误帧列表 | P2 | ⏳ |
| 8 | 部署运维 | 树莓派 systemd 服务、局域网访问、日志轮转 | P0 | ⏳(M3) |

## 技术选型(概览,详见 docs/需求分析与技术选型.md)

| 部分 | 选型 | 理由 |
|---|---|---|
| BLF 解析 | Python + `python-can`(BLFReader) | 生态成熟,ARM64 有预编译 wheel,流式解析 |
| DBC 解析 | Python + `cantools` | CAN 领域事实标准,纯 Python |
| Web 后端 | Python + FastAPI + Uvicorn | 异步不阻塞、自带 API 文档、内存 <100MB |
| 前端图表 | **chartjs**(已落地,本地 vendor 免 CDN) | 性能最优化 |
| 前端框架 | 原生 HTML/JS | 零构建,树莓派只托管静态文件 |
| 部署 | Raspberry Pi OS + systemd | 开机自启、免 Docker 开销 |


## 目录结构

```
blf-dbc-web/
├── README.md                        # 本文件
├── docs/
│   └── 需求分析与技术选型.md         # 需求拆解 + 语言选型分析
├── backend/                         # FastAPI 后端
│   ├── app/
│   │   ├── main.py                  # 入口(API 路由 + 前端静态托管)
│   │   ├── config.py                # 路径/常量
│   │   ├── api/                     # files / dbc / blf 路由 + ws(播放)
│   │   └── services/                # decoder / playback / frame_source / blf_cache
│   ├── pyproject.toml               # uv 依赖声明(uv sync 生成 .venv + uv.lock)
│   ├── uv.lock
│   └── scripts/make_test_data.py    # 测试数据生成
├── frontend/                        # 前端(由后端静态托管)
│   ├── index.html                   # 界面
│   ├── css/style.css                # 深色主题
│   ├── js/app.js                    # 报文树 / Chart.js 曲线 / 播放 / 光标读数 / 缩放
│   └── vendor/                      # chart.js 本地库(不依赖 CDN)
└── data/uploads/                    # 上传文件存储 + 测试数据
```

## 本地开发运行

```bash
cd backend
# 1. 创建虚拟环境并安装依赖(自动生成 .venv/ + uv.lock)
uv sync
# 2. 生成测试数据(data/uploads/test.dbc + test.blf)
uv run python scripts/make_test_data.py
# 3. 启动服务(uv 虚拟环境内)
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000
# 或直接 .venv/bin/python -m uvicorn app.main:app --port 8000
```

- **Web 界面**: http://127.0.0.1:8000/ ( 风格:CAN 分析仪)
- **交互式 API 文档**(OpenAPI): http://127.0.0.1:8000/docs
- 打开页面后自动加载测试数据并显示第一个信号曲线,可点击左侧报文/信号树切换信号

### 已实现的界面功能(风格)

- 深色主题 + 顶部工具栏 + 底部状态栏(总帧数/时长/报文数)
- 报文/信号树:按报文展开信号,点击加载曲线,**多示波器窗口**(最多 64 个信号,同窗共享 y 轴,颜色区分)
- **信号时序曲线**(Chart.js):独立时间轴、光标竖线同步(全窗口)、tooltip 读数(值表信号显示 名称(值))
- **CANoe 式播放**:配置信号 → 点播放 → 后端逐帧解析经 WebSocket 推送,曲线在固定时间轴上动态增长(速率 0.5x~5x,进度条拖拽定位)
- **缩放/平移**:普通滚轮=页面滚动,Ctrl+滚轮=缩放(限窗 0.5s,全窗口同步),拖拽平移,重置按钮;x 范围钳制 [0,日志时长]
- **测量锚点**:点击设锚点,红色竖线全窗口同步,显示 Δt/频率
- **Trace 报文流**:报文帧表格(时间/ID/DLC/hex 数据/解码信号值),分页浏览
- **ID 统计**:各报文帧数/频率横向条形图
- **导出 CSV**:工具栏按钮,导出当前报文全部信号(带 UTF-8 BOM,Excel 可直接打开)

### 已实现的后端接口

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 健康检查 |
| `GET /api/files` / `POST /api/files/upload` / `DELETE /api/files/{name}` | 文件列表 / 上传 / 删除 |
| `GET /api/dbc/{name}/messages` | DBC 报文列表 |
| `GET /api/dbc/{name}/messages/{frame_id}` | 信号详情(frame_id 支持十进制或 0x 前缀) |
| `GET /api/blf/{name}/stats` | BLF 流式统计(帧数/频率/错误帧/按 ID 聚合) |
| `GET /api/blf/{name}/decode?dbc=&frame_id=&signal=&start=&end=&max_points=` | 信号解码时间序列(区间过滤 + 降采样) |
| `GET /api/blf/{name}/signal-stats` / `cycle-stats` / `bus-load` | 信号统计 / 报文周期抖动 / 总线负载 |
| `WS /ws/replay` | 播放通道(config/play/pause/stop/seek/rate;batch 帧批次推送) |

> 💡 依赖统一由 **uv** 管理(`uv sync` 自动解析依赖并锁定 `uv.lock`),不再依赖系统 Python 的 pip 包;uvicorn 启动必须用 `.venv` 内的解释器(或 `uv run`),避免与系统 Python 混淆。

## 运行环境

- 开发机:macOS(当前)/ 任意平台,需安装 [uv](https://docs.astral.sh/uv/)
- 部署机:树莓派 4(建议 ≥4GB RAM)或 5,Raspberry Pi OS(Bookworm, ARM64)—— 同样用 uv 管理(ARM64 有预编译 wheel)
- Python ≥ 3.10(uv 自动选用)
