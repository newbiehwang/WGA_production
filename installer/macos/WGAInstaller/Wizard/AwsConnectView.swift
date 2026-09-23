import SwiftUI
import WGAInstallerKit

/// ② AWS 연결: [새 Access Key 입력 → 키체인 저장] 또는 [기존 프로필 선택]
/// → 계정 ID·사용자 ARN·리전 표시, 루트 계정 경고, 무료 플랜 제약 안내
struct AwsConnectView: View {
    @EnvironmentObject var model: WizardModel
    @State private var mode: Mode = .newKey
    @State private var accessKeyId = ""
    @State private var secretAccessKey = ""   // SecureField 값. 저장이 끝나면 바로 비운다
    @State private var saving = false
    @State private var chosenProfile = ""

    enum Mode: String, CaseIterable, Identifiable {
        case newKey = "새 Access Key 입력"
        case existing = "기존 AWS 프로필 사용"
        var id: String { rawValue }
    }

    /// check 결과 중 이 화면에 보여 줄 항목
    private static let shownChecks = ["aws_credentials", "root_account", "region", "free_plan"]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("AWS 연결").font(.title2).bold()
            Picker("", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            switch mode {
            case .newKey: newKeyForm
            case .existing: existingProfileForm
            }

            if let message = model.awsMessage {
                Text(message).font(.callout).textSelection(.enabled)
            }
            if let run = model.runs[.aws] {
                if model.isRunning(.aws) { ProgressView("연결 확인 중…").controlSize(.small) }
                CheckList(items: run.checks.filter { Self.shownChecks.contains($0.id) })
                ErrorList(errors: run.errors)
                if run.status == .ok, let next = WizardStep.aws.next,
                   run.checks.contains(where: { $0.id == "aws_credentials" && $0.status == .ok }) {
                    Button("다음: \(next.title)") { model.selected = next }
                }
            } else {
                Spacer()
            }
        }
        .padding(20)
        .task {
            model.loadProfiles()
            await model.refreshHelperStatus()
            chosenProfile = model.settings.profile ?? model.profiles.first ?? ""
        }
    }

    private var newKeyForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("IAM 사용자의 Access Key를 입력하세요. 키는 이 Mac의 키체인에만 저장되고, "
                 + "~/.aws/credentials 파일에는 남지 않습니다. 루트 계정의 키는 쓰지 마세요.")
                .foregroundStyle(.secondary)
            if let status = model.helperStatus, status.stored {
                Label("저장된 키: \(status.maskedAccessKeyId ?? "알 수 없음")", systemImage: "key.fill")
                    .font(.callout)
            }
            Form {
                TextField("Access Key ID", text: $accessKeyId)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                SecureField("Secret Access Key", text: $secretAccessKey)
            }
            .frame(maxWidth: 480)
            Button(saving ? "저장 중…" : "키체인에 저장하고 연결 확인") {
                saving = true
                let id = accessKeyId, secret = secretAccessKey
                Task {
                    let saved = await model.saveAccessKey(accessKeyId: id, secretAccessKey: secret)
                    // 성공하든 실패하든 비밀 값은 화면 상태에서 지운다 (다시 입력받는다)
                    secretAccessKey = ""
                    if saved { accessKeyId = "" }
                    saving = false
                }
            }
            .disabled(saving || accessKeyId.isEmpty || secretAccessKey.isEmpty || model.isAnyRunning)
        }
    }

    private var existingProfileForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("이미 AWS CLI에 설정해 둔 프로필(예: wga-dev)을 씁니다.").foregroundStyle(.secondary)
            if model.profiles.isEmpty {
                Text("~/.aws/config와 ~/.aws/credentials에서 프로필을 찾지 못했습니다.").font(.callout)
            } else {
                Picker("프로필", selection: $chosenProfile) {
                    ForEach(model.profiles, id: \.self) { Text($0).tag($0) }
                }
                .frame(maxWidth: 320)
                Button("이 프로필로 연결 확인") { model.useProfile(chosenProfile) }
                    .disabled(chosenProfile.isEmpty || model.isAnyRunning)
            }
        }
    }
}
