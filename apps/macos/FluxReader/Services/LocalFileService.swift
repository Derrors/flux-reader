import Darwin
import Foundation

protocol FileAccessing: Sendable {
  func loadDocument(at url: URL) throws -> MarkdownDocument
  func saveDocument(
    content: String,
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws -> MarkdownDocument
}

enum FileAccessError: LocalizedError, Equatable, Sendable {
  case unsupportedFileType(String)
  case notRegularFile
  case fileTooLarge(actual: Int, limit: Int)
  case invalidUTF8
  case fileModifiedExternally
  case saveRecoveryRequired(String)

  var errorDescription: String? {
    switch self {
    case .unsupportedFileType(let fileExtension):
      let suffix = fileExtension.isEmpty ? "无扩展名" : ".\(fileExtension)"
      return "不支持 \(suffix) 文件，请选择 Markdown 文稿。"
    case .notRegularFile:
      return "所选项目不是可读取的普通文件。"
    case .fileTooLarge(let actual, let limit):
      let formatter = ByteCountFormatter()
      formatter.countStyle = .file
      return
        "文件大小为 \(formatter.string(fromByteCount: Int64(actual)))，超过 \(formatter.string(fromByteCount: Int64(limit))) 限制。"
    case .invalidUTF8:
      return "文件不是有效的 UTF-8 文本。"
    case .fileModifiedExternally:
      return "文件已被其他应用修改。请从磁盘重新载入，或使用“另存为”保留当前草稿。"
    case .saveRecoveryRequired(let backupPath):
      return "保存期间检测到并发修改，未继续覆盖。可恢复副本保留在：\(backupPath)"
    }
  }
}

struct LocalFileService: FileAccessing {
  static let defaultMaximumFileSize = 2 * 1_024 * 1_024

  let maximumFileSize: Int
  private let postWriteModificationDateProvider: @Sendable (URL) throws -> Date?
  private let didValidateWrite: @Sendable (URL) -> Void
  private let willCommitWrite: @Sendable (URL) -> Void
  private let didCommitWrite: @Sendable (URL) -> Void
  private let willRestoreDisplacedFile: @Sendable (URL) -> Void
  private let replacementOwnershipSetter: @Sendable (Int32, uid_t, gid_t) throws -> Void
  private let retainedRecoveryStore: any RetainedFileRecoveryStoring

  init(
    maximumFileSize: Int = defaultMaximumFileSize,
    postWriteModificationDateProvider: @escaping @Sendable (URL) throws -> Date? = {
      url in
      let attributes = try FileManager.default.attributesOfItem(
        atPath: url.path(percentEncoded: false)
      )
      return attributes[.modificationDate] as? Date
    },
    didValidateWrite: @escaping @Sendable (URL) -> Void = { _ in },
    willCommitWrite: @escaping @Sendable (URL) -> Void = { _ in },
    didCommitWrite: @escaping @Sendable (URL) -> Void = { _ in },
    willRestoreDisplacedFile: @escaping @Sendable (URL) -> Void = { _ in },
    retainedRecoveryStore: any RetainedFileRecoveryStoring =
      EphemeralRetainedFileRecoveryStore(),
    replacementOwnershipSetter:
      @escaping @Sendable (
        Int32,
        uid_t,
        gid_t
      ) throws -> Void = { descriptor, ownerID, groupID in
        guard fchown(descriptor, ownerID, groupID) == 0 else {
          throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
      }
  ) {
    self.maximumFileSize = maximumFileSize
    self.postWriteModificationDateProvider = postWriteModificationDateProvider
    self.didValidateWrite = didValidateWrite
    self.willCommitWrite = willCommitWrite
    self.didCommitWrite = didCommitWrite
    self.willRestoreDisplacedFile = willRestoreDisplacedFile
    self.retainedRecoveryStore = retainedRecoveryStore
    self.replacementOwnershipSetter = replacementOwnershipSetter
  }

  func loadDocument(at url: URL) throws -> MarkdownDocument {
    guard MarkdownDocument.supports(url) else {
      throw FileAccessError.unsupportedFileType(url.pathExtension)
    }

    let hasSecurityScope = url.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope {
        url.stopAccessingSecurityScopedResource()
      }
    }

    let values = try url.resourceValues(forKeys: [
      .isRegularFileKey,
      .fileSizeKey,
      .contentModificationDateKey,
    ])

    guard values.isRegularFile == true else {
      throw FileAccessError.notRegularFile
    }

    if let fileSize = values.fileSize, fileSize > maximumFileSize {
      throw FileAccessError.fileTooLarge(actual: fileSize, limit: maximumFileSize)
    }

    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count <= maximumFileSize else {
      throw FileAccessError.fileTooLarge(actual: data.count, limit: maximumFileSize)
    }
    guard let content = String(data: data, encoding: .utf8) else {
      throw FileAccessError.invalidUTF8
    }

    return MarkdownDocument(
      url: url.standardizedFileURL,
      content: content,
      byteCount: data.count,
      modificationDate: values.contentModificationDate
    )
  }

  func saveDocument(
    content: String,
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws -> MarkdownDocument {
    guard MarkdownDocument.supports(url) else {
      throw FileAccessError.unsupportedFileType(url.pathExtension)
    }

    let data = Data(content.utf8)
    guard data.count <= maximumFileSize else {
      throw FileAccessError.fileTooLarge(actual: data.count, limit: maximumFileSize)
    }

    let hasSecurityScope = url.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope {
        url.stopAccessingSecurityScopedResource()
      }
    }

    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var writeResult: Result<MarkdownDocument, Error>?
    let writingOptions: NSFileCoordinator.WritingOptions =
      FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
      ? .forReplacing : []

    coordinator.coordinate(
      writingItemAt: url,
      options: writingOptions,
      error: &coordinationError
    ) { coordinatedURL in
      writeResult = Result {
        try validateWriteTarget(
          at: coordinatedURL,
          expectedModificationDate: expectedModificationDate,
          expectedContent: expectedContent,
          expectedTargetExists: expectedTargetExists
        )
        didValidateWrite(coordinatedURL)
        try writeDataPreservingMetadata(
          data,
          to: coordinatedURL,
          expectedContent: expectedContent,
          expectedTargetExists: expectedTargetExists
        )

        // The content commit is the save boundary. Metadata lookup can fail
        // transiently on a NAS after the atomic replacement; that must not turn
        // an already committed save into a reported failure.
        let modificationDate = try? postWriteModificationDateProvider(coordinatedURL)

        return MarkdownDocument(
          url: coordinatedURL.standardizedFileURL,
          content: content,
          byteCount: data.count,
          modificationDate: modificationDate
        )
      }
    }

    if let coordinationError {
      throw coordinationError
    }
    guard let writeResult else {
      throw CocoaError(.fileWriteUnknown)
    }
    return try writeResult.get()
  }

  private func validateWriteTarget(
    at url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws {
    let fileExists = FileManager.default.fileExists(
      atPath: url.path(percentEncoded: false)
    )
    guard fileExists else {
      if expectedTargetExists || expectedModificationDate != nil || expectedContent != nil {
        throw FileAccessError.fileModifiedExternally
      }
      return
    }
    guard expectedTargetExists else {
      throw FileAccessError.fileModifiedExternally
    }

    // URL resource values may be cached on a URL that was used to open the
    // document. FileManager attributes force a fresh snapshot for the
    // last-moment conflict check inside the coordinated write.
    let attributes = try FileManager.default.attributesOfItem(
      atPath: url.path(percentEncoded: false)
    )
    guard attributes[.type] as? FileAttributeType == .typeRegular else {
      throw FileAccessError.notRegularFile
    }
    if let expectedModificationDate {
      guard attributes[.modificationDate] as? Date == expectedModificationDate else {
        throw FileAccessError.fileModifiedExternally
      }
    }
    if let expectedContent {
      let expectedData = Data(expectedContent.utf8)
      guard
        let currentSize = attributes[.size] as? NSNumber,
        currentSize.intValue == expectedData.count
      else {
        throw FileAccessError.fileModifiedExternally
      }

      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      let currentData = try handle.read(upToCount: expectedData.count + 1) ?? Data()
      guard currentData == expectedData else {
        throw FileAccessError.fileModifiedExternally
      }
    }
  }

  private func writeDataPreservingMetadata(
    _ data: Data,
    to url: URL,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: url.path(percentEncoded: false)) else {
      guard !expectedTargetExists, expectedContent == nil else {
        throw FileAccessError.fileModifiedExternally
      }
      let temporaryURL = url.deletingLastPathComponent().appendingPathComponent(
        ".\(url.lastPathComponent).flux-reader-new-\(UUID().uuidString)",
        isDirectory: false
      )
      defer { try? fileManager.removeItem(at: temporaryURL) }
      try data.write(to: temporaryURL, options: .atomic)
      willCommitWrite(url)
      let renameResult = temporaryURL.path.withCString { sourcePath in
        url.path.withCString { destinationPath in
          renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
        }
      }
      guard renameResult == 0 else {
        if errno == EEXIST || expectedTargetExists {
          throw FileAccessError.fileModifiedExternally
        }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      return
    }

    // Existing files use an explicit same-directory transaction. Keeping the
    // original descriptor open lets us prove which inode was displaced even
    // when a non-cooperating process replaces the pathname after validation.
    guard expectedTargetExists, let expectedContent else {
      throw FileAccessError.fileModifiedExternally
    }
    let originalDescriptor = try openRegularFileForReading(at: url)
    defer { close(originalDescriptor) }
    let originalIdentity = try fileIdentity(for: originalDescriptor)
    guard
      try fileContents(
        descriptor: originalDescriptor,
        limit: maximumFileSize + 1
      ) == Data(expectedContent.utf8)
    else {
      throw FileAccessError.fileModifiedExternally
    }

    let transactionID = UUID().uuidString
    let parentURL = url.deletingLastPathComponent()
    let recoveryURL = parentURL.appendingPathComponent(
      ".\(url.lastPathComponent).flux-reader-recovery-\(transactionID).md",
      isDirectory: false
    )
    let baselineData = Data(expectedContent.utf8)
    let recoveryVersion = try retainedRecoveryStore.reserveVersion(
      sourceURL: url,
      recoveryURL: recoveryURL,
      byteCount: baselineData.count,
      contentDigest: DraftRecoveryRecord.contentDigest(expectedContent)
    )
    var didSwap = false
    defer {
      if !didSwap {
        try? fileManager.removeItem(at: recoveryURL)
        try? retainedRecoveryStore.cancelReservation(recoveryVersion.id)
      }
    }

    let temporaryIdentity = try createReplacementFile(
      at: recoveryURL,
      data: data,
      preservingMetadataFrom: originalDescriptor
    )
    willCommitWrite(url)

    // Swap the replacement and the pathname atomically. Unlike two exclusive
    // renames, this never leaves the user-visible pathname absent if the
    // process is killed between transaction steps. The old pathname occupant
    // is now at temporaryURL until it has been proven to be our baseline.
    guard atomicSwap(recoveryURL, url) == 0 else {
      if errno == ENOENT {
        throw FileAccessError.fileModifiedExternally
      }
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    didSwap = true

    guard
      fileMatches(at: url, identity: temporaryIdentity, data: data),
      fileMatches(
        at: recoveryURL,
        identity: originalIdentity,
        data: baselineData
      )
    else {
      // If a non-cooperating process won the pathname immediately before the
      // swap, put that exact inode back only through another atomic exchange.
      // Any uncertainty retains both paths for recovery instead of unlinking
      // or overwriting a version we do not own.
      if rollbackSwapIfSafe(
        targetURL: url,
        displacedURL: recoveryURL,
        committedIdentity: temporaryIdentity,
        committedData: data
      ) {
        try? retainedRecoveryStore.finalizeVersion(
          recoveryVersion.id,
          byteCount: data.count,
          contentDigest: DraftRecoveryRecord.contentDigest(
            String(decoding: data, as: UTF8.self)
          )
        )
        throw recoveryRequired(for: [recoveryURL])
      }
      throw recoveryRequired(for: [recoveryURL])
    }

    do {
      try retainedRecoveryStore.finalizeVersion(
        recoveryVersion.id,
        byteCount: baselineData.count,
        contentDigest: DraftRecoveryRecord.contentDigest(expectedContent)
      )
    } catch {
      // The reservation is already durable and points at the displaced inode.
      // Fail closed so the UI can surface the pending recovery record.
      throw recoveryRequired(for: [recoveryURL])
    }

    didCommitWrite(url)

    guard fileMatches(at: url, identity: temporaryIdentity, data: data) else {
      throw recoveryRequired(for: [recoveryURL])
    }

    // Revalidate the displaced inode and its bytes after the commit hook before
    // declaring success. If it already changed, surface its recovery path;
    // regardless of this check, the inode remains retained for later fd writes.
    guard
      fileMatches(
        at: recoveryURL,
        identity: originalIdentity,
        data: baselineData
      )
    else {
      throw recoveryRequired(for: [recoveryURL])
    }

    // Deliberately retain the displaced inode. A non-cooperating process may
    // still hold the old file descriptor and write after every pathname check;
    // unlinking here would make those later bytes unrecoverable. Workspace
    // indexing skips this hidden, uniquely named recovery version. Cleanup must
    // only happen through an explicit recovery lifecycle, never in this save
    // transaction.
  }

  private func fileContents(at url: URL, limit: Int) throws -> Data {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    return try handle.read(upToCount: limit) ?? Data()
  }

  private struct FileIdentity: Equatable {
    let device: UInt64
    let inode: UInt64
  }

  private func openRegularFileForReading(at url: URL) throws -> Int32 {
    let descriptor = open(
      url.path(percentEncoded: false),
      O_RDONLY | O_CLOEXEC | O_NOFOLLOW
    )
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    do {
      var status = stat()
      guard fstat(descriptor, &status) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      guard (status.st_mode & S_IFMT) == S_IFREG else {
        throw FileAccessError.notRegularFile
      }
      return descriptor
    } catch {
      close(descriptor)
      throw error
    }
  }

  private func fileIdentity(for descriptor: Int32) throws -> FileIdentity {
    var status = stat()
    guard fstat(descriptor, &status) == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return FileIdentity(
      device: UInt64(status.st_dev),
      inode: UInt64(status.st_ino)
    )
  }

  private func fileIdentity(at url: URL) throws -> FileIdentity {
    let descriptor = try openRegularFileForReading(at: url)
    defer { close(descriptor) }
    return try fileIdentity(for: descriptor)
  }

  private func fileContents(descriptor: Int32, limit: Int) throws -> Data {
    guard lseek(descriptor, 0, SEEK_SET) >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: min(64 * 1_024, max(limit, 1)))
    while result.count < limit {
      let count = read(
        descriptor,
        &buffer,
        min(buffer.count, limit - result.count)
      )
      guard count >= 0 else {
        if errno == EINTR { continue }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      if count == 0 { break }
      result.append(buffer, count: count)
    }
    return result
  }

  private func createReplacementFile(
    at url: URL,
    data: Data,
    preservingMetadataFrom originalDescriptor: Int32
  ) throws -> FileIdentity {
    let descriptor = open(
      url.path(percentEncoded: false),
      O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
      S_IRUSR | S_IWUSR
    )
    guard descriptor >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    defer { close(descriptor) }

    do {
      try data.withUnsafeBytes { rawBuffer in
        var offset = 0
        while offset < rawBuffer.count {
          guard let baseAddress = rawBuffer.baseAddress else { break }
          let written = Darwin.write(
            descriptor,
            baseAddress.advanced(by: offset),
            rawBuffer.count - offset
          )
          guard written >= 0 else {
            if errno == EINTR { continue }
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
          }
          offset += written
        }
      }

      var originalStatus = stat()
      guard fstat(originalDescriptor, &originalStatus) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }

      var replacementStatus = stat()
      guard fstat(descriptor, &replacementStatus) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      if replacementStatus.st_uid != originalStatus.st_uid
        || replacementStatus.st_gid != originalStatus.st_gid
      {
        try replacementOwnershipSetter(
          descriptor,
          originalStatus.st_uid,
          originalStatus.st_gid
        )
      }

      guard fstat(descriptor, &replacementStatus) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      guard
        replacementStatus.st_uid == originalStatus.st_uid,
        replacementStatus.st_gid == originalStatus.st_gid
      else {
        throw CocoaError(.fileWriteNoPermission)
      }

      let metadataFlags = copyfile_flags_t(COPYFILE_XATTR | COPYFILE_ACL)
      guard fcopyfile(originalDescriptor, descriptor, nil, metadataFlags) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      // fchown may clear set-id bits, and applying an ACL may adjust the mode.
      // Restore the source mode last, then verify the complete POSIX identity
      // before the replacement is eligible for the atomic swap.
      guard fchmod(descriptor, originalStatus.st_mode & 0o7777) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      guard fstat(descriptor, &replacementStatus) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      guard
        replacementStatus.st_uid == originalStatus.st_uid,
        replacementStatus.st_gid == originalStatus.st_gid,
        replacementStatus.st_mode & 0o7777 == originalStatus.st_mode & 0o7777
      else {
        throw CocoaError(.fileWriteNoPermission)
      }
      guard fsync(descriptor) == 0 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
      }
      return try fileIdentity(for: descriptor)
    } catch {
      try? FileManager.default.removeItem(at: url)
      throw error
    }
  }

  private func atomicSwap(_ firstURL: URL, _ secondURL: URL) -> Int32 {
    firstURL.path.withCString { firstPath in
      secondURL.path.withCString { secondPath in
        renamex_np(firstPath, secondPath, UInt32(RENAME_SWAP))
      }
    }
  }

  private func fileMatches(
    at url: URL,
    identity: FileIdentity,
    data: Data
  ) -> Bool {
    guard let descriptor = try? openRegularFileForReading(at: url) else { return false }
    defer { close(descriptor) }
    guard
      (try? fileIdentity(for: descriptor)) == identity,
      (try? fileContents(descriptor: descriptor, limit: data.count + 1)) == data,
      (try? fileIdentity(at: url)) == identity
    else { return false }
    return true
  }

  private func rollbackSwapIfSafe(
    targetURL: URL,
    displacedURL: URL,
    committedIdentity: FileIdentity,
    committedData: Data
  ) -> Bool {
    guard let displacedIdentity = try? fileIdentity(at: displacedURL) else {
      return false
    }
    guard
      fileMatches(
        at: targetURL,
        identity: committedIdentity,
        data: committedData
      ),
      (try? fileIdentity(at: displacedURL)) == displacedIdentity
    else { return false }

    willRestoreDisplacedFile(targetURL)
    guard
      fileMatches(
        at: targetURL,
        identity: committedIdentity,
        data: committedData
      ),
      (try? fileIdentity(at: displacedURL)) == displacedIdentity,
      atomicSwap(targetURL, displacedURL) == 0,
      (try? fileIdentity(at: targetURL)) == displacedIdentity,
      fileMatches(
        at: displacedURL,
        identity: committedIdentity,
        data: committedData
      )
    else { return false }
    return true
  }

  private func recoveryRequired(for urls: [URL]) -> FileAccessError {
    .saveRecoveryRequired(
      urls
        .map { $0.path(percentEncoded: false) }
        .joined(separator: "；")
    )
  }
}
