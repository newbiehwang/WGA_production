# WGA 설치 마법사 — macOS 앱

SwiftUI 앱이 `installer/core`의 CLI를 실행하고, CLI가 내보내는 JSON Lines 이벤트를 화면에 보여 줍니다.
macOS 13 이상, 로컬 빌드(ad-hoc 서명) 기준입니다. App Store 밖에서 배포합니다.

## 빌드와 실행

```bash
brew install xcodegen
cd installer/macos
xcodegen generate                      # WGAInstaller.xcodeproj 생성 (커밋하지 않음)
open WGAInstaller.xcodeproj            # Xcode에서 ⌘R
```

명령줄로 빌드·테스트:

```bash
xcodebuild -project WGAInstaller.xcodeproj -scheme WGAInstaller test
```

로직만 확인할 때는 Xcode 프로젝트 없이 패키지 테스트로 충분합니다.

```bash
cd installer/macos/WGAInstallerKit && swift test
```

## 배포용 디스크 이미지 (.dmg)

```bash
installer/macos/make-dmg.sh            # → installer/macos/build/WGA-Installer-<버전>.dmg (+ .sha256)
```

Release로 빌드하고 번들을 검사(core·헬퍼 포함, `__pycache__` 없음, 서명 검증)한 뒤 `hdiutil`로 압축 이미지를 만듭니다. 이미지에는 앱, Applications 바로가기, `처음 실행하기.txt`가 들어갑니다. 버전은 `project.yml`의 `MARKETING_VERSION`에서 가져옵니다.

- **Gatekeeper:** ad-hoc 서명이라 받은 사람의 Mac에서는 "확인되지 않은 개발자"로 막힙니다(`spctl` 결과 rejected). 여는 방법은 `dmg/처음 실행하기.txt`에 있습니다. macOS 15부터는 Control-클릭 → 열기가 통하지 않고, 시스템 설정 → 개인정보 보호 및 보안 → "그래도 열기"를 눌러야 합니다.
- **저장소는 들어 있지 않습니다:** 앱은 WGA 저장소의 `deploy.sh`로 배포하므로, 받은 사람도 저장소를 clone해 설정에서 지정해야 합니다.
- **Developer ID가 생기면:** 이 스크립트에 Developer ID 서명과 `notarytool` 공증, `stapler` 단계를 더하면 경고 없이 열립니다.

처음 실행하면 ⌘, (설정)에서 **WGA 저장소 폴더**를 지정하세요. 지정하지 않으면 사전 점검의 "WGA 저장소" 항목이 실패합니다.

## 구조

```
installer/macos/
├── project.yml              XcodeGen 설정 (앱·헬퍼·테스트 타깃, core 복사 스크립트)
├── WGAInstaller/            SwiftUI 화면 (App/, Wizard/)
├── WGAInstallerTests/       앱 번들 구성 확인 (core·헬퍼가 제자리에 들어갔는지)
└── WGAInstallerKit/         로직 패키지 (swift test로 실행)
    ├── WGAInstallerKit      이벤트 해석, CLI 실행, 단계 상태(StepRun), 마법사 상태(WizardModel), ~/.aws/config 편집
    ├── CredentialStore      키체인 저장·조회, credential_process 출력 형식
    └── wga-credential-helper  AWS CLI credential_process로 등록되는 도구
```

앱 번들:

```
WGA Installer.app/Contents/MacOS/WGA Installer            앱
WGA Installer.app/Contents/MacOS/wga-credential-helper    헬퍼 (서명 ID com.wga.installer.credential-helper)
WGA Installer.app/Contents/Resources/core/                installer/core 복사본 (빌드할 때마다 동기화)
```

- 화면은 `WizardModel`을 보고 그리기만 합니다. 상태 전이는 `StepRun.apply(event)`로 이벤트 목록만 가지고 테스트합니다.
- CLI는 `/bin/bash Resources/core/wga-installer <명령> --json`으로 실행합니다. Python을 고르는 규칙(Homebrew 우선)을 실행기 한곳에 두기 위해서입니다.
- Finder에서 연 앱은 PATH에 Homebrew 폴더가 없어서, CLI를 실행할 때 `/opt/homebrew/bin`·`/usr/local/bin`을 앞에 붙입니다.
- 취소 버튼은 CLI에 SIGINT를 보냅니다. CLI가 deploy.sh와 그 자식 프로세스까지 정리합니다.

## AWS 자격 증명: 키체인과 credential_process

"새 Access Key 입력"을 고르면:

1. 앱이 `wga-credential-helper store`를 실행해 **stdin으로** 키를 넘깁니다. 명령 인자로는 넘기지 않습니다(`ps`에 보이므로).
2. 헬퍼가 키를 로그인 키체인에 저장합니다(서비스 `com.wga.installer.aws`, 항목 이름 "WGA Installer AWS 자격 증명").
3. 앱이 `~/.aws/config`에 아래 섹션만 추가하거나 갱신합니다. 바꾸기 전에 원본을 `config.bak-<시각>`으로 백업하고, 다른 섹션은 건드리지 않습니다.
   ```ini
   [profile wga-installer]
   credential_process = "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper" get
   region = ap-northeast-2
   ```
4. AWS CLI가 필요할 때 헬퍼를 실행해 키를 받습니다. **키는 `~/.aws/credentials`에 평문으로 남지 않습니다.**

### 키체인은 헬퍼만 다룹니다
로그인 키체인의 항목은 그것을 만든 프로그램만 허용 창 없이 읽을 수 있습니다. 앱이 만든 항목을 헬퍼가 읽으면 허용 창이 뜨고, 그동안 AWS CLI가 멈춥니다. 그래서 저장·조회·삭제를 모두 헬퍼가 하고, 앱은 키 값을 다시 읽지 않습니다. 헬퍼는 허용 창을 끄고 실행하므로, 권한이 없으면 창을 띄우지 않고 곧바로 실패합니다.

데이터 보호 키체인은 쓰지 않습니다. 개발자 팀 ID로 서명해야 쓸 수 있어서, Apple Developer Program 가입 전인 로컬 빌드에서는 사용할 수 없기 때문입니다.

### 키체인 접근 확인 결과 (임시 키체인 파일로 확인)
| 상황 | 결과 |
|---|---|
| 헬퍼가 저장 → 같은 헬퍼가 읽기 | 허용 창 없이 읽음 |
| 서명이 다른 프로그램이 읽기 | 창 없이 곧바로 거부 |
| 서명이 다른 프로그램이 상태 확인(값은 읽지 않음) | 됨 |
| 서명이 다른 프로그램이 다시 저장 | **거부** (`-25244`: 다른 프로그램이 만든 항목은 지울 수 없음) |

**알려진 제한:** 로컬(ad-hoc) 빌드는 빌드할 때마다 서명이 바뀝니다. 그래서 헬퍼를 다시 빌드하면 이전에 저장한 키를 읽지도 바꾸지도 못합니다. 이때 헬퍼는 "'키체인 접근' 앱에서 'WGA Installer AWS 자격 증명' 항목을 삭제한 뒤 다시 저장하세요"라고 안내합니다. Developer ID로 서명한 배포본은 버전이 바뀌어도 서명 ID가 같아서 이 문제가 없습니다. 이에 대비해 헬퍼의 서명 ID를 `com.wga.installer.credential-helper`로 고정해 두었습니다.

## 개발용 환경 변수

| 변수 | 용도 |
|---|---|
| `WGA_INSTALLER_CORE` | 앱 번들 대신 쓸 `installer/core` 경로 (Xcode 실행 설정에 넣으면 파이썬을 고친 뒤 다시 빌드하지 않아도 됨) |
| `WGA_CREDENTIAL_HELPER` | 앱 번들 대신 쓸 헬퍼 경로 |
| `WGA_KEYCHAIN_PATH` | (헬퍼) 로그인 키체인 대신 쓸 키체인 파일 (테스트용) |
| `WGA_KEYCHAIN_TESTS=1` | 실제 키체인 통합 테스트 실행 (임시 키체인을 만들고 지움) |
| `WGA_CORE_E2E=1` | 저장소의 실제 `installer/core`로 `check --dry-run`을 실행하는 연결 테스트 |

## 화면

| 단계 | 실행하는 명령 | 화면에서 하는 일 |
|---|---|---|
| ① 시작·사전 점검 | `check` | 도구·저장소·연결 점검, 설치 명령 복사 |
| ② AWS 연결 | `check --profile …` | 새 Access Key를 키체인에 저장하거나 기존 프로필 선택, 계정·ARN·루트 계정 경고 |
| ③ 사전 설정 | `setup` | 할당량 요청, API 키·Slack 값 입력(보안 입력란 시트) |
| ④ 배포 | `deploy --alarm-email …` | 6단계 진행 막대, 실시간 로그, 취소(경고 후) |
| ⑤ 검증 | `verify` | 항목별 결과, 프론트엔드·대시보드 "열기" |
| ⑥ GitHub 자동 배포 | `oidc [--test-run] [--block-test]` | OIDC Role·Environment·변수 설정, 시험 배포, 차단 확인 |
| ⑦ 정리 | `teardown [--allow-prod]` | 지울 대상 목록 → 환경 이름 입력 → 단계별 승인 |

- **dry-run:** 도구 막대의 `dry-run` 버튼을 켜면 모든 단계가 현재 상태만 확인하고, 실행할 명령을 화면에 보여 주기만 합니다. 실제 계정에서 전 과정을 안전하게 미리 볼 수 있습니다.
- **질문 시트:** CLI가 묻는 승인·입력·선택은 시트로 뜹니다. 승인 시트에는 실행할 명령이 그대로 보이고, 비밀 값은 CLI가 이미 `***`로 가린 상태입니다.
- **한 번에 한 단계:** 배포 중에 정리를 시작하는 식으로 겹쳐 실행하지 않도록, 실행 중에는 다른 단계의 실행 버튼과 설정을 잠급니다.
- **한 번만 쓰는 선택:** 시험 배포, 차단 확인, prod 삭제 허용은 실행하고 나면 다시 꺼집니다. 다음 실행에 모르고 적용되지 않게 하기 위해서입니다.
- **로그:** 검색, 전체 복사(비밀 값은 가려진 상태), 새 줄이 오면 자동으로 아래로 따라갑니다. 최근 5000줄을 보여 줍니다.
- **설정(⌘,):** 환경·리전·저장소·알람 이메일·GitHub 저장소·dry-run, 그리고 진단 정보(CLI·헬퍼 경로)가 있습니다.
