"""명령줄 진입점: `python -m wga_installer <명령> [옵션]`

    python -m wga_installer check              # 사전 점검 (터미널용 텍스트 출력)
    python -m wga_installer check --json       # 앱용 JSON Lines 출력
    python -m wga_installer check --profile wga-dev --region ap-northeast-2

종료 코드
    0  성공
    1  단계 실패 (점검 실패, 명령 오류 등 — 자세한 내용은 error·check 이벤트)
    2  명령줄 사용법 오류 (argparse가 stderr에 설명을 쓴다)
    3  Python 버전이 낮음 (wga_installer/__init__.py)
    130 사용자가 Ctrl+C로 중단
"""
import argparse
import os
import sys
import traceback
from pathlib import Path
from typing import TextIO

from .context import DEFAULT_ENV, ENVIRONMENTS, build_context
from .events import Emitter, JsonEmitter, Redactor, TextEmitter
from .runner import Interaction, Runner
from .steps import check

# 명령 이름 → 단계 모듈의 run 함수. 이후 마일스톤에서 setup·deploy·verify·oidc·teardown을 추가한다
COMMANDS = {
    "check": (check.run, "사전 점검 (아무것도 바꾸지 않음)"),
}

EXIT_INTERRUPTED = 130


def build_parser() -> argparse.ArgumentParser:
    # 모든 명령에 공통인 옵션. 명령 뒤에 쓰는 형식(`check --json`)을 쓰기 위해 각 하위 명령에 붙인다
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true",
                        help="이벤트를 JSON Lines로 출력 (macOS 앱이 사용)")
    common.add_argument("--dry-run", action="store_true",
                        help="상태 확인만 하고 변경 명령은 보여 주기만 함")
    common.add_argument("--yes", action="store_true",
                        help="변경 작업을 묻지 않고 승인 (되돌릴 수 없는 삭제 작업에는 적용되지 않음)")
    common.add_argument("--env", choices=ENVIRONMENTS, default=DEFAULT_ENV,
                        help=f"배포 환경 (기본 {DEFAULT_ENV})")
    common.add_argument("--region", help="AWS 리전 (기본: AWS_REGION → 프로필 설정 → ap-northeast-2)")
    common.add_argument("--profile", help="사용할 AWS CLI 프로필 (기본: AWS CLI 기본 규칙)")
    common.add_argument("--repo", help="WGA 저장소 경로 (기본: 현재 폴더에서 상위로 찾음)")

    parser = argparse.ArgumentParser(prog="wga_installer", description="WGA 설치 마법사 단계 엔진")
    commands = parser.add_subparsers(dest="command", required=True, metavar="<명령>")
    for name, (_, help_text) in COMMANDS.items():
        commands.add_parser(name, parents=[common], help=help_text, description=help_text)
    return parser


def main(argv: list[str] | None = None, *, stdin: TextIO | None = None, stdout: TextIO | None = None,
         environ: dict[str, str] | None = None, cwd: Path | None = None) -> int:
    """테스트에서 입출력·환경을 바꿔 끼울 수 있도록 인자로 받는다 (기본은 실제 프로세스의 값)."""
    args = build_parser().parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    environ = dict(os.environ if environ is None else environ)

    redactor = Redactor()
    emitter: Emitter = (JsonEmitter if args.json else TextEmitter)(redactor, stdout)
    try:
        ctx = build_context(env=args.env, region=args.region, profile=args.profile, repo=args.repo,
                            environ=environ, cwd=cwd or Path.cwd())
        interaction = Interaction(emitter, json_mode=args.json, stdin=stdin, prompt_stream=stdout)
        runner = Runner(emitter, interaction, env=ctx.command_env(),
                        cwd=str(ctx.repo_root) if ctx.repo_root else None,
                        dry_run=args.dry_run, assume_yes=args.yes)
        step_run, _ = COMMANDS[args.command]
        return step_run(ctx, runner, emitter)
    except KeyboardInterrupt:
        emitter.error(args.command, "사용자가 중단했습니다")
        return EXIT_INTERRUPTED
    except Exception as exc:  # noqa: BLE001 - 어떤 예외든 앱이 이해할 수 있는 error 이벤트로 바꾼다
        # 예외 메시지·스택에도 비밀 값이 섞일 수 있으므로 Redactor를 거친다.
        # 스택은 stdout(JSON Lines 통로)을 깨뜨리지 않도록 stderr로 보낸다.
        emitter.error(args.command, f"예상하지 못한 오류: {type(exc).__name__}: {exc}",
                      hint="설치 마법사의 버그일 수 있습니다. stderr의 상세 내용과 함께 알려 주세요")
        sys.stderr.write(redactor.redact(traceback.format_exc()))
        return 1


if __name__ == "__main__":
    sys.exit(main())
