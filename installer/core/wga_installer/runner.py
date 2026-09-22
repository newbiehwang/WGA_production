"""외부 명령(aws, gh, deploy.sh 등) 실행과 사용자 입력 처리

명령은 두 종류로 나눠 실행한다.
- 읽기 전용 명령 (`Runner.run`): 상태를 확인만 한다. `--dry-run`에서도 실제로 실행한다.
  (dry-run에서도 "무엇이 이미 되어 있고 무엇을 할 것인지"를 정확히 보여 주려면 현재 상태를 읽어야 한다)
- 변경 명령 (`Runner.change`): AWS·GitHub 상태를 바꾼다. 실행 전에 반드시 명령을 보여 주고 승인을 받는다.
  `--dry-run`이면 명령만 보여 주고 실행하지 않는다.

사용자 입력 (`Interaction`)
- JSON 모드(앱): CLI가 `confirm_required`/`input_required` 이벤트를 stdout으로 보내면,
  앱이 stdin으로 한 줄짜리 JSON 응답을 돌려준다.
      {"type": "confirm_response", "id": "<이벤트 id>", "approved": true}
      {"type": "secret_response",  "id": "<이벤트 id>", "value": "<비밀 값>"}
  응답이 없거나(EOF) 형식이 틀리거나 id가 다르면 "거절"로 처리한다. 모호할 때 변경하지 않는 쪽이 안전하다.
- 텍스트 모드(터미널): `y/N` 질문과 getpass(입력 내용이 화면에 보이지 않음)를 쓴다.

비밀 값은 명령 인자로 넘기지 않는다. 실행 중인 프로세스의 인자는 같은 Mac의 다른 사용자도
`ps`로 볼 수 있기 때문이다. 대신 `secret_file`로 권한 0600 임시 파일을 만들어
`aws ... --cli-input-json file://<경로>`처럼 파일 경로만 넘기고, 끝나면 즉시 지운다.
"""
import getpass
import json
import os
import subprocess
import tempfile
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import TextIO

from .events import Emitter, format_command

# CommandResult.outcome 값
EXECUTED = "executed"   # 실제로 실행함
DRY_RUN = "dry_run"     # --dry-run이라 실행하지 않음
DECLINED = "declined"   # 사용자가 승인하지 않아 실행하지 않음

# 셸 관례를 따른 종료 코드 (실행 자체가 안 됐을 때 CommandResult에 넣는다)
RC_TIMEOUT = 124
RC_NOT_EXECUTABLE = 126
RC_NOT_FOUND = 127

DEFAULT_TIMEOUT = 60   # 읽기 전용 명령의 기본 제한 시간(초). 네트워크가 멈춰도 점검이 끝없이 기다리지 않게 한다


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str
    outcome: str = EXECUTED

    @property
    def ok(self) -> bool:
        """실제로 실행했고 성공했는지. dry-run·거절은 성공이 아니다 (호출한 쪽이 outcome으로 따로 처리)."""
        return self.outcome == EXECUTED and self.returncode == 0

    @property
    def output(self) -> str:
        """stdout과 stderr를 합친 출력. 도구마다 버전·상태를 어느 쪽에 쓰는지 달라서 파싱할 때 쓴다
        (예: aws-cli v1은 `--version`을 stderr에, v2는 stdout에 쓴다)."""
        return self.stdout + self.stderr


class Interaction:
    """사용자에게 승인·값을 묻는다. 모드에 따라 stdin JSON 응답 또는 터미널 질문을 쓴다."""

    def __init__(self, emitter: Emitter, *, json_mode: bool,
                 stdin: TextIO, prompt_stream: TextIO) -> None:
        self.emitter = emitter
        self.json_mode = json_mode
        self.stdin = stdin
        self.prompt_stream = prompt_stream   # 텍스트 모드에서 질문을 쓰는 곳 (보통 stdout)

    def confirm(self, id_: str, command: str, reason: str) -> bool:
        """변경 작업을 보여 주고 승인 여부를 받는다."""
        self.emitter.confirm_required(id_, command, reason)
        if self.json_mode:
            response = self._read_response("confirm_response", id_)
            # approved가 정확히 true일 때만 승인. "yes" 같은 문자열이나 누락은 거절로 본다
            return response is not None and response.get("approved") is True
        self.prompt_stream.write("  진행할까요? [y/N] ")
        self.prompt_stream.flush()
        answer = self.stdin.readline().strip().lower()
        return answer in ("y", "yes")

    def secret(self, id_: str, prompt: str) -> str | None:
        """비밀 값을 입력받는다. 받은 값은 곧바로 Redactor에 등록해 이후 어떤 출력에서도 가려지게 한다."""
        if self.json_mode:
            self.emitter.input_required(id_, prompt, secret=True)
            response = self._read_response("secret_response", id_)
            value = response.get("value") if response else None
            if not isinstance(value, str):
                return None
        elif self.stdin.isatty():
            value = getpass.getpass(f"  {prompt}: ", stream=self.prompt_stream)
        else:
            # 파이프로 값을 넣는 경우 (자동화 스크립트). getpass는 이때 경고를 띄우므로 직접 한 줄을 읽는다
            self.prompt_stream.write(f"  {prompt}: ")
            self.prompt_stream.flush()
            value = self.stdin.readline().rstrip("\n")
        self.emitter.redactor.add(value)
        return value

    def _read_response(self, expected_type: str, id_: str) -> dict | None:
        line = self.stdin.readline()
        if not line:
            # 앱이 stdin을 닫았다 (앱 종료 등). 사람이 답하지 않은 것이므로 거절로 처리한다
            self.emitter.error("input", f"'{id_}'에 대한 응답을 받지 못해 진행하지 않습니다")
            return None
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            # 받은 줄에 비밀 값이 들어 있을 수 있으므로 오류 메시지에 원문을 넣지 않는다
            response = None
        if (not isinstance(response, dict) or response.get("type") != expected_type
                or response.get("id") != id_):
            self.emitter.error("input", f"'{id_}'에 대한 응답 형식이 올바르지 않아 진행하지 않습니다",
                               hint=f'{{"type": "{expected_type}", "id": "{id_}", ...}} 형식의 한 줄 JSON이어야 합니다')
            return None
        return response


class Runner:
    """명령을 실행하고, 변경 명령에는 dry-run·승인 절차를 적용한다."""

    def __init__(self, emitter: Emitter, interaction: Interaction, *, env: dict[str, str],
                 cwd: str | None = None, dry_run: bool = False, assume_yes: bool = False) -> None:
        self.emitter = emitter
        self.interaction = interaction
        self.env = env            # 모든 명령에 넘길 환경 변수 전체 (Context.command_env()로 만든다)
        self.cwd = cwd            # 기본 작업 폴더 (보통 저장소 루트)
        self.dry_run = dry_run
        self.assume_yes = assume_yes
        self._emit_lock = threading.Lock()   # 스트리밍 중 stdout·stderr 스레드가 동시에 출력하지 않게 한다

    def run(self, cmd: list[str], *, timeout: float | None = DEFAULT_TIMEOUT, cwd: str | None = None,
            stream: bool = False, on_line: Callable[[str, str], None] | None = None,
            extra_env: dict[str, str] | None = None) -> CommandResult:
        """읽기 전용 명령을 실행한다. dry-run이어도 실행한다."""
        return self._execute(cmd, timeout=timeout, cwd=cwd, stream=stream, on_line=on_line,
                             extra_env=extra_env)

    def change(self, cmd: list[str], *, id_: str, reason: str, allow_assume_yes: bool = True,
               timeout: float | None = None, cwd: str | None = None, stream: bool = False,
               on_line: Callable[[str, str], None] | None = None,
               extra_env: dict[str, str] | None = None) -> CommandResult:
        """상태를 바꾸는 명령. 보여 주기 → (dry-run이면 여기서 끝) → 승인 → 실행 순서를 따른다.

        allow_assume_yes=False: `--yes`를 줘도 반드시 사람에게 묻는다 (teardown처럼 되돌릴 수 없는 작업).
        timeout 기본값이 None인 이유: 스택 배포처럼 수십 분 걸리는 작업을 중간에 끊으면 더 위험하다.
        """
        command = format_command(cmd)
        if self.dry_run:
            self.emitter.dry_run(id_, command, reason)
            return CommandResult(0, "", "", DRY_RUN)

        if self.assume_yes and allow_assume_yes:
            # 승인 질문은 건너뛰지만, 무엇을 실행했는지는 기록에 남긴다
            self.emitter.log(f"--yes로 자동 승인: {reason}: {command}", stream="info")
            approved = True
        else:
            approved = self.interaction.confirm(id_, command, reason)
        if not approved:
            self.emitter.log(f"승인하지 않아 실행하지 않았습니다: {reason}", stream="info")
            return CommandResult(0, "", "", DECLINED)

        return self._execute(cmd, timeout=timeout, cwd=cwd, stream=stream, on_line=on_line,
                             extra_env=extra_env)

    def _execute(self, cmd: list[str], *, timeout: float | None, cwd: str | None, stream: bool,
                 on_line: Callable[[str, str], None] | None,
                 extra_env: dict[str, str] | None) -> CommandResult:
        env = {**self.env, **(extra_env or {})}
        workdir = cwd or self.cwd
        try:
            if stream:
                return self._execute_streaming(cmd, env=env, cwd=workdir, timeout=timeout, on_line=on_line)
            proc = subprocess.run(
                cmd, env=env, cwd=workdir, timeout=timeout,
                # stdin을 막는 이유: 이 프로세스의 stdin은 앱이 응답을 보내는 통로다.
                # 자식 명령이 그 줄을 읽어 가면 응답이 사라지고, aws/gh가 대화형 질문으로 멈출 수도 있다.
                stdin=subprocess.DEVNULL,
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            return CommandResult(proc.returncode, proc.stdout, proc.stderr)
        except FileNotFoundError:
            return CommandResult(RC_NOT_FOUND, "", f"명령을 찾을 수 없습니다: {cmd[0]}")
        except PermissionError:
            return CommandResult(RC_NOT_EXECUTABLE, "", f"실행 권한이 없습니다: {cmd[0]}")
        except subprocess.TimeoutExpired:
            return CommandResult(RC_TIMEOUT, "", f"{timeout:g}초 안에 끝나지 않아 중단했습니다: {cmd[0]}")

    def _execute_streaming(self, cmd: list[str], *, env: dict[str, str], cwd: str | None,
                           timeout: float | None,
                           on_line: Callable[[str, str], None] | None) -> CommandResult:
        """출력을 한 줄씩 `log` 이벤트로 바로 내보내며 실행한다 (deploy.sh처럼 오래 걸리는 명령용).

        on_line(line, stream): 줄마다 호출되는 콜백. deploy 단계가 `====== N. 제목 ======` 줄을
        진행 표시로 바꾸는 데 쓴다 (M2).
        """
        proc = subprocess.Popen(cmd, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding="utf-8", errors="replace", bufsize=1)
        chunks: dict[str, list[str]] = {"stdout": [], "stderr": []}

        def pump(pipe: TextIO, name: str) -> None:
            # stdout과 stderr를 각각 다른 스레드에서 읽는다. 한쪽만 읽으면 다른 쪽 파이프 버퍼가
            # 가득 차 자식 프로세스가 멈출 수 있다(교착). 줄이 오는 즉시 이벤트로 내보낸다.
            for raw in pipe:
                chunks[name].append(raw)
                line = raw.rstrip("\n")
                with self._emit_lock:
                    self.emitter.log(line, stream=name)
                    if on_line:
                        on_line(line, name)

        threads = [threading.Thread(target=pump, args=(proc.stdout, "stdout"), daemon=True),
                   threading.Thread(target=pump, args=(proc.stderr, "stderr"), daemon=True)]
        for thread in threads:
            thread.start()
        try:
            returncode = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            returncode = RC_TIMEOUT
        for thread in threads:
            thread.join()
        return CommandResult(returncode, "".join(chunks["stdout"]), "".join(chunks["stderr"]))


# 반환 타입: (yield 값, send 값, return 값). Generator[str]처럼 줄여 쓰는 형식은 3.13부터라 전부 적는다
@contextmanager
def secret_file(data: dict, *, directory: str | None = None) -> Generator[str, None, None]:
    """비밀 값을 담은 JSON을 권한 0600 임시 파일로 만들고 경로를 돌려준다. with 블록이 끝나면
    (예외가 나도) 파일을 지운다. 사용 예:

        with secret_file({"Name": name, "Value": value, "Type": "SecureString"}) as path:
            runner.change(["aws", "ssm", "put-parameter", "--cli-input-json", f"file://{path}"], ...)
    """
    # mkstemp는 파일을 O_EXCL로 새로 만들고(이미 있는 파일·심볼릭 링크를 따라가지 않음) 권한을 0600으로 준다.
    fd, path = tempfile.mkstemp(prefix="wga-installer-", suffix=".json", dir=directory)
    try:
        os.fchmod(fd, 0o600)   # umask 설정과 관계없이 소유자만 읽고 쓸 수 있게 한 번 더 못 박는다
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        yield path
    finally:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
