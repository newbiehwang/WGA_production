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

## 현재 범위 (M4)
- 화면: ① 시작·사전 점검, ② AWS 연결, 질문 시트(승인·입력·선택), 설정
- ③~⑦(사전 설정·배포·검증·GitHub 자동 배포·정리) 화면은 M5에서 추가합니다. 그 전까지는 사이드바에 "준비 중"으로 표시되고, 터미널에서 CLI로 실행할 수 있습니다.
