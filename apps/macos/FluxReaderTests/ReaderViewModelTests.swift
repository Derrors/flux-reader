import Foundation
import XCTest

@testable import FluxReader

final class ReaderViewModelTests: XCTestCase {
  private var temporaryDirectory: URL!

  override func setUpWithError() throws {
    temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: temporaryDirectory,
      withIntermediateDirectories: true
    )
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: temporaryDirectory)
    temporaryDirectory = nil
  }

  @MainActor
  func testRestoresMultipleWorkspacesAndRecentDocumentsOnlyOnce() async throws {
    let firstWorkspace = temporaryDirectory.appendingPathComponent(
      "First",
      isDirectory: true
    )
    let secondWorkspace = temporaryDirectory.appendingPathComponent(
      "Second",
      isDirectory: true
    )
    try FileManager.default.createDirectory(
      at: firstWorkspace,
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: secondWorkspace,
      withIntermediateDirectories: true
    )
    let markdownURL = firstWorkspace.appendingPathComponent("README.md")
    let secondURL = secondWorkspace.appendingPathComponent("Guide.md")
    try Data("# Workspace".utf8).write(to: markdownURL)
    try Data("# Second".utf8).write(to: secondURL)
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [firstWorkspace, secondWorkspace]
    store.recents = [RecentDocument(url: markdownURL, lastOpenedAt: Date())]
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.count == 2 }
    viewModel.restoreLibraryIfNeeded()

    XCTAssertEqual(viewModel.workspaces.map(\.documentCount), [1, 1])
    XCTAssertEqual(viewModel.recentDocuments.map(\.url), [markdownURL])
    XCTAssertEqual(store.restoreWorkspacesCallCount, 1)

    viewModel.closeAllWorkspaces()
    XCTAssertTrue(viewModel.workspaces.isEmpty)
    XCTAssertEqual(store.clearWorkspacesCallCount, 1)
  }

  @MainActor
  func testOpeningDocumentRecordsRecentAndLoadsContent() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("# Guide".utf8).write(to: markdownURL)
    let store = InMemoryBookmarkStore()
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }

    XCTAssertEqual(viewModel.currentDocument?.content, "# Guide")
    XCTAssertEqual(viewModel.draftContent, "# Guide")
    XCTAssertEqual(viewModel.previewDocument?.content, "# Guide")
    XCTAssertFalse(viewModel.hasUnsavedChanges)
    XCTAssertFalse(viewModel.isEditing)
    XCTAssertEqual(store.recordedDocumentURLs, [markdownURL.standardizedFileURL])
    XCTAssertEqual(viewModel.recentDocuments.map(\.url), [markdownURL.standardizedFileURL])
  }

  @MainActor
  func testImporterRoutesDocumentsAndFoldersThroughOnePresentation() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("# Guide".utf8).write(to: markdownURL)
    let store = InMemoryBookmarkStore()
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.presentFileImporter()
    XCTAssertEqual(viewModel.importerRequest, .document)
    XCTAssertTrue(viewModel.isImporterPresented)

    viewModel.handleImporterResult(.success([markdownURL]))
    XCTAssertFalse(viewModel.isImporterPresented)
    await waitUntil { viewModel.currentDocument != nil }
    XCTAssertEqual(viewModel.currentDocument?.content, "# Guide")

    viewModel.presentFolderImporter()
    XCTAssertEqual(viewModel.importerRequest, .folders)
    XCTAssertTrue(viewModel.isImporterPresented)

    viewModel.handleImporterResult(.success([temporaryDirectory]))
    XCTAssertFalse(viewModel.isImporterPresented)
    await waitUntil { viewModel.workspaces.count == 1 }
    XCTAssertEqual(viewModel.workspaces.first?.rootURL, temporaryDirectory.standardizedFileURL)
  }

  @MainActor
  func testImporterCanRetryAfterCancellation() {
    let viewModel = ReaderViewModel(
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )
    let cancellation = NSError(
      domain: NSCocoaErrorDomain,
      code: NSUserCancelledError
    )

    viewModel.presentFileImporter()
    viewModel.handleImporterResult(.failure(cancellation))
    XCTAssertFalse(viewModel.isImporterPresented)

    viewModel.presentFileImporter()
    XCTAssertEqual(viewModel.importerRequest, .document)
    XCTAssertTrue(viewModel.isImporterPresented)
  }

  @MainActor
  func testEditingAndSavingUpdatesFileAndDocumentModel() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("# Original".utf8).write(to: markdownURL)
    let viewModel = ReaderViewModel(
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }

    let updatedContent = "# Updated\n\n已保存的 Markdown"
    viewModel.toggleEditing()
    viewModel.draftContent = updatedContent

    XCTAssertTrue(viewModel.isEditing)
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.canSave)
    XCTAssertEqual(viewModel.previewDocument?.content, updatedContent)

    viewModel.save()
    await waitUntil {
      !viewModel.isSaving && viewModel.currentDocument?.content == updatedContent
    }

    XCTAssertEqual(
      String(decoding: try Data(contentsOf: markdownURL), as: UTF8.self),
      updatedContent
    )
    XCTAssertEqual(viewModel.currentDocument?.byteCount, Data(updatedContent.utf8).count)
    XCTAssertEqual(viewModel.draftContent, updatedContent)
    XCTAssertFalse(viewModel.hasUnsavedChanges)
    XCTAssertFalse(viewModel.canSave)
    XCTAssertTrue(viewModel.isEditing)
    XCTAssertEqual(viewModel.saveStatusMessage, "已保存")
    XCTAssertNil(viewModel.saveErrorMessage)
  }

  @MainActor
  func testImporterFailureKeepsCurrentDirtyDraftAccessible() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("# Original".utf8).write(to: markdownURL)
    let viewModel = ReaderViewModel(
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }
    viewModel.toggleEditing()
    viewModel.draftContent = "# Unsaved draft"

    viewModel.handleImporterResult(
      .failure(CocoaError(.fileReadNoPermission))
    )

    XCTAssertEqual(viewModel.currentDocument?.url, markdownURL.standardizedFileURL)
    XCTAssertEqual(viewModel.currentDocument?.content, "# Original")
    XCTAssertEqual(viewModel.draftContent, "# Unsaved draft")
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isEditing)
    XCTAssertNotNil(viewModel.saveErrorMessage)
  }

  @MainActor
  func testExternalModificationConflictKeepsDirtyDraftAndReportsError() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    let originalContent = "# Original"
    let originalModificationDate = Date(timeIntervalSince1970: 1_700_000_000)
    try Data(originalContent.utf8).write(to: markdownURL)
    try FileManager.default.setAttributes(
      [.modificationDate: originalModificationDate],
      ofItemAtPath: markdownURL.path(percentEncoded: false)
    )
    let viewModel = ReaderViewModel(
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }

    let draft = "# My unsaved draft"
    let externalContent = "# Changed elsewhere"
    viewModel.toggleEditing()
    viewModel.draftContent = draft
    try Data(externalContent.utf8).write(to: markdownURL)
    try FileManager.default.setAttributes(
      [.modificationDate: originalModificationDate.addingTimeInterval(60)],
      ofItemAtPath: markdownURL.path(percentEncoded: false)
    )

    viewModel.save()
    await waitUntil {
      !viewModel.isSaving && viewModel.saveErrorMessage != nil
    }

    XCTAssertEqual(
      String(decoding: try Data(contentsOf: markdownURL), as: UTF8.self),
      externalContent
    )
    XCTAssertEqual(viewModel.currentDocument?.content, originalContent)
    XCTAssertEqual(viewModel.draftContent, draft)
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isEditing)
    XCTAssertNil(viewModel.saveStatusMessage)
    XCTAssertEqual(
      viewModel.saveErrorMessage,
      FileAccessError.fileModifiedExternally.localizedDescription
    )

    viewModel.dismissSaveError()
    viewModel.reloadFromDisk()
    XCTAssertTrue(viewModel.isUnsavedChangesConfirmationPresented)
    viewModel.discardChangesAndOpenPendingDocument()
    await waitUntil { viewModel.currentDocument?.content == externalContent }

    XCTAssertEqual(viewModel.draftContent, externalContent)
    XCTAssertFalse(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isEditing)
  }

  @MainActor
  func testWatcherRefreshDoesNotOverwriteDirtyDraft() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    let originalContent = "# Original"
    let externalContent = "# Changed elsewhere"
    let draft = "# Unsaved draft"
    try Data(originalContent.utf8).write(to: markdownURL)
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [temporaryDirectory]
    let watcher = TestWorkspaceWatcher()
    let folderService = CountingFolderIndexService()
    let viewModel = ReaderViewModel(
      folderService: folderService,
      bookmarkStore: store,
      workspaceWatcher: watcher
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.count == 1 }
    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }
    viewModel.toggleEditing()
    viewModel.draftContent = draft

    try Data(externalContent.utf8).write(to: markdownURL)
    watcher.fire()
    await waitUntil(timeoutIterations: 300) {
      folderService.callCount >= 2 && !viewModel.isWorkspaceLoading
    }

    XCTAssertEqual(viewModel.currentDocument?.content, originalContent)
    XCTAssertEqual(viewModel.draftContent, draft)
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isEditing)
  }

  @MainActor
  func testWatcherRefreshAfterSaveKeepsEditorActive() async throws {
    let markdownURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("# Original".utf8).write(to: markdownURL)
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [temporaryDirectory]
    let watcher = TestWorkspaceWatcher()
    let folderService = CountingFolderIndexService()
    let viewModel = ReaderViewModel(
      folderService: folderService,
      bookmarkStore: store,
      workspaceWatcher: watcher
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.count == 1 }
    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }
    viewModel.toggleEditing()
    viewModel.draftContent = "# Saved"
    viewModel.save()
    await waitUntil { !viewModel.isSaving && !viewModel.hasUnsavedChanges }

    watcher.fire()
    await waitUntil(timeoutIterations: 300) {
      folderService.callCount >= 2 && !viewModel.isWorkspaceLoading
    }
    try await Task.sleep(for: .milliseconds(100))

    XCTAssertEqual(viewModel.currentDocument?.content, "# Saved")
    XCTAssertTrue(viewModel.isEditing)
  }

  @MainActor
  func testCancelAndDiscardWhenOpeningAnotherDocumentWithUnsavedChanges() async throws {
    let firstURL = temporaryDirectory.appendingPathComponent("first.md")
    let secondURL = temporaryDirectory.appendingPathComponent("second.md")
    try Data("# First".utf8).write(to: firstURL)
    try Data("# Second".utf8).write(to: secondURL)
    let store = InMemoryBookmarkStore()
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(firstURL)
    await waitUntil { viewModel.currentDocument?.url == firstURL.standardizedFileURL }
    viewModel.toggleEditing()
    viewModel.draftContent = "# First draft"

    viewModel.open(secondURL)

    XCTAssertTrue(viewModel.isUnsavedChangesConfirmationPresented)
    XCTAssertEqual(viewModel.currentDocument?.url, firstURL.standardizedFileURL)
    XCTAssertEqual(store.recordedDocumentURLs, [firstURL.standardizedFileURL])

    viewModel.cancelPendingDocumentOpen()

    XCTAssertFalse(viewModel.isUnsavedChangesConfirmationPresented)
    XCTAssertEqual(viewModel.currentDocument?.url, firstURL.standardizedFileURL)
    XCTAssertEqual(viewModel.draftContent, "# First draft")
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isEditing)
    XCTAssertEqual(store.recordedDocumentURLs, [firstURL.standardizedFileURL])

    viewModel.open(secondURL)
    XCTAssertTrue(viewModel.isUnsavedChangesConfirmationPresented)
    viewModel.discardChangesAndOpenPendingDocument()
    await waitUntil { viewModel.currentDocument?.url == secondURL.standardizedFileURL }

    XCTAssertFalse(viewModel.isUnsavedChangesConfirmationPresented)
    XCTAssertEqual(viewModel.currentDocument?.content, "# Second")
    XCTAssertEqual(viewModel.draftContent, "# Second")
    XCTAssertFalse(viewModel.hasUnsavedChanges)
    XCTAssertFalse(viewModel.isEditing)
    XCTAssertEqual(
      store.recordedDocumentURLs,
      [firstURL.standardizedFileURL, secondURL.standardizedFileURL]
    )
  }

  @MainActor
  func testEditingDuringSaveDoesNotLoseDraftWhenAnotherDocumentIsRequested() async throws {
    let firstURL = temporaryDirectory.appendingPathComponent("first.md")
    let secondURL = temporaryDirectory.appendingPathComponent("second.md")
    try Data("# First".utf8).write(to: firstURL)
    try Data("# Second".utf8).write(to: secondURL)
    let fileService = BlockingFileService()
    let viewModel = ReaderViewModel(
      fileService: fileService,
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(firstURL)
    await waitUntil { viewModel.currentDocument?.url == firstURL.standardizedFileURL }
    viewModel.draftContent = "# Saved snapshot"
    viewModel.save()
    await waitUntil { fileService.saveStarted }

    viewModel.draftContent = "# New draft"
    viewModel.open(secondURL)
    fileService.finishSave()
    await waitUntil { !viewModel.isSaving }

    XCTAssertEqual(viewModel.currentDocument?.url, firstURL.standardizedFileURL)
    XCTAssertEqual(viewModel.currentDocument?.content, "# Saved snapshot")
    XCTAssertEqual(viewModel.draftContent, "# New draft")
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertTrue(viewModel.isUnsavedChangesConfirmationPresented)
    XCTAssertEqual(
      String(decoding: try Data(contentsOf: firstURL), as: UTF8.self),
      "# Saved snapshot"
    )

    viewModel.cancelPendingDocumentOpen()
  }

  @MainActor
  func testSaveAsDoesNotSaveAnotherDocumentSelectedWhilePanelWasOpen() async throws {
    let firstURL = temporaryDirectory.appendingPathComponent("first.md")
    let secondURL = temporaryDirectory.appendingPathComponent("second.md")
    let destinationURL = temporaryDirectory.appendingPathComponent("saved.md")
    try Data("# First".utf8).write(to: firstURL)
    try Data("# Second".utf8).write(to: secondURL)
    let viewModel = ReaderViewModel(
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(firstURL)
    await waitUntil { viewModel.currentDocument?.url == firstURL.standardizedFileURL }
    let panelSourceURL = try XCTUnwrap(viewModel.currentDocument?.url)

    viewModel.open(secondURL)
    await waitUntil { viewModel.currentDocument?.url == secondURL.standardizedFileURL }
    viewModel.draftContent = "# Second draft"
    viewModel.saveAs(to: destinationURL, for: panelSourceURL)

    XCTAssertFalse(FileManager.default.fileExists(atPath: destinationURL.path))
    XCTAssertEqual(viewModel.currentDocument?.url, secondURL.standardizedFileURL)
    XCTAssertEqual(viewModel.draftContent, "# Second draft")
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertNotNil(viewModel.saveErrorMessage)
  }

  @MainActor
  func testSaveAsRejectsSameTimestampChangeToExistingDestination() async throws {
    let sourceURL = temporaryDirectory.appendingPathComponent("source.md")
    let destinationURL = temporaryDirectory.appendingPathComponent("destination.md")
    let destinationModificationDate = Date(timeIntervalSince1970: 1_700_000_000)
    let originalDestinationContent = "# Version A"
    let externalDestinationContent = "# Version B"
    XCTAssertEqual(
      originalDestinationContent.utf8.count,
      externalDestinationContent.utf8.count
    )
    try Data("# Source".utf8).write(to: sourceURL)
    try Data(originalDestinationContent.utf8).write(to: destinationURL)
    try FileManager.default.setAttributes(
      [.modificationDate: destinationModificationDate],
      ofItemAtPath: destinationURL.path
    )
    let fileService = BlockingFileService()
    let viewModel = ReaderViewModel(
      fileService: fileService,
      bookmarkStore: InMemoryBookmarkStore(),
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.open(sourceURL)
    await waitUntil { viewModel.currentDocument?.url == sourceURL.standardizedFileURL }
    viewModel.draftContent = "# Local draft"
    viewModel.saveAs(to: destinationURL, for: sourceURL)
    await waitUntil { fileService.saveStarted }

    try Data(externalDestinationContent.utf8).write(to: destinationURL)
    try FileManager.default.setAttributes(
      [.modificationDate: destinationModificationDate],
      ofItemAtPath: destinationURL.path
    )
    fileService.finishSave()
    await waitUntil { !viewModel.isSaving && viewModel.saveErrorMessage != nil }

    XCTAssertEqual(
      try String(contentsOf: destinationURL, encoding: .utf8),
      externalDestinationContent
    )
    XCTAssertEqual(viewModel.currentDocument?.url, sourceURL.standardizedFileURL)
    XCTAssertEqual(viewModel.draftContent, "# Local draft")
    XCTAssertTrue(viewModel.hasUnsavedChanges)
    XCTAssertEqual(
      viewModel.saveErrorMessage,
      FileAccessError.fileModifiedExternally.localizedDescription
    )
  }

  @MainActor
  func testFailedWorkspaceRefreshKeepsPersistedWorkspace() async throws {
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [temporaryDirectory]
    let folderService = SequencedFolderIndexService()
    let viewModel = ReaderViewModel(
      folderService: folderService,
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.count == 1 }

    let workspace = try XCTUnwrap(viewModel.workspaces.first)
    viewModel.refreshWorkspace(workspace)
    await waitUntil {
      !viewModel.isWorkspaceLoading && viewModel.message(for: workspace) != nil
    }

    XCTAssertEqual(viewModel.workspaces.first?.rootURL, temporaryDirectory.standardizedFileURL)
    XCTAssertEqual(store.workspaceURLs, [temporaryDirectory.standardizedFileURL])
    XCTAssertTrue(store.removedWorkspaceURLs.isEmpty)
  }

  @MainActor
  func testWatcherAutomaticallyRefreshesFolderAndSearchesContents() async throws {
    let firstURL = temporaryDirectory.appendingPathComponent("first.md")
    try Data("# First".utf8).write(to: firstURL)
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [temporaryDirectory]
    let watcher = TestWorkspaceWatcher()
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: watcher
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.first?.documentCount == 1 }

    let secondURL = temporaryDirectory.appendingPathComponent("second.md")
    try Data("The automatic needle is here.".utf8).write(to: secondURL)
    watcher.fire()
    await waitUntil(timeoutIterations: 300) {
      viewModel.workspaces.first?.documentCount == 2
    }

    viewModel.searchQuery = "needle"
    await waitUntil(timeoutIterations: 300) {
      !viewModel.isSearching && viewModel.searchResults.count == 1
    }

    XCTAssertEqual(viewModel.searchResults.first?.documentURL, secondURL)
    XCTAssertEqual(viewModel.searchResults.first?.matchKind, .content)
  }

  @MainActor
  func testClosingOverlappingWorkspaceKeepsDocumentUnderRemainingRoot() async throws {
    let nestedURL = temporaryDirectory.appendingPathComponent("Nested", isDirectory: true)
    try FileManager.default.createDirectory(at: nestedURL, withIntermediateDirectories: true)
    let markdownURL = nestedURL.appendingPathComponent("guide.md")
    try Data("# Guide".utf8).write(to: markdownURL)
    let store = InMemoryBookmarkStore()
    store.workspaceURLs = [temporaryDirectory, nestedURL]
    let viewModel = ReaderViewModel(
      bookmarkStore: store,
      workspaceWatcher: TestWorkspaceWatcher()
    )

    viewModel.restoreLibraryIfNeeded()
    await waitUntil { viewModel.workspaces.count == 2 }
    viewModel.open(markdownURL)
    await waitUntil { viewModel.currentDocument != nil }
    XCTAssertEqual(viewModel.currentDocument?.resourceRootURL, nestedURL.standardizedFileURL)

    let nestedWorkspace = try XCTUnwrap(
      viewModel.workspaces.first { $0.rootURL == nestedURL.standardizedFileURL }
    )
    viewModel.closeWorkspace(nestedWorkspace)

    XCTAssertEqual(
      viewModel.currentDocument?.resourceRootURL, temporaryDirectory.standardizedFileURL)
  }

  @MainActor
  private func waitUntil(
    timeoutIterations: Int = 100,
    _ predicate: () -> Bool
  ) async {
    for _ in 0..<timeoutIterations {
      if predicate() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("等待异步状态更新超时")
  }
}

private final class SequencedFolderIndexService: FolderIndexing, @unchecked Sendable {
  private let lock = NSLock()
  private var callCount = 0

  func indexFolder(at url: URL) throws -> WorkspaceSnapshot {
    lock.lock()
    defer { lock.unlock() }
    callCount += 1
    guard callCount == 1 else {
      throw CocoaError(.fileReadUnknown)
    }
    return WorkspaceSnapshot(
      rootURL: url.standardizedFileURL,
      children: [],
      documentCount: 0
    )
  }
}

private final class CountingFolderIndexService: FolderIndexing, @unchecked Sendable {
  private let lock = NSLock()
  private var _callCount = 0

  var callCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return _callCount
  }

  func indexFolder(at url: URL) throws -> WorkspaceSnapshot {
    lock.lock()
    _callCount += 1
    lock.unlock()
    return try LocalFolderIndexService().indexFolder(at: url)
  }
}

private final class TestWorkspaceWatcher: WorkspaceWatching, @unchecked Sendable {
  private let lock = NSLock()
  private var callbacks: [@Sendable () -> Void] = []

  func watch(
    rootURL: URL,
    onChange: @escaping @Sendable () -> Void
  ) throws -> any WorkspaceWatchToken {
    lock.lock()
    callbacks.append(onChange)
    lock.unlock()
    return TestWorkspaceWatchToken()
  }

  func fire() {
    lock.lock()
    let pendingCallbacks = callbacks
    lock.unlock()
    for callback in pendingCallbacks {
      callback()
    }
  }
}

private final class TestWorkspaceWatchToken: WorkspaceWatchToken, @unchecked Sendable {
  func cancel() {}
}

private final class BlockingFileService: FileAccessing, @unchecked Sendable {
  private let base = LocalFileService()
  private let lock = NSLock()
  private let saveGate = DispatchSemaphore(value: 0)
  private var _saveStarted = false

  var saveStarted: Bool {
    lock.lock()
    defer { lock.unlock() }
    return _saveStarted
  }

  func loadDocument(at url: URL) throws -> MarkdownDocument {
    try base.loadDocument(at: url)
  }

  func saveDocument(
    content: String,
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws -> MarkdownDocument {
    lock.lock()
    _saveStarted = true
    lock.unlock()
    saveGate.wait()
    return try base.saveDocument(
      content: content,
      to: url,
      expectedModificationDate: expectedModificationDate,
      expectedContent: expectedContent,
      expectedTargetExists: expectedTargetExists
    )
  }

  func finishSave() {
    saveGate.signal()
  }
}

private final class InMemoryBookmarkStore: BookmarkStoring {
  var workspaceURLs: [URL] = []
  var recents: [RecentDocument] = []
  var recordedDocumentURLs: [URL] = []
  var removedWorkspaceURLs: [URL] = []
  var restoreWorkspacesCallCount = 0
  var clearWorkspacesCallCount = 0

  func saveWorkspace(_ url: URL) throws {
    let standardizedURL = url.standardizedFileURL
    workspaceURLs.removeAll { $0.standardizedFileURL == standardizedURL }
    workspaceURLs.insert(standardizedURL, at: 0)
  }

  func restoreWorkspaces() -> [URL] {
    restoreWorkspacesCallCount += 1
    return workspaceURLs
  }

  func removeWorkspace(_ url: URL) {
    let standardizedURL = url.standardizedFileURL
    removedWorkspaceURLs.append(standardizedURL)
    workspaceURLs.removeAll { $0.standardizedFileURL == standardizedURL }
  }

  func clearWorkspaces() {
    clearWorkspacesCallCount += 1
    workspaceURLs = []
  }

  func recordRecentDocument(_ url: URL) throws {
    let standardizedURL = url.standardizedFileURL
    recordedDocumentURLs.append(standardizedURL)
    recents.removeAll { $0.url == standardizedURL }
    recents.insert(
      RecentDocument(url: standardizedURL, lastOpenedAt: Date()),
      at: 0
    )
  }

  func restoreRecentDocuments() -> [RecentDocument] {
    recents
  }

  func removeRecentDocument(_ url: URL) {
    recents.removeAll { $0.url == url.standardizedFileURL }
  }

  func clearRecentDocuments() {
    recents = []
  }
}
