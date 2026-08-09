import Foundation

protocol FolderIndexing: Sendable {
  func indexFolder(at url: URL) throws -> WorkspaceSnapshot
}

enum FolderIndexError: LocalizedError, Equatable, Sendable {
  case notDirectory
  case symbolicLinkRoot
  case tooManyEntries(limit: Int)

  var errorDescription: String? {
    switch self {
    case .notDirectory:
      "所选项目不是文件夹。"
    case .symbolicLinkRoot:
      "不能把符号链接作为工作文件夹，请选择它指向的真实文件夹。"
    case .tooManyEntries(let limit):
      "文件夹项目超过 \(limit) 个，已停止扫描。请选择范围更小的文件夹。"
    }
  }
}

struct LocalFolderIndexService: FolderIndexing {
  static let defaultMaximumEntryCount = 10_000
  static let defaultMaximumDepth = 20

  let maximumEntryCount: Int
  let maximumDepth: Int

  init(
    maximumEntryCount: Int = defaultMaximumEntryCount,
    maximumDepth: Int = defaultMaximumDepth
  ) {
    self.maximumEntryCount = maximumEntryCount
    self.maximumDepth = maximumDepth
  }

  func indexFolder(at url: URL) throws -> WorkspaceSnapshot {
    let rootURL = url.standardizedFileURL
    let rootValues = try rootURL.resourceValues(forKeys: [
      .isDirectoryKey,
      .isSymbolicLinkKey,
    ])
    guard rootValues.isSymbolicLink != true else {
      throw FolderIndexError.symbolicLinkRoot
    }
    guard rootValues.isDirectory == true else {
      throw FolderIndexError.notDirectory
    }

    let fileManager = FileManager.default
    let resourceKeys: Set<URLResourceKey> = [
      .isDirectoryKey,
      .isRegularFileKey,
      .isSymbolicLinkKey,
      .isPackageKey,
    ]
    var visitedEntryCount = 0
    var documentCount = 0

    func nodes(in directoryURL: URL, depth: Int) throws -> [WorkspaceNode] {
      try Task.checkCancellation()
      guard depth <= maximumDepth else { return [] }

      let childURLs: [URL]
      do {
        childURLs = try fileManager.contentsOfDirectory(
          at: directoryURL,
          includingPropertiesForKeys: Array(resourceKeys),
          options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )
      } catch {
        if depth == 0 { throw error }
        return []
      }

      var result: [WorkspaceNode] = []
      for childURL in childURLs {
        try Task.checkCancellation()
        visitedEntryCount += 1
        guard visitedEntryCount <= maximumEntryCount else {
          throw FolderIndexError.tooManyEntries(limit: maximumEntryCount)
        }

        let values: URLResourceValues
        do {
          values = try childURL.resourceValues(forKeys: resourceKeys)
        } catch {
          continue
        }

        guard values.isSymbolicLink != true, values.isPackage != true else {
          continue
        }

        if values.isDirectory == true {
          let childNodes = try nodes(in: childURL, depth: depth + 1)
          guard !childNodes.isEmpty else { continue }
          result.append(
            WorkspaceNode(
              url: childURL.standardizedFileURL,
              name: childURL.lastPathComponent,
              kind: .folder,
              children: childNodes
            )
          )
        } else if values.isRegularFile == true, MarkdownDocument.supports(childURL) {
          documentCount += 1
          result.append(
            WorkspaceNode(
              url: childURL.standardizedFileURL,
              name: childURL.lastPathComponent,
              kind: .document,
              children: []
            )
          )
        }
      }

      return result.sorted { lhs, rhs in
        if lhs.kind != rhs.kind {
          return lhs.kind == .folder
        }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
      }
    }

    let children = try nodes(in: rootURL, depth: 0)
    return WorkspaceSnapshot(
      rootURL: rootURL,
      children: children,
      documentCount: documentCount
    )
  }
}
