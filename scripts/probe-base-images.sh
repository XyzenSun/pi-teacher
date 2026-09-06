#!/usr/bin/env bash
# 探测 node 基础镜像的 Python 环境、体积、以及 better-sqlite3 是否需要现场编译。
# 用途：为 pi-teacher 选定 Docker 基础镜像（见 docs/open-questions.md）。
#
# 用法：bash probe-base-images.sh [镜像标签...]
#   默认探测 node:22-slim 与 node:22-alpine
#   结果同时打印到终端并写入 probe-result-<时间戳>.txt

set -uo pipefail   # 故意不加 -e：单个探测失败不应中断整轮

IMAGES=("$@")
if [ ${#IMAGES[@]} -eq 0 ]; then
    IMAGES=(node:22-slim node:22-alpine)
fi

REPORT="probe-result-$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$REPORT") 2>&1

echo "探测时间: $(date '+%F %T')"
echo "宿主 docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 未知)"
echo "宿主架构: $(uname -m)"
echo

# ---------------------------------------------------------------------------
# 1. 拉取并记录体积
# ---------------------------------------------------------------------------
echo "############################################################"
echo "# 1. 镜像体积"
echo "############################################################"
echo

for img in "${IMAGES[@]}"; do
    echo "--- 拉取 $img ---"
    if ! docker pull "$img"; then
        echo "!! 拉取失败: $img（后续探测将跳过）"
        continue
    fi
    echo
done

echo "--- 解压后体积（docker images 报告的 SIZE）---"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' \
  | grep -E "$(IFS='|'; echo "${IMAGES[*]}" | sed 's/[.*]/\\&/g')" || true
echo
echo "提示：压缩后（下载）体积见 Docker Hub 页面，本地无法直接读取。"
echo

# ---------------------------------------------------------------------------
# 2. 各镜像自带什么
# ---------------------------------------------------------------------------
echo "############################################################"
echo "# 2. 镜像自带的运行时与工具"
echo "############################################################"
echo

# 单引号包裹，避免宿主 shell 提前展开
PROBE_SCRIPT='
    echo "[发行版]"
    (cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|VERSION_ID)=") || echo "  读不到 os-release"
    echo "  libc: $(ldd --version 2>&1 | head -1)"
    echo

    echo "[Node 与包管理器]"
    echo "  node:  $(node --version 2>&1)"
    echo "  npm:   $(npm --version 2>&1)"
    echo

    echo "[Python]"
    if command -v python3 >/dev/null 2>&1; then
        echo "  python3: $(python3 --version 2>&1)  -> $(command -v python3)"
    else
        echo "  python3: 未安装"
    fi
    if command -v python >/dev/null 2>&1; then
        echo "  python:  $(python --version 2>&1)  -> $(command -v python)"
    else
        echo "  python:  未安装（无 python 别名）"
    fi
    if command -v pip3 >/dev/null 2>&1; then
        echo "  pip3:    $(pip3 --version 2>&1 | cut -c1-60)"
    else
        echo "  pip3:    未安装"
    fi
    # 标准库是否完整：venv 和 sqlite3 模块在精简发行版里常被拆包剥离
    if command -v python3 >/dev/null 2>&1; then
        echo -n "  venv 模块: "; python3 -c "import venv; print(\"可用\")" 2>&1 | tail -1
        echo -n "  sqlite3 模块: "; python3 -c "import sqlite3; print(\"可用\")" 2>&1 | tail -1
    fi
    echo

    echo "[Shell]"
    echo "  /bin/sh -> $(readlink -f /bin/sh 2>/dev/null || echo 未知)"
    if command -v bash >/dev/null 2>&1; then
        echo "  bash: $(bash --version 2>&1 | head -1)"
    else
        echo "  bash: 未安装"
    fi
    echo

    echo "[coreutils 是 GNU 还是 BusyBox]"
    for c in ls sed grep awk find date; do
        p=$(command -v $c 2>/dev/null) || { echo "  $c: 未安装"; continue; }
        real=$(readlink -f "$p" 2>/dev/null || echo "$p")
        case "$real" in
            *busybox*) echo "  $c: BusyBox ($real)" ;;
            *)         echo "  $c: $real" ;;
        esac
    done
    echo

    echo "[GNU 扩展行为实测]"
    # GNU sed 支持 -i 直接跟后缀，BusyBox 需要 -i .bak（带空格）或不支持
    echo test > /tmp/t.txt
    if sed -i.bak "s/test/ok/" /tmp/t.txt 2>/dev/null && [ -f /tmp/t.txt.bak ]; then
        echo "  sed -i.bak: 支持（GNU 行为）"
    else
        echo "  sed -i.bak: 不支持（BusyBox 行为）"
    fi
    # GNU date 的相对时间解析，BusyBox 完全没有
    if date -d "3 days ago" >/dev/null 2>&1; then
        echo "  date -d \"3 days ago\": 支持（GNU 行为）"
    else
        echo "  date -d 相对时间: 不支持（BusyBox 行为）"
    fi
    # GNU grep 的 -P（PCRE），AI 写脚本时很常用
    if echo abc | grep -P "a\\w+" >/dev/null 2>&1; then
        echo "  grep -P (PCRE): 支持"
    else
        echo "  grep -P (PCRE): 不支持"
    fi
'

for img in "${IMAGES[@]}"; do
    echo "============================================================"
    echo "  $img"
    echo "============================================================"
    docker run --rm "$img" sh -c "$PROBE_SCRIPT" || echo "!! 探测失败: $img"
    echo
done

# ---------------------------------------------------------------------------
# 3. better-sqlite3 是否需要现场编译（选型的关键变量）
# ---------------------------------------------------------------------------
echo "############################################################"
echo "# 3. better-sqlite3 安装探测"
echo "############################################################"
echo
echo "关注点：输出里若出现 node-gyp / 'Building from source' / gyp ERR，"
echo "说明该镜像没有可用的预编译二进制，Dockerfile 必须带编译工具链。"
echo

SQLITE_SCRIPT='
    mkdir -p /tmp/probe && cd /tmp/probe
    npm init -y >/dev/null 2>&1
    echo "--- npm install better-sqlite3（完整输出）---"
    # --foreground-scripts 让 node-gyp 的编译日志显示出来而非被折叠
    npm install better-sqlite3 --foreground-scripts 2>&1 | tail -40
    echo
    echo "--- 安装结果验证 ---"
    node -e "
        try {
            const db = require(\"better-sqlite3\")(\":memory:\");
            db.exec(\"CREATE TABLE t (a INTEGER)\");
            db.prepare(\"INSERT INTO t VALUES (?)\").run(42);
            console.log(\"  运行正常，查询结果:\", db.prepare(\"SELECT a FROM t\").get());
        } catch (e) {
            console.log(\"  加载失败:\", e.message);
        }
    "
'

for img in "${IMAGES[@]}"; do
    echo "============================================================"
    echo "  $img — better-sqlite3"
    echo "============================================================"
    # 给 5 分钟：若走源码编译会比较慢
    timeout 300 docker run --rm "$img" sh -c "$SQLITE_SCRIPT" \
        || echo "!! 失败或超时（超时本身即说明在走源码编译）"
    echo
done

# ---------------------------------------------------------------------------
# 4. Alpine 补装 GNU 工具的体积代价
# ---------------------------------------------------------------------------
echo "############################################################"
echo "# 4. Alpine 补装 bash + GNU 工具的体积代价"
echo "############################################################"
echo

ALPINE_IMG=""
for img in "${IMAGES[@]}"; do
    case "$img" in *alpine*) ALPINE_IMG="$img"; break ;; esac
done

if [ -z "$ALPINE_IMG" ]; then
    echo "（本轮未探测 alpine 镜像，跳过）"
else
    echo "基准镜像: $ALPINE_IMG"
    docker run --rm "$ALPINE_IMG" sh -c '
        echo "--- apk add bash coreutils findutils grep sed gawk 的下载与安装量 ---"
        apk add --no-cache bash coreutils findutils grep sed gawk 2>&1 | tail -8
        echo
        echo "--- 装完后 GNU 行为复测 ---"
        echo test > /tmp/t.txt
        sed -i.bak "s/test/ok/" /tmp/t.txt 2>/dev/null && [ -f /tmp/t.txt.bak ] \
            && echo "  sed -i.bak: 已恢复 GNU 行为" \
            || echo "  sed -i.bak: 仍不支持"
        date -d "3 days ago" >/dev/null 2>&1 \
            && echo "  date -d 相对时间: 已恢复" \
            || echo "  date -d 相对时间: 仍不支持"
        echo abc | grep -P "a\w+" >/dev/null 2>&1 \
            && echo "  grep -P: 已恢复" \
            || echo "  grep -P: 仍不支持"
        echo "  /bin/sh 仍是: $(readlink -f /bin/sh)  （注意：装 bash 不会改 sh 的指向）"
    ' || echo "!! 探测失败"
    echo
    echo "--- 实际体积增量（构建两个镜像对比）---"
    tmpdir=$(mktemp -d)
    printf 'FROM %s\n' "$ALPINE_IMG" > "$tmpdir/Dockerfile.base"
    printf 'FROM %s\nRUN apk add --no-cache bash coreutils findutils grep sed gawk\n' \
        "$ALPINE_IMG" > "$tmpdir/Dockerfile.gnu"
    docker build -q -t probe-alpine-base -f "$tmpdir/Dockerfile.base" "$tmpdir" >/dev/null 2>&1
    docker build -q -t probe-alpine-gnu  -f "$tmpdir/Dockerfile.gnu"  "$tmpdir" >/dev/null 2>&1
    docker images --format '{{.Repository}}\t{{.Size}}' \
        | grep -E 'probe-alpine-(base|gnu)' || echo "  构建失败，无数据"
    rm -rf "$tmpdir"
    docker rmi probe-alpine-base probe-alpine-gnu >/dev/null 2>&1
fi

echo
echo "############################################################"
echo "探测结束。报告已写入: $REPORT"
echo "############################################################"
