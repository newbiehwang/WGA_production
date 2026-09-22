#!/bin/bash
# 가짜 외부 명령 (aws, gh, git, node 등). tests/installer/helpers.py의 FakeCli가 임시 bin 폴더에
# 도구 이름으로 이 파일을 가리키는 심볼릭 링크를 만든다. 실행되면
#   1. 호출 내역(도구 이름, 인자, 주요 환경 변수)을 $FAKE_CLI_LOG에 한 줄로 남기고
#   2. $FAKE_CLI_RULES/<도구>.sh 규칙 파일(if 문 목록)을 source해 정해진 출력·종료 코드를 돌려준다.
#      규칙에 사용 횟수(times)가 있으면 그만큼 쓴 뒤에는 다음 규칙으로 넘어간다 (상태가 바뀌는 상황을 흉내).
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

# 파일로 넘어온 입력(aws ... file://<경로>, gh api --input <경로>)은 실행이 끝나면 지워지므로,
# 권한과 내용을 지금 $FAKE_CLI_CAPTURES에 복사해 둔다. 항목 구분: 줄 하나짜리 RS(0x1e)
previous=""
for arg in "$@"; do
  src=""
  if [[ "$arg" == file://* ]]; then
    src=${arg#file://}
  elif [[ "$previous" == "--input" && -f "$arg" ]]; then
    src=$arg
  fi
  previous=$arg
  if [[ -n "$src" ]]; then
    listing=$(/bin/ls -l "$src")
    { printf '%s\n' "${listing:0:10}"; /bin/cat "$src"; printf '\n\x1e\n'; } >> "$FAKE_CLI_CAPTURES"
  fi
done

# 규칙 사용 횟수 확인: 한도(0이면 무제한)보다 적게 썼으면 1을 더하고 성공(0)을 돌려준다.
# (macOS 기본 bash 3.2에는 case의 ;;& 가 없어 규칙을 if 문으로 만들고 이 함수로 횟수를 센다)
_take() {
  local limit=$1 counter="$FAKE_CLI_RULES/.count-$2" used=0
  [[ -f "$counter" ]] && used=$(<"$counter")
  if (( limit > 0 && used >= limit )); then
    return 1
  fi
  echo $((used + 1)) > "$counter"
}

rules="$FAKE_CLI_RULES/$tool.sh"
[[ -f "$rules" ]] && source "$rules"
echo "fake $tool: 규칙 없음: $*" >&2
exit 99
