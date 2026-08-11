import AppKit
import SwiftUI

struct MarkdownRendererView: View {
  let document: MarkdownDocument
  var findQuery = ""
  var findCaseSensitive = false
  var activeFindMatch = 0
  var scrollSynchronizer: SplitScrollSynchronizer? = nil

  @State private var usesNativeFallback = false
  @State private var isWebContentVisible = !WebMarkdownView.isHandoffEnabled

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        if !isWebContentVisible || usesNativeFallback || WebMarkdownView.rendererURL == nil {
          Group {
            if usesNativeFallback || WebMarkdownView.rendererURL == nil {
              NativeMarkdownView(document: document)
            } else {
              NativeMarkdownPlaceholderView(document: document)
            }
          }
          .accessibilityIdentifier("flux-reader-native-placeholder")
        }

        if WebMarkdownView.rendererURL != nil && !usesNativeFallback {
          WebMarkdownView(
            document: document,
            findQuery: findQuery,
            findCaseSensitive: findCaseSensitive,
            activeFindMatch: activeFindMatch,
            scrollSynchronizer: scrollSynchronizer,
            onRenderPending: {
              if WebMarkdownView.isHandoffEnabled {
                isWebContentVisible = false
              }
            },
            onContentDidPaint: {
              withAnimation(.easeOut(duration: 0.12)) {
                isWebContentVisible = true
              }
            },
            onFailure: {
              isWebContentVisible = false
              usesNativeFallback = true
            }
          )
          .opacity(isWebContentVisible ? 1 : 0)
          .allowsHitTesting(isWebContentVisible)
          .accessibilityHidden(!isWebContentVisible)
          .accessibilityIdentifier("flux-reader-web-preview")
        }
      }

      Divider()

      DocumentStatusBar(document: document)
    }
    .onChange(of: document.id) { _, _ in
      usesNativeFallback = false
      isWebContentVisible = !WebMarkdownView.isHandoffEnabled
    }
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
