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
