# Agent Observatory

本地运行的多 Agent 工作流可视化工具。通过各工具的原生 hooks 采集 **Cursor / Claude Code / Codex** 的会话、子 agent、工具调用、思考与失败，实时展示 agent 关系图、时间线与指标，并在任务结束时和每 30 分钟向你汇报（Dashboard 汇报面板 + Windows 桌面通知）。自研 Python 多 agent 程序可用单文件 SDK 接入。

## 启动

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python main.py          # 首次会自动 npm 构建前端；打开 http://127.0.0.1:7777
```

前端开发模式：`cd frontend; npm install; npm run dev`（5173 端口，/api 与 /ws 代理到 7777）。

## 接入 Cursor / Claude Code / Codex

```powershell
python hooks/install.py                 # 自动检测 ~/.cursor ~/.claude ~/.codex 并写入用户级 hooks
python hooks/install.py cursor codex    # 只装指定工具
python hooks/install.py --uninstall     # 移除本工具的条目，保留其他 hooks
```

- 幂等；首次修改前会备份为 `.bak`。
- Codex：安装器会在 `~/.codex/config.toml` 打开 `[features] hooks = true`，需在 Codex 里用 `/hooks` 批准一次。
- hook 脚本 `hooks/observe_hook.py` 仅用标准库，1.5 秒超时、失败静默、永远 exit 0，服务没开也不影响你的 agent。
- 一次会话 = 一个 Run；子 agent（Cursor subagent / Claude Task / Codex subagent）作为子节点挂在主 agent 下，其内部的工具调用归属到子 agent。

## 在自己的 Python 多 agent 程序中接入

```python
from observatory.sdk import Tracer   # 单文件、仅标准库，可直接拷贝到其他项目

tr = Tracer(title="分析文档")
with tr.agent("planner") as planner:
    with tr.task(planner, "拆分任务"):
        with tr.llm(planner, model="gpt-4o", input=prompt) as call:
            call.output, call.input_tokens, call.output_tokens = ...
        tr.message(planner, "researcher", "查一下 X")
tr.end()
```

也可以直接 `POST /api/events`（单个或数组），字段见 `GET /api/schema`。示例：`python examples/multi_agent_demo.py`（8 个场景：单 agent、串行、并行、agent→tool→agent、agent 失败、工具失败、LLM 失败、并发 run）。

## 汇报

- 每轮任务结束：写入 Reports 面板；耗时 ≥ `OBSERVATORY_NOTIFY_MIN_SECONDS`（默认 20）或失败时弹桌面通知。
- 定时摘要：每 `OBSERVATORY_REPORT_INTERVAL_MIN` 分钟（默认 30），有活动才发，仅显示在 Web 的 Reports 面板。
- 手动：Reports 面板按钮，或 `python main.py report`（仅 Web / 终端）。
- 桌面通知只在任务运行结束时弹出，其他汇报都在 Web 中完成。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OBSERVATORY_HOST` / `OBSERVATORY_PORT` | `127.0.0.1` / `7777` | 服务地址 |
| `OBSERVATORY_URL` | `http://127.0.0.1:7777` | hook 脚本 / SDK 上报地址 |
| `OBSERVATORY_DB` | `data/observatory.db` | SQLite，重启后回放 |
| `OBSERVATORY_REPORT_INTERVAL_MIN` | `30` | 定时摘要间隔 |
| `OBSERVATORY_NOTIFY` | `1` | `0` 关闭桌面通知 |
| `OBSERVATORY_NOTIFY_MIN_SECONDS` | `20` | 短任务不打扰 |

## 测试

```powershell
.\.venv\Scripts\python tests\test_observatory.py
```

启动真实服务、以子进程运行真实 hook 脚本，覆盖三种工具的 payload、子 agent 关联与合并、Windows 中文编码恢复、8 个 SDK 场景、校验与 WebSocket。

## 已知限制

- Cursor / Claude Code / Codex 的 hooks 不提供 token 用量，显示为 N/A（SDK 上报时会显示真实值）。
- Cursor 已在本机实测（3.22）；Claude Code / Codex 按官方文档 payload 测试，本机未安装。
- Cursor 对部分子 agent 的内部工具调用不触发 hook，这类调用无法被看到。
- Windows 上 Cursor 会把含中文的 hook 输入按 GBK 误解码，脚本会从 Cursor 的临时 payload 文件恢复原文。
