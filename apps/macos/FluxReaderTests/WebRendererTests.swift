import AppKit
import SwiftUI
import WebKit
import XCTest

@testable import FluxReader

final class AppAppearanceTests: XCTestCase {
  func testAppearanceOptionsAndPreferredColorSchemes() {
    XCTAssertEqual(AppAppearance.defaultValue, .light)
    XCTAssertEqual(AppAppearance.allCases, [.system, .light, .dark])
    XCTAssertNil(AppAppearance.system.preferredColorScheme)
    XCTAssertEqual(AppAppearance.light.preferredColorScheme, .light)
    XCTAssertEqual(AppAppearance.dark.preferredColorScheme, .dark)
  }

  func testAppearancePersistsThroughAppStorage() throws {
    let suiteName = "AppAppearanceTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let storage = AppStorage(
      wrappedValue: AppAppearance.defaultValue,
      AppAppearance.storageKey,
      store: defaults
    )

    XCTAssertEqual(storage.wrappedValue, .light)
    storage.wrappedValue = .dark
    XCTAssertEqual(defaults.string(forKey: AppAppearance.storageKey), AppAppearance.dark.rawValue)

    let restoredStorage = AppStorage(
      wrappedValue: AppAppearance.defaultValue,
      AppAppearance.storageKey,
      store: defaults
    )
    XCTAssertEqual(restoredStorage.wrappedValue, .dark)
    restoredStorage.wrappedValue = .system
    XCTAssertEqual(defaults.string(forKey: AppAppearance.storageKey), AppAppearance.system.rawValue)
  }
}

@MainActor
private final class SplitScrollEndpointSpy: SplitScrollEndpoint {
  private(set) var receivedFractions: [Double] = []

  func applySynchronizedScrollFraction(_ fraction: Double) {
    receivedFractions.append(fraction)
  }
}

final class SplitScrollSynchronizerTests: XCTestCase {
  @MainActor
  func testRoutesOnlyToOppositePaneAndClampsFractions() {
    let synchronizer = SplitScrollSynchronizer()
    let editor = SplitScrollEndpointSpy()
    let preview = SplitScrollEndpointSpy()
    synchronizer.attach(editor, to: .editor)
    synchronizer.attach(preview, to: .preview)

    synchronizer.userDidScroll(.editor, fraction: 0.25)
    XCTAssertEqual(editor.receivedFractions, [])
    XCTAssertEqual(preview.receivedFractions, [0.25])

    synchronizer.userDidScroll(.preview, fraction: 2)
    XCTAssertEqual(editor.receivedFractions, [1])
    XCTAssertEqual(preview.receivedFractions, [0.25])

    synchronizer.resetPositions()
    XCTAssertEqual(editor.receivedFractions, [1, 0])
    XCTAssertEqual(preview.receivedFractions, [0.25, 0])

    synchronizer.detach(preview, from: .preview)
    synchronizer.userDidScroll(.editor, fraction: 0.75)
    XCTAssertEqual(preview.receivedFractions, [0.25, 0])
  }
}

final class WebRendererTests: XCTestCase {
  func testRenderHandoffAcceptsOnlyCurrentGenerationOnce() {
    var tracker = RenderHandoffTracker()
    tracker.begin(generation: "generation-1")

    XCTAssertFalse(tracker.accept(generation: "stale-generation"))
    XCTAssertEqual(tracker.pendingGeneration, "generation-1")
    XCTAssertTrue(tracker.accept(generation: "generation-1"))
    XCTAssertNil(tracker.pendingGeneration)
    XCTAssertFalse(tracker.accept(generation: "generation-1"))

    tracker.begin(generation: "generation-2")
    tracker.invalidate()
    XCTAssertFalse(tracker.accept(generation: "generation-2"))
  }

  func testWebContentRetryBudgetAllowsExactlyOneAutomaticReload() {
    var budget = WebContentRetryBudget()
    XCTAssertEqual(budget.remainingAttempts, 1)
    XCTAssertTrue(budget.consume())
    XCTAssertEqual(budget.remainingAttempts, 0)
    XCTAssertFalse(budget.consume())
  }

  @MainActor
  func testBundledRendererEntryAndConfiguration() throws {
    let rendererURL = try XCTUnwrap(WebMarkdownView.rendererURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: rendererURL.path))

    let html = try String(contentsOf: rendererURL, encoding: .utf8)
    XCTAssertTrue(html.contains("Content-Security-Policy"))
    XCTAssertTrue(html.contains("img-src 'self' https: flux-reader-resource:"))
    XCTAssertTrue(html.contains("type=\"module\""))

    let schemeHandler = RendererSchemeHandler(
      rootURL: rendererURL.deletingLastPathComponent()
    )
    XCTAssertEqual(
      schemeHandler.resourceURL(for: WebMarkdownView.rendererEntryURL)?.resolvingSymlinksInPath(),
      rendererURL.resolvingSymlinksInPath()
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "https://app.example/macos.html")!
      )
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "flux-reader://other/macos.html")!
      )
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "flux-reader://app/%2E%2E/Info.plist")!
      )
    )

    let configuration = try XCTUnwrap(
      WebMarkdownView.makeConfiguration(
        contentController: WKUserContentController()
      )
    )
    XCTAssertNotNil(
      configuration.urlSchemeHandler(
        forURLScheme: RendererSchemeHandler.scheme
      )
    )
    XCTAssertNotNil(
      configuration.urlSchemeHandler(
        forURLScheme: DocumentResourceSchemeHandler.scheme
      )
    )
  }

  @MainActor
  func testContractBuildRendersSharedManifestInWKWebView() async throws {
    let contractRoot =
      repositoryRoot
      .appendingPathComponent("packages/reader-web/dist-contract-macos", isDirectory: true)
    let entryURL = contractRoot.appendingPathComponent("macos.html")
    guard FileManager.default.fileExists(atPath: entryURL.path) else {
      XCTFail(
        "Missing macOS render-contract build. Run npm --prefix packages/reader-web run build:contract:macos first."
      )
      return
    }

    let manifestURL =
      repositoryRoot
      .appendingPathComponent("packages/reader-web/test/fixtures/render-contract/manifest.json")
    let manifest = try JSONDecoder().decode(
      RenderContractManifest.self,
      from: Data(contentsOf: manifestURL)
    )

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.setURLSchemeHandler(
      RendererSchemeHandler(rootURL: contractRoot),
      forURLScheme: RendererSchemeHandler.scheme
    )
    let webView = WKWebView(
      frame: CGRect(x: 0, y: 0, width: 1_024, height: 768), configuration: configuration)
    let window = NSWindow(
      contentRect: webView.frame,
      styleMask: [.borderless],
      backing: .buffered,
      defer: false
    )
    window.contentView = webView
    window.orderFront(nil)
    defer {
      window.orderOut(nil)
      window.contentView = nil
    }

    for contractCase in manifest.cases {
      var components = URLComponents(
        url: WebMarkdownView.rendererEntryURL, resolvingAgainstBaseURL: false)
      components?.queryItems = [URLQueryItem(name: "case", value: contractCase.file)]
      let url = try XCTUnwrap(components?.url)
      webView.load(URLRequest(url: url))
      let result = try await waitForRenderContract(
        in: webView,
        file: contractCase.file,
        entry: "macos"
      )
      XCTAssertEqual(result.failures, [], contractCase.file)

      switch contractCase.file {
      case "math.md":
        let mathCount = try await elementCount(
          ".math-inline math, .math-display math",
          in: webView
        )
        XCTAssertEqual(mathCount, 2)
      case "mermaid.md":
        let diagramCount = try await elementCount(".mermaid-canvas svg", in: webView)
        let diagramErrorCount = try await elementCount(".mermaid-error", in: webView)
        XCTAssertEqual(diagramCount, 1)
        XCTAssertEqual(diagramErrorCount, 1)
      case "code.md":
        let highlightedCount = try await elementCount(".shiki-wrapper .shiki", in: webView)
        let skippedCount = try await elementCount(
          ".code-block[data-render-state=skipped]",
          in: webView
        )
        XCTAssertEqual(highlightedCount, 1)
        XCTAssertEqual(skippedCount, 1)
      default:
        break
      }
    }
  }

  func testDocumentResourceResolverStaysInsideWorkspaceAndRejectsSymlinkEscape() throws {
    let rootURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let docsURL = rootURL.appendingPathComponent("docs", isDirectory: true)
    let imagesURL = rootURL.appendingPathComponent("images", isDirectory: true)
    let outsideURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer {
      try? FileManager.default.removeItem(at: rootURL)
      try? FileManager.default.removeItem(at: outsideURL)
    }
    try FileManager.default.createDirectory(at: docsURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: imagesURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: outsideURL, withIntermediateDirectories: true)

    let documentURL = docsURL.appendingPathComponent("README.md")
    let imageURL = imagesURL.appendingPathComponent("封面 1.png")
    try Data("# Test".utf8).write(to: documentURL)
    try Data([0x89, 0x50, 0x4E, 0x47]).write(to: imageURL)
    try Data([0x89, 0x50, 0x4E, 0x47]).write(
      to: outsideURL.appendingPathComponent("secret.png")
    )
    try FileManager.default.createSymbolicLink(
      at: rootURL.appendingPathComponent("escaped", isDirectory: true),
      withDestinationURL: outsideURL
    )

    let document = MarkdownDocument(
      url: documentURL,
      content: "",
      byteCount: 0,
      modificationDate: nil,
      resourceRootURL: rootURL
    )
    let context = DocumentResourceContext(
      document: document,
      resourceToken: "test-token"
    )
    let resolver = DocumentResourceResolver()
    let loader = DocumentResourceLoader()

    XCTAssertEqual(
      resolver.resourceURL(
        for: try resourceRequest("../images/%E5%B0%81%E9%9D%A2%201.png"),
        context: context
      ),
      imageURL.standardizedFileURL
    )
    XCTAssertEqual(
      resolver.resourceURL(
        for: try resourceRequest("/images/%E5%B0%81%E9%9D%A2%201.png"),
        context: context
      ),
      imageURL.standardizedFileURL
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest("../../outside.png"),
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest("/escaped/secret.png"),
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: URL(string: "https://example.com/image.png")!,
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest(
          "/images/%E5%B0%81%E9%9D%A2%201.png",
          token: "stale-token"
        ),
        context: context
      )
    )

    let loaded = try loader.load(at: imageURL, rootURL: rootURL)
    XCTAssertEqual(loaded.data, Data([0x89, 0x50, 0x4E, 0x47]))
    XCTAssertEqual(loaded.mimeType, "image/png")
    XCTAssertThrowsError(
      try loader.load(
        at: rootURL.appendingPathComponent("escaped/secret.png"),
        rootURL: rootURL
      )
    )
  }

  private func resourceRequest(
    _ source: String,
    token: String = "test-token"
  ) throws -> URL {
    var components = URLComponents()
    components.scheme = DocumentResourceSchemeHandler.scheme
    components.host = "image"
    components.path = "/\(token)"
    components.queryItems = [URLQueryItem(name: "path", value: source)]
    return try XCTUnwrap(components.url)
  }

  @MainActor
  private func waitForRenderContract(
    in webView: WKWebView,
    file: String,
    entry: String
  ) async throws -> RenderContractResult {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(20))
    var lastSnapshot: String?

    while clock.now < deadline {
      do {
        lastSnapshot =
          try await webView.evaluateJavaScript(
            """
            JSON.stringify({
              state: document.documentElement.dataset.renderContractState || null,
              entry: document.documentElement.dataset.renderContractEntry || null,
              file: document.documentElement.dataset.renderContractCase || null,
              result: globalThis.__FLUX_READER_RENDER_CONTRACT__ || null
            })
            """
          ) as? String
        if let lastSnapshot,
          let data = lastSnapshot.data(using: .utf8),
          let snapshot = try? JSONDecoder().decode(RenderContractSnapshot.self, from: data),
          snapshot.entry == entry,
          snapshot.file == file,
          let result = snapshot.result,
          snapshot.state == "passed" || snapshot.state == "failed"
        {
          if snapshot.state == "failed" {
            throw RenderContractTestError.failed(
              "\(entry)/\(file): \(result.failures.joined(separator: "; "))"
            )
          }
          return result
        }
      } catch {
        // Navigation can briefly invalidate the JavaScript execution context.
        // The contract state itself is the readiness signal, so retry until
        // the bounded deadline instead of sleeping for a guessed render time.
      }
      try await Task.sleep(for: .milliseconds(50))
    }

    throw RenderContractTestError.timedOut(
      "Timed out waiting for \(entry)/\(file). Last state: \(lastSnapshot ?? "<none>")"
    )
  }

  @MainActor
  private func elementCount(_ selector: String, in webView: WKWebView) async throws -> Int {
    let encodedSelector = try JSONEncoder().encode(selector)
    let selectorLiteral = try XCTUnwrap(String(data: encodedSelector, encoding: .utf8))
    let value = try await webView.evaluateJavaScript(
      "document.querySelectorAll(\(selectorLiteral)).length"
    )
    return try XCTUnwrap((value as? NSNumber)?.intValue)
  }

  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }
}

private struct RenderContractManifest: Decodable {
  struct ContractCase: Decodable {
    let file: String
  }

  let cases: [ContractCase]
}

private struct RenderContractSnapshot: Decodable {
  let state: String?
  let entry: String?
  let file: String?
  let result: RenderContractResult?
}

private struct RenderContractResult: Decodable {
  let failures: [String]
}

private enum RenderContractTestError: LocalizedError {
  case failed(String)
  case timedOut(String)

  var errorDescription: String? {
    switch self {
    case .failed(let message), .timedOut(let message):
      message
    }
  }
}
