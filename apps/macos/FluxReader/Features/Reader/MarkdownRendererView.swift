import AppKit
import SwiftUI

struct MarkdownRendererView: View {
  let document: MarkdownDocument
  var findQuery = ""
  var findCaseSensitive = false
  var activeFindMatch = 0
  var scrollSynchronizer: SplitScrollSynchronizer? = nil
  var isActive = true

  @State private var usesNativeFallback = false
  @State private var hasPresentedWebContent = !WebMarkdownView.isHandoffEnabled
  @State private var isRenderPending = WebMarkdownView.isHandoffEnabled
  @State private var presentedDocumentID: URL?

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        if usesNativeFallback || WebMarkdownView.rendererURL == nil {
          NativeMarkdownView(document: document)
            .accessibilityIdentifier("flux-reader-native-placeholder")
        }

        if WebMarkdownView.rendererURL != nil && !usesNativeFallback {
          WebMarkdownView(
            document: document,
            findQuery: findQuery,
            findCaseSensitive: findCaseSensitive,
            activeFindMatch: activeFindMatch,
            scrollSynchronizer: scrollSynchronizer,
            isActive: isActive,
            onRenderPending: {
              isRenderPending = true
            },
            onContentDidPaint: {
              hasPresentedWebContent = true
              presentedDocumentID = document.id
              isRenderPending = false
            },
            onFailure: {
              isRenderPending = false
              usesNativeFallback = true
            }
          )
          .accessibilityIdentifier("flux-reader-web-preview")
        }

        if !usesNativeFallback
          && WebMarkdownView.isHandoffEnabled
          && (isRenderPending || presentedDocumentID != document.id)
          && isActive
        {
          RenderLoadingOverlay(hasPreviousContent: hasPresentedWebContent)
        }
      }

      Divider()

      DocumentStatusBar(document: document)
    }
    .onChange(of: document.id) { _, _ in
      let wasUsingNativeFallback = usesNativeFallback
      usesNativeFallback = false
      // 正常 Web 标签切换由 Coordinator 的 generation 回调驱动。
      // 这里只处理从上一个文稿的 native fallback 重新挂载 WebView 的瞬间。
      if wasUsingNativeFallback && isActive { isRenderPending = true }
    }
  }
}

private struct RenderLoadingOverlay: View {
  let hasPreviousContent: Bool

  var body: some View {
    ZStack {
      Color(nsColor: .textBackgroundColor)
        .opacity(hasPreviousContent ? 0.72 : 1)
      VStack(spacing: 10) {
        ProgressView()
          .controlSize(.small)
        Text("正在渲染预览…")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("正在渲染预览")
  }
}

private struct DocumentStatusBar: View {
  let document: MarkdownDocument

  var body: some View {
    HStack(spacing: 12) {
      Text(document.url.path(percentEncoded: false))
        .lineLimit(1)
        .truncationMode(.middle)

      Spacer()

      Text(
        ByteCountFormatter.string(
          fromByteCount: Int64(document.byteCount),
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
}
