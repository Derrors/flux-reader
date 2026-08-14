import Darwin
import Foundation
import XCTest

@testable import FluxReader

final class LocalFileServiceTests: XCTestCase {
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

  func testLoadsUTF8Markdown() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let source = "# Flux Reader\n\n原生 macOS 阅读器"
    try Data(source.utf8).write(to: url)

    let document = try LocalFileService().loadDocument(at: url)

    XCTAssertEqual(document.url, url.standardizedFileURL)
    XCTAssertEqual(document.content, source)
    XCTAssertEqual(document.byteCount, Data(source.utf8).count)
  }

  func testRejectsUnsupportedFileType() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.txt")
    try Data("plain text".utf8).write(to: url)

    XCTAssertThrowsError(try LocalFileService().loadDocument(at: url)) { error in
      XCTAssertEqual(error as? FileAccessError, .unsupportedFileType("txt"))
    }
  }

  func testRejectsOversizedFile() throws {
    let url = temporaryDirectory.appendingPathComponent("large.md")
    try Data(repeating: 65, count: 17).write(to: url)

    XCTAssertThrowsError(
      try LocalFileService(maximumFileSize: 16).loadDocument(at: url)
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileTooLarge(actual: 17, limit: 16))
    }
  }

  func testProductionLimitsSupportTenMiBDocumentsAndRecovery() {
    let tenMiB = 10 * 1_024 * 1_024

    XCTAssertEqual(ProductPolicy.maximumEditableDocumentBytes, tenMiB)
    XCTAssertEqual(ProductPolicy.maximumLocalImageBytes, 25 * 1_024 * 1_024)
    XCTAssertEqual(ProductPolicy.maximumWorkspaceCount, 8)
    XCTAssertEqual(ProductPolicy.maximumDocumentTabs, 12)
    XCTAssertEqual(ProductPolicy.maximumRecentDocuments, 12)
    XCTAssertEqual(LocalFileService.defaultMaximumFileSize, tenMiB)
    XCTAssertEqual(DocumentResourceLoader.maximumFileSize, ProductPolicy.maximumLocalImageBytes)
    XCTAssertEqual(DocumentSessionRecord.maximumTabCount, ProductPolicy.maximumDocumentTabs)
    XCTAssertGreaterThan(LocalDraftRecoveryStore.maximumRecordSize, tenMiB)
    XCTAssertGreaterThanOrEqual(
      LocalDocumentSessionStore.maximumRecordSize,
      tenMiB * DocumentSessionRecord.maximumTabCount
    )
  }

  func testProductionLimitAcceptsTenMiBAndRejectsTheNextByte() throws {
    let url = temporaryDirectory.appendingPathComponent("boundary.md")
    let limit = LocalFileService.defaultMaximumFileSize
    try Data(repeating: 65, count: limit).write(to: url)

    XCTAssertEqual(try LocalFileService().loadDocument(at: url).byteCount, limit)

    try Data(repeating: 65, count: limit + 1).write(to: url)
    XCTAssertThrowsError(try LocalFileService().loadDocument(at: url)) { error in
      XCTAssertEqual(
        error as? FileAccessError,
        .fileTooLarge(actual: limit + 1, limit: limit)
      )
    }
  }

  func testRejectsInvalidUTF8() throws {
    let url = temporaryDirectory.appendingPathComponent("invalid.md")
    try Data([0xC3, 0x28]).write(to: url)

    XCTAssertThrowsError(try LocalFileService().loadDocument(at: url)) { error in
      XCTAssertEqual(error as? FileAccessError, .invalidUTF8)
    }
  }

  func testSavesUTF8MarkdownAndReturnsLatestSnapshot() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Before".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let updatedSource = "# After\n\n保存后的中文内容"

    let savedDocument = try service.saveDocument(
      content: updatedSource,
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), updatedSource)
    XCTAssertEqual(savedDocument.url, url.standardizedFileURL)
    XCTAssertEqual(savedDocument.content, updatedSource)
    XCTAssertEqual(savedDocument.byteCount, Data(updatedSource.utf8).count)
    XCTAssertNotNil(savedDocument.modificationDate)
  }

  func testSuccessfulSaveRetainsDisplacedInodeForLateExternalWrites() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    let savedContent = "# Saved"
    let lateExternalContent = "# Late write through old descriptor"
    try Data(originalContent.utf8).write(to: url)
    let descriptor = open(url.path(percentEncoded: false), O_RDWR | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(descriptor) }

    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    _ = try service.saveDocument(
      content: savedContent,
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), savedContent)
    guard ftruncate(descriptor, 0) == 0, lseek(descriptor, 0, SEEK_SET) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    try Data(lateExternalContent.utf8).withUnsafeBytes { bytes in
      guard
        let baseAddress = bytes.baseAddress,
        Darwin.write(descriptor, baseAddress, bytes.count) == bytes.count,
        fsync(descriptor) == 0
      else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }

    let recoveryURL = try XCTUnwrap(
      try FileManager.default.contentsOfDirectory(
        at: temporaryDirectory,
        includingPropertiesForKeys: nil
      ).first(where: {
        $0.lastPathComponent.contains(".sample.md.flux-reader-recovery-")
      })
    )
    XCTAssertEqual(
      try String(contentsOf: recoveryURL, encoding: .utf8),
      lateExternalContent
    )
  }

  func testRetainedVersionIsManifestedAndOnlyExplicitCleanupRemovesIt() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let manifestURL = temporaryDirectory.appendingPathComponent("manifest.json")
    let originalContent = "# Original"
    let savedContent = "# Saved"
    let lateExternalContent = "# Late write through old descriptor"
    try Data(originalContent.utf8).write(to: url)
    let descriptor = open(url.path(percentEncoded: false), O_RDWR | O_CLOEXEC)
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(descriptor) }

    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      minimumRetentionInterval: 0
    )
    let service = LocalFileService(retainedRecoveryStore: recoveryStore)
    let originalDocument = try service.loadDocument(at: url)
    _ = try service.saveDocument(
      content: savedContent,
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    let version = try XCTUnwrap(recoveryStore.loadVersions().first)
    XCTAssertEqual(version.state, .retained)
    XCTAssertTrue(FileManager.default.fileExists(atPath: version.recoveryURL.path))

    guard ftruncate(descriptor, 0) == 0, lseek(descriptor, 0, SEEK_SET) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    try Data(lateExternalContent.utf8).withUnsafeBytes { bytes in
      guard
        let baseAddress = bytes.baseAddress,
        Darwin.write(descriptor, baseAddress, bytes.count) == bytes.count,
        fsync(descriptor) == 0
      else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }
    XCTAssertEqual(
      try String(contentsOf: version.recoveryURL, encoding: .utf8),
      lateExternalContent
    )

    try recoveryStore.deleteVersion(version.id, now: Date())
    XCTAssertFalse(FileManager.default.fileExists(atPath: version.recoveryURL.path))
    XCTAssertTrue(try recoveryStore.loadVersions().isEmpty)
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), savedContent)
  }

  func testSixthSaveFailsClosedBeforeCommitAndPreservesOldDescriptorVersion() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Version 0".utf8).write(to: url)
    let oldestDescriptor = open(
      url.path(percentEncoded: false),
      O_RDWR | O_CLOEXEC
    )
    guard oldestDescriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(oldestDescriptor) }
    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("manifest.json"),
      maximumVersionsPerDocument: 5,
      maximumTotalVersions: 50,
      minimumRetentionInterval: 0
    )
    let commitRecorder = CommitCallRecorder()
    let service = LocalFileService(
      willCommitWrite: { _ in commitRecorder.record() },
      retainedRecoveryStore: recoveryStore
    )

    var snapshot = try service.loadDocument(at: url)
    var oldestRecoveryURL: URL?
    for index in 1...5 {
      snapshot = try service.saveDocument(
        content: "# Version \(index)",
        to: url,
        expectedModificationDate: snapshot.modificationDate,
        expectedContent: snapshot.content,
        expectedTargetExists: true
      )
      if index == 1 {
        oldestRecoveryURL = try XCTUnwrap(recoveryStore.loadVersions().first).recoveryURL
      }
    }

    let versionZeroURL = try XCTUnwrap(oldestRecoveryURL)
    XCTAssertEqual(commitRecorder.count, 5)
    XCTAssertEqual(try recoveryStore.loadVersions().count, 5)
    XCTAssertTrue(FileManager.default.fileExists(atPath: versionZeroURL.path))
    XCTAssertEqual(try String(contentsOf: versionZeroURL, encoding: .utf8), "# Version 0")

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Version 6",
        to: url,
        expectedModificationDate: snapshot.modificationDate,
        expectedContent: snapshot.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(
        error as? RetainedFileRecoveryError,
        .limitReached(perDocument: 5, total: 50)
      )
    }

    XCTAssertEqual(commitRecorder.count, 5, "The blocked save must not start target commit")
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "# Version 5")
    XCTAssertTrue(FileManager.default.fileExists(atPath: versionZeroURL.path))
    XCTAssertEqual(try recoveryStore.loadVersions().count, 5)

    let lateContent = Data("# Late write after blocked save".utf8)
    guard
      ftruncate(oldestDescriptor, 0) == 0,
      lseek(oldestDescriptor, 0, SEEK_SET) == 0
    else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    try lateContent.withUnsafeBytes { bytes in
      guard
        let baseAddress = bytes.baseAddress,
        Darwin.write(oldestDescriptor, baseAddress, bytes.count) == bytes.count,
        fsync(oldestDescriptor) == 0
      else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }

    XCTAssertTrue(FileManager.default.fileExists(atPath: versionZeroURL.path))
    XCTAssertEqual(try Data(contentsOf: versionZeroURL), lateContent)
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "# Version 5")
  }

  func testRecoveryVersionTotalCountAndByteLimitsAreEnforced() throws {
    let firstSource = temporaryDirectory.appendingPathComponent("first.md")
    let secondSource = temporaryDirectory.appendingPathComponent("second.md")
    let countLimitedStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("count-manifest.json"),
      maximumVersionsPerDocument: 5,
      maximumTotalVersions: 1,
      minimumRetentionInterval: 0
    )
    let firstCountRecoveryURL = temporaryDirectory.appendingPathComponent(
      "first-recovery.md"
    )
    let firstCountVersion = try countLimitedStore.reserveVersion(
      sourceURL: firstSource,
      recoveryURL: firstCountRecoveryURL,
      byteCount: 4,
      contentDigest: "first"
    )
    try Data("1234".utf8).write(to: firstCountRecoveryURL)
    try countLimitedStore.finalizeVersion(
      firstCountVersion.id,
      byteCount: 4,
      contentDigest: "first"
    )

    XCTAssertThrowsError(
      try countLimitedStore.reserveVersion(
        sourceURL: secondSource,
        recoveryURL: temporaryDirectory.appendingPathComponent("second-recovery.md"),
        byteCount: 4,
        contentDigest: "second"
      )
    ) { error in
      XCTAssertEqual(
        error as? RetainedFileRecoveryError,
        .limitReached(perDocument: 5, total: 1)
      )
    }
    XCTAssertEqual(try countLimitedStore.loadVersions().count, 1)
    XCTAssertEqual(try Data(contentsOf: firstCountRecoveryURL), Data("1234".utf8))

    let byteLimitedStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("byte-manifest.json"),
      maximumVersionsPerDocument: 5,
      maximumTotalVersions: 5,
      maximumTotalBytes: 5,
      minimumRetentionInterval: 0
    )
    let firstByteRecoveryURL = temporaryDirectory.appendingPathComponent(
      "byte-first.md"
    )
    let firstByteVersion = try byteLimitedStore.reserveVersion(
      sourceURL: firstSource,
      recoveryURL: firstByteRecoveryURL,
      byteCount: 3,
      contentDigest: "first"
    )
    try Data("123".utf8).write(to: firstByteRecoveryURL)
    try byteLimitedStore.finalizeVersion(
      firstByteVersion.id,
      byteCount: 3,
      contentDigest: "first"
    )

    XCTAssertThrowsError(
      try byteLimitedStore.reserveVersion(
        sourceURL: secondSource,
        recoveryURL: temporaryDirectory.appendingPathComponent("byte-second.md"),
        byteCount: 3,
        contentDigest: "second"
      )
    ) { error in
      XCTAssertEqual(
        error as? RetainedFileRecoveryError,
        .totalByteLimitReached(5)
      )
    }
    XCTAssertEqual(try byteLimitedStore.loadVersions().count, 1)
    XCTAssertEqual(try Data(contentsOf: firstByteRecoveryURL), Data("123".utf8))
  }

  func testActivePendingReservationIsNotReconciledUntilProcessRestart() throws {
    let sourceURL = temporaryDirectory.appendingPathComponent("sample.md")
    let manifestURL = temporaryDirectory.appendingPathComponent("manifest.json")
    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      maximumVersionsPerDocument: 2,
      maximumTotalVersions: 2,
      minimumRetentionInterval: 0
    )
    let reservation = try recoveryStore.reserveVersion(
      sourceURL: sourceURL,
      recoveryURL: temporaryDirectory.appendingPathComponent(
        "crashed-before-sidecar.md"
      ),
      byteCount: 4,
      contentDigest: "crash"
    )

    XCTAssertEqual(try recoveryStore.loadVersions(), [reservation])

    let restartedStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      maximumVersionsPerDocument: 2,
      maximumTotalVersions: 2,
      minimumRetentionInterval: 0
    )
    XCTAssertTrue(try restartedStore.loadVersions().isEmpty)
  }

  func testInterruptedDeletionReconcilesDeletingManifestAfterRestart() throws {
    let manifestURL = temporaryDirectory.appendingPathComponent(
      "deleting-manifest.json"
    )
    let recoveryURL = temporaryDirectory.appendingPathComponent("recovery.md")
    let content = "# Recovery"
    try Data(content.utf8).write(to: recoveryURL)
    let fault = ManifestWriteFaultInjector()
    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      minimumRetentionInterval: 0,
      manifestWriteInterceptor: fault.intercept
    )
    let version = try recoveryStore.reserveVersion(
      sourceURL: temporaryDirectory.appendingPathComponent("sample.md"),
      recoveryURL: recoveryURL,
      byteCount: Data(content.utf8).count,
      contentDigest: DraftRecoveryRecord.contentDigest(content)
    )
    try recoveryStore.finalizeVersion(
      version.id,
      byteCount: Data(content.utf8).count,
      contentDigest: DraftRecoveryRecord.contentDigest(content)
    )
    fault.failNextEmptyManifestWrite()

    XCTAssertThrowsError(try recoveryStore.deleteVersion(version.id, now: Date()))
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: recoveryURL.path(percentEncoded: false)
      )
    )

    let restartedStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      minimumRetentionInterval: 0
    )
    XCTAssertTrue(try restartedStore.loadVersions().isEmpty)
  }

  func testDeletingRecordReconcilesWhenDeletedSidecarBookmarkCannotResolve() throws {
    let manifestURL = temporaryDirectory.appendingPathComponent(
      "stale-deleting-manifest.json"
    )
    let version = RetainedFileRecoveryVersion(
      sourceURL: temporaryDirectory.appendingPathComponent("sample.md"),
      sourceBookmark: nil,
      recoveryURL: temporaryDirectory.appendingPathComponent("already-deleted.md"),
      recoveryBookmark: Data("not-a-bookmark".utf8),
      byteCount: 10,
      contentDigest: "digest",
      state: .deleting
    )
    try JSONEncoder().encode([version]).write(to: manifestURL)

    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: manifestURL,
      minimumRetentionInterval: 0
    )
    XCTAssertTrue(try recoveryStore.loadVersions().isEmpty)
  }

  func testPendingReservationWithExistingSidecarRemainsVisible() throws {
    let recoveryURL = temporaryDirectory.appendingPathComponent("pending-sidecar.md")
    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("manifest.json"),
      minimumRetentionInterval: 0
    )
    let version = try recoveryStore.reserveVersion(
      sourceURL: temporaryDirectory.appendingPathComponent("sample.md"),
      recoveryURL: recoveryURL,
      byteCount: 7,
      contentDigest: "pending"
    )
    try Data("pending".utf8).write(to: recoveryURL)

    XCTAssertEqual(try recoveryStore.loadVersions(), [version])
    XCTAssertEqual(try recoveryStore.loadVersions().first?.state, .pending)
  }

  func testLateOldDescriptorGrowthCountsActualBytesAndBlocksNextSave() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("old".utf8).write(to: url)
    let oldDescriptor = open(url.path(percentEncoded: false), O_RDWR | O_CLOEXEC)
    guard oldDescriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(oldDescriptor) }

    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("manifest.json"),
      maximumTotalBytes: 12,
      minimumRetentionInterval: 0
    )
    let service = LocalFileService(retainedRecoveryStore: recoveryStore)
    var snapshot = try service.loadDocument(at: url)
    snapshot = try service.saveDocument(
      content: "new",
      to: url,
      expectedModificationDate: snapshot.modificationDate,
      expectedContent: snapshot.content,
      expectedTargetExists: true
    )

    let lateContent = Data(repeating: 65, count: 20)
    guard ftruncate(oldDescriptor, 0) == 0, lseek(oldDescriptor, 0, SEEK_SET) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    try lateContent.withUnsafeBytes { bytes in
      guard
        let baseAddress = bytes.baseAddress,
        Darwin.write(oldDescriptor, baseAddress, bytes.count) == bytes.count,
        fsync(oldDescriptor) == 0
      else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
    }

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "next",
        to: url,
        expectedModificationDate: snapshot.modificationDate,
        expectedContent: snapshot.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(
        error as? RetainedFileRecoveryError,
        .totalByteLimitReached(12)
      )
    }
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "new")
    XCTAssertEqual(try recoveryStore.loadVersions().count, 1)
  }

  func testRecoveryVersionCannotBeDeletedBeforeSafetyRetentionExpires() throws {
    let now = Date(timeIntervalSince1970: 10_000)
    let recoveryURL = temporaryDirectory.appendingPathComponent("recovery.md")
    try Data("# Recovery".utf8).write(to: recoveryURL)
    let recoveryStore = LocalRetainedFileRecoveryStore(
      manifestURL: temporaryDirectory.appendingPathComponent("manifest.json"),
      minimumRetentionInterval: 3_600,
      nowProvider: { now }
    )
    let version = try recoveryStore.reserveVersion(
      sourceURL: temporaryDirectory.appendingPathComponent("sample.md"),
      recoveryURL: recoveryURL,
      byteCount: 10,
      contentDigest: "digest"
    )
    try recoveryStore.finalizeVersion(
      version.id,
      byteCount: 10,
      contentDigest: "digest"
    )

    XCTAssertThrowsError(
      try recoveryStore.deleteVersion(
        version.id,
        now: now.addingTimeInterval(3_599)
      )
    ) { error in
      XCTAssertEqual(
        error as? RetainedFileRecoveryError,
        .minimumRetentionNotReached(now.addingTimeInterval(3_600))
      )
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: recoveryURL.path))
    XCTAssertEqual(try recoveryStore.loadVersions().count, 1)
  }

  func testSavePreservesOwnerAndSupplementaryGroup() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let alternateGroupID = try supplementaryGroupDifferentFromDirectory()
    guard chown(url.path(percentEncoded: false), uid_t.max, alternateGroupID) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    guard chmod(url.path(percentEncoded: false), 0o640) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    let originalStatus = try fileStatus(at: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    _ = try service.saveDocument(
      content: "# Saved",
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    let savedStatus = try fileStatus(at: url)
    XCTAssertEqual(savedStatus.st_uid, originalStatus.st_uid)
    XCTAssertEqual(savedStatus.st_gid, originalStatus.st_gid)
    XCTAssertEqual(savedStatus.st_mode & 0o7777, originalStatus.st_mode & 0o7777)
  }

  func testSaveFailsClosedWhenOwnershipCannotBePreserved() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    try Data(originalContent.utf8).write(to: url)
    let alternateGroupID = try supplementaryGroupDifferentFromDirectory()
    guard chown(url.path(percentEncoded: false), uid_t.max, alternateGroupID) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    let service = LocalFileService(
      replacementOwnershipSetter: { _, _, _ in
        throw CocoaError(.fileWriteNoPermission)
      }
    )
    let originalDocument = try service.loadDocument(at: url)
    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Must not commit",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    )
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), originalContent)
  }

  func testRejectsOversizedSaveWithoutChangingExistingFile() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalSource = "old"
    try Data(originalSource.utf8).write(to: url)
    let service = LocalFileService(maximumFileSize: 8)
    let originalDocument = try service.loadDocument(at: url)

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "123456789",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(
        error as? FileAccessError,
        .fileTooLarge(actual: 9, limit: 8)
      )
    }

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), originalSource)
  }

  func testRejectsSaveWhenFileWasModifiedExternally() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let externallyModifiedSource = "# External change"
    try Data(externallyModifiedSource.utf8).write(to: url)
    let externalModificationDate = try XCTUnwrap(originalDocument.modificationDate)
      .addingTimeInterval(5)
    try FileManager.default.setAttributes(
      [.modificationDate: externalModificationDate],
      ofItemAtPath: url.path(percentEncoded: false)
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local change",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externallyModifiedSource
    )
  }

  func testRejectsSameSizeContentChangeWhenModificationDateIsPreserved() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let originalModificationDate = try XCTUnwrap(originalDocument.modificationDate)
    let externallyModifiedSource = "# External"
    XCTAssertEqual(
      externallyModifiedSource.utf8.count,
      originalDocument.content.utf8.count
    )
    try Data(externallyModifiedSource.utf8).write(to: url)
    try FileManager.default.setAttributes(
      [.modificationDate: originalModificationDate],
      ofItemAtPath: url.path(percentEncoded: false)
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local change",
        to: url,
        expectedModificationDate: originalModificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externallyModifiedSource
    )
  }

  func testSavePreservesExtendedAttributesOnExistingFile() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let attributeName = "com.derrors.flux-reader.tests"
    let attributeValue = Data("preserve-me".utf8)
    try setExtendedAttribute(attributeValue, named: attributeName, at: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)

    _ = try service.saveDocument(
      content: "# Saved",
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(
      try extendedAttribute(named: attributeName, at: url),
      attributeValue
    )
  }

  func testSavesNewMarkdownWhenTargetRemainsAbsent() throws {
    let url = temporaryDirectory.appendingPathComponent("new.md")
    let service = LocalFileService()

    let savedDocument = try service.saveDocument(
      content: "# New document",
      to: url,
      expectedModificationDate: nil,
      expectedContent: nil,
      expectedTargetExists: false
    )

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      "# New document"
    )
    XCTAssertEqual(savedDocument.url, url.standardizedFileURL)
  }

  func testRejectsNewSaveWhenTargetAppearsAfterConfirmation() throws {
    let url = temporaryDirectory.appendingPathComponent("new.md")
    let competingContent = "# Created by another application"
    try Data(competingContent.utf8).write(to: url)
    let service = LocalFileService()

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: nil,
        expectedContent: nil,
        expectedTargetExists: false
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      competingContent
    )
  }

  func testMetadataReadFailureAfterCommitStillReportsSuccessfulSave() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      postWriteModificationDateProvider: { _ in
        throw CocoaError(.fileReadUnknown)
      }
    )

    let savedDocument = try service.saveDocument(
      content: "# Saved",
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "# Saved")
    XCTAssertEqual(savedDocument.content, "# Saved")
    XCTAssertNil(savedDocument.modificationDate)
  }

  func testConcurrentExternalWriteAtCommitIsRestoredInsteadOfOverwritten() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    let externalContent = "# External write in commit window"
    try Data(originalContent.utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      willCommitWrite: { commitURL in
        try? Data(externalContent.utf8).write(to: commitURL, options: .atomic)
      }
    )

    var recoveryURL: URL?
    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      guard
        let accessError = error as? FileAccessError,
        case .saveRecoveryRequired(let recoveryPath) = accessError
      else {
        return XCTFail("Expected a recovery-required error, got \(error)")
      }
      recoveryURL = URL(fileURLWithPath: recoveryPath)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externalContent
    )
    XCTAssertEqual(
      try String(contentsOf: try XCTUnwrap(recoveryURL), encoding: .utf8),
      "# Local draft"
    )
  }

  func testExternalDeletionAfterValidationIsNotSilentlyRecreated() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      didValidateWrite: { validatedURL in
        try? FileManager.default.removeItem(at: validatedURL)
      }
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
  }

  func testExternalDeletionAtCommitIsNotSilentlyRecreated() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      willCommitWrite: { commitURL in
        try? FileManager.default.removeItem(at: commitURL)
      }
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path(percentEncoded: false)))
  }

  func testConcurrentCreationAtCommitIsNotOverwritten() throws {
    let url = temporaryDirectory.appendingPathComponent("new.md")
    let externalContent = "# Created concurrently"
    let service = LocalFileService(
      willCommitWrite: { commitURL in
        FileManager.default.createFile(
          atPath: commitURL.path(percentEncoded: false),
          contents: Data(externalContent.utf8)
        )
      }
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: nil,
        expectedContent: nil,
        expectedTargetExists: false
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externalContent
    )
  }

  func testExternalRenameAfterCommitPreservesVisibleAndBaselineVersions() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    let externalContent = "# External rename after commit"
    try Data(originalContent.utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      didCommitWrite: { commitURL in
        try? Data(externalContent.utf8).write(to: commitURL, options: .atomic)
      }
    )

    var recoveryURL: URL?
    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      guard
        let accessError = error as? FileAccessError,
        case .saveRecoveryRequired(let recoveryPath) = accessError
      else {
        return XCTFail("Expected a recovery-required error, got \(error)")
      }
      recoveryURL = URL(fileURLWithPath: recoveryPath)
    }

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), externalContent)
    let baselineURL = try XCTUnwrap(recoveryURL)
    XCTAssertEqual(try String(contentsOf: baselineURL, encoding: .utf8), originalContent)
  }

  func testInPlaceWriteToDisplacedFileAfterCommitIsRetainedForRecovery() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    let externalContent = "# External write to displaced inode"
    let localContent = "# Local draft"
    try Data(originalContent.utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      didCommitWrite: { commitURL in
        let directoryURL = commitURL.deletingLastPathComponent()
        guard
          let recoveryURL = try? FileManager.default
            .contentsOfDirectory(
              at: directoryURL,
              includingPropertiesForKeys: nil
            )
            .first(where: {
              $0.lastPathComponent.contains(".flux-reader-recovery-")
            })
        else { return }
        try? Data(externalContent.utf8).write(to: recoveryURL)
      }
    )

    var recoveryURL: URL?
    XCTAssertThrowsError(
      try service.saveDocument(
        content: localContent,
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      guard
        let accessError = error as? FileAccessError,
        case .saveRecoveryRequired(let recoveryPath) = accessError
      else {
        return XCTFail("Expected a recovery-required error, got \(error)")
      }
      recoveryURL = URL(fileURLWithPath: recoveryPath)
    }

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), localContent)
    XCTAssertEqual(
      try String(contentsOf: try XCTUnwrap(recoveryURL), encoding: .utf8),
      externalContent
    )
  }

  func testExternalRenameDuringRollbackWindowIsNeverOverwritten() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalContent = "# Original"
    let firstExternalContent = "# First external replacement"
    let latestExternalContent = "# Latest external replacement"
    try Data(originalContent.utf8).write(to: url)
    let originalDocument = try LocalFileService().loadDocument(at: url)
    let service = LocalFileService(
      willCommitWrite: { commitURL in
        try? Data(firstExternalContent.utf8).write(
          to: commitURL,
          options: .atomic
        )
      },
      willRestoreDisplacedFile: { commitURL in
        try? Data(latestExternalContent.utf8).write(
          to: commitURL,
          options: .atomic
        )
      }
    )

    var recoveryURL: URL?
    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      guard
        let accessError = error as? FileAccessError,
        case .saveRecoveryRequired(let recoveryPath) = accessError
      else {
        return XCTFail("Expected a recovery-required error, got \(error)")
      }
      recoveryURL = URL(fileURLWithPath: recoveryPath)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      latestExternalContent
    )
    let displacedURL = try XCTUnwrap(recoveryURL)
    XCTAssertEqual(
      try String(contentsOf: displacedURL, encoding: .utf8),
      firstExternalContent
    )
  }

  private func setExtendedAttribute(
    _ value: Data,
    named name: String,
    at url: URL
  ) throws {
    let result = url.path.withCString { path in
      name.withCString { attributeName in
        value.withUnsafeBytes { bytes in
          setxattr(path, attributeName, bytes.baseAddress, bytes.count, 0, 0)
        }
      }
    }
    guard result == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
  }

  private func fileStatus(at url: URL) throws -> stat {
    var status = stat()
    guard lstat(url.path(percentEncoded: false), &status) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return status
  }

  private func supplementaryGroupDifferentFromDirectory() throws -> gid_t {
    let directoryGroupID = try fileStatus(at: temporaryDirectory).st_gid
    let count = getgroups(0, nil)
    guard count > 0 else {
      throw XCTSkip("No supplementary groups are available")
    }
    var groups = [gid_t](repeating: 0, count: Int(count))
    guard getgroups(count, &groups) == count else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    guard let groupID = groups.first(where: { $0 != directoryGroupID }) else {
      throw XCTSkip("No group differs from the temporary directory group")
    }
    return groupID
  }

  private func extendedAttribute(named name: String, at url: URL) throws -> Data {
    let length = url.path.withCString { path in
      name.withCString { attributeName in
        getxattr(path, attributeName, nil, 0, 0, 0)
      }
    }
    guard length >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    var value = Data(count: length)
    let bytesRead = value.withUnsafeMutableBytes { bytes in
      url.path.withCString { path in
        name.withCString { attributeName in
          getxattr(path, attributeName, bytes.baseAddress, bytes.count, 0, 0)
        }
      }
    }
    guard bytesRead == length else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return value
  }
}

private final class ManifestWriteFaultInjector: @unchecked Sendable {
  private let lock = NSLock()
  private var shouldFailEmptyManifestWrite = false

  func failNextEmptyManifestWrite() {
    lock.lock()
    shouldFailEmptyManifestWrite = true
    lock.unlock()
  }

  func intercept(_ versions: [RetainedFileRecoveryVersion]) throws {
    lock.lock()
    defer { lock.unlock() }
    guard shouldFailEmptyManifestWrite, versions.isEmpty else { return }
    shouldFailEmptyManifestWrite = false
    throw CocoaError(.fileWriteUnknown)
  }
}

private final class CommitCallRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var recordedCount = 0

  var count: Int {
    lock.withLock { recordedCount }
  }

  func record() {
    lock.withLock { recordedCount += 1 }
  }
}
