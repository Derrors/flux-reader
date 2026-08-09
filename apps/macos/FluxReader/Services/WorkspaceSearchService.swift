import Foundation

protocol WorkspaceSearching: Sendable {
  func search(
    query: String,
    workspaces: [WorkspaceSnapshot]
  ) throws -> [WorkspaceSearchResult]
}

struct LocalWorkspaceSearchService: WorkspaceSearching {
  private struct Candidate {
    let workspaceRootURL: URL
    let documentURL: URL
    let relativePath: String
  }

  static let defaultMaximumResultCount = 100

  let maximumResultCount: Int
  let maximumFileSize: Int

  init(
    maximumResultCount: Int = defaultMaximumResultCount,
    maximumFileSize: Int = LocalFileService.defaultMaximumFileSize
  ) {
    self.maximumResultCount = max(1, maximumResultCount)
    self.maximumFileSize = maximumFileSize
  }

  func search(
    query: String,
    workspaces: [WorkspaceSnapshot]
  ) throws -> [WorkspaceSearchResult] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return [] }

    let candidates = uniqueCandidates(in: workspaces)
    var fileNameMatches: [WorkspaceSearchResult] = []
    var contentCandidates: [Candidate] = []

    for candidate in candidates {
      try Task.checkCancellation()
      if candidate.relativePath.range(
        of: needle,
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
      ) != nil {
        fileNameMatches.append(
          WorkspaceSearchResult(
            workspaceRootURL: candidate.workspaceRootURL,
            documentURL: candidate.documentURL,
            relativePath: candidate.relativePath,
            snippet: candidate.relativePath,
            matchKind: .fileName
          )
        )
      } else {
        contentCandidates.append(candidate)
      }
    }

    let sortedFileNameMatches = sorted(fileNameMatches)
    guard sortedFileNameMatches.count < maximumResultCount else {
      return Array(sortedFileNameMatches.prefix(maximumResultCount))
    }

    var contentMatches: [WorkspaceSearchResult] = []
    let remainingResultCount = maximumResultCount - sortedFileNameMatches.count
    for candidate in contentCandidates {
      try Task.checkCancellation()
      guard
        let snippet = try? matchingSnippet(in: candidate.documentURL, query: needle)
      else { continue }
      contentMatches.append(
        WorkspaceSearchResult(
          workspaceRootURL: candidate.workspaceRootURL,
          documentURL: candidate.documentURL,
          relativePath: candidate.relativePath,
          snippet: snippet,
          matchKind: .content
        )
      )
      if contentMatches.count >= remainingResultCount { break }
    }

    return sortedFileNameMatches + sorted(contentMatches)
  }

  private func matchingSnippet(in url: URL, query: String) throws -> String? {
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard
      values.isRegularFile == true,
      (values.fileSize ?? 0) <= maximumFileSize
    else { return nil }

    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count <= maximumFileSize, let content = String(data: data, encoding: .utf8)
    else { return nil }
    guard
      let range = content.range(
        of: query,
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]
      )
    else { return nil }

    let lineRange = content.lineRange(for: range)
    let line = content[lineRange]
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    guard line.count > 180 else { return line }
    return String(line.prefix(177)) + "…"
  }

  private func sorted(_ results: [WorkspaceSearchResult]) -> [WorkspaceSearchResult] {
    results.sorted {
      let relativeComparison = $0.relativePath.localizedStandardCompare($1.relativePath)
      if relativeComparison != .orderedSame {
        return relativeComparison == .orderedAscending
      }
      return $0.documentURL.path(percentEncoded: false).localizedStandardCompare(
        $1.documentURL.path(percentEncoded: false)
      ) == .orderedAscending
    }
  }

  private func uniqueCandidates(in workspaces: [WorkspaceSnapshot]) -> [Candidate] {
    let deepestFirst = workspaces.enumerated().sorted { lhs, rhs in
      let lhsLength = lhs.element.rootURL.path(percentEncoded: false).count
      let rhsLength = rhs.element.rootURL.path(percentEncoded: false).count
      if lhsLength != rhsLength { return lhsLength > rhsLength }
      return lhs.offset < rhs.offset
    }
    var seenDocumentURLs: Set<URL> = []
    var candidates: [Candidate] = []

    for (_, workspace) in deepestFirst {
      for documentURL in workspace.documentURLs {
        let key = documentURL.standardizedFileURL
        guard seenDocumentURLs.insert(key).inserted else { continue }
        candidates.append(
          Candidate(
            workspaceRootURL: workspace.rootURL,
            documentURL: documentURL,
            relativePath: Self.relativePath(
              for: documentURL,
              rootURL: workspace.rootURL
            )
          )
        )
      }
    }
    return candidates
  }

  private static func relativePath(for url: URL, rootURL: URL) -> String {
    let rootPath = rootURL.standardizedFileURL.path(percentEncoded: false)
    let documentPath = url.standardizedFileURL.path(percentEncoded: false)
    let boundary = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
    guard documentPath.hasPrefix(boundary) else { return url.lastPathComponent }
    return String(documentPath.dropFirst(boundary.count))
  }
}
