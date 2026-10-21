#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
PROJECT_DIR="$(pwd -P)"

compose() {
  docker compose --project-directory "$PROJECT_DIR" -f "$PROJECT_DIR/compose.yaml" "$@"
}

die() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
用法：bash deploy.sh [start|stop|restart|logs|status|keys]
  start    构建并启动，等待健康检查，显示访问地址和密钥（默认）
  stop     停止并移除容器，保留账号、统计和日志数据卷
  restart  重启现有服务并等待健康检查
  logs     查看最近日志并持续跟踪
  status   查看容器与健康检查状态
  keys     显示当前调用密钥和管理密钥

首次部署只需 Docker Engine 和 Docker Compose v2，无需宿主机安装 Node.js。
自定义端口：DS_PORT=8080 bash deploy.sh
也可复制 .env.example 为 .env 后修改端口与监听地址。
USAGE
}

check_docker() {
  command -v docker >/dev/null 2>&1 || die '未找到 Docker，请先安装 Docker Engine 和 Docker Compose v2。'
  docker compose version >/dev/null 2>&1 || die '未找到 Docker Compose v2（docker compose）。'
  docker info >/dev/null 2>&1 || die '无法连接 Docker 引擎，请检查 Docker 是否启动及当前用户权限。'
}

wait_healthy() {
  local timeout="${DS_DEPLOY_TIMEOUT:-120}"
  case "$timeout" in
    ''|*[!0-9]*) die 'DS_DEPLOY_TIMEOUT 必须是 1–3600 的整数秒数。' ;;
  esac
  [[ ${#timeout} -le 4 ]] || die 'DS_DEPLOY_TIMEOUT 必须是 1–3600 的整数秒数。'
  timeout=$((10#$timeout))
  (( timeout >= 1 && timeout <= 3600 )) || die 'DS_DEPLOY_TIMEOUT 必须是 1–3600 的整数秒数。'
  local elapsed=0 container_id state
  printf '等待服务健康检查（最多 %s 秒）...\n' "$timeout"
  while (( elapsed < timeout )); do
    container_id="$(compose ps -a -q ds2api)"
    if [[ -n "$container_id" ]]; then
      state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
      case "$state" in
        'running healthy') return 0 ;;
        exited*|dead*|'running unhealthy') break ;;
      esac
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  compose ps -a || true
  compose logs --tail 60 ds2api >&2 || true
  die '服务未通过健康检查。请检查上面的容器日志；数据卷已保留。'
}

show_access() {
  local published port
  published="$(compose port ds2api 3210)"
  port="${published##*:}"
  printf '\n服务已就绪。\n管理台：http://<服务器IP>:%s/admin\nAPI Base URL：http://<服务器IP>:%s/v1\n\n' "$port" "$port"
  compose exec -T ds2api node docker/entrypoint.js --show-credentials
  printf '\n使用 Admin Key 登录管理台并添加账号；客户端使用 API Key。\n'
}

action="${1:-start}"
[[ $# -le 1 ]] || { usage >&2; exit 2; }
case "$action" in
  help|-h|--help) usage; exit 0 ;;
  start|stop|restart|logs|status|keys) ;;
  *) usage >&2; exit 2 ;;
esac

check_docker
case "$action" in
  start)
    compose up -d --build
    wait_healthy
    show_access
    ;;
  stop) compose down ;;
  restart)
    compose restart ds2api
    wait_healthy
    show_access
    ;;
  logs) compose logs --follow --tail 100 ds2api ;;
  status) compose ps -a ;;
  keys) compose exec -T ds2api node docker/entrypoint.js --show-credentials ;;
esac
