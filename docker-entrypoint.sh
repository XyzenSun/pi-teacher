#!/bin/sh
# Pi Teacher 容器入口：先把镜像里的内置 skill 铺进 Pi 的全局 skill 目录，再启动后端。
#
# 内置 skill 由我们维护：每次启动都用镜像里的版本覆盖同名目录（先 rm -rf 再 cp -pr），
# 升级镜像就等于升级了内置 skill；用户自己放进 ~/.pi/agent/skills 的其他目录一概不碰。
# 想定制某个内置 skill，复制一份改名即可——同名目录下次启动会被覆盖回来。
# cp 用 -p 保留可执行位（skill 的二进制靠它），-u 没有意义（目录已先删掉）。
set -eu

BUILTIN_SKILLS_DIR=/app/skills
SKILLS_DIR="${HOME:-/root}/.pi/agent/skills"

mkdir -p "$SKILLS_DIR"
for skill in "$BUILTIN_SKILLS_DIR"/*/; do
  [ -d "$skill" ] || continue
  name=$(basename "$skill")
  rm -rf "${SKILLS_DIR:?}/${name:?}"
  cp -pr "$skill" "$SKILLS_DIR/$name"
  echo "[entrypoint] 内置 skill 已同步到 $SKILLS_DIR/$name"
done

exec "$@"
