import SwiftUI
import WGAInstallerKit

/// ③ 사전 설정: 할당량 요청 상태, Anthropic 키·Slack 값 입력(보안 입력란은 CLI가 물을 때 시트로 뜬다)
struct SetupView: View {
    var body: some View {
        StepScreen(step: .setup) {
            Text("Anthropic API 키와 Slack 값은 실행 중에 보안 입력란으로 묻습니다. 입력한 값은 이 Mac에 저장하지 않고 "
                 + "AWS SSM Parameter Store에 암호화해 저장합니다. Slack을 쓰지 않으면 비워 두세요.")
                .foregroundStyle(.secondary)
        }
    }
}

/// ④ 배포: 진행 표시(6단계), 실시간 로그, 예상 시간, 취소(경고)
struct DeployView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        StepScreen(step: .deploy) {
            Form {
                TextField("알람 이메일 (선택)", text: $model.settings.alarmEmail,
                          prompt: Text("비우면 알람 메일을 보내지 않습니다"))
            }
            .frame(maxWidth: 480)
            .disabled(model.isRunning(.deploy))
            Text("배포 전에 할당량과 필수 SSM 값을 먼저 확인하고, 부족하면 시작하지 않습니다. "
                 + "알람 이메일을 넣었다면 배포 뒤 받은 구독 확인 메일의 링크를 눌러야 알람이 옵니다.")
                .font(.callout).foregroundStyle(.secondary)
        }
    }
}

/// ⑤ 검증: 검사 항목별 통과/실패, 프론트엔드·대시보드 열기
struct VerifyView: View {
    var body: some View {
        StepScreen(step: .verify)
    }
}

/// ⑥ GitHub 자동 배포: gh 로그인 상태 → OIDC 설정 → 변수 등록 경고 → 차단 테스트
struct OidcView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        StepScreen(step: .oidc) {
            if !["dev", "prod"].contains(model.settings.environment) {
                Label("GitHub 자동 배포는 dev와 prod만 설정할 수 있습니다 (설정에서 환경을 바꾸세요)",
                      systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            }
            Form {
                TextField("GitHub 저장소 (선택)", text: $model.settings.githubRepository,
                          prompt: Text("owner/repo — 비우면 저장소 폴더의 git remote"))
                Toggle("설정 후 main 브랜치로 시험 배포 (실제로 배포되고 비용이 발생합니다)", isOn: $model.options.testRun)
                Toggle("다른 브랜치의 배포가 막히는지 확인 (임시 브랜치를 만들었다 지웁니다)", isOn: $model.options.blockTest)
            }
            .frame(maxWidth: 560)
            .disabled(model.isRunning(.oidc))
            Label("저장소 변수 AWS_DEPLOY_ROLE_ARN_\(model.settings.environment.uppercased())가 등록되면, "
                  + "그 뒤로 main에 push할 때마다 자동으로 배포됩니다.", systemImage: "exclamationmark.circle")
                .font(.callout)
        }
    }
}

/// ⑦ 정리: 삭제 대상 목록 → 환경 이름 입력 → 진행 표시
struct TeardownView: View {
    @EnvironmentObject var model: WizardModel

    var body: some View {
        StepScreen(step: .teardown) {
            Label("\(model.settings.environment) 환경의 스택·버킷(저장된 파일 포함)·로그·SSM 값·GitHub 설정을 모두 지웁니다. "
                  + "지울 대상을 먼저 보여 주고, 환경 이름을 직접 입력해야 진행합니다.", systemImage: "trash")
                .foregroundStyle(.red)
            Form {
                TextField("GitHub 저장소 (선택)", text: $model.settings.githubRepository,
                          prompt: Text("owner/repo — 비우면 저장소 폴더의 git remote"))
                if model.settings.environment == "prod" {
                    Toggle("prod 삭제를 허용합니다", isOn: $model.options.allowProd)
                }
            }
            .frame(maxWidth: 560)
            .disabled(model.isRunning(.teardown))
        }
    }
}
