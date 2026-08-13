import AppKit
import SwiftUI
import UniformTypeIdentifiers
import WebKit

enum SplitScrollPane {
  case editor
  case preview
}

@MainActor
protocol SplitScrollEndpoint: AnyObject {
  func applySynchronizedScrollFraction(_ fraction: Double)
}

@MainActor
final class SplitScrollSynchronizer: ObservableObject {
  private weak var editorEndpoint: (any SplitScrollEndpoint)?
  private weak var previewEndpoint: (any SplitScrollEndpoint)?

  func attach(_ endpoint: any SplitScrollEndpoint, to pane: SplitScrollPane) {
    switch pane {
    case .editor:
      editorEndpoint = endpoint
    case .preview:
      previewEndpoint = endpoint
    }
  }

  func detach(_ endpoint: any SplitScrollEndpoint, from pane: SplitScrollPane) {
    switch pane {
    case .editor where editorEndpoint === endpoint:
      editorEndpoint = nil
    case .preview where previewEndpoint === endpoint:
      previewEndpoint = nil
    default:
      break
    }
  }

  func userDidScroll(_ source: SplitScrollPane, fraction: Double) {
    let clampedFraction = min(1, max(0, fraction))
    switch source {
    case .editor:
      previewEndpoint?.applySynchronizedScrollFraction(clampedFraction)
    case .preview:
      editorEndpoint?.applySynchronizedScrollFraction(clampedFraction)
    }
  }

  func resetPositions() {
    editorEndpoint?.applySynchronizedScrollFraction(0)
    previewEndpoint?.applySynchronizedScrollFraction(0)
  }
}

struct WebMarkdownView: NSViewRepresentable {
  static let isHandoffEnabled =
    ProcessInfo.processInfo.environment["FLUX_READER_DISABLE_WEB_HANDOFF"] != "1"
  static let rendererURL = Bundle.main.url(
    forResource: "macos",
    withExtension: "html",
    subdirectory: "Reader"
  )
  static let rendererEntryURL = URL(
    string: "\(RendererSchemeHandler.scheme)://app/macos.html"
  )!

  let document: MarkdownDocument
  let findQuery: String
  let findCaseSensitive: Bool
  let activeFindMatch: Int
  let scrollSynchronizer: SplitScrollSynchronizer?
  let isActive: Bool
  let onRenderPending: @MainActor () -> Void
  let onContentDidPaint: @MainActor () -> Void
  let onFailure: @MainActor () -> Void

  @Environment(\.colorScheme) private var colorScheme

  init(
    document: MarkdownDocument,
    findQuery: String = "",
    findCaseSensitive: Bool = false,
    activeFindMatch: Int = 0,
    scrollSynchronizer: SplitScrollSynchronizer? = nil,
    isActive: Bool = true,
    onRenderPending: @escaping @MainActor () -> Void = {},
    onContentDidPaint: @escaping @MainActor () -> Void = {},
    onFailure: @escaping @MainActor () -> Void
  ) {
    self.document = document
    self.findQuery = findQuery
    self.findCaseSensitive = findCaseSensitive
    self.activeFindMatch = activeFindMatch
    self.scrollSynchronizer = scrollSynchronizer
    self.isActive = isActive
    self.onRenderPending = onRenderPending
    self.onContentDidPaint = onContentDidPaint
    self.onFailure = onFailure
  }

  func makeCoordinator() -> Coordinator {
    Coordinator(
      scrollSynchronizer: scrollSynchronizer,
      onRenderPending: onRenderPending,
      onContentDidPaint: onContentDidPaint,
      onFailure: onFailure
    )
  }

  func makeNSView(context: Context) -> WKWebView {
    let contentController = WKUserContentController()
    contentController.add(context.coordinator, name: Coordinator.readyHandlerName)
    contentController.add(context.coordinator, name: Coordinator.contentDidPaintHandlerName)
    contentController.add(context.coordinator, name: Coordinator.copyTextHandlerName)
    contentController.add(context.coordinator, name: Coordinator.scrollHandlerName)

    guard
      let configuration = Self.makeConfiguration(
        contentController: contentController,
        documentResourceHandler: context.coordinator.documentResourceHandler
      )
    else {
      Task { @MainActor in onFailure() }
      return WKWebView(frame: .zero)
    }

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.alphaValue = Self.isHandoffEnabled ? 0 : 1
    webView.allowsMagnification = true
    webView.navigationDelegate = context.coordinator
    webView.uiDelegate = context.coordinator

    context.coordinator.attach(to: webView)
    if isActive {
      context.coordinator.update(
        document: document,
        theme: rendererTheme,
        findQuery: findQuery,
        findCaseSensitive: findCaseSensitive,
        activeFindMatch: activeFindMatch
      )
    }
    context.coordinator.loadRenderer()
    return webView
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.onFailure = onFailure
    context.coordinator.onRenderPending = onRenderPending
    context.coordinator.onContentDidPaint = onContentDidPaint
    context.coordinator.updateScrollSynchronizer(scrollSynchronizer)
    guard isActive else { return }
    context.coordinator.update(
      document: document,
      theme: rendererTheme,
      findQuery: findQuery,
      findCaseSensitive: findCaseSensitive,
      activeFindMatch: activeFindMatch
    )
  }

  static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
    coordinator.detach(from: webView)
  }

  private var rendererTheme: String {
    colorScheme == .dark ? "dark" : "light"
  }

  static func makeConfiguration(
    contentController: WKUserContentController,
    documentResourceHandler: DocumentResourceSchemeHandler = DocumentResourceSchemeHandler()
  ) -> WKWebViewConfiguration? {
    guard let rendererURL else { return nil }

    let configuration = WKWebViewConfiguration()
    configuration.userContentController = contentController
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.setURLSchemeHandler(
      RendererSchemeHandler(rootURL: rendererURL.deletingLastPathComponent()),
      forURLScheme: RendererSchemeHandler.scheme
    )
    configuration.setURLSchemeHandler(
      documentResourceHandler,
      forURLScheme: DocumentResourceSchemeHandler.scheme
    )
    return configuration
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler,
    WKUIDelegate, SplitScrollEndpoint
  {
    static let readyHandlerName = "rendererReady"
    static let contentDidPaintHandlerName = "contentDidPaint"
    static let copyTextHandlerName = "copyText"
    static let scrollHandlerName = "scrollPosition"

    var onFailure: @MainActor () -> Void
    var onRenderPending: @MainActor () -> Void
    var onContentDidPaint: @MainActor () -> Void
    let documentResourceHandler = DocumentResourceSchemeHandler()

    private weak var webView: WKWebView?
    private weak var scrollSynchronizer: SplitScrollSynchronizer?
    private var pendingPayload: RenderPayload?
    private var lastRenderedPayload: RenderPayload?
    private var presentedPayload: RenderPayload?
    private var rendererReady = false
    private var didReportFailure = false
    private var webContentRetryBudget = WebContentRetryBudget()
    private var handoffTracker = RenderHandoffTracker()
    private var paintTimeoutTask: Task<Void, Never>?
    private var resourceToken = UUID().uuidString
    private var pendingScrollFraction: Double?
    private var isScrollUpdateInFlight = false
    private var documentScrollFractions: [String: Double] = [:]

    init(
      scrollSynchronizer: SplitScrollSynchronizer?,
      onRenderPending: @escaping @MainActor () -> Void,
      onContentDidPaint: @escaping @MainActor () -> Void,
      onFailure: @escaping @MainActor () -> Void
    ) {
      self.scrollSynchronizer = scrollSynchronizer
      self.onRenderPending = onRenderPending
      self.onContentDidPaint = onContentDidPaint
      self.onFailure = onFailure
      super.init()
      scrollSynchronizer?.attach(self, to: .preview)
    }

    func attach(to webView: WKWebView) {
      self.webView = webView
    }

    func detach(from webView: WKWebView) {
      paintTimeoutTask?.cancel()
      paintTimeoutTask = nil
      handoffTracker.invalidate()
      if let scrollSynchronizer {
        scrollSynchronizer.detach(self, from: .preview)
      }
      webView.configuration.userContentController.removeScriptMessageHandler(
        forName: Self.readyHandlerName
      )
      webView.configuration.userContentController.removeScriptMessageHandler(
        forName: Self.contentDidPaintHandlerName
      )
      webView.configuration.userContentController.removeScriptMessageHandler(
        forName: Self.copyTextHandlerName
      )
      webView.configuration.userContentController.removeScriptMessageHandler(
        forName: Self.scrollHandlerName
      )
      webView.navigationDelegate = nil
      webView.uiDelegate = nil
      scrollSynchronizer = nil
      self.webView = nil
    }

    func updateScrollSynchronizer(_ next: SplitScrollSynchronizer?) {
      guard scrollSynchronizer !== next else { return }
      if let scrollSynchronizer {
        scrollSynchronizer.detach(self, from: .preview)
      }
      scrollSynchronizer = next
      next?.attach(self, to: .preview)
    }

    func update(
      document: MarkdownDocument,
      theme: String,
      findQuery: String,
      findCaseSensitive: Bool,
      activeFindMatch: Int
    ) {
      resourceToken = Self.resourceToken(for: document)
      documentResourceHandler.update(
        document: document,
        resourceToken: resourceToken
      )
      let candidate = RenderPayload(
        generation: "",
        documentKey: document.id.absoluteString,
        content: document.content,
        title: document.displayName,
        theme: theme,
        resourceToken: resourceToken,
        findQuery: findQuery,
        findCaseSensitive: findCaseSensitive,
        activeFindMatch: activeFindMatch
      )
      guard pendingPayload?.isEquivalent(to: candidate) != true else {
        renderIfReady()
        return
      }

      let hidesVisibleContent = pendingPayload?.hasSameVisibleContent(as: candidate) != true
      pendingPayload = RenderPayload(
        generation: UUID().uuidString,
        documentKey: candidate.documentKey,
        content: candidate.content,
        title: candidate.title,
        theme: candidate.theme,
        resourceToken: candidate.resourceToken,
        findQuery: candidate.findQuery,
        findCaseSensitive: candidate.findCaseSensitive,
        activeFindMatch: candidate.activeFindMatch
      )
      if let pendingPayload {
        beginHandoff(for: pendingPayload, hidesVisibleContent: hidesVisibleContent)
      }
      renderIfReady()
    }

    func loadRenderer() {
      guard let webView, WebMarkdownView.rendererURL != nil else {
        reportFailure()
        return
      }

      webView.load(URLRequest(url: WebMarkdownView.rendererEntryURL))
    }

    func userContentController(
      _ userContentController: WKUserContentController,
      didReceive message: WKScriptMessage
    ) {
      switch message.name {
      case Self.readyHandlerName:
        rendererReady = true
        renderIfReady()
        flushPendingScrollFraction()
      case Self.contentDidPaintHandlerName:
        acceptContentDidPaint(message.body)
      case Self.copyTextHandlerName:
        copyText(message.body)
      case Self.scrollHandlerName:
        if let fraction = Self.userScrollFraction(
          from: message.body,
          presentedGeneration: presentedPayload?.generation
        ) {
          if let documentKey = presentedPayload?.documentKey {
            documentScrollFractions[documentKey] = fraction
          }
          scrollSynchronizer?.userDidScroll(.preview, fraction: fraction)
        } else if let value = message.body as? NSNumber {
          // Accept the legacy payload while an already-loaded renderer is
          // being replaced during development. Release builds use the typed
          // user-scroll message above.
          scrollSynchronizer?.userDidScroll(
            .preview,
            fraction: min(1, max(0, value.doubleValue))
          )
        }
      default:
        break
      }
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      guard let url = navigationAction.request.url else { return .cancel }

      if isRendererPage(url) {
        return .allow
      }

      if navigationAction.navigationType == .linkActivated {
        openExternalURL(url)
      }
      return .cancel
    }

    func webView(
      _ webView: WKWebView,
      createWebViewWith configuration: WKWebViewConfiguration,
      for navigationAction: WKNavigationAction,
      windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
      if let url = navigationAction.request.url {
        openExternalURL(url)
      }
      return nil
    }

    func webView(
      _ webView: WKWebView,
      didFail navigation: WKNavigation!,
      withError error: any Error
    ) {
      reportFailure()
    }

    func webView(
      _ webView: WKWebView,
      didFailProvisionalNavigation navigation: WKNavigation!,
      withError error: any Error
    ) {
      reportFailure()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
      guard webContentRetryBudget.consume() else {
        reportFailure()
        return
      }

      rendererReady = false
      lastRenderedPayload = nil
      presentedPayload = nil
      if let pendingPayload {
        beginHandoff(for: pendingPayload, hidesVisibleContent: true)
      }
      loadRenderer()
    }

    private func renderIfReady() {
      guard
        rendererReady,
        let webView,
        let pendingPayload,
        pendingPayload != lastRenderedPayload
      else { return }

      lastRenderedPayload = pendingPayload
      let arguments: [String: Any] = [
        "generation": pendingPayload.generation,
        "content": pendingPayload.content,
        "title": pendingPayload.title,
        "theme": pendingPayload.theme,
        "resourceToken": pendingPayload.resourceToken,
        "findQuery": pendingPayload.findQuery,
        "findCaseSensitive": pendingPayload.findCaseSensitive,
        "activeFindMatch": pendingPayload.activeFindMatch,
      ]

      Task { @MainActor [weak self, weak webView] in
        guard let self, let webView else { return }
        do {
          _ = try await webView.callAsyncJavaScript(
            "globalThis.fluxReader.render(payload)",
            arguments: ["payload": arguments],
            contentWorld: .page
          )
        } catch {
          self.reportFailure()
        }
      }
    }

    func applySynchronizedScrollFraction(_ fraction: Double) {
      pendingScrollFraction = min(1, max(0, fraction))
      flushPendingScrollFraction()
    }

    private func flushPendingScrollFraction() {
      guard
        rendererReady,
        let webView,
        !isScrollUpdateInFlight,
        let fraction = pendingScrollFraction
      else { return }

      pendingScrollFraction = nil
      isScrollUpdateInFlight = true
      Task { @MainActor [weak self, weak webView] in
        guard let self else { return }
        defer {
          self.isScrollUpdateInFlight = false
          self.flushPendingScrollFraction()
        }
        guard let webView else { return }
        do {
          _ = try await webView.callAsyncJavaScript(
            "globalThis.fluxReader.setScrollFraction(fraction)",
            arguments: ["fraction": fraction],
            contentWorld: .page
          )
        } catch {
          self.reportFailure()
        }
      }
    }

    private func isRendererPage(_ url: URL) -> Bool {
      url.scheme == RendererSchemeHandler.scheme
        && url.host == "app"
        && url.path == "/macos.html"
    }

    private func openExternalURL(_ url: URL) {
      guard let scheme = url.scheme?.lowercased() else { return }
      guard ["http", "https", "mailto"].contains(scheme) else { return }
      NSWorkspace.shared.open(url)
    }

    private func copyText(_ body: Any) {
      guard
        let text = body as? String,
        text.utf8.count <= LocalFileService.defaultMaximumFileSize
      else { return }

      NSPasteboard.general.clearContents()
      NSPasteboard.general.writeObjects([text as NSString])
    }

    private func reportFailure() {
      guard !didReportFailure else { return }
      didReportFailure = true
      paintTimeoutTask?.cancel()
      paintTimeoutTask = nil
      presentedPayload = pendingPayload
      handoffTracker.invalidate()
      onFailure()
    }

    private func beginHandoff(
      for payload: RenderPayload,
      hidesVisibleContent: Bool
    ) {
      handoffTracker.begin(generation: payload.generation)
      paintTimeoutTask?.cancel()
      if hidesVisibleContent {
        if WebMarkdownView.isHandoffEnabled && lastRenderedPayload == nil {
          webView?.alphaValue = 0
        }
        let generation = payload.generation
        Task { @MainActor [weak self] in
          guard self?.handoffTracker.pendingGeneration == generation else { return }
          self?.onRenderPending()
        }
      }

      let generation = payload.generation
      paintTimeoutTask = Task { @MainActor [weak self] in
        do {
          try await Task.sleep(for: .seconds(10))
        } catch {
          return
        }
        guard self?.handoffTracker.pendingGeneration == generation else { return }
        self?.reportFailure()
      }
    }

    private func acceptContentDidPaint(_ body: Any) {
      guard
        let payload = body as? [String: Any],
        let generation = payload["generation"] as? String,
        let theme = payload["theme"] as? String,
        let hasContent = payload["hasContent"] as? Bool,
        let pendingPayload,
        pendingPayload.generation == generation,
        pendingPayload.theme == theme,
        hasContent == !pendingPayload.content.isEmpty,
        handoffTracker.accept(generation: generation)
      else { return }

      paintTimeoutTask?.cancel()
      paintTimeoutTask = nil
      presentedPayload = pendingPayload
      pendingScrollFraction = documentScrollFractions[pendingPayload.documentKey] ?? 0
      flushPendingScrollFraction()
      webView?.alphaValue = 1
      onContentDidPaint()
    }

    static func resourceToken(for document: MarkdownDocument) -> String {
      document.resourceRevision.uuidString.lowercased()
    }

    static func userScrollFraction(
      from body: Any,
      presentedGeneration: String?
    ) -> Double? {
      guard
        let payload = body as? [String: Any],
        payload["kind"] as? String == "user",
        let generation = payload["generation"] as? String,
        generation == presentedGeneration,
        let value = payload["fraction"] as? NSNumber
      else { return nil }
      return min(1, max(0, value.doubleValue))
    }
  }
}

private struct RenderPayload: Equatable {
  let generation: String
  let documentKey: String
  let content: String
  let title: String
  let theme: String
  let resourceToken: String
  let findQuery: String
  let findCaseSensitive: Bool
  let activeFindMatch: Int

  func isEquivalent(to other: RenderPayload) -> Bool {
    documentKey == other.documentKey
      && content == other.content
      && title == other.title
      && theme == other.theme
      && resourceToken == other.resourceToken
      && findQuery == other.findQuery
      && findCaseSensitive == other.findCaseSensitive
      && activeFindMatch == other.activeFindMatch
  }

  func hasSameVisibleContent(as other: RenderPayload) -> Bool {
    documentKey == other.documentKey
      && content == other.content
      && theme == other.theme
      && resourceToken == other.resourceToken
  }
}

struct RenderHandoffTracker {
  private(set) var pendingGeneration: String?

  mutating func begin(generation: String) {
    pendingGeneration = generation
  }

  mutating func accept(generation: String) -> Bool {
    guard pendingGeneration == generation else { return false }
    pendingGeneration = nil
    return true
  }

  mutating func invalidate() {
    pendingGeneration = nil
  }
}

struct WebContentRetryBudget {
  private(set) var remainingAttempts = 1

  mutating func consume() -> Bool {
    guard remainingAttempts > 0 else { return false }
    remainingAttempts -= 1
    return true
  }
}

@MainActor
final class RendererSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "flux-reader"

  private let rootURL: URL

  init(rootURL: URL) {
    self.rootURL = rootURL.standardizedFileURL
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    guard let requestURL = urlSchemeTask.request.url else {
      urlSchemeTask.didFailWithError(RendererResourceError.invalidRequest(nil))
      return
    }
    guard let resourceURL = resourceURL(for: requestURL) else {
      urlSchemeTask.didFailWithError(RendererResourceError.invalidRequest(requestURL))
      return
    }

    do {
      let values = try resourceURL.resourceValues(forKeys: [.isRegularFileKey])
      guard values.isRegularFile == true else {
        throw RendererResourceError.missingResource(resourceURL)
      }

      let data = try Data(contentsOf: resourceURL, options: [.mappedIfSafe])
      let contentType = UTType(filenameExtension: resourceURL.pathExtension)
      let response = URLResponse(
        url: requestURL,
        mimeType: contentType?.preferredMIMEType ?? "application/octet-stream",
        expectedContentLength: data.count,
        textEncodingName: nil
      )
      urlSchemeTask.didReceive(response)
      urlSchemeTask.didReceive(data)
      urlSchemeTask.didFinish()
    } catch {
      urlSchemeTask.didFailWithError(error)
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}

  func resourceURL(for requestURL: URL) -> URL? {
    guard requestURL.scheme == Self.scheme, requestURL.host == "app" else {
      return nil
    }

    let relativePath = requestURL.path(percentEncoded: false)
      .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !relativePath.isEmpty else { return nil }

    let candidate = rootURL.appending(path: relativePath).standardizedFileURL
    let rawRootPath = rootURL.path(percentEncoded: false)
    let rootPath = rawRootPath.hasSuffix("/") ? String(rawRootPath.dropLast()) : rawRootPath
    let candidatePath = candidate.path(percentEncoded: false)
    let rootBoundary = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
    guard candidatePath.hasPrefix(rootBoundary) else { return nil }
    return candidate
  }
}

private enum RendererResourceError: LocalizedError {
  case invalidRequest(URL?)
  case missingResource(URL)

  var errorDescription: String? {
    switch self {
    case .invalidRequest(let url):
      "渲染器请求不合法：\(url?.absoluteString ?? "<nil>")"
    case .missingResource(let url):
      "渲染器资源不存在：\(url.path(percentEncoded: false))"
    }
  }
}
