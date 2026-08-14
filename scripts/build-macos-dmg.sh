#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(tr -d '\r\n' < "$PROJECT_ROOT/versions/macos")"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_ROOT/dist/release}"
DERIVED_DATA="${DERIVED_DATA:-$PROJECT_ROOT/.build/macos-release}"
SIGNING_IDENTITY="${MACOS_SIGNING_IDENTITY:-}"
NOTARY_KEY_PATH="${APPLE_NOTARY_KEY_PATH:-}"
NOTARY_KEY_ID="${APPLE_NOTARY_KEY_ID:-}"
NOTARY_ISSUER_ID="${APPLE_NOTARY_ISSUER_ID:-}"

if [[ -n "$SIGNING_IDENTITY" ]]; then
  DISTRIBUTION_MODE="notarized"
  DMG_NAME="Flux-Reader-${VERSION}-universal.dmg"
else
  DISTRIBUTION_MODE="unnotarized"
  DMG_NAME="Flux-Reader-${VERSION}-unnotarized-universal.dmg"
fi

DMG_PATH="$OUTPUT_DIR/$DMG_NAME"
APP_PATH="$DERIVED_DATA/Build/Products/Release/FluxReader.app"
EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/FluxReader"
TEMP_ROOT="${TMPDIR:-/tmp}"
TEMP_ROOT="${TEMP_ROOT%/}"
STAGING_DIR=""

cleanup() {
  if [[ -z "$STAGING_DIR" ]]; then
    return
  fi
  case "$STAGING_DIR" in
    "$TEMP_ROOT"/flux-reader-dmg.*)
      rm -rf -- "$STAGING_DIR"
      ;;
    *)
      echo "拒绝清理非预期临时目录：$STAGING_DIR" >&2
      ;;
  esac
}
trap cleanup EXIT

if [[ ! "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
  echo "BUILD_NUMBER 必须是正整数，当前值：${BUILD_NUMBER}" >&2
  exit 1
fi

if [[ "$DISTRIBUTION_MODE" == "notarized" ]]; then
  if [[ -z "$NOTARY_KEY_PATH" || -z "$NOTARY_KEY_ID" ]]; then
    echo "Developer ID 模式必须设置 APPLE_NOTARY_KEY_PATH 与 APPLE_NOTARY_KEY_ID。" >&2
    exit 1
  fi
  if [[ ! -r "$NOTARY_KEY_PATH" ]]; then
    echo "无法读取 Apple 公证 API 私钥：$NOTARY_KEY_PATH" >&2
    exit 1
  fi
fi

if [[ -n "${DMG_ASSET:-}" && "$DMG_ASSET" != "$DMG_NAME" ]]; then
  echo "DMG 资产名不一致：工作流期望 ${DMG_ASSET}，构建脚本生成 ${DMG_NAME}" >&2
  exit 1
fi

node "$PROJECT_ROOT/scripts/sync-version.js" --check --platform macos
mkdir -p "$OUTPUT_DIR"

xcodebuild \
  -project "$PROJECT_ROOT/apps/macos/FluxReader.xcodeproj" \
  -scheme FluxReader \
  -configuration Release \
  -destination 'generic/platform=macOS' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  ONLY_ACTIVE_ARCH=NO \
  ARCHS='arm64 x86_64' \
  MARKETING_VERSION="$VERSION" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  build

test -d "$APP_PATH"
test -x "$EXECUTABLE_PATH"

ARCHITECTURES="$(lipo -archs "$EXECUTABLE_PATH")"
for required_architecture in arm64 x86_64; do
  if [[ " $ARCHITECTURES " != *" $required_architecture "* ]]; then
    echo "macOS 产物缺少 $required_architecture 架构：$ARCHITECTURES" >&2
    exit 1
  fi
done

BUNDLE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
if [[ "$BUNDLE_VERSION" != "$VERSION" ]]; then
  echo "macOS Bundle 版本不匹配：期望 ${VERSION}，实际 ${BUNDLE_VERSION}" >&2
  exit 1
fi

BUNDLE_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")"
if [[ "$BUNDLE_BUILD" != "$BUILD_NUMBER" ]]; then
  echo "macOS Bundle 构建号不匹配：期望 ${BUILD_NUMBER}，实际 ${BUNDLE_BUILD}" >&2
  exit 1
fi

if [[ "$DISTRIBUTION_MODE" == "notarized" ]]; then
  codesign \
    --force \
    --sign "$SIGNING_IDENTITY" \
    --options runtime \
    --timestamp \
    --entitlements "$PROJECT_ROOT/apps/macos/FluxReader/Resources/FluxReader.entitlements" \
    "$APP_PATH"
else
  # 无 Developer ID 时使用 ad-hoc 签名，保留 Sandbox entitlement；该签名不提供身份背书。
  codesign \
    --force \
    --sign - \
    --options runtime \
    --timestamp=none \
    --entitlements "$PROJECT_ROOT/apps/macos/FluxReader/Resources/FluxReader.entitlements" \
    "$APP_PATH"
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

STAGING_DIR="$(mktemp -d "$TEMP_ROOT/flux-reader-dmg.XXXXXX")"
ditto "$APP_PATH" "$STAGING_DIR/FluxReader.app"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "Flux Reader $VERSION" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"
hdiutil verify "$DMG_PATH"

if [[ "$DISTRIBUTION_MODE" == "notarized" ]]; then
  codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$DMG_PATH"
  codesign --verify --strict --verbose=2 "$DMG_PATH"

  NOTARY_RESULT="$STAGING_DIR/notary-result.json"
  NOTARY_ARGUMENTS=(
    --key "$NOTARY_KEY_PATH"
    --key-id "$NOTARY_KEY_ID"
  )
  if [[ -n "$NOTARY_ISSUER_ID" ]]; then
    NOTARY_ARGUMENTS+=(--issuer "$NOTARY_ISSUER_ID")
  fi

  xcrun notarytool submit "$DMG_PATH" \
    "${NOTARY_ARGUMENTS[@]}" \
    --wait \
    --timeout 30m \
    --output-format json > "$NOTARY_RESULT"
  node -e '
    const fs = require("node:fs");
    const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (result.status !== "Accepted") {
      console.error(`Apple 公证未通过：${result.status ?? "未知状态"} (${result.id ?? "无提交 ID"})`);
      process.exit(1);
    }
    console.log(`✓ Apple 公证已接受：${result.id}`);
  ' "$NOTARY_RESULT"

  xcrun stapler staple -v "$DMG_PATH"
  xcrun stapler validate -v "$DMG_PATH"
  spctl --assess --type open --verbose=2 "$DMG_PATH"
  echo "✓ Developer ID 签名并已公证的 macOS DMG：$DMG_PATH"
else
  echo "✓ ad-hoc 签名、未公证的 macOS DMG：$DMG_PATH"
fi
