#!/bin/bash
# WGA 설치 마법사 앱을 배포용 디스크 이미지(.dmg) 하나로 만든다.
#
#   installer/macos/make-dmg.sh              # installer/macos/build/에 만든다
#   installer/macos/make-dmg.sh ~/Desktop    # 출력 폴더 지정
#
# 결과물
#   WGA-Installer-<버전>.dmg          앱 + Applications 바로가기 + "처음 실행하기.txt"
#   WGA-Installer-<버전>.dmg.sha256   받은 사람이 파일이 손상·변조되지 않았는지 확인할 해시
#
# 순서: XcodeGen으로 프로젝트 생성 → Release 빌드 → 서명 검증 → 임시 폴더에 담기 → hdiutil로 압축 이미지 생성
#
# 서명: Apple Developer Program 가입 전이라 ad-hoc 서명이다. 받은 사람의 Mac에서는 Gatekeeper가
# "확인되지 않은 개발자"로 막으므로, 여는 방법을 "처음 실행하기.txt"에 적어 둔다. Developer ID가 생기면
# 이 스크립트에 codesign(Developer ID)·notarytool 공증 단계를 더하면 된다.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${1:-$HERE/build}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

command -v xcodegen >/dev/null || { echo "오류: xcodegen이 없습니다 → brew install xcodegen" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "오류: Xcode가 필요합니다" >&2; exit 1; }

echo "▶ Xcode 프로젝트 생성"
(cd "$HERE" && xcodegen generate --quiet)

echo "▶ Release 빌드"
# 빌드 로그는 파일로 남기고, 실패하면 마지막 부분을 보여 준다
LOG="$OUT/build.log"
if ! xcodebuild -project "$HERE/WGAInstaller.xcodeproj" -scheme WGAInstaller -configuration Release \
      -derivedDataPath "$OUT/DerivedData" build >"$LOG" 2>&1; then
  tail -30 "$LOG" >&2
  echo "오류: 빌드에 실패했습니다 (전체 로그: $LOG)" >&2
  exit 1
fi
APP="$OUT/DerivedData/Build/Products/Release/WGA Installer.app"

echo "▶ 앱 번들 검사"
# 번들 안에 CLI와 헬퍼가 있는지, 서명이 깨지지 않았는지 (번들 내용이 바뀌면 서명 검증이 실패한다)
[[ -x "$APP/Contents/Resources/core/wga-installer" ]] || { echo "오류: 번들에 installer/core가 없습니다" >&2; exit 1; }
[[ -x "$APP/Contents/MacOS/wga-credential-helper" ]] || { echo "오류: 번들에 헬퍼가 없습니다" >&2; exit 1; }
if find "$APP/Contents/Resources/core" -name "__pycache__" | grep -q .; then
  echo "오류: 번들에 __pycache__가 있습니다" >&2; exit 1
fi
codesign --verify --deep --strict "$APP"

VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
DMG="$OUT/WGA-Installer-$VERSION.dmg"

echo "▶ 디스크 이미지 만들기 ($VERSION)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# ditto: 코드 서명과 확장 속성을 그대로 복사한다 (cp -R은 환경에 따라 서명에 필요한 정보를 잃을 수 있다)
ditto "$APP" "$STAGE/WGA Installer.app"
# 창에서 앱을 끌어다 놓을 수 있도록 Applications 폴더 바로가기를 둔다
ln -s /Applications "$STAGE/Applications"
cp "$HERE/dmg/처음 실행하기.txt" "$STAGE/처음 실행하기.txt"

rm -f "$DMG" "$DMG.sha256"
# UDZO: 압축된 읽기 전용 이미지 (배포용 표준 형식)
hdiutil create -volname "WGA Installer $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
(cd "$OUT" && shasum -a 256 "$(basename "$DMG")" > "$(basename "$DMG").sha256")

echo "✓ 만들었습니다: $DMG ($(du -h "$DMG" | cut -f1))"
echo "  SHA-256: $(cut -d' ' -f1 "$DMG.sha256")"
