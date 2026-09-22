import Foundation

/// 앱이 실행할 파일들의 위치.
///
/// 앱 번들 구조 (installer/macos/project.yml이 만든다)
///     WGA Installer.app/Contents/MacOS/WGA Installer            앱
///     WGA Installer.app/Contents/MacOS/wga-credential-helper    credential_process 헬퍼
///     WGA Installer.app/Contents/Resources/core/                installer/core 복사본 (wga-installer 실행기 + wga_installer 패키지)
public struct InstallerLocation: Equatable, Sendable {
    /// installer/core 폴더 (wga-installer 실행기가 있는 곳)
    public let coreDirectory: URL
    /// wga-credential-helper 실행 파일
    public let helperExecutable: URL

    public init(coreDirectory: URL, helperExecutable: URL) {
        self.coreDirectory = coreDirectory
        self.helperExecutable = helperExecutable
    }

    public var launcher: URL { coreDirectory.appendingPathComponent("wga-installer") }

    /// 앱 번들에서 찾는다. 개발 중에는 환경 변수로 바꿀 수 있다
    /// (WGA_INSTALLER_CORE: 저장소의 installer/core, WGA_CREDENTIAL_HELPER: swift build로 만든 헬퍼).
    public static func fromBundle(_ bundle: Bundle = .main,
                                  environment: [String: String] = ProcessInfo.processInfo.environment) -> InstallerLocation {
        let core = environment["WGA_INSTALLER_CORE"].map { URL(fileURLWithPath: $0) }
            ?? bundle.resourceURL!.appendingPathComponent("core")
        let helper = environment["WGA_CREDENTIAL_HELPER"].map { URL(fileURLWithPath: $0) }
            ?? bundle.bundleURL.appendingPathComponent("Contents/MacOS/wga-credential-helper")
        return InstallerLocation(coreDirectory: core, helperExecutable: helper)
    }
}

public enum ToolPath {
    /// Homebrew가 도구를 설치하는 폴더. Finder·Dock에서 연 앱은 셸 설정(~/.zprofile)을 읽지 않아
    /// PATH가 /usr/bin:/bin:/usr/sbin:/sbin뿐이다. 그대로 CLI를 실행하면 aws·gh·node를 찾지 못해
    /// 사전 점검이 "설치되어 있지 않음"으로 나온다. 그래서 앱이 실행하는 명령의 PATH 앞에 이 폴더들을 붙인다.
    public static let extraDirectories = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]

    /// 기존 PATH 앞에 extraDirectories를 (없는 것만) 붙인다.
    public static func augmented(_ current: String?) -> String {
        let existing = (current ?? "").split(separator: ":").map(String.init).filter { !$0.isEmpty }
        let base = existing.isEmpty ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] : existing
        let missing = extraDirectories.filter { !base.contains($0) }
        return (missing + base).joined(separator: ":")
    }

    /// 자식 프로세스에 넘길 환경 변수
    public static func environment(_ base: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var env = base
        env["PATH"] = augmented(base["PATH"])
        return env
    }
}
