---
name: sbx
description: 在云沙箱（Daytona / E2B / CodeSandbox）中执行代码验证，当代码可能有危险时需要在云沙箱中执行，或将程序部署到沙箱做快速原型验证时，调用此技能。
---

# sbx — 云沙箱代码验证

统一 CLI 操作三家云沙箱。所有命令支持 `--json`（稳定结构，供解析）。CLI 已随本 skill 自带（下文所有相对路径以本 skill 目录为基准，换成解析后的绝对路径执行）：

```bash
scripts/sbx <command> [options] --json
```

## 认证

API key 只从环境变量读取：`DAYTONA_API_KEY` / `E2B_API_KEY` / `CODESANDBOX_API_KEY`，由 Pi Teacher 后端作为环境变量注入到命令进程，**不要**使用 `--envfile`，也不要去找任何配置文件。
命令提示没有可用平台时，直接告诉用户：到「系统设置 → 高级配置 → 用户环境变量」填写对应平台的 key，保存后立即生效，无需重开对话；不要自行尝试其他路径或猜测密钥。

先用 `scripts/sbx list` 探测可用平台（只显示已配置 key 的平台），无平台则提示用户配置。

## 标准工作流（完整闭环）

```bash
# 1. 创建沙箱（必须显式 --ttl，防烧钱；平台差异见下表）
scripts/sbx create -p e2b --ttl 10 --json
# → {"sandboxId":"...","platform":"e2b","sourceDescription":"..."}

# 2. 上传文件/目录
scripts/sbx upload -p e2b -s <id> ./script.py /home/user/script.py --json

# 3. 执行（前台阻塞，退出码=沙箱内命令退出码；--json 输出 stdout/stderr/exitCode/status）
scripts/sbx run -p e2b -s <id> "python /home/user/script.py" --json

# 4. 下载产物
scripts/sbx download -p e2b -s <id> /home/user/out.png ./out.png --json

# 5. 必须销毁（按秒计费）
scripts/sbx destroy -p e2b -s <id> --yes --json
```

## 强制规范

1. **全部用 `--json`** 解析结构化字段，不要解析人读输出
2. **create 必须显式 `--ttl`**；任务结束**必须 `destroy`**（沙箱按秒计费）
3. **成败判断用退出码**：`run` 透传沙箱内命令的 exit code；CLI 自身错误是 2（参数/key/Dockerfile）或 3（平台错误）
4. 失败修复循环：读 `stderr` → 改代码 → 重新 upload → 重新 run
5. 同一沙箱内多次 run 共享环境（Daytona session 模式下 cd/env 跨命令保持）

## 平台选择

| 需求 | 平台 | 理由 |
|---|---|---|
| 默认/通用验证 | `e2b` | 出网全开、冷启动快、stderr 分离 |
| 需要出网调外部 API | `e2b` 或 `codesandbox` | **Daytona 默认 egress 白名单**（仅 pypi/npm/docker hub/github），出不了任意站 |
| 需要 GPU / Windows | `daytona` | 唯一支持（本期 CLI 未暴露 GPU 参数） |
| 数据科学全家桶预装 | `daytona` | torch/pandas 等预装 |
| 需要 Docker/多服务 | `codesandbox` | VM 内完整 Docker |
| 临时 web 预览 | 任一 | 见 preview 用法 |

## 环境来源（create 三选一，互斥）

```bash
scripts/sbx create -p e2b --ttl 10 --json                              # 平台默认模板
scripts/sbx create -p e2b --template my-tpl --ttl 10 --json            # 平台已有模板
scripts/sbx create -p e2b --dockerfile ./Dockerfile --ttl 10 --json    # 本地 Dockerfile（强制单阶段，本地拦截）
scripts/sbx create -p daytona --image python:3.12-slim --ttl 10 --json # 公共镜像（daytona 免构建秒级）
```

Dockerfile/镜像会构建为平台模板并**按内容缓存**（同内容秒级复用）；Dockerfile 改动自动构建新模板。要求**单阶段**（多 `FROM` 会被本地拒绝并报行号）。

## 临时 web 预览

```bash
scripts/sbx run -p e2b -s <id> "cd /app && (npm run dev -- --host 0.0.0.0 &)" --json  # E2B 必须绑 0.0.0.0
scripts/sbx preview -p e2b -s <id> --port 3000 --json
# → {"url":"https://3000-xxx.e2b.app","port":3000}
```

预览 URL 公网可访问（HTTPS + WebSocket），适合临时看效果，不适合长期托管。

## 平台限制速记（踩过的坑）

| 平台 | 限制 |
|---|---|
| E2B / CodeSandbox | **后台命令结束后从进程表消失**，`result` 只能查运行中的命令；短命令拿结果用前台模式 |
| CodeSandbox | `stderr` 恒为空（平台合并输出到 stdout）；沙箱内命令跑在 devcontainer 容器中 |
| CodeSandbox / E2B | `--image`/`--dockerfile` 首次构建需 0.5~1 分钟（有缓存） |
| Daytona | egress 白名单；`--image` 需带具体 tag（`latest` 不接受） |
