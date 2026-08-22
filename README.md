# BLF/DBC 网页解析分析平台

基于网页的 CAN 总线数据分析工具:上传 **BLF 日志文件**(CANoe/CANalyzer 记录格式)与 **DBC 数据库文件**(报文/信号定义),在浏览器中完成解析、解码与可视化。服务端部署在**树莓派**上,局域网内任意设备通过浏览器访问。

---

## 项目概述

| 项目 | 说明 |
|---|---|
| 目标 | 摆脱对 CANoe/CANalyzer 等商业工具的依赖,用网页完成日常 CAN 数据分析 |
| 使用方式 | 局域网内打开浏览器 → 上传 .blf + .dbc → 查看信号曲线、报文统计、导出数据 |
| 部署形态 | 树莓派 4/5(ARM64)常驻运行,支持 systemd 自启动 |
| 输入 | .blf(日志)、.dbc(数据库)、.csv(可选导出) |
| 输出 | 信号时序图、报文统计、解码后的 CSV/JSON |

## 核心功能(需求拆解一览)

| # | 模块 | 功能 | 优先级 |
|---|---|---|---|
| 1 | 文件管理 | BLF/DBC 上传、列表、删除;大文件(GB 级)分块上传 | P0 |
| 2 | DBC 解析 | 报文 ID、信号定义(起始位/长度/缩放/偏移/单位/值表)展示 | P0 |
| 3 | BLF 解析 | 流式读取 CAN/CAN FD 帧,按 ID 统计帧数、频率、错误帧 | P0 |
| 4 | 信号解码 | 按 DBC 规则将原始帧解码为物理值(如 12.5 V、3000 rpm) | P0 |
| 5 | 可视化 | 信号时序曲线(时间轴缩放/多信号对比)、ID 分布柱状图 | P1 |
| 6 | 数据导出 | 解码结果导出 CSV / JSON,供外部工具进一步分析 | P1 |
| 7 | 总线分析 | 总线负载率、周期抖动、CAN FD 统计、错误帧列表 | P2 |
| 8 | 部署运维 | 树莓派 systemd 服务、局域网访问、日志轮转 | P0 |

## 技术选型(概览,详见 docs/需求分析与技术选型.md)

| 部分 | 选型 | 一句话理由 |
|---|---|---|
| BLF 解析 | Python + `python-can`(BLFReader)/ `vblf` | 生态成熟,现成库直接读写 BLF |
| DBC 解析 | Python + `cantools` | CAN 领域事实标准,纯 Python 零依赖负担 |
| Web 后端 | Python + FastAPI + Uvicorn | 异步高性能,自带 API 文档,树莓派上轻量 |
| 前端 | 原生 HTML/JS + ECharts(备选 Vue3) | 图表能力强,静态资源由树莓派托管,压力小 |
| 部署 | Raspberry Pi OS + systemd(+ Nginx 反向代理) | 免 Docker 开销,ARM 上最稳 |

## 目录结构

```
blf-dbc-web/
├── README.md                    # 本文件
├── docs/
│   └── 需求分析与技术选型.md     # 需求拆解 + 语言选型分析
├── backend/                     # FastAPI 后端
│   ├── app/
│   │   ├── main.py              # 入口
│   │   ├── api/                 # 路由:上传/解析/解码/导出
│   │   ├── parsers/             # blf_parser.py / dbc_parser.py
│   │   └── services/            # 解码引擎、统计引擎
│   ├── requirements.txt
│   └── tests/
├── frontend/                    # 前端静态资源
│   ├── index.html
│   ├── js/                      # 视图逻辑、ECharts 配置
│   └── css/
├── data/                        # 上传文件存储(运行时)
└── deploy/                      # systemd 单元、Nginx 配置
```

## 开发里程碑

- **M1 核心解析 API**:BLF/DBC 上传与解析、信号解码接口(后端可跑通)
- **M2 前端可视化**:文件管理页 + 信号曲线页 + 统计页
- **M3 树莓派部署**:systemd 服务、局域网访问、性能验证(GB 级文件)

## 本地开发运行

```bash
cd backend
# 1. 安装依赖(注意:须与启动 uvicorn 用同一个 Python 解释器)
python3 -m pip install -r requirements.txt
# 2. 生成测试数据(data/uploads/test.dbc + test.blf)
python3 scripts/make_test_data.py
# 3. 启动服务
python3 -m uvicorn app.main:app --port 8000
```

- 交互式 API 文档(OpenAPI): http://127.0.0.1:8000/docs
- 已实现的接口:
  - `GET /api/health` 健康检查
  - `GET/POST/DELETE /api/files...` 文件上传 / 列表 / 删除
  - `GET /api/dbc/{name}/messages` 报文列表
  - `GET /api/dbc/{name}/messages/{frame_id}` 信号详情(frame_id 支持十进制或 0x 前缀)
  - `GET /api/blf/{name}/stats` BLF 流式统计(帧数/频率/错误帧/按 ID 聚合)
  - `GET /api/blf/{name}/decode?dbc=&frame_id=&signal=&start=&end=&max_points=` 信号解码时间序列

> ⚠️ macOS 上可能存在多个 Python 解释器(pip 安装用的与 PATH 中的 `python3` 不一致),务必用**同一个**解释器执行 pip install 与 uvicorn,否则报 `No module named uvicorn`。

## 运行环境

- 开发机:macOS(当前)/ 任意平台
- 部署机:树莓派 4(建议 ≥4GB RAM)或 5,Raspberry Pi OS(Bookworm, ARM64)
- Python ≥ 3.10
