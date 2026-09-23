import AppKit
import SwiftUI
import WGAInstallerKit
import XCTest
@testable import WGA_Installer

/// README에 넣을 화면 그림(단계 화면 하나하나)을 만든다. 테스트는 앱 안에서 실행되므로(TEST_HOST) 진짜 창을 띄워
/// 그 창의 그림을 받아 온다. 내용은 설명용 예시 이벤트다 — 실제 AWS 계정에 연결하지 않으므로
/// 계정 정보가 들어갈 일이 없다.
///
/// 창을 쓰는 이유: SwiftUI의 ImageRenderer는 NavigationSplitView·List처럼 AppKit 뷰로 그려지는
/// 화면을 그리지 못하고 빗금 친 경고 그림만 내놓는다. 앱이 자기 창을 복사하는 것은 화면 기록
/// 권한이 필요 없다.
///
///   WGA_SNAPSHOTS=1 xcodebuild test -scheme WGAInstaller -only-testing:WGAInstallerTests/ScreenshotTests
///
/// 기본으로 건너뛰는 이유: 화면을 조금만 손봐도 그림이 달라져 CI가 실패할 수 있고, 문서용 그림은
/// 바꾸고 싶을 때만 다시 만들면 된다. 저장 위치는 installer/macos/docs/screenshots/ (WGA_SNAPSHOT_DIR로 바꿀 수 있다).
@MainActor
final class ScreenshotTests: XCTestCase {
    /// 이벤트를 테스트가 직접 넣어 주는 가짜 CLI (실제로는 아무것도 실행하지 않는다)
    final class ScriptedLauncher: CLILaunching, @unchecked Sendable {
        final class Session: CLISession, @unchecked Sendable {
            func respond(_ response: InstallerResponse) {}
            func cancel() {}
        }

        /// 명령 이름 → 그 명령이 보낼 이벤트와 종료 코드
        var script: [String: (events: [InstallerEvent], exitCode: Int32?)] = [:]

        func launch(command: String, arguments: [String],
                    onEvent: @escaping @Sendable (InstallerEvent) -> Void,
                    onExit: @escaping @Sendable (Int32) -> Void) throws -> CLISession {
            let scene = script[command] ?? ([], 0)
            scene.events.forEach(onEvent)
            // 종료 코드가 없으면 "실행 중"인 화면이 된다 (진행 막대와 취소 버튼이 보이는 상태)
            if let code = scene.exitCode { onExit(code) }
            return Session()
        }
    }

    final class NoHelper: CredentialHelping, @unchecked Sendable {
        func store(accessKeyId: String, secretAccessKey: String) throws {}
        func status() throws -> HelperStatus { HelperStatus(stored: false, maskedAccessKeyId: nil) }
        func delete() throws {}
    }

    final class MemoryStorage: SettingsStorage {
        var value: InstallerSettings?
        func load() -> InstallerSettings? { value }
        func save(_ settings: InstallerSettings) { value = settings }
    }

    func testMakeScreenshots() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["WGA_SNAPSHOTS"] == "1",
                          "WGA_SNAPSHOTS=1일 때만 실행 (문서용 그림 생성)")
        let directory = outputDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        for scene in Self.scenes {
            let launcher = ScriptedLauncher()
            launcher.script = scene.script
            let model = makeModel(launcher)
            model.selected = scene.step
            model.run(scene.step)
            drainMainQueue()   // WizardModel이 이벤트를 메인 큐로 넘기므로 반영될 때까지 기다린다

            let url = directory.appendingPathComponent("\(scene.name).png")
            try render(detail(for: scene.step).environmentObject(model), to: url)
            print("그림 저장: \(url.path)")
        }
    }

    // MARK: - 화면 목록 (README에 넣는 순서)

    /// 예시 이벤트. 실제 CLI가 보내는 이벤트와 같은 모양이라, 형식이 바뀌면 이 파일도 같이 고쳐야 한다.
    static var scenes: [(name: String, step: WizardStep, script: [String: (events: [InstallerEvent], exitCode: Int32?)])] {
        [
            ("01-check", .check, ["check": (checkEvents, 0)]),
            ("02-aws", .aws, ["check": (awsEvents, 0)]),
            ("03-deploy", .deploy, ["deploy": (deployEvents, nil)]),
            ("04-verify", .verify, ["verify": (verifyEvents, 0)]),
            ("05-oidc", .oidc, ["oidc": (oidcEvents, 0)]),
            ("06-teardown", .teardown, ["teardown": (teardownEvents, nil)]),
        ]
    }

    static let checkEvents: [InstallerEvent] = [
        .stepStarted(step: "check", title: "사전 점검"),
        .check(id: "repo", title: "WGA 저장소", status: .ok, detail: "/Users/me/WGA_production", hint: nil, url: nil),
        .check(id: "python", title: "Python", status: .ok, detail: "3.12.4 (/opt/homebrew/bin/python3)", hint: nil, url: nil),
        .check(id: "aws_cli", title: "AWS CLI", status: .ok, detail: "aws-cli/2.17.0", hint: nil, url: nil),
        .check(id: "node", title: "Node.js", status: .ok, detail: "v22.5.1", hint: nil, url: nil),
        .check(id: "gh", title: "GitHub CLI", status: .warn, detail: "설치되어 있지 않습니다",
               hint: "GitHub 자동 배포 단계에서만 필요합니다: brew install gh", url: nil),
        .check(id: "aws_credentials", title: "AWS 자격 증명", status: .ok,
               detail: "계정 123456789012, 사용자 arn:aws:iam::123456789012:user/wga-installer", hint: nil, url: nil),
        .check(id: "region", title: "배포 리전", status: .info, detail: "ap-northeast-2 (기본값)", hint: nil, url: nil),
        .stepFinished(step: "check", status: .ok, summary: "필수 항목을 모두 갖췄습니다. gh는 GitHub 자동 배포를 쓸 때 설치하세요"),
    ]

    static let awsEvents: [InstallerEvent] = [
        .stepStarted(step: "check", title: "사전 점검"),
        .check(id: "aws_credentials", title: "AWS 자격 증명", status: .ok,
               detail: "계정 123456789012, 사용자 arn:aws:iam::123456789012:user/wga-installer", hint: nil, url: nil),
        .check(id: "root_account", title: "루트 계정 여부", status: .ok, detail: "IAM 사용자로 접속했습니다", hint: nil, url: nil),
        .check(id: "region", title: "배포 리전", status: .info, detail: "ap-northeast-2 (서울)", hint: nil, url: nil),
        .check(id: "free_plan", title: "요금제", status: .info,
               detail: "IAM Identity Center를 쓸 수 없는 계정입니다 (무료 플랜)", hint: nil, url: nil),
        .stepFinished(step: "check", status: .ok, summary: "AWS 연결을 확인했습니다"),
    ]

    static let deployEvents: [InstallerEvent] = [
        .stepStarted(step: "deploy", title: "배포 (dev, ap-northeast-2)"),
        .check(id: "quota", title: "API Gateway 통합 타임아웃 할당량", status: .ok, detail: "120000ms", hint: nil, url: nil),
        .check(id: "ssm", title: "필수 SSM 값", status: .ok, detail: "ANTHROPIC_API_KEY 등록됨", hint: nil, url: nil),
        .progress(step: "deploy", phase: "5/8", label: "MCP 이미지 빌드 (CodeBuild)"),
        .log(stream: "stdout", line: "====== 5. MCP 스택 배포 ======"),
        .log(stream: "stdout", line: "wga-mcp-dev 스택 업데이트 중…"),
        .log(stream: "stdout", line: "CodeBuild 빌드 시작: wga-mcp-build-dev"),
        .log(stream: "stderr", line: "경고: 이미지 빌드는 5~10분 걸릴 수 있습니다"),
        .log(stream: "info", line: "여기까지 12분 걸렸습니다"),
    ]

    static let verifyEvents: [InstallerEvent] = [
        .stepStarted(step: "verify", title: "검증 (dev)"),
        .check(id: "stacks", title: "스택 상태", status: .ok, detail: "5개 스택 모두 CREATE_COMPLETE", hint: nil, url: nil),
        .check(id: "api_auth", title: "API 인증", status: .ok, detail: "토큰 없는 요청을 401로 막습니다", hint: nil, url: nil),
        .check(id: "logs", title: "로그의 권한 오류", status: .ok, detail: "최근 1시간 AccessDenied 없음", hint: nil, url: nil),
        .check(id: "frontend", title: "프론트엔드", status: .ok, detail: "https://dev.d1234abcd.amplifyapp.com",
               hint: nil, url: "https://dev.d1234abcd.amplifyapp.com"),
        .check(id: "dashboard", title: "대시보드", status: .ok, detail: "wga-dashboard-dev", hint: nil,
               url: "https://ap-northeast-2.console.aws.amazon.com/cloudwatch/home"),
        .stepFinished(step: "verify", status: .ok, summary: "검증을 마쳤습니다. 프론트엔드 주소로 접속해 로그인해 보세요"),
    ]

    static let oidcEvents: [InstallerEvent] = [
        .stepStarted(step: "oidc", title: "GitHub 자동 배포 (dev)"),
        .check(id: "gh_auth", title: "GitHub 로그인", status: .ok, detail: "newbiehwang", hint: nil, url: nil),
        .check(id: "repo", title: "대상 저장소", status: .ok, detail: "newbiehwang/WGA_production", hint: nil, url: nil),
        .check(id: "oidc_stack", title: "OIDC 스택", status: .ok, detail: "wga-github-oidc-dev (CREATE_COMPLETE)", hint: nil, url: nil),
        .check(id: "variable", title: "저장소 변수", status: .ok, detail: "AWS_DEPLOY_ROLE_ARN_DEV 등록됨", hint: nil, url: nil),
        .stepFinished(step: "oidc", status: .ok,
                      summary: "이제 main에 push하면 GitHub Actions가 Access Key 없이 배포합니다"),
    ]

    @ViewBuilder
    private func detail(for step: WizardStep) -> some View {
        switch step {
        case .check: CheckView()
        case .aws: AwsConnectView()
        case .setup: SetupView()
        case .deploy: DeployView()
        case .verify: VerifyView()
        case .oidc: OidcView()
        case .teardown: TeardownView()
        }
    }

    static let teardownEvents: [InstallerEvent] = [
        .stepStarted(step: "teardown", title: "정리 (dev)"),
        .check(id: "stacks", title: "지울 스택", status: .info, detail: "wga-dev, wga-mcp-dev, wga-frontend-dev, wga-base-dev", hint: nil, url: nil),
        .check(id: "buckets", title: "지울 버킷", status: .info, detail: "7개 (안의 파일과 이전 버전까지 모두 지웁니다)", hint: nil, url: nil),
        .check(id: "shared", title: "함께 쓰는 리소스", status: .info,
               detail: "GitHub OIDC 공급자와 템플릿 버킷은 다른 환경도 쓰므로 그대로 둡니다", hint: nil, url: nil),
        .inputRequired(id: "confirm-env", prompt: "지우려면 환경 이름(dev)을 그대로 입력하세요", secret: false),
    ]

    // MARK: - 그리기

    private func makeModel(_ launcher: ScriptedLauncher) -> WizardModel {
        var settings = InstallerSettings()
        settings.environment = "dev"
        settings.region = "ap-northeast-2"
        settings.repositoryPath = "/Users/me/WGA_production"
        settings.profile = "wga-installer"
        let storage = MemoryStorage()
        storage.value = settings
        return WizardModel(launcher: launcher, helper: NoHelper(),
                           helperExecutable: URL(fileURLWithPath: "/dev/null"),
                           awsDirectory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),
                           storage: storage)
    }

    /// 창을 띄워 그 안의 화면을 PNG로 저장한다.
    /// 밝은 모드 지정은 뷰를 넣기 전에 해야 한다 (넣은 뒤에 바꾸면 다시 그리는 도중에 복사되어 빈 그림이 나온다).
    private func render(_ view: some View, to url: URL) throws {
        let size = NSSize(width: 1000, height: 640)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "WGA 설치 마법사"
        window.appearance = NSAppearance(named: .aqua)   // 그림은 밝은 모드로 통일한다
        window.contentView = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
        // 창을 화면 밖에 두고 띄운다 (작업 중인 사람의 화면을 가리거나 포커스를 뺏지 않도록)
        window.setFrameOrigin(NSPoint(x: -3000, y: 0))
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        // SwiftUI가 값을 반영하고 그릴 시간을 준다 (.task로 비동기로 채우는 화면이 있다)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))

        guard let content = window.contentView,
              let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else {
            throw XCTSkip("이 환경에서는 창을 그릴 수 없습니다")
        }
        content.cacheDisplay(in: content.bounds, to: bitmap)   // 화면 해상도 그대로 (Retina면 2배)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw XCTSkip("PNG로 바꾸지 못했습니다")
        }
        try png.write(to: url)
    }

    /// 메인 큐에 쌓인 이벤트 처리가 끝날 때까지 기다린다
    private func drainMainQueue() {
        let done = expectation(description: "main queue")
        DispatchQueue.main.async { done.fulfill() }
        wait(for: [done], timeout: 5)
    }

    /// 저장 위치: WGA_SNAPSHOT_DIR 또는 저장소의 installer/macos/docs/screenshots
    private func outputDirectory() -> URL {
        if let path = ProcessInfo.processInfo.environment["WGA_SNAPSHOT_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        // 이 파일 위치: installer/macos/WGAInstallerTests/
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../docs/screenshots").standardizedFileURL
    }
}
