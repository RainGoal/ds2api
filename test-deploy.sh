#!/usr/bin/env bash
# 使用命令替身验证部署流程；不连接 Docker 引擎。
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")"; pwd -P)"
DEPLOY_SCRIPT="$PROJECT_DIR/deploy.sh"
TEMP_PARENT="$(cd -- "${TMPDIR:-/tmp}"; pwd -P)"
TEST_DIR="$(mktemp -d "$TEMP_PARENT/ds2api-deploy-test.XXXXXX")"
cleanup() {
  # 仅删除 mktemp 在指定临时父目录中创建的本次测试目录。
  if [[ "$TEST_DIR" == "$TEMP_PARENT"/ds2api-deploy-test.* ]]; then
    rm -rf -- "$TEST_DIR"
  fi
}
trap cleanup EXIT
mkdir "$TEST_DIR/bin"
export STUB_CALLS="$TEST_DIR/calls" STUB_COUNT="$TEST_DIR/count"
export PATH="$TEST_DIR/bin:$PATH"

cat > "$TEST_DIR/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STUB_CALLS"
case "${1:-}" in
  info) exit 0 ;;
  inspect)
    count="$(cat "$STUB_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$STUB_COUNT"
    case "$STUB_SCENARIO" in
      unhealthy) printf 'running unhealthy\n' ;;
      timeout) printf 'running starting\n' ;;
      delayed)
        if (( count < 2 )); then printf 'running starting\n'; else printf 'running healthy\n'; fi
        ;;
      *) printf 'running healthy\n' ;;
    esac
    exit 0
    ;;
  compose) shift ;;
  *) exit 90 ;;
esac
if [[ "${1:-}" == version ]]; then exit 0; fi
if [[ "${1:-}" != --project-directory || "${3:-}" != -f ]]; then exit 91; fi
if [[ "$2" != "$STUB_PROJECT_DIR" || "$4" != "$STUB_PROJECT_DIR/compose.yaml" ]]; then exit 92; fi
shift 4
case "${1:-}" in
  up) if [[ "$STUB_SCENARIO" == up_failure ]]; then exit 17; fi ;;
  ps)
    if [[ "$*" == 'ps -a -q ds2api' ]]; then printf 'test-container\n'; else printf 'mock container status\n'; fi
    ;;
  port) printf '0.0.0.0:8088\n' ;;
  exec)
    if [[ "$STUB_SCENARIO" == delayed ]]; then
      if (( $(cat "$STUB_COUNT") < 2 )); then exit 93; fi
    fi
    printf 'API Key:   sk-test\nAdmin Key: admin-test\n'
    ;;
  logs) printf 'mock diagnostic logs\n' ;;
  down|restart) ;;
  *) exit 94 ;;
esac
STUB
cat > "$TEST_DIR/bin/sleep" <<'STUB'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >> "$STUB_CALLS"
STUB
chmod +x "$TEST_DIR/bin/docker" "$TEST_DIR/bin/sleep"
export STUB_PROJECT_DIR="$PROJECT_DIR"

fail() { printf 'FAIL: %s\n' "$*" >&2; cat "$TEST_DIR/output" >&2; exit 1; }
contains() { if ! grep -Fq -- "$2" "$1"; then fail "缺少预期内容：$2"; fi; }
excludes() { if grep -Fq -- "$2" "$1"; then fail "出现意外内容：$2"; fi; }
run_deploy() {
  local expected="$1" scenario="$2" timeout="$3" actual
  shift 3
  : > "$STUB_CALLS"
  printf '0\n' > "$STUB_COUNT"
  if (
    cd -- "$TEST_DIR"
    STUB_SCENARIO="$scenario" DS_DEPLOY_TIMEOUT="$timeout" bash "$DEPLOY_SCRIPT" "$@"
  ) > "$TEST_DIR/output" 2>&1; then actual=0; else actual=$?; fi
  if [[ "$actual" != "$expected" ]]; then fail "退出码：预期 $expected，实际 $actual（$scenario $*）"; fi
}

run_deploy 0 delayed 8
contains "$STUB_CALLS" 'up -d --build'
contains "$STUB_CALLS" 'sleep 2'
contains "$TEST_DIR/output" 'http://<服务器IP>:8088/admin'
contains "$TEST_DIR/output" 'http://<服务器IP>:8088/v1'
contains "$TEST_DIR/output" 'API Key:   sk-test'
contains "$TEST_DIR/output" 'Admin Key: admin-test'
if [[ "$(cat "$STUB_COUNT")" != 2 ]]; then fail '启动未等待健康状态'; fi
printf 'PASS start waits for health and displays access credentials\n'

run_deploy 0 healthy 8 stop
contains "$STUB_CALLS" 'down'
excludes "$STUB_CALLS" 'down -v'
excludes "$STUB_CALLS" '--volumes'
excludes "$STUB_CALLS" 'inspect'
printf 'PASS stop preserves persistent volumes\n'

run_deploy 0 healthy 8 restart
contains "$STUB_CALLS" 'restart ds2api'
contains "$STUB_CALLS" 'inspect'
contains "$TEST_DIR/output" 'Admin Key: admin-test'
printf 'PASS restart checks health\n'

run_deploy 1 unhealthy 8 start
contains "$STUB_CALLS" 'logs --tail 60 ds2api'
contains "$TEST_DIR/output" 'mock container status'
contains "$TEST_DIR/output" 'mock diagnostic logs'
excludes "$STUB_CALLS" 'exec -T'
printf 'PASS unhealthy exits with diagnostic logs\n'

run_deploy 1 timeout 08 start
contains "$TEST_DIR/output" '最多 8 秒'
contains "$STUB_CALLS" 'logs --tail 60 ds2api'
contains "$TEST_DIR/output" 'mock diagnostic logs'
excludes "$STUB_CALLS" 'exec -T'
if [[ "$(cat "$STUB_COUNT")" != 4 ]]; then fail '08 未按十进制 8 秒轮询'; fi
printf 'PASS timeout exits with logs and parses 08 as decimal\n'

run_deploy 17 up_failure 8 start
excludes "$STUB_CALLS" 'inspect'
excludes "$STUB_CALLS" 'exec -T'
excludes "$TEST_DIR/output" 'API Key:'
printf 'PASS failed compose up stops subsequent steps\n'

run_deploy 2 healthy 8 unsupported
if [[ -s "$STUB_CALLS" ]]; then fail '无效参数不应调用 Docker'; fi
run_deploy 2 healthy 8 start extra
if [[ -s "$STUB_CALLS" ]]; then fail '多余参数不应调用 Docker'; fi
run_deploy 0 healthy 8 --help
contains "$TEST_DIR/output" 'bash deploy.sh'
if [[ -s "$STUB_CALLS" ]]; then fail '帮助命令不应调用 Docker'; fi
printf 'PASS help and unsupported arguments return correct exit codes\n'
