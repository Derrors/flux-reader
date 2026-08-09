import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct ReaderView: View {
  @ObservedObject var viewModel: ReaderViewModel
  @Binding var appearance: AppAppearance

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
          Button {
            viewModel.toggleEditing()
          } label: {
            Label(
              viewModel.isEditing ? "预览" : "编辑",
              systemImage: viewModel.isEditing ? "eye" : "pencil"
            )
          }
          .help(viewModel.isEditing ? "预览当前草稿" : "编辑当前文稿")
          .accessibilityIdentifier("flux.edit")

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
          Picker("外观", selection: $appearance) {
            ForEach(AppAppearance.allCases) { option in
              Label(option.title, systemImage: option.systemImage)
                .tag(option)
            }
          }
        } label: {
          Label("外观", systemImage: appearance.systemImage)
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
    .alert("无法完成文稿操作", isPresented: saveErrorBinding) {
      Button("好") {
        viewModel.dismissSaveError()
      }
    } message: {
      Text(viewModel.saveErrorMessage ?? "未知错误")
    }
    .searchable(
      text: $viewModel.searchQuery,
      placement: .sidebar,
      prompt: "搜索文件名和正文"
    )
  }

  private var navigationTitle: String {
    guard let document = viewModel.currentDocument else { return "Flux Reader" }
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

  @ViewBuilder
  private var detail: some View {
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
      if viewModel.isEditing {
        MarkdownEditorView(
          content: $viewModel.draftContent,
          document: document,
          hasUnsavedChanges: viewModel.hasUnsavedChanges,
          isSaving: viewModel.isSaving,
          statusMessage: viewModel.saveStatusMessage
        )
      } else if let previewDocument = viewModel.previewDocument {
        MarkdownRendererView(document: previewDocument)
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
    guard let document = viewModel.currentDocument else { return }
    let sourceDocumentURL = document.url.standardizedFileURL

    let panel = NSSavePanel()
    panel.title = "另存 Markdown 文稿"
    panel.prompt = "保存"
    panel.nameFieldStringValue = document.displayName
    panel.directoryURL = document.url.deletingLastPathComponent()
    panel.allowedContentTypes = MarkdownContentType.allowedContentTypes
    panel.allowsOtherFileTypes = false
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    panel.begin { response in
      guard response == .OK, let url = panel.url else { return }
      viewModel.saveAs(to: url, for: sourceDocumentURL)
    }
  }
}

private struct MarkdownEditorView: View {
  @Binding var content: String

  let document: MarkdownDocument
  let hasUnsavedChanges: Bool
  let isSaving: Bool
  let statusMessage: String?

  @FocusState private var editorIsFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      TextEditor(text: $content)
        .font(.system(.body, design: .monospaced))
        .lineSpacing(3)
        .padding(12)
        .textEditorStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(nsColor: .textBackgroundColor))
        .focused($editorIsFocused)
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
    .onAppear {
      editorIsFocused = true
    }
  }
}
