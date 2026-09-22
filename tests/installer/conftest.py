"""설치 마법사 테스트 픽스처. 도우미 클래스·함수는 helpers.py에 있다."""
from pathlib import Path

import pytest

from .helpers import FakeCli


@pytest.fixture
def fake(tmp_path) -> FakeCli:
    return FakeCli(tmp_path)


@pytest.fixture
def repo(tmp_path) -> Path:
    """deploy.sh와 cloudformation/만 있는 최소한의 가짜 저장소."""
    root = tmp_path / "repo"
    (root / "cloudformation").mkdir(parents=True)
    deploy = root / "deploy.sh"
    deploy.write_text("#!/bin/bash\n")
    deploy.chmod(0o755)
    return root
