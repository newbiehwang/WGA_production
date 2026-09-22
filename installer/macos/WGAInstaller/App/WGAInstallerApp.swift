import SwiftUI
import WGAInstallerKit

/// 앱 진입점. 로직은 모두 WGAInstallerKit(WizardModel)에 있고, 여기서는 실제 구현을 골라 연결만 한다.
@main
struct WGAInstallerApp: App {
    @StateObject private var model: WizardModel

    init() {
        // 헬퍼·CLI가 먼저 끝나 닫힌 파이프에 써도 앱이 SIGPIPE로 죽지 않게 한다 (ProcessSignals 설명 참고)
        ProcessSignals.ignoreBrokenPipe()
        let location = InstallerLocation.fromBundle()
        _model = StateObject(wrappedValue: WizardModel(
            launcher: ProcessLauncher(location: location),
            helper: CredentialHelperClient(executable: location.helperExecutable),
            helperExecutable: location.helperExecutable,
            storage: UserDefaultsSettingsStorage()))
    }

    var body: some Scene {
        WindowGroup("WGA 설치 마법사") {
            ContentView()
                .environmentObject(model)
                .frame(minWidth: 860, minHeight: 560)
        }
        // macOS 앱 메뉴의 "설정…"(⌘,)으로 여는 창
        Settings {
            SettingsView()
                .environmentObject(model)
        }
    }
}
