import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ReaderView: View {
  @ObservedObject var viewModel: ReaderViewModel
  @Binding var appearance: AppAppearance
  @State private var editorScrollFraction = 0.0
  @State private var previewScrollFraction = 0.0

  var body: some View {
    NavigationSplitView {
      sidebar
    } detail: {
      detail
        .navigationTitle(navigationTitle)
    }
    .navigationSplitViewStyle(.balanced)
    .frame(minWidth: 860, minHeight: 580)
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        if viewModel.currentDocument != nil {
          if viewModel.isViewingRetainedRecoveryVersion {
            Label("恢复版本（只读）", systemImage: "lock.fill")
              .help("恢复版本只能查看；如需继续处理，请使用“另存为”创建新文稿")
          } else {
            Picker("文稿视图", selection: documentViewModeBinding) {
              ForEach(ReaderViewModel.DocumentViewMode.allCases) { mode in
                Label(mode.title, systemImage: mode.systemImage)
                  .tag(mode)
              }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 190)
            .help("切换预览、编辑或左右分栏")
            .accessibilityIdentifier("flux.document-view-mode")
          }

          Button {
            viewModel.presentFind()
          } label: {
            Label("查找", systemImage: "magnifyingglass")
          }
          .help("在当前文稿中查找（⌘F）")
          .accessibilityIdentifier("flux.find")

          if viewModel.hasUnsavedChanges {
            Text("未保存")
              .font(.caption)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("flux.dirty-indicator")
          }

          Button {
            viewModel.save()
          } label: {
            if viewModel.isSaving {
              ProgressView()
                .controlSize(.small)
            } else {
              Label("保存", systemImage: "square.and.arrow.down")
            }
          }
          .help("保存当前文稿")
          .disabled(!viewModel.canSave)
          .accessibilityIdentifier("flux.save")

          Menu {
            Button("另存为…") {
              viewModel.requestSaveAs()
            }
            .disabled(!viewModel.canSaveAs)

            Button("还原到已保存版本", role: .destructive) {
              viewModel.revertDraft()
            }
            .disabled(!viewModel.hasUnsavedChanges || viewModel.isSaving)

            Button("从磁盘重新载入…") {
              viewModel.reloadFromDisk()
            }
            .disabled(viewModel.isSaving)
          } label: {
            Label("文稿操作", systemImage: "ellipsis.circle")
          }
          .help("另存为或还原文稿")
          .accessibilityIdentifier("flux.document-actions")
        }

        Menu {
          ForEach(AppAppearance.allCases) { option in
            Button {
              appearance = option
            } label: {
              Label(
                option.title,
                systemImage: appearance == option ? "checkmark" : option.systemImage
              )
            }
          }
        } label: {
          Label("切换外观", systemImage: appearance.systemImage)
            .labelStyle(.iconOnly)
        }
        .help("切换跟随系统、浅色或深色外观")
        .accessibilityIdentifier("flux.appearance")
        .accessibilityValue(appearance.title)

        if !viewModel.workspaces.isEmpty {
          Button {
            viewModel.refreshAllWorkspaces()
          } label: {
            Label("刷新文件夹", systemImage: "arrow.clockwise")
          }
          .help("立即刷新全部文件夹；平时会自动监听变化")
        }

        Button {
          viewModel.presentFolderImporter()
        } label: {
          Label("打开文件夹", systemImage: "folder.badge.plus")
        }
        .help("打开 Markdown 文件夹")

        Button {
          viewModel.presentFileImporter()
        } label: {
          Label("打开文件", systemImage: "doc.badge.plus")
        }
        .help("打开 Markdown 文稿")
      }
    }
    .fileImporter(
      isPresented: $viewModel.isImporterPresented,
      allowedContentTypes: viewModel.importerRequest == .document
        ? MarkdownContentType.allowedContentTypes : [.folder],
      allowsMultipleSelection: viewModel.importerRequest == .folders,
      onCompletion: viewModel.handleImporterResult
    )
    .onOpenURL(perform: viewModel.open)
    .dropDestination(for: URL.self) { urls, _ in
      viewModel.handleDrop(urls)
    }
    .task {
      viewModel.restoreLibraryIfNeeded()
    }
    .onChange(of: viewModel.saveAsRequestID) { _, _ in
      presentSavePanel()
    }
    .confirmationDialog(
      "当前文稿有未保存的更改",
      isPresented: $viewModel.isUnsavedChangesConfirmationPresented,
      titleVisibility: .visible
    ) {
      Button("保存并打开") {
        viewModel.saveAndOpenPendingDocument()
      }
      Button("不保存并打开", role: .destructive) {
        viewModel.discardChangesAndOpenPendingDocument()
      }
      Button("取消", role: .cancel) {
        viewModel.cancelPendingDocumentOpen()
      }
    } message: {
      Text("你可以先保存当前更改，或放弃更改后继续打开其他文稿。")
    }
    .confirmationDialog(
      "永久删除保存恢复版本？",
      isPresented: recoveryVersionDeletionBinding,
      titleVisibility: .visible
    ) {
      Button("删除恢复版本", role: .destructive) {
        viewModel.confirmDeleteRetainedRecoveryVersion()
      }
      .accessibilityIdentifier("flux.confirm-delete-recovery-version")
      Button("取消", role: .cancel) {
        viewModel.cancelDeleteRetainedRecoveryVersion()
      }
    } message: {
      Text(
        "恢复版本用于保留其他应用通过旧文件句柄晚到写入的内容。应用至少保留 24 小时；确认删除后无法恢复。"
      )
    }
    .confirmationDialog(
      "关闭前要保存更改吗？",
      isPresented: $viewModel.isTabCloseConfirmationPresented,
      titleVisibility: .visible
    ) {
      Button("保存并关闭") {
        viewModel.saveAndClosePendingTab()
      }
      Button("不保存并关闭", role: .destructive) {
        viewModel.discardAndClosePendingTab()
      }
      Button("取消", role: .cancel) {
        viewModel.cancelPendingTabClose()
      }
    } message: {
      Text("未保存的更改只会在你明确放弃后丢弃。")
    }
    .alert("无法完成文稿操作", isPresented: saveErrorBinding) {
      Button("好") {
        viewModel.dismissSaveError()
      }
    } message: {
      Text(viewModel.saveErrorMessage ?? "未知错误")
    }
    .alert("已恢复未保存的草稿", isPresented: draftRecoveryMessageBinding) {
      Button("继续编辑") {
        viewModel.dismissDraftRecoveryMessage()
      }
    } message: {
      Text(viewModel.draftRecoveryMessage ?? "已恢复草稿，磁盘文件尚未被覆盖。")
    }
    .searchable(
      text: $viewModel.searchQuery,
      placement: .sidebar,
      prompt: "搜索文件名和正文"
    )
    .onChange(of: viewModel.activeTabID) { _, _ in
      editorScrollFraction = 0
      previewScrollFraction = 0
    }
  }

  private var documentViewModeBinding: Binding<ReaderViewModel.DocumentViewMode> {
    Binding(
      get: { viewModel.documentViewMode },
      set: { viewModel.setDocumentViewMode($0) }
    )
  }

  private var navigationTitle: String {
    guard let document = viewModel.currentDocument else { return "Flux Reader" }
    if viewModel.isViewingRetainedRecoveryVersion {
      return "\(document.displayName) — 恢复版本（只读）"
    }
    return viewModel.hasUnsavedChanges
      ? "\(document.displayName) — 已修改" : document.displayName
  }

  private var saveErrorBinding: Binding<Bool> {
    Binding(
      get: { viewModel.saveErrorMessage != nil },
      set: { isPresented in
        if !isPresented { viewModel.dismissSaveError() }
      }
    )
  }

  private var draftRecoveryMessageBinding: Binding<Bool> {
    Binding(
      get: { viewModel.draftRecoveryMessage != nil },
      set: { isPresented in
        if !isPresented { viewModel.dismissDraftRecoveryMessage() }
      }
    )
  }

  private var recoveryVersionDeletionBinding: Binding<Bool> {
    Binding(
      get: { viewModel.recoveryVersionPendingDeletion != nil },
      set: { isPresented in
        if !isPresented { viewModel.cancelDeleteRetainedRecoveryVersion() }
      }
    )
  }

  private var sidebar: some View {
    List {
      Section("当前文稿") {
        if let document = viewModel.currentDocument {
          Label(document.displayName, systemImage: "doc.text")
            .lineLimit(1)
            .help(document.url.path(percentEncoded: false))
            .accessibilityIdentifier("flux.current-document")
        } else {
          Label("尚未打开", systemImage: "doc")
            .foregroundStyle(.secondary)
        }
      }

      if !viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        searchResultsSection
      }

      workspaceSection

      if !viewModel.retainedRecoveryVersions.isEmpty {
        retainedRecoveryVersionsSection
      }

      if !viewModel.recentDocuments.isEmpty {
        Section("最近文稿") {
          ForEach(viewModel.recentDocuments) { document in
            Button {
              viewModel.openRecentDocument(document)
            } label: {
              Label(document.displayName, systemImage: "clock")
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .help(document.url.path(percentEncoded: false))
            .contextMenu {
              Button("从最近文稿移除") {
                viewModel.removeRecentDocument(document)
              }
            }
          }

          Button("清除最近记录", role: .destructive) {
            viewModel.clearRecentDocuments()
          }
          .font(.caption)
        }
      }
    }
    .accessibilityIdentifier("flux.sidebar")
    .navigationTitle("Flux Reader")
    .navigationSplitViewColumnWidth(min: 220, ideal: 280, max: 380)
  }

  @ViewBuilder
  private var retainedRecoveryVersionsSection: some View {
    Section("保存恢复版本") {
      ForEach(viewModel.retainedRecoveryVersions) { version in
        HStack(spacing: 8) {
          Button {
            viewModel.openRetainedRecoveryVersion(version)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Label(version.displayName, systemImage: "clock.arrow.circlepath")
                .lineLimit(1)
              Text(version.createdAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.secondary)
              if version.state == .pending {
                Text("未完成保存事务，内容已保留")
                  .font(.caption2)
                  .foregroundStyle(.orange)
                  .accessibilityIdentifier("flux.recovery-state-pending")
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
          .help("打开保留版本，不覆盖当前磁盘文件")
          .accessibilityIdentifier("flux.recovery-version-\(version.id.uuidString)")

          Button {
            viewModel.requestDeleteRetainedRecoveryVersion(version)
          } label: {
            Image(systemName: "trash")
          }
          .buttonStyle(.borderless)
          .help("明确删除恢复版本")
          .accessibilityIdentifier(
            "flux.delete-recovery-version-\(version.id.uuidString)"
          )
        }
      }

      Text(
        "应用不会自动删除恢复版本。每份文稿最多 5 个、全部文稿最多 50 个、总量最多 100 MiB；达到上限时保存会在写入前暂停。版本保留满 24 小时后，可点击垃圾桶并明确确认删除，再重试保存。"
      )
      .font(.caption2)
      .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private var workspaceSection: some View {
    Section("文件夹") {
      ForEach(viewModel.workspaces) { workspace in
        HStack(spacing: 8) {
          Label(workspace.displayName, systemImage: "folder.fill")
            .lineLimit(1)
            .help(workspace.rootURL.path(percentEncoded: false))

          Spacer()

          if viewModel.isWorkspaceLoading(workspace) {
            ProgressView()
              .controlSize(.mini)
          }

          Button {
            viewModel.refreshWorkspace(workspace)
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .buttonStyle(.borderless)
          .help("立即刷新文件夹")

          Button {
            viewModel.closeWorkspace(workspace)
          } label: {
            Image(systemName: "xmark.circle")
          }
          .buttonStyle(.borderless)
          .help("关闭文件夹并移除持久授权")
        }
        .accessibilityIdentifier("flux.workspace.\(workspace.displayName)")

        if workspace.children.isEmpty {
          Text("没有找到 Markdown 文稿")
            .font(.caption)
            .foregroundStyle(.secondary)
        } else {
          OutlineGroup(workspace.children, children: \.outlineChildren) { node in
            workspaceNode(node)
          }
        }

        Text("共 \(workspace.documentCount) 份文稿 · 自动监听")
          .font(.caption2)
          .foregroundStyle(.tertiary)

        if let message = viewModel.message(for: workspace) {
          Label(message, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }

      if viewModel.workspaces.isEmpty && !viewModel.isWorkspaceLoading {
        Button {
          viewModel.presentFolderImporter()
        } label: {
          Label("打开文件夹…", systemImage: "folder.badge.plus")
        }
        .buttonStyle(.plain)
      }

      if viewModel.isWorkspaceLoading && viewModel.workspaces.isEmpty {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text("正在扫描 Markdown 文稿…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      if let message = viewModel.libraryMessage {
        Label(message, systemImage: "exclamationmark.triangle")
          .font(.caption)
          .foregroundStyle(.orange)
      }

      if viewModel.workspaces.count > 1 {
        Button("关闭全部文件夹", role: .destructive) {
          viewModel.closeAllWorkspaces()
        }
        .font(.caption)
      }
    }
  }

  @ViewBuilder
  private var searchResultsSection: some View {
    Section("搜索结果") {
      if viewModel.isSearching {
        HStack(spacing: 8) {
          ProgressView()
            .controlSize(.small)
          Text("正在搜索文件名和正文…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      } else if viewModel.searchResults.isEmpty {
        Text("没有匹配的文稿")
          .font(.caption)
          .foregroundStyle(.secondary)
      } else {
        ForEach(viewModel.searchResults) { result in
          Button {
            viewModel.openSearchResult(result)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Label(
                result.displayName,
                systemImage: result.matchKind == .fileName
                  ? "doc.text.magnifyingglass" : "text.magnifyingglass"
              )
              .lineLimit(1)

              Text(result.relativePath)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)

              if result.matchKind == .content {
                Text(result.snippet)
                  .font(.caption2)
                  .foregroundStyle(.tertiary)
                  .lineLimit(2)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .buttonStyle(.plain)
          .help(result.documentURL.path(percentEncoded: false))
        }
      }
    }
    .accessibilityIdentifier("flux.search.results")
  }

  @ViewBuilder
  private func workspaceNode(_ node: WorkspaceNode) -> some View {
    switch node.kind {
    case .folder:
      Label(node.name, systemImage: "folder")
        .lineLimit(1)
        .help(node.url.path(percentEncoded: false))
    case .document:
      Button {
        viewModel.open(node.url)
      } label: {
        Label(node.name, systemImage: "doc.text")
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .buttonStyle(.plain)
      .foregroundStyle(
        viewModel.currentDocument?.id == node.id ? Color.accentColor : Color.primary
      )
      .help(node.url.path(percentEncoded: false))
    }
  }

  private var detail: some View {
    VStack(spacing: 0) {
      if !viewModel.documentTabs.isEmpty {
        DocumentTabBar(
          tabs: viewModel.documentTabs,
          activeTabID: viewModel.activeTabID,
          onActivate: viewModel.activateTab,
          onClose: viewModel.requestCloseTab
        )
        Divider()
      }

      if viewModel.isFindPresented, viewModel.currentDocument != nil {
        DocumentFindBar(viewModel: viewModel)
        Divider()
      }

      detailContent
    }
  }

  @ViewBuilder
  private var detailContent: some View {
    switch viewModel.phase {
    case .empty:
      placeholder
    case .loading(let fileName):
      VStack(spacing: 14) {
        ProgressView()
          .controlSize(.large)
        Text("正在打开 \(fileName)…")
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded(let document):
      VStack(spacing: 0) {
        if viewModel.isViewingRetainedRecoveryVersion {
          HStack(spacing: 8) {
            Label("保存恢复版本（只读）", systemImage: "lock.fill")
              .font(.callout.weight(.semibold))
              .accessibilityIdentifier("flux.recovery-read-only")
            Text("如需继续处理，请使用“另存为”创建新文稿。")
              .font(.callout)
              .foregroundStyle(.secondary)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
          .background(.bar)
          Divider()
        }

        if viewModel.isSplitView, let previewDocument = viewModel.previewDocument {
          HSplitView {
            MarkdownEditorView(
              content: $viewModel.draftContent,
              document: document,
              hasUnsavedChanges: viewModel.hasUnsavedChanges,
              isSaving: viewModel.isSaving,
              statusMessage: viewModel.saveStatusMessage,
              selectedRange: viewModel.activeFindRange,
              targetScrollFraction: previewScrollFraction,
              onScrollFractionChange: { editorScrollFraction = $0 }
            )
            .frame(minWidth: 280)

            MarkdownRendererView(
              document: previewDocument,
              findQuery: viewModel.isFindPresented ? viewModel.findQuery : "",
              findCaseSensitive: viewModel.findCaseSensitive,
              activeFindMatch: viewModel.activeFindMatchIndex,
              targetScrollFraction: editorScrollFraction,
              onScrollFractionChange: { previewScrollFraction = $0 }
            )
            .frame(minWidth: 280)
          }
        } else if viewModel.isEditing {
          MarkdownEditorView(
            content: $viewModel.draftContent,
            document: document,
            hasUnsavedChanges: viewModel.hasUnsavedChanges,
            isSaving: viewModel.isSaving,
            statusMessage: viewModel.saveStatusMessage,
            selectedRange: viewModel.activeFindRange
          )
        } else if let previewDocument = viewModel.previewDocument {
          MarkdownRendererView(
            document: previewDocument,
            findQuery: viewModel.isFindPresented ? viewModel.findQuery : "",
            findCaseSensitive: viewModel.findCaseSensitive,
            activeFindMatch: viewModel.activeFindMatchIndex
          )
        }
      }
    case .failure(let message):
      VStack(spacing: 16) {
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 36))
          .foregroundStyle(.orange)
        Text("无法打开文稿")
          .font(.title2.weight(.semibold))
        Text(message)
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
          .frame(maxWidth: 480)
        Button("选择其他文件") {
          viewModel.presentFileImporter()
        }
      }
      .padding(32)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var placeholder: some View {
    VStack(spacing: 16) {
      Image(systemName: "doc.text.magnifyingglass")
        .font(.system(size: 42))
        .foregroundStyle(.secondary)
      Text("打开 Markdown 文稿")
        .font(.title2.weight(.semibold))
        .accessibilityIdentifier("flux.empty-title")
      Text("选择或拖入 .md、.markdown、.mdx 文件，也可以打开整个文件夹。")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)

      HStack(spacing: 10) {
        Button("打开文件…") {
          viewModel.presentFileImporter()
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("flux.open-file")

        Button("打开文件夹…") {
          viewModel.presentFolderImporter()
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("flux.open-folder")
      }
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func presentSavePanel() {
    guard let presentation = viewModel.saveAsPresentation else { return }

    let panel = NSSavePanel()
    panel.title = "另存 Markdown 文稿"
    panel.prompt = "保存"
    panel.nameFieldStringValue = presentation.suggestedFileName
    panel.directoryURL = presentation.suggestedDirectoryURL
    panel.allowedContentTypes = MarkdownContentType.allowedContentTypes
    panel.allowsOtherFileTypes = false
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.begin { response in
      guard response == .OK, let url = panel.url else { return }
      viewModel.saveAs(to: url, for: presentation.sourceDocumentURL)
    }
  }
}

private struct DocumentTabBar: View {
  let tabs: [ReaderViewModel.DocumentTab]
  let activeTabID: URL?
  let onActivate: (URL) -> Void
  let onClose: (URL) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 4) {
        ForEach(tabs) { tab in
          HStack(spacing: 4) {
            Button {
              onActivate(tab.id)
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "doc.text")
                Text(tab.displayName)
                  .lineLimit(1)
                if tab.hasUnsavedChanges {
                  Circle()
                    .fill(Color.accentColor)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel("未保存")
                }
              }
            }
            .buttonStyle(.plain)
            .help(tab.path)
            .accessibilityIdentifier("flux.tab.\(tab.displayName)")

            Button {
              onClose(tab.id)
            } label: {
              Image(systemName: "xmark")
                .font(.caption2)
            }
            .buttonStyle(.borderless)
            .help("关闭 \(tab.displayName)")
            .accessibilityLabel("关闭 \(tab.displayName)")
          }
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .background(
            activeTabID == tab.id
              ? Color.accentColor.opacity(0.16) : Color.clear,
            in: RoundedRectangle(cornerRadius: 7)
          )
          .overlay(alignment: .bottom) {
            if activeTabID == tab.id {
              Rectangle()
                .fill(Color.accentColor)
                .frame(height: 2)
            }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
    }
    .background(.bar)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("打开的文稿")
  }
}

private struct DocumentFindBar: View {
  @ObservedObject var viewModel: ReaderViewModel
  @FocusState private var queryFocused: Bool

  var body: some View {
    VStack(spacing: 6) {
      HStack(spacing: 7) {
        Button {
          viewModel.toggleReplace()
        } label: {
          Image(systemName: viewModel.isReplacePresented ? "chevron.down" : "chevron.right")
        }
        .buttonStyle(.borderless)
        .disabled(!viewModel.canEdit)
        .help(viewModel.isReplacePresented ? "隐藏替换" : "显示替换")

        TextField("查找", text: $viewModel.findQuery)
          .textFieldStyle(.roundedBorder)
          .focused($queryFocused)
          .onSubmit { viewModel.selectNextFindMatch() }
          .accessibilityIdentifier("flux.find-query")

        Text(findResultLabel)
          .font(.caption.monospacedDigit())
          .foregroundStyle(.secondary)
          .frame(minWidth: 64)

        Button {
          viewModel.findCaseSensitive.toggle()
        } label: {
          Text("Aa")
            .font(.caption.weight(viewModel.findCaseSensitive ? .bold : .regular))
        }
        .buttonStyle(.borderless)
        .help("区分大小写")
        .accessibilityLabel("区分大小写")

        Button {
          viewModel.selectNextFindMatch(backward: true)
        } label: {
          Image(systemName: "chevron.up")
        }
        .buttonStyle(.borderless)
        .disabled(viewModel.findMatchCount == 0)
        .help("上一个匹配")

        Button {
          viewModel.selectNextFindMatch()
        } label: {
          Image(systemName: "chevron.down")
        }
        .buttonStyle(.borderless)
        .disabled(viewModel.findMatchCount == 0)
        .help("下一个匹配")

        Button {
          viewModel.dismissFind()
        } label: {
          Image(systemName: "xmark")
        }
        .buttonStyle(.borderless)
        .help("关闭查找")
      }

      if viewModel.isReplacePresented {
        HStack(spacing: 7) {
          Color.clear.frame(width: 18, height: 1)
          TextField("替换为", text: $viewModel.replaceQuery)
            .textFieldStyle(.roundedBorder)
            .onSubmit { viewModel.replaceCurrentFindMatch() }
            .accessibilityIdentifier("flux.replace-query")
          Button("替换") {
            viewModel.replaceCurrentFindMatch()
          }
          .disabled(!viewModel.canReplace)
          Button("全部替换") {
            viewModel.replaceAllFindMatches()
          }
          .disabled(!viewModel.canReplace)
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(.bar)
    .onAppear { queryFocused = true }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("文稿内查找与替换")
  }

  private var findResultLabel: String {
    guard !viewModel.findQuery.isEmpty else { return "输入关键词" }
    guard viewModel.findMatchCount > 0 else { return "无结果" }
    return "\(viewModel.activeFindMatchIndex + 1) / \(viewModel.findMatchCount)"
  }
}

private struct MarkdownEditorView: View {
  @Binding var content: String

  let document: MarkdownDocument
  let hasUnsavedChanges: Bool
  let isSaving: Bool
  let statusMessage: String?
  var selectedRange: NSRange? = nil
  var targetScrollFraction: Double? = nil
  var onScrollFractionChange: (Double) -> Void = { _ in }

  var body: some View {
    VStack(spacing: 0) {
      MarkdownTextView(
        text: $content,
        selectedRange: selectedRange,
        targetScrollFraction: targetScrollFraction,
        onScrollFractionChange: onScrollFractionChange
      )
      .accessibilityLabel("Markdown 编辑器")
      .accessibilityIdentifier("flux.editor")

      Divider()

      HStack(spacing: 12) {
        Text(document.url.path(percentEncoded: false))
          .lineLimit(1)
          .truncationMode(.middle)

        Spacer()

        if isSaving {
          Label("正在保存…", systemImage: "arrow.triangle.2.circlepath")
        } else if hasUnsavedChanges {
          Label("未保存", systemImage: "circle.fill")
            .accessibilityIdentifier("flux.editor-dirty-status")
        } else if let statusMessage {
          Label(statusMessage, systemImage: "checkmark.circle")
            .accessibilityIdentifier("flux.save-status")
        }

        Text(
          ByteCountFormatter.string(
            fromByteCount: Int64(content.utf8.count),
            countStyle: .file
          )
        )
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .background(.bar)
    }
  }
}

private struct MarkdownTextView: NSViewRepresentable {
  @Binding var text: String
  let selectedRange: NSRange?
  let targetScrollFraction: Double?
  let onScrollFractionChange: (Double) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  func makeNSView(context: Context) -> NSScrollView {
    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = false
    scrollView.autohidesScrollers = true
    scrollView.drawsBackground = true
    scrollView.backgroundColor = .textBackgroundColor
    scrollView.contentView.postsBoundsChangedNotifications = true

    let textView = NSTextView()
    textView.isRichText = false
    textView.importsGraphics = false
    textView.allowsUndo = true
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.minSize = .zero
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainer?.widthTracksTextView = true
    textView.textContainer?.containerSize = NSSize(
      width: scrollView.contentSize.width,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.textContainerInset = NSSize(width: 12, height: 12)
    textView.textContainer?.lineFragmentPadding = 0
    textView.font = .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
    textView.string = text
    textView.delegate = context.coordinator
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.setAccessibilityIdentifier("flux.editor")
    scrollView.documentView = textView
    context.coordinator.attach(scrollView: scrollView, textView: textView)

    DispatchQueue.main.async {
      textView.window?.makeFirstResponder(textView)
    }
    return scrollView
  }

  func updateNSView(_ scrollView: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let textView = scrollView.documentView as? NSTextView else { return }
    if textView.string != text {
      context.coordinator.isApplyingText = true
      let selection = textView.selectedRange()
      textView.string = text
      textView.setSelectedRange(
        NSRange(
          location: min(selection.location, (text as NSString).length),
          length: 0
        ))
      context.coordinator.isApplyingText = false
    }
    if let selectedRange,
      NSMaxRange(selectedRange) <= (textView.string as NSString).length,
      textView.selectedRange() != selectedRange
    {
      textView.setSelectedRange(selectedRange)
      textView.scrollRangeToVisible(selectedRange)
    }
    context.coordinator.applyScrollFraction(targetScrollFraction)
  }

  static func dismantleNSView(_ scrollView: NSScrollView, coordinator: Coordinator) {
    coordinator.detach()
    (scrollView.documentView as? NSTextView)?.delegate = nil
  }

  @MainActor
  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: MarkdownTextView
    var isApplyingText = false
    private weak var scrollView: NSScrollView?
    private weak var textView: NSTextView?
    private var isApplyingScroll = false

    init(parent: MarkdownTextView) {
      self.parent = parent
    }

    func attach(scrollView: NSScrollView, textView: NSTextView) {
      self.scrollView = scrollView
      self.textView = textView
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(boundsDidChange),
        name: NSView.boundsDidChangeNotification,
        object: scrollView.contentView
      )
    }

    func detach() {
      NotificationCenter.default.removeObserver(
        self,
        name: NSView.boundsDidChangeNotification,
        object: scrollView?.contentView
      )
      scrollView = nil
      textView = nil
    }

    @objc private func boundsDidChange(_ notification: Notification) {
      reportScrollFraction()
    }

    func textDidChange(_ notification: Notification) {
      guard !isApplyingText, let textView else { return }
      parent.text = textView.string
    }

    func applyScrollFraction(_ value: Double?) {
      guard let value, let scrollView, let textView else { return }
      let maximum = max(textView.bounds.height - scrollView.contentSize.height, 0)
      guard maximum > 0 else { return }
      let target = maximum * min(1, max(0, value))
      if abs(scrollView.contentView.bounds.origin.y - target) < 1 { return }
      isApplyingScroll = true
      scrollView.contentView.scroll(to: NSPoint(x: 0, y: target))
      scrollView.reflectScrolledClipView(scrollView.contentView)
      isApplyingScroll = false
    }

    private func reportScrollFraction() {
      guard !isApplyingScroll, let scrollView, let textView else { return }
      let maximum = max(textView.bounds.height - scrollView.contentSize.height, 0)
      parent.onScrollFractionChange(
        maximum > 0 ? min(1, max(0, scrollView.contentView.bounds.origin.y / maximum)) : 0
      )
    }
  }
}
