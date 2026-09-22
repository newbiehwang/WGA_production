import XCTest
import WGAInstallerKit

/// 앱 번들 구성 확인. 테스트는 앱 안에서 실행되므로(TEST_HOST) Bundle.main이 앱 번들이다.
/// 로직 테스트는 WGAInstallerKit 패키지에 있고, 여기서는 빌드 설정(project.yml)이 파일을 제자리에 넣었는지만 본다.
final class AppBundleTests: XCTestCase {
    let location = InstallerLocation.fromBundle(.main, environment: [:])

    func testCoreIsBundled() throws {
        let fm = FileManager.default
        XCTAssertTrue(fm.isExecutableFile(atPath: location.launcher.path), "Resources/core/wga-installer가 없습니다")
        XCTAssertTrue(fm.fileExists(atPath: location.coreDirectory.appendingPathComponent("wga_installer/__main__.py").path))
        // 개발 중 생긴 캐시는 넣지 않는다
        let files = try fm.subpathsOfDirectory(atPath: location.coreDirectory.path)
        XCTAssertFalse(files.contains { $0.contains("__pycache__") })
    }

    func testHelperIsBundledNextToApp() {
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: location.helperExecutable.path),
                      "Contents/MacOS/wga-credential-helper가 없습니다")
    }

    func testHelperRejectsUnknownCommand() throws {
        // 번들에 든 헬퍼가 실제로 실행되는지 (키체인을 건드리지 않는 명령으로)
        let process = Process()
        process.executableURL = location.helperExecutable
        process.arguments = ["no-such-command"]
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 2)
    }
}
