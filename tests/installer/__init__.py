"""설치 마법사(installer/core) 테스트.

패키지로 만든 이유: tests/conftest.py와 이 폴더의 conftest.py가 둘 다 `conftest`라는 최상위 모듈 이름을 쓰면
기존 테스트의 `from conftest import ROOT`가 이 폴더의 conftest를 가져가 깨진다.
패키지 안에서는 `installer.conftest`가 되어 충돌하지 않는다.
"""
