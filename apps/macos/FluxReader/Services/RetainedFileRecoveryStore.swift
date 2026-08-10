import Darwin
import Foundation

struct RetainedFileRecoveryVersion: Codable, Equatable, Identifiable, Sendable {
  static let currentFormatVersion = 1

  enum State: String, Codable, Sendable {
    case pending
    case retained
    case deleting
  }

  let formatVersion: Int
  let id: UUID
  let sourceURL: URL
  let sourceBookmark: Data?
  let recoveryURL: URL
  let recoveryBookmark: Data?
  let createdAt: Date
  let byteCount: Int
  let contentDigest: String
  let state: State

  init(
    id: UUID = UUID(),
    sourceURL: URL,
    sourceBookmark: Data?,
    recoveryURL: URL,
    recoveryBookmark: Data? = nil,
    createdAt: Date = Date(),
    byteCount: Int,
    contentDigest: String,
    state: State = .pending
  ) {
    self.formatVersion = Self.currentFormatVersion
    self.id = id
    self.sourceURL = sourceURL.standardizedFileURL
    self.sourceBookmark = sourceBookmark
    self.recoveryURL = recoveryURL.standardizedFileURL
    self.recoveryBookmark = recoveryBookmark
    self.createdAt = createdAt
    self.byteCount = byteCount
    self.contentDigest = contentDigest
    self.state = state
  }

  var displayName: String {
    sourceURL.lastPathComponent
  }

  func resolvedRecoveryURL() throws -> URL {
    guard let recoveryBookmark else { return recoveryURL.standardizedFileURL }
    var isStale = false
    return try URL(
      resolvingBookmarkData: recoveryBookmark,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    ).standardizedFileURL
  }

  func resolvedSourceURL() throws -> URL {
    guard let sourceBookmark else { return sourceURL.standardizedFileURL }
    var isStale = false
    return try URL(
      resolvingBookmarkData: sourceBookmark,
      options: [.withSecurityScope, .withoutUI],
      relativeTo: nil,
      bookmarkDataIsStale: &isStale
    ).standardizedFileURL
  }

  func finalized(recoveryBookmark: Data?) -> Self {
    Self(
      id: id,
      sourceURL: sourceURL,
      sourceBookmark: sourceBookmark,
      recoveryURL: recoveryURL,
      recoveryBookmark: recoveryBookmark,
      createdAt: createdAt,
      byteCount: byteCount,
      contentDigest: contentDigest,
      state: .retained
    )
  }

  func transitioning(to state: State) -> Self {
    Self(
      id: id,
      sourceURL: sourceURL,
      sourceBookmark: sourceBookmark,
      recoveryURL: recoveryURL,
      recoveryBookmark: recoveryBookmark,
      createdAt: createdAt,
      byteCount: byteCount,
      contentDigest: contentDigest,
      state: state
    )
  }
}

enum RetainedFileRecoveryError: LocalizedError, Equatable, Sendable {
  case limitReached(perDocument: Int, total: Int)
  case totalByteLimitReached(Int)
  case versionNotFound
  case minimumRetentionNotReached(Date)
  case quotaCannotBeVerified(String)

  var errorDescription: String? {
    switch self {
    case .limitReached(let perDocument, let total):
      return
        "保存恢复版本已达到上限（每份文稿 \(perDocument) 个、全部文稿 \(total) 个），本次保存尚未写入磁盘。请打开左侧边栏的“保存恢复版本”，在满 24 小时后点击垃圾桶并确认删除不再需要的版本，再重试保存。"
    case .totalByteLimitReached(let limit):
      let size = ByteCountFormatter.string(
        fromByteCount: Int64(limit),
        countStyle: .file
      )
      return "保存恢复版本已达到 \(size) 总量上限，本次保存尚未写入磁盘。请打开左侧边栏的“保存恢复版本”，在满 24 小时后点击垃圾桶并确认删除不再需要的版本，再重试保存。"
    case .versionNotFound:
      return "恢复版本记录已不存在，请刷新后重试。"
    case .minimumRetentionNotReached(let date):
      let formatter = DateFormatter()
      formatter.dateStyle = .medium
      formatter.timeStyle = .short
      return "该恢复版本仍处于安全保留期，请在 \(formatter.string(from: date)) 后再删除。"
    case .quotaCannotBeVerified(let path):
      return "无法安全核对恢复版本的实际大小，本次保存尚未写入磁盘。请检查该版本，或在满 24 小时后从左侧边栏明确确认删除，再重试保存：\(path)"
    }
  }
}

protocol RetainedFileRecoveryStoring: Sendable {
  func loadVersions() throws -> [RetainedFileRecoveryVersion]
  func reserveVersion(
    sourceURL: URL,
    recoveryURL: URL,
    byteCount: Int,
    contentDigest: String
  ) throws -> RetainedFileRecoveryVersion
  func finalizeVersion(
    _ id: UUID,
    byteCount: Int,
    contentDigest: String
  ) throws
  func cancelReservation(_ id: UUID) throws
  func deleteVersion(_ id: UUID, now: Date) throws
}

/// Used only when `LocalFileService` is exercised without application-level
/// recovery management (primarily focused transaction tests). The production
/// `ReaderViewModel` always injects `LocalRetainedFileRecoveryStore`.
struct EphemeralRetainedFileRecoveryStore: RetainedFileRecoveryStoring {
  func loadVersions() throws -> [RetainedFileRecoveryVersion] { [] }

  func reserveVersion(
    sourceURL: URL,
    recoveryURL: URL,
    byteCount: Int,
    contentDigest: String
  ) throws -> RetainedFileRecoveryVersion {
    RetainedFileRecoveryVersion(
      sourceURL: sourceURL,
      sourceBookmark: nil,
      recoveryURL: recoveryURL,
      byteCount: byteCount,
      contentDigest: contentDigest
    )
  }

  func finalizeVersion(
    _ id: UUID,
    byteCount: Int,
    contentDigest: String
  ) throws {}
  func cancelReservation(_ id: UUID) throws {}
  func deleteVersion(_ id: UUID, now: Date) throws {}
}

final class LocalRetainedFileRecoveryStore: RetainedFileRecoveryStoring,
  @unchecked Sendable
{
  static let defaultMaximumVersionsPerDocument = 5
  static let defaultMaximumTotalVersions = 50
  static let defaultMaximumTotalBytes = 100 * 1_024 * 1_024
  static let defaultMinimumRetentionInterval: TimeInterval = 24 * 60 * 60
  static let maximumManifestSize = 2 * 1_024 * 1_024

  let manifestURL: URL
  let maximumVersionsPerDocument: Int
  let maximumTotalVersions: Int
  let maximumTotalBytes: Int
  let minimumRetentionInterval: TimeInterval

  private let lock = NSLock()
  private let nowProvider: @Sendable () -> Date
  private let manifestWriteInterceptor: @Sendable ([RetainedFileRecoveryVersion]) throws -> Void
  private var activeReservationIDs = Set<UUID>()

  init(
    manifestURL: URL? = nil,
    maximumVersionsPerDocument: Int = defaultMaximumVersionsPerDocument,
    maximumTotalVersions: Int = defaultMaximumTotalVersions,
    maximumTotalBytes: Int = defaultMaximumTotalBytes,
    minimumRetentionInterval: TimeInterval? = nil,
    nowProvider: @escaping @Sendable () -> Date = Date.init,
    manifestWriteInterceptor:
      @escaping @Sendable (
        [RetainedFileRecoveryVersion]
      ) throws -> Void = { _ in }
  ) {
    self.manifestURL = (manifestURL ?? Self.defaultManifestURL()).standardizedFileURL
    self.maximumVersionsPerDocument = maximumVersionsPerDocument
    self.maximumTotalVersions = maximumTotalVersions
    self.maximumTotalBytes = maximumTotalBytes
    self.minimumRetentionInterval =
      minimumRetentionInterval ?? Self.defaultRetentionInterval()
    self.nowProvider = nowProvider
    self.manifestWriteInterceptor = manifestWriteInterceptor
  }

  static func defaultManifestURL(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> URL {
    #if DEBUG
      if environment["FLUX_READER_UI_TESTING"] == "1" {
        let sanitizedTestID =
          environment["FLUX_READER_UI_TEST_DOCUMENT_ID"]?
          .replacingOccurrences(
            of: "[^A-Za-z0-9_-]",
            with: "-",
            options: .regularExpression
          ) ?? "missing-test-id"
        let testID = sanitizedTestID.isEmpty ? "missing-test-id" : sanitizedTestID
        return FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUITests", isDirectory: true)
          .appendingPathComponent(testID, isDirectory: true)
          .appendingPathComponent("RecoveryVersions", isDirectory: true)
          .appendingPathComponent("manifest.json", isDirectory: false)
          .standardizedFileURL
      }
      if environment["XCTestConfigurationFilePath"] != nil
        || environment["XCTestBundlePath"] != nil
        || environment["XCInjectBundleInto"] != nil
      {
        return FileManager.default.temporaryDirectory
          .appendingPathComponent("FluxReaderUnitTests", isDirectory: true)
          .appendingPathComponent(
            "\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)",
            isDirectory: true
          )
          .appendingPathComponent("RecoveryVersions", isDirectory: true)
          .appendingPathComponent("manifest.json", isDirectory: false)
          .standardizedFileURL
      }
    #endif

    let applicationSupportURL =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first
      ?? FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support", isDirectory: true)
    let bundleIdentifier = Bundle.main.bundleIdentifier ?? "com.derrors.FluxReader"
    return
      applicationSupportURL
      .appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent("RecoveryVersions", isDirectory: true)
      .appendingPathComponent("manifest.json", isDirectory: false)
  }

  static func defaultRetentionInterval(
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> TimeInterval {
    #if DEBUG
      if environment["FLUX_READER_UI_TESTING"] == "1" { return 0 }
    #endif
    return defaultMinimumRetentionInterval
  }

  func loadVersions() throws -> [RetainedFileRecoveryVersion] {
    try lock.withLock {
      try readReconciledManifest().sorted { $0.createdAt > $1.createdAt }
    }
  }

  func reserveVersion(
    sourceURL: URL,
    recoveryURL: URL,
    byteCount: Int,
    contentDigest: String
  ) throws -> RetainedFileRecoveryVersion {
    try lock.withLock {
      var versions = try readReconciledManifest()
      let source = sourceURL.standardizedFileURL
      try validateQuota(
        for: versions,
        sourceURL: source,
        proposedByteCount: byteCount
      )

      let sourceBookmark = try? source.bookmarkData(
        options: .withSecurityScope,
        includingResourceValuesForKeys: nil,
        relativeTo: nil
      )
      let version = RetainedFileRecoveryVersion(
        sourceURL: source,
        sourceBookmark: sourceBookmark,
        recoveryURL: recoveryURL,
        createdAt: nowProvider(),
        byteCount: byteCount,
        contentDigest: contentDigest
      )
      versions.append(version)
      try writeManifest(versions)
      activeReservationIDs.insert(version.id)
      return version
    }
  }

  func finalizeVersion(
    _ id: UUID,
    byteCount: Int,
    contentDigest: String
  ) throws {
    try lock.withLock {
      defer { activeReservationIDs.remove(id) }
      var versions = try readManifest()
      guard let index = versions.firstIndex(where: { $0.id == id }) else {
        throw RetainedFileRecoveryError.versionNotFound
      }
      let version = versions[index]
      let bookmark = try? version.recoveryURL.bookmarkData(
        options: .withSecurityScope,
        includingResourceValuesForKeys: nil,
        relativeTo: nil
      )
      versions[index] = RetainedFileRecoveryVersion(
        id: version.id,
        sourceURL: version.sourceURL,
        sourceBookmark: version.sourceBookmark,
        recoveryURL: version.recoveryURL,
        recoveryBookmark: bookmark,
        createdAt: version.createdAt,
        byteCount: byteCount,
        contentDigest: contentDigest,
        state: .retained
      )
      try writeManifest(versions)
    }
  }

  func cancelReservation(_ id: UUID) throws {
    try lock.withLock {
      defer { activeReservationIDs.remove(id) }
      var versions = try readManifest()
      versions.removeAll { $0.id == id }
      try writeManifest(versions)
    }
  }

  func deleteVersion(_ id: UUID, now: Date = Date()) throws {
    try lock.withLock {
      var versions = try readReconciledManifest()
      guard let index = versions.firstIndex(where: { $0.id == id }) else {
        throw RetainedFileRecoveryError.versionNotFound
      }
      let version = versions[index]
      let eligibleAt = version.createdAt.addingTimeInterval(minimumRetentionInterval)
      guard now >= eligibleAt else {
        throw RetainedFileRecoveryError.minimumRetentionNotReached(eligibleAt)
      }
      try transitionAndDeleteVersion(id, in: &versions)
    }
  }

  #if DEBUG
    func resetForUITesting() throws {
      try lock.withLock {
        activeReservationIDs.removeAll()
        let versions = try readManifest()
        for version in versions {
          try? FileManager.default.removeItem(at: version.recoveryURL)
        }
        guard
          FileManager.default.fileExists(
            atPath: manifestURL.path(percentEncoded: false)
          )
        else { return }
        try FileManager.default.removeItem(at: manifestURL)
      }
    }
  #endif

  private func readManifest() throws -> [RetainedFileRecoveryVersion] {
    let path = manifestURL.path(percentEncoded: false)
    guard FileManager.default.fileExists(atPath: path) else { return [] }
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    guard
      attributes[.type] as? FileAttributeType == .typeRegular,
      let size = attributes[.size] as? NSNumber,
      size.intValue <= Self.maximumManifestSize
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
    let data = try Data(contentsOf: manifestURL)
    guard data.count <= Self.maximumManifestSize else {
      throw CocoaError(.fileReadTooLarge)
    }
    let versions = try JSONDecoder().decode([RetainedFileRecoveryVersion].self, from: data)
    guard
      versions.allSatisfy({ version in
        version.formatVersion == RetainedFileRecoveryVersion.currentFormatVersion
          && version.sourceURL.isFileURL
          && version.recoveryURL.isFileURL
          && version.byteCount >= 0
      })
    else {
      throw CocoaError(.fileReadCorruptFile)
    }
    return versions
  }

  private func readReconciledManifest() throws -> [RetainedFileRecoveryVersion] {
    let versions = try readManifest()
    var reconciled: [RetainedFileRecoveryVersion] = []
    reconciled.reserveCapacity(versions.count)
    var changed = false
    for version in versions {
      switch version.state {
      case .pending:
        if !activeReservationIDs.contains(version.id),
          recoveryPathIsDefinitelyMissing(for: version)
        {
          changed = true
        } else {
          reconciled.append(version)
        }
      case .retained:
        reconciled.append(version)
      case .deleting:
        do {
          try removeRecoverySidecar(for: version)
          changed = true
        } catch {
          // A deleting record remains durable and visible when the sidecar
          // cannot be reached. A later load retries without pretending the
          // version was removed.
          reconciled.append(version)
        }
      }
    }
    if changed {
      try writeManifest(reconciled)
    }
    return reconciled
  }

  /// Retained versions are never removed while reserving a save. Reaching any
  /// quota fails before the replacement file is created; cleanup is only
  /// available through `deleteVersion`, after the retention interval and an
  /// explicit user confirmation in the UI.
  private func validateQuota(
    for versions: [RetainedFileRecoveryVersion],
    sourceURL: URL,
    proposedByteCount: Int
  ) throws {
    guard
      versions.filter({ $0.sourceURL == sourceURL }).count
        < maximumVersionsPerDocument,
      versions.count < maximumTotalVersions
    else {
      throw RetainedFileRecoveryError.limitReached(
        perDocument: maximumVersionsPerDocument,
        total: maximumTotalVersions
      )
    }
    let accountedBytes = try totalAccountedByteCount(for: versions)
    let (proposedTotalBytes, overflowed) = accountedBytes.addingReportingOverflow(
      proposedByteCount
    )
    guard !overflowed, proposedTotalBytes <= maximumTotalBytes else {
      throw RetainedFileRecoveryError.totalByteLimitReached(maximumTotalBytes)
    }
  }

  private func transitionAndDeleteVersion(
    _ id: UUID,
    in versions: inout [RetainedFileRecoveryVersion]
  ) throws {
    guard let index = versions.firstIndex(where: { $0.id == id }) else {
      throw RetainedFileRecoveryError.versionNotFound
    }
    let deletingVersion = versions[index].transitioning(to: .deleting)
    versions[index] = deletingVersion
    try writeManifest(versions)
    try removeRecoverySidecar(for: deletingVersion)
    versions.removeAll { $0.id == id }
    try writeManifest(versions)
  }

  private func removeRecoverySidecar(
    for version: RetainedFileRecoveryVersion
  ) throws {
    let sourceURL = try? version.resolvedSourceURL()
    let sourceHasScope = sourceURL?.startAccessingSecurityScopedResource() == true
    defer {
      if sourceHasScope { sourceURL?.stopAccessingSecurityScopedResource() }
    }

    // Once unlink has completed, resolving the file bookmark itself may fail
    // on a later launch. The durable manifest URL remains the authoritative
    // fallback while the source bookmark grants access to its parent folder.
    let recoveryURL =
      (try? version.resolvedRecoveryURL())
      ?? version.recoveryURL.standardizedFileURL
    let hasSecurityScope = recoveryURL.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope { recoveryURL.stopAccessingSecurityScopedResource() }
    }
    do {
      try FileManager.default.removeItem(at: recoveryURL)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
      // ENOENT completes both an interrupted two-phase deletion and an
      // explicitly confirmed removal of an externally deleted sidecar.
    }
  }

  private func totalAccountedByteCount(
    for versions: [RetainedFileRecoveryVersion]
  ) throws -> Int {
    var accountedBytes = 0
    for version in versions {
      let versionBytes = try actualAccountedByteCount(for: version)
      let (updatedBytes, overflowed) = accountedBytes.addingReportingOverflow(
        versionBytes
      )
      guard !overflowed else {
        throw RetainedFileRecoveryError.totalByteLimitReached(maximumTotalBytes)
      }
      accountedBytes = updatedBytes
    }
    return accountedBytes
  }

  /// Only ENOENT is safe to reconcile automatically. Permission, network, or
  /// bookmark failures keep the pending record visible rather than risking the
  /// loss of a transaction sidecar that merely cannot be reached right now.
  private func recoveryPathIsDefinitelyMissing(
    for version: RetainedFileRecoveryVersion
  ) -> Bool {
    let sourceURL = try? version.resolvedSourceURL()
    let sourceHasScope = sourceURL?.startAccessingSecurityScopedResource() == true
    defer {
      if sourceHasScope { sourceURL?.stopAccessingSecurityScopedResource() }
    }

    let recoveryURL = (try? version.resolvedRecoveryURL()) ?? version.recoveryURL
    let recoveryHasScope = recoveryURL.startAccessingSecurityScopedResource()
    defer {
      if recoveryHasScope { recoveryURL.stopAccessingSecurityScopedResource() }
    }

    var status = stat()
    let result = recoveryURL.path.withCString { lstat($0, &status) }
    return result != 0 && errno == ENOENT
  }

  /// Recompute quota usage from an open descriptor on every reservation. The
  /// manifest size remains a conservative floor, while fstat detects growth
  /// caused by a process that kept the displaced inode open after the save.
  private func actualAccountedByteCount(
    for version: RetainedFileRecoveryVersion
  ) throws -> Int {
    let sourceURL = try? version.resolvedSourceURL()
    let sourceHasScope = sourceURL?.startAccessingSecurityScopedResource() == true
    defer {
      if sourceHasScope { sourceURL?.stopAccessingSecurityScopedResource() }
    }

    let recoveryURL: URL
    do {
      recoveryURL = try version.resolvedRecoveryURL()
    } catch {
      throw RetainedFileRecoveryError.quotaCannotBeVerified(
        version.recoveryURL.path(percentEncoded: false)
      )
    }
    let recoveryHasScope = recoveryURL.startAccessingSecurityScopedResource()
    defer {
      if recoveryHasScope { recoveryURL.stopAccessingSecurityScopedResource() }
    }

    let descriptor = open(
      recoveryURL.path(percentEncoded: false),
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW
    )
    guard descriptor >= 0 else {
      throw RetainedFileRecoveryError.quotaCannotBeVerified(
        recoveryURL.path(percentEncoded: false)
      )
    }
    defer { close(descriptor) }

    var status = stat()
    guard
      fstat(descriptor, &status) == 0,
      status.st_mode & S_IFMT == S_IFREG,
      status.st_size >= 0,
      let actualSize = Int(exactly: status.st_size)
    else {
      throw RetainedFileRecoveryError.quotaCannotBeVerified(
        recoveryURL.path(percentEncoded: false)
      )
    }
    return max(version.byteCount, actualSize)
  }

  private func writeManifest(_ versions: [RetainedFileRecoveryVersion]) throws {
    try manifestWriteInterceptor(versions)
    let data = try JSONEncoder().encode(versions)
    guard data.count <= Self.maximumManifestSize else {
      throw CocoaError(.fileWriteOutOfSpace)
    }
    let directoryURL = manifestURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directoryURL,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    try data.write(to: manifestURL, options: .atomic)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: manifestURL.path(percentEncoded: false)
    )
  }
}

extension NSLock {
  fileprivate func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
