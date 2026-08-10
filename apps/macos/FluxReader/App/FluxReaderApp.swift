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
        .disabled(!viewModel.canEdit)

        Button("还原到已保存版本", role: .destructive) {
          viewModel.revertDraft()
        }
        .disabled(!viewModel.hasUnsavedChanges || viewModel.isSaving)

        Button("从磁盘重新载入…") {
          viewModel.reloadFromDisk()
        }
        .disabled(viewModel.currentDocument == nil || viewModel.isSaving)

        Divider()

        Button("查找…") {
          viewModel.presentFind()
        }
        .keyboardShortcut("f", modifiers: .command)
        .disabled(viewModel.currentDocument == nil)

        Button("查找并替换…") {
          viewModel.presentFind(replace: true)
        }
        .keyboardShortcut("f", modifiers: [.command, .option])
        .disabled(!viewModel.canEdit)

        Divider()

        Picker("文稿视图", selection: documentViewModeBinding) {
          ForEach(ReaderViewModel.DocumentViewMode.allCases) { mode in
            Label(mode.title, systemImage: mode.systemImage)
              .tag(mode)
          }
        }
        .disabled(viewModel.currentDocument == nil)

        Button("关闭标签页") {
          viewModel.closeActiveTab()
        }
        .keyboardShortcut("w", modifiers: .command)
        .disabled(viewModel.activeTabID == nil)
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

  private var documentViewModeBinding: Binding<ReaderViewModel.DocumentViewMode> {
    Binding(
      get: { viewModel.documentViewMode },
      set: { viewModel.setDocumentViewMode($0) }
    )
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
    #if DEBUG
      if ProcessInfo.processInfo.environment[
        "FLUX_READER_UI_TEST_FORCE_TERMINATION"
      ] == "1" {
        // XCUITest uses this only to model an abrupt process exit. Do not clear
        // the recovery record or show the normal user-facing quit decision.
        return .terminateNow
      }
    #endif

    guard let viewModel else { return .terminateNow }
    guard
      viewModel.hasUnsavedChanges || viewModel.isSaving
        || viewModel.isDraftRecoverySyncing
        || viewModel.hasDraftRecoveryCleanupFailure
    else {
      return viewModel.persistSessionForTermination() ? .terminateNow : .terminateCancel
    }
    guard !isTerminationPending else { return .terminateLater }

    // Once a save has crossed into background I/O, "不保存" cannot safely
    // mean "terminate immediately": the write may still commit after the
    // process starts exiting. Wait for that operation and cancel termination
    // if it fails or leaves a newer dirty draft.
    if viewModel.isSaving {
      beginTerminationAfterPendingWork(viewModel)
      return .terminateLater
    }

    // Returning to the on-disk text starts an asynchronous recovery-record
    // clear. A clean editor is not safe to terminate until that clear has
    // either completed or failed visibly.
    if !viewModel.hasUnsavedChanges, viewModel.isDraftRecoverySyncing {
      beginTerminationAfterPendingWork(viewModel)
      return .terminateLater
    }

    if !viewModel.hasUnsavedChanges,
      viewModel.hasDraftRecoveryCleanupFailure
    {
      return presentDraftRecoveryCleanupFailure(sender, viewModel: viewModel)
    }

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
      beginTerminationAfterPendingWork(viewModel)
      return .terminateLater
    case .alertSecondButtonReturn:
      return viewModel.discardChangesForTermination()
        ? .terminateNow : .terminateCancel
    default:
      return .terminateCancel
    }
  }

  private func presentDraftRecoveryCleanupFailure(
    _ sender: NSApplication,
    viewModel: ReaderViewModel
  ) -> NSApplication.TerminateReply {
    sender.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "恢复草稿尚未清理"
    alert.informativeText =
      viewModel.draftRecoveryCleanupErrorMessage
      ?? "恢复记录仍被保留。你可以重试清理，或明确保留记录后退出。"
    alert.addButton(withTitle: "重试清理")
    alert.addButton(withTitle: "保留并退出")
    alert.addButton(withTitle: "取消")

    switch alert.runModal() {
    case .alertFirstButtonReturn:
      viewModel.retryDraftRecoveryCleanup()
      beginTerminationAfterPendingWork(viewModel)
      return .terminateLater
    case .alertSecondButtonReturn:
      return viewModel.persistSessionForTermination() ? .terminateNow : .terminateCancel
    default:
      return .terminateCancel
    }
  }

  private func beginTerminationAfterPendingWork(_ viewModel: ReaderViewModel) {
    isTerminationPending = true
    if viewModel.hasUnsavedChanges, !viewModel.isSaving {
      viewModel.save()
    }

    terminationTask?.cancel()
    terminationTask = Task { [weak self, weak viewModel] in
      guard let self, let viewModel else { return }
      while viewModel.isSaving || viewModel.isDraftRecoverySyncing {
        try? await Task.sleep(for: .milliseconds(50))
      }
      guard !Task.isCancelled else { return }

      let workCompleted =
        !viewModel.hasUnsavedChanges && viewModel.saveErrorMessage == nil
        && !viewModel.hasDraftRecoveryCleanupFailure
      let shouldTerminate = workCompleted && viewModel.persistSessionForTermination()
      isTerminationPending = false
      terminationTask = nil
      NSApp.reply(toApplicationShouldTerminate: shouldTerminate)
    }
  }
}
