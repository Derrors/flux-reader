import AppKit
import SwiftUI

enum AppAppearance: String, CaseIterable, Identifiable {
  case system
  case light
  case dark

  static let storageKey = "fluxReader.appearance"
  static let defaultValue: AppAppearance = .light

  var id: Self { self }

  var title: String {
    switch self {
    case .system:
      "跟随系统"
    case .light:
      "浅色"
    case .dark:
      "深色"
    }
  }

  var systemImage: String {
    switch self {
    case .system:
      "circle.lefthalf.filled"
    case .light:
      "sun.max"
    case .dark:
      "moon"
    }
  }

  var preferredColorScheme: ColorScheme? {
    switch self {
    case .system:
      nil
    case .light:
      .light
    case .dark:
      .dark
    }
  }
}

@main
@MainActor
struct FluxReaderApp: App {
  @StateObject private var viewModel = ReaderViewModel()
  @AppStorage(AppAppearance.storageKey) private var appearance = AppAppearance.defaultValue
  @NSApplicationDelegateAdaptor(FluxReaderApplicationDelegate.self)
  private var applicationDelegate

  var body: some Scene {
    WindowGroup {
      ReaderView(viewModel: viewModel, appearance: $appearance)
        .preferredColorScheme(appearance.preferredColorScheme)
        .onAppear {
          applicationDelegate.viewModel = viewModel
        }
    }
    .defaultSize(width: 1_080, height: 720)
    .commands {
      CommandGroup(replacing: .saveItem) {
        Button("保存") {
          viewModel.save()
        }
        .keyboardShortcut("s", modifiers: .command)
        .disabled(!viewModel.canSave)

        Button("另存为…") {
          viewModel.requestSaveAs()
        }
        .keyboardShortcut("s", modifiers: [.command, .shift])
        .disabled(!viewModel.canSaveAs)
      }

      CommandGroup(replacing: .newItem) {
        Button("打开文件…") {
          viewModel.presentFileImporter()
        }
        .keyboardShortcut("o", modifiers: .command)

        Button("打开文件夹…") {
          viewModel.presentFolderImporter()
        }
        .keyboardShortcut("o", modifiers: [.command, .shift])

        Divider()

        Button("刷新全部文件夹") {
          viewModel.refreshAllWorkspaces()
        }
        .keyboardShortcut("r", modifiers: .command)
        .disabled(viewModel.workspaces.isEmpty)

        Button("关闭全部文件夹") {
          viewModel.closeAllWorkspaces()
        }
        .disabled(viewModel.workspaces.isEmpty)
      }

      CommandMenu("文稿") {
        Button(viewModel.isEditing ? "预览" : "编辑") {
          viewModel.toggleEditing()
        }
        .keyboardShortcut("e", modifiers: .command)
        .disabled(viewModel.currentDocument == nil)

        Button("还原到已保存版本", role: .destructive) {
          viewModel.revertDraft()
        }
        .disabled(!viewModel.hasUnsavedChanges || viewModel.isSaving)

        Button("从磁盘重新载入…") {
          viewModel.reloadFromDisk()
        }
        .disabled(viewModel.currentDocument == nil || viewModel.isSaving)
      }

      CommandMenu("外观") {
        Picker("外观", selection: $appearance) {
          ForEach(AppAppearance.allCases) { option in
            Label(option.title, systemImage: option.systemImage)
              .tag(option)
          }
        }
      }
    }
  }
}

@MainActor
final class FluxReaderApplicationDelegate: NSObject, NSApplicationDelegate {
  weak var viewModel: ReaderViewModel?

  private var isTerminationPending = false
  private var terminationTask: Task<Void, Never>?

  func applicationShouldTerminate(
    _ sender: NSApplication
  ) -> NSApplication.TerminateReply {
    guard let viewModel else { return .terminateNow }
    guard viewModel.hasUnsavedChanges || viewModel.isSaving else {
      return .terminateNow
    }
    guard !isTerminationPending else { return .terminateLater }

    sender.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "要在退出前保存更改吗？"
    alert.informativeText =
      "如果不保存，对 \(viewModel.currentDocument?.displayName ?? "当前文稿") 的更改将会丢失。"
    alert.addButton(withTitle: "保存")
    alert.addButton(withTitle: "不保存")
    alert.addButton(withTitle: "取消")

    switch alert.runModal() {
    case .alertFirstButtonReturn:
      beginTerminationAfterSaving(viewModel)
      return .terminateLater
    case .alertSecondButtonReturn:
      return .terminateNow
    default:
      return .terminateCancel
    }
  }

  private func beginTerminationAfterSaving(_ viewModel: ReaderViewModel) {
    isTerminationPending = true
    if !viewModel.isSaving {
      viewModel.save()
    }

    terminationTask?.cancel()
    terminationTask = Task { [weak self, weak viewModel] in
      guard let self, let viewModel else { return }
      while viewModel.isSaving {
        try? await Task.sleep(for: .milliseconds(50))
      }
      guard !Task.isCancelled else { return }

      let shouldTerminate =
        !viewModel.hasUnsavedChanges && viewModel.saveErrorMessage == nil
      isTerminationPending = false
      terminationTask = nil
      NSApp.reply(toApplicationShouldTerminate: shouldTerminate)
    }
  }
}
