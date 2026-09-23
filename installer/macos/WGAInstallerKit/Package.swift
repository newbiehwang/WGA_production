// swift-tools-version:5.9
// WGA 설치 마법사 macOS 앱의 로직 패키지.
//
// 화면(SwiftUI 뷰)을 뺀 모든 로직을 여기에 둔다. 이렇게 나누면 Xcode 프로젝트 없이
// `swift test`만으로 이벤트 해석, CLI 실행, 화면 상태 전이, 키체인 저장을 테스트할 수 있다.
// 앱(installer/macos/project.yml의 WGAInstaller 타깃)은 이 패키지를 가져다 쓴다.
//
//   WGAInstallerKit        앱 로직: CLI(installer/core) 실행, 이벤트 해석, 단계 상태, ~/.aws/config 편집
//   CredentialStore        키체인 저장·조회와 credential_process 출력 형식 (헬퍼가 쓴다)
//   wga-credential-helper  AWS CLI의 credential_process로 등록되는 명령줄 도구
import PackageDescription

let package = Package(
    name: "WGAInstallerKit",
    platforms: [.macOS(.v13)],   // NavigationSplitView 등 앱이 쓰는 SwiftUI 기능의 최소 버전
    products: [
        .library(name: "WGAInstallerKit", targets: ["WGAInstallerKit"]),
        .library(name: "CredentialStore", targets: ["CredentialStore"]),
        .executable(name: "wga-credential-helper", targets: ["wga-credential-helper"]),
    ],
    targets: [
        .target(name: "WGAInstallerKit", dependencies: ["CredentialStore"]),   // 입력 형식 검사를 헬퍼와 같은 규칙으로
        .target(name: "CredentialStore"),
        .executableTarget(name: "wga-credential-helper", dependencies: ["CredentialStore"]),
        .testTarget(name: "WGAInstallerKitTests", dependencies: ["WGAInstallerKit"]),
        .testTarget(name: "CredentialStoreTests", dependencies: ["CredentialStore"]),
    ]
)
