import AppKit
import SwiftUI

/// Flux Reader 的 macOS 玻璃拟态层级。
///
/// 大面积内容只使用系统 Material；只有小型浮层与选中态在 macOS 26 上使用
/// Liquid Glass，避免正文滚动时叠加多层实时折射。
enum FluxGlassSurfaceLevel {
  case content
  case floating
  case selection

  var material: Material {
    switch self {
    case .content:
      .regularMaterial
    case .floating:
      .thinMaterial
    case .selection:
      .ultraThinMaterial
    }
  }

  var usesLiquidGlass: Bool {
    switch self {
    case .content:
      false
    case .floating, .selection:
      true
    }
  }

  var shadowRadius: CGFloat {
    switch self {
    case .content:
      22
    case .floating:
      14
    case .selection:
      8
    }
  }

  var shadowY: CGFloat {
    switch self {
    case .content:
      10
    case .floating:
      7
    case .selection:
      4
    }
  }
}

enum FluxLiquidGlassPalette {
  static func toolbarBackground(for colorScheme: ColorScheme) -> AnyShapeStyle {
    if colorScheme == .dark {
      return AnyShapeStyle(
        LinearGradient(
          colors: [
            Color(red: 0.055, green: 0.075, blue: 0.095),
            Color(red: 0.105, green: 0.095, blue: 0.125),
          ],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
    }

    return AnyShapeStyle(
      LinearGradient(
        colors: [
          Color(red: 0.88, green: 0.94, blue: 0.95),
          Color(red: 0.97, green: 0.91, blue: 0.85),
          Color(red: 0.91, green: 0.94, blue: 0.96),
        ],
        startPoint: .leading,
        endPoint: .trailing
      )
    )
  }
}

/// 静态渐变叠加系统 Material，提供参考稿中的暖色环境光，但不随滚动重绘。
struct FluxLiquidGlassBackdrop: View {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    GeometryReader { geometry in
      if reduceTransparency {
        Color(nsColor: .windowBackgroundColor)
      } else {
        ZStack {
          Rectangle()
            .fill(.ultraThinMaterial)

          LinearGradient(
            colors: baseGradient,
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )

          Circle()
            .fill(Color.accentColor.opacity(colorScheme == .dark ? 0.16 : 0.13))
            .frame(width: geometry.size.width * 0.62)
            .blur(radius: 90)
            .offset(
              x: geometry.size.width * 0.34,
              y: -geometry.size.height * 0.35
            )

          Circle()
            .fill(warmGlow.opacity(colorScheme == .dark ? 0.15 : 0.22))
            .frame(width: geometry.size.width * 0.52)
            .blur(radius: 100)
            .offset(
              x: -geometry.size.width * 0.38,
              y: geometry.size.height * 0.38
            )
        }
      }
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }

  private var baseGradient: [Color] {
    if colorScheme == .dark {
      return [
        Color(red: 0.055, green: 0.075, blue: 0.095),
        Color(red: 0.105, green: 0.095, blue: 0.125),
        Color(red: 0.060, green: 0.085, blue: 0.095),
      ]
    }
    return [
      Color(red: 0.88, green: 0.94, blue: 0.95).opacity(0.86),
      Color(red: 0.97, green: 0.91, blue: 0.85).opacity(0.78),
      Color(red: 0.91, green: 0.94, blue: 0.96).opacity(0.88),
    ]
  }

  private var warmGlow: Color {
    colorScheme == .dark
      ? Color(red: 0.72, green: 0.43, blue: 0.30)
      : Color(red: 0.95, green: 0.66, blue: 0.43)
  }
}

struct FluxGlassSidebarBackground: View {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    Group {
      if reduceTransparency {
        Color(nsColor: .windowBackgroundColor)
      } else {
        Rectangle().fill(.ultraThinMaterial)
      }
    }
    .overlay(alignment: .trailing) {
      Rectangle()
        .fill(borderColor)
        .frame(width: 1)
    }
  }

  private var borderColor: Color {
    colorScheme == .dark ? Color.white.opacity(0.12) : Color.white.opacity(0.72)
  }
}

private struct FluxGlassSurfaceModifier: ViewModifier {
  let level: FluxGlassSurfaceLevel
  let cornerRadius: CGFloat

  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.colorSchemeContrast) private var contrast

  @ViewBuilder
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)

    if reduceTransparency {
      content
        .background(opaqueFallback, in: shape)
        .overlay(shape.strokeBorder(borderColor, lineWidth: borderWidth))
    } else if #available(macOS 26.0, *), level.usesLiquidGlass {
      content
        .glassEffect(.regular, in: shape)
        .overlay(shape.strokeBorder(borderColor, lineWidth: borderWidth))
        .shadow(
          color: Color.black.opacity(colorScheme == .dark ? 0.28 : 0.12),
          radius: level.shadowRadius,
          y: level.shadowY
        )
    } else {
      content
        .background(level.material, in: shape)
        .overlay(shape.strokeBorder(borderColor, lineWidth: borderWidth))
        .shadow(
          color: Color.black.opacity(colorScheme == .dark ? 0.28 : 0.12),
          radius: level.shadowRadius,
          y: level.shadowY
        )
    }
  }

  private var opaqueFallback: Color {
    if colorScheme == .dark {
      return Color(red: 0.075, green: 0.08, blue: 0.09)
    }
    return Color(red: 0.97, green: 0.97, blue: 0.965)
  }

  private var borderColor: Color {
    if contrast == .increased {
      return colorScheme == .dark ? Color.white.opacity(0.34) : Color.black.opacity(0.22)
    }
    return colorScheme == .dark ? Color.white.opacity(0.15) : Color.white.opacity(0.76)
  }

  private var borderWidth: CGFloat {
    contrast == .increased ? 1.25 : 1
  }
}

private struct FluxGlassBarModifier: ViewModifier {
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.colorScheme) private var colorScheme

  func body(content: Content) -> some View {
    content.background {
      Group {
        if reduceTransparency {
          Color(nsColor: .windowBackgroundColor)
        } else {
          Rectangle().fill(.ultraThinMaterial)
        }
      }
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(
            colorScheme == .dark
              ? Color.white.opacity(0.10) : Color.white.opacity(0.64)
          )
          .frame(height: 1)
      }
    }
  }
}

private struct FluxActiveGlassModifier: ViewModifier {
  let isActive: Bool

  @ViewBuilder
  func body(content: Content) -> some View {
    if isActive {
      content.modifier(
        FluxGlassSurfaceModifier(level: .selection, cornerRadius: 9)
      )
    } else {
      content
    }
  }
}

extension View {
  func fluxGlassSurface(
    _ level: FluxGlassSurfaceLevel,
    cornerRadius: CGFloat
  ) -> some View {
    modifier(FluxGlassSurfaceModifier(level: level, cornerRadius: cornerRadius))
  }

  func fluxGlassBar() -> some View {
    modifier(FluxGlassBarModifier())
  }

  func fluxActiveGlass(_ isActive: Bool) -> some View {
    modifier(FluxActiveGlassModifier(isActive: isActive))
  }
}

/// 让 SwiftUI Window 保留系统交通灯与可拖拽标题栏，同时允许内容背景参与磨砂合成。
struct FluxGlassWindowConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    FluxGlassWindowConfigurationView()
  }

  func updateNSView(_ nsView: NSView, context: Context) {
    (nsView as? FluxGlassWindowConfigurationView)?.applyConfiguration()
  }
}

@MainActor
private final class FluxGlassWindowConfigurationView: NSView {
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    applyConfiguration()
  }

  func applyConfiguration() {
    guard let window else { return }
    // Apple only guarantees transparent title bars when the content view extends
    // through the full title-bar region. This also keeps the app backdrop behind
    // the toolbar when macOS reveals it in full-screen mode.
    window.styleMask.insert(.fullSizeContentView)
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.backgroundColor = .clear
    window.isOpaque = false
    window.toolbarStyle = .unifiedCompact
    window.isMovableByWindowBackground = true
  }
}
