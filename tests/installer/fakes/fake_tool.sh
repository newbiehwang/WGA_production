#!/bin/bash
# 가짜 외부 명령 (aws, gh, git, node 등). tests/installer/helpers.py의 FakeCli가 임시 bin 폴더에
# 도구 이름으로 이 파일을 가리키는 심볼릭 링크를 만든다. 실행되면
#   1. 호출 내역(도구 이름, 인자, 주요 환경 변수)을 $FAKE_CLI_LOG에 한 줄로 남기고
#   2. $FAKE_CLI_RULES/<도구>.sh 규칙 파일(case 문)을 source해 정해진 출력·종료 코드를 돌려준다.
#   맞는 규칙이 없으면 종료 코드 99로 실패한다 (예상하지 못한 명령이 조용히 성공하지 않도록).
#
# 링크 대상이 항상 이 파일 하나인 이유: macOS는 새로 만든 실행 파일을 처음 실행할 때 보안 검사로
# 수백 ms를 쓴다. 테스트마다 실행 파일을 새로 만들면 점검 한 번에 수 초가 걸리므로, 실행 파일은
# 고정하고 테스트마다 바뀌는 규칙은 실행하지 않는 데이터 파일(source)로 둔다.

tool=${0##*/}

# 기록 형식: 도구 US 인자1 US 인자2 ... RS 이름=값 US 이름=값 ... (US=0x1f, RS=0x1e)
{
  printf '%s' "$tool"
  for arg in "$@"; do printf '\x1f%s' "$arg"; done
  printf '\x1e'
  for name in AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION AWS_PAGER AWS_ACCESS_KEY_ID GH_PROMPT_DISABLED; do
    # ${!name+x}: 값이 비어 있어도 "설정됨"으로 기록한다 (AWS_PAGER="" 확인용)
    [[ -n "${!name+x}" ]] && printf '%s=%s\x1f' "$name" "${!name}"
  done
  printf '\n'
} >> "$FAKE_CLI_LOG"

rules="$FAKE_CLI_RULES/$tool.sh"
[[ -f "$rules" ]] && source "$rules"
echo "fake $tool: 규칙 없음: $*" >&2
exit 99
